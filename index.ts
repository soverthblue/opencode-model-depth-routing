import type { Plugin } from "@opencode/plugin";
import { clampMode, isAuthorizedDirector, MODES, parseId, parseModel, parseRolePolicy, parseTier, selectModel, sessionIdForWorkUnit, messageIdForWorkUnit, type Mode, type RolePolicy, type WorkUnit } from "./core.js";
import { definition } from "./rpc.js";

const PREFIX = "model-depth-routing.v1.";
const presetKey = (tier: Mode) => `${PREFIX}preset.${tier}`;
const roleKey = (role: string) => `${PREFIX}role.${encodeURIComponent(role)}`;
const unitKey = (id: string) => `${PREFIX}unit.${id}`;
const ROUTING_ROLE_IDS = new Set(["implementer", "researcher", "reviewer", "general"]);
const WORKER_ROLES = ["general", "implementer", "researcher", "reviewer"] as const;
const normalizeRole = (role: string) => role.toLowerCase();
const objectInput = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RPC input must be an object");
  return value as Record<string, unknown>;
};

function readUnit(value: unknown): WorkUnit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored work-unit record is invalid");
  const unit = value as Partial<WorkUnit>;
  if (typeof unit.workUnitId !== "string" || typeof unit.sourceSessionID !== "string" || typeof unit.role !== "string" ||
      !MODES.includes(unit.tier as Mode) || typeof unit.sessionID !== "string" ||
      !["created", "started", "running", "completed", "failed", "interrupted"].includes(unit.status as string)) {
    throw new Error("Stored work-unit record is invalid");
  }
  if (unit.selectedModel !== undefined) unit.selectedModel = parseModel(unit.selectedModel);
  return unit as WorkUnit;
}

export default {
  id: "model-depth-routing",
  async setup(ctx: Plugin.Context) {
    const locks = new Map<string, Promise<unknown>>();
    const starts = new Map<string, { phase: "creating" | "admitting" | "running"; cancelRequested: boolean; admissionSettled: boolean; sessionID?: string }>();
    const withLock = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => gate);
      locks.set(key, tail);
      await previous;
      try { return await task(); }
      finally { release(); if (locks.get(key) === tail) locks.delete(key); }
    };
    const readPreset = async (tier: Mode) => ctx.storage.get(presetKey(tier));
    const readRole = async (role: string): Promise<RolePolicy | undefined> => {
      const value = await ctx.storage.get(roleKey(normalizeRole(role))) ??
        (role.toLowerCase() === "general" ? await ctx.storage.get(roleKey("General")) : undefined);
      return value === undefined ? undefined : parseRolePolicy(value);
    };
    const syncUnitStatus = (unit: WorkUnit): Promise<WorkUnit> => withLock(`${unitKey(unit.workUnitId)}.status`, async () => {
      // Native subagent work is reconciled only from its exact tool-call lifecycle;
      // its child session is optional and must never be guessed from history.
      if (unit.kind === "native") return unit;
      const start = starts.get(unit.workUnitId);
      if (start && !start.admissionSettled) {
        const visible = { ...unit, status: "started" as const };
        await ctx.storage.set(unitKey(unit.workUnitId), visible);
        return visible;
      }
      const session = await ctx.session.get({ sessionID: unit.sessionID });
      unit.status = session.time.idle === undefined ? "running"
        : session.outcome === "interrupted" ? "interrupted"
          : session.outcome === "succeeded" ? "completed"
            : unit.status === "failed" ? "failed"
              : start ? "failed" : "started";
      await ctx.storage.set(unitKey(unit.workUnitId), unit);
      if (unit.status === "completed" || unit.status === "failed" || unit.status === "interrupted") starts.delete(unit.workUnitId);
      return unit;
    });
    const interruptNativeChild = async (workUnitId: string, childSessionID: string): Promise<WorkUnit> => {
      try {
        await ctx.session.interrupt({ sessionID: childSessionID });
        await ctx.session.wait({ sessionID: childSessionID });
        const child = await ctx.session.get({ sessionID: childSessionID });
        return await withLock(unitKey(workUnitId), async () => {
          const latest = readUnit(await ctx.storage.get(unitKey(workUnitId)));
          if (child.time.idle === undefined) latest.status = "running";
          else if (child.outcome === "interrupted") latest.status = "interrupted";
          else if (child.outcome === "succeeded") latest.status = "completed";
          else latest.status = "failed";
          await ctx.storage.set(unitKey(workUnitId), latest);
          return latest;
        });
      } catch {
        return readUnit(await ctx.storage.get(unitKey(workUnitId)));
      }
    };
    const catalog = async () => (await ctx.model.list()).data;
    const agents = async () => (await ctx.agent.list()).data;
    const resolveRoutingAgent = async (role: string) => {
      const roleID = role.toLowerCase();
      if (!ROUTING_ROLE_IDS.has(roleID)) throw new Error(`Role is not eligible for routed work: ${role}`);
      let listed;
      try {
        listed = (await agents()).find((agent) => agent.id === roleID);
      } catch {
        throw new Error(`Routing agent resolution failed: ${role}`);
      }
      if (!listed) throw new Error(`Routing agent is unavailable: ${role}`);
      let resolved;
      try {
        resolved = await ctx.agent.get({ agentID: listed.id });
      } catch {
        throw new Error(`Routing agent is unavailable: ${role}`);
      }
      const resolvedAgent = resolved?.data;
      if (!resolvedAgent || resolvedAgent.id !== roleID || resolvedAgent.mode !== "subagent" || resolvedAgent.hidden) {
        throw new Error(`Routing agent is unavailable or ineligible: ${role}`);
      }
      return resolvedAgent;
    };
    const readRoles = async (): Promise<Record<string, RolePolicy | null>> => {
      const roles: Record<string, RolePolicy | null> = { director: (await readRole("director")) ?? null };
      for (const role of WORKER_ROLES) roles[role] = (await readRole(role)) ?? null;
      return roles;
    };
    const registration = await ctx.rpc.register(definition, {
      presets: async (input) => {
        const args = objectInput(input);
        if (args.tier !== undefined || args.model !== undefined) {
          const tier = parseTier(args.tier);
          const model = selectModel(tier, args.model, await catalog());
          await withLock(presetKey(tier), () => ctx.storage.set(presetKey(tier), model));
        }
        const preset: Partial<Record<Mode, unknown>> = {};
        for (const tier of MODES) preset[tier] = (await readPreset(tier)) ?? null;
        return {
          presets: preset,
          catalog: (await catalog()).map((model) => ({
            providerID: model.providerID,
            modelID: model.id,
            name: model.name,
            variants: model.variants.map((variant) => variant.id),
          })),
        };
      },
      roles: async (input) => {
        const args = objectInput(input);
        if (args.role !== undefined || args.policy !== undefined) {
          const role = normalizeRole(parseId(args.role, "role"));
          const policy = parseRolePolicy(args.policy);
          if (role === "director") {
            if (policy.strategy !== "Fixed") throw new Error("Director supports Fixed routing only");
          } else {
            if (!ROUTING_ROLE_IDS.has(role)) throw new Error(`Unknown role: ${role}`);
            await resolveRoutingAgent(role);
          }
          const tiers = policy.strategy === "Fixed" ? [policy.tier] : [policy.min, policy.default, policy.max];
          const models = await catalog();
          for (const tier of tiers) selectModel(tier, await readPreset(tier), models);
          await withLock(roleKey(role), () => ctx.storage.set(roleKey(role), policy));
            if (role === "director" && typeof args.sessionID === "string") {
            const directorPolicy = policy as Extract<RolePolicy, { strategy: "Fixed" }>;
            const model = selectModel(directorPolicy.tier, await readPreset(directorPolicy.tier), models);
            const session = await ctx.session.get({ sessionID: args.sessionID });
            const sessionAgentID = session.agent;
            if (sessionAgentID && !session.metadata?.workUnitId) {
              let agent;
              try { agent = (await ctx.agent.get({ agentID: sessionAgentID })).data; } catch { agent = undefined; }
              if (!isAuthorizedDirector(sessionAgentID, agent)) {
                return { roles: await readRoles(), director: directorPolicy, applied: false, reason: "Current session is not an available primary Director session." };
              }
              await ctx.session.switchModel({
                sessionID: args.sessionID,
                model: { id: model.modelID, providerID: model.providerID, variant: model.variant },
              });
              const updated = await ctx.session.get({ sessionID: args.sessionID });
              if (updated.model?.id !== model.modelID || updated.model?.providerID !== model.providerID || updated.model?.variant !== model.variant) {
                throw new Error("Director preset was saved, but the current primary session did not confirm the model change");
              }
              return { roles: await readRoles(), director: directorPolicy, applied: true };
            }
            return { roles: await readRoles(), director: directorPolicy, applied: false, reason: "Saved for Director sessions; current session is not the primary Director." };
          }
        }
        const roles = await readRoles();
        return { roles, director: roles.director };
      },
      routing: async (input, { signal }) => {
        const args = objectInput(input);
        const action = args.action;
        if (action === "list") {
          const scanned = await ctx.storage.scan({ prefix: `${PREFIX}unit.`, limit: 100 });
          const units = await Promise.all(scanned.entries.map((entry) => syncUnitStatus(readUnit(entry.value))));
          return { units, next: scanned.next ?? null };
        }
        const workUnitId = parseId(args.workUnitId, "workUnitId");
        if (action === "status" || action === "cancel") {
          const stored = await ctx.storage.get(unitKey(workUnitId));
          if (stored === undefined) throw new Error(`Unknown work unit: ${workUnitId}`);
          const unit = readUnit(stored);
          if (unit.kind === "native") {
            if (action === "cancel" && !["completed", "failed", "interrupted"].includes(unit.status)) {
              await withLock(unitKey(workUnitId), async () => {
                const latest = readUnit(await ctx.storage.get(unitKey(workUnitId)));
                latest.cancelRequested = true;
                Object.assign(unit, latest);
                await ctx.storage.set(unitKey(workUnitId), latest);
              });
              if (unit.childSessionID) Object.assign(unit, await interruptNativeChild(unit.workUnitId, unit.childSessionID));
            }
            return { workUnitId, sessionID: unit.childSessionID, tier: unit.tier, status: unit.status, kind: "native", childSessionID: unit.childSessionID, cancelRequested: unit.cancelRequested ?? false };
          }
          const start = starts.get(workUnitId);
          if (action === "cancel" && start) {
            const admitted = await withLock(`${unitKey(workUnitId)}.admission`, async () => {
              start.cancelRequested = true;
              return start.phase === "running" && !!start.sessionID;
            });
            if (!admitted) {
              const visible = { ...unit, status: "started" as const };
              await ctx.storage.set(unitKey(workUnitId), visible);
              return { workUnitId, sessionID: unit.sessionID, tier: unit.tier, status: "started" };
            }
            // Prompt admission may still be queued while the session looks idle.
            // Interrupt regardless of idle state; start will interrupt again once
            // the admission promise settles, covering an interrupt-before-admit race.
            void ctx.session.interrupt({ sessionID: unit.sessionID }).catch(() => undefined);
            const visible = { ...unit, status: "started" as const };
            await ctx.storage.set(unitKey(workUnitId), visible);
            return { workUnitId, sessionID: unit.sessionID, tier: unit.tier, status: "started" };
          }
          const session = await ctx.session.get({ sessionID: unit.sessionID });
          if (action === "cancel" && session.time.idle === undefined) {
            await ctx.session.interrupt({ sessionID: unit.sessionID });
            await ctx.session.wait({ sessionID: unit.sessionID });
          }
          const current = await syncUnitStatus(unit);
          return { workUnitId, sessionID: current.sessionID, tier: current.tier, status: current.status };
        }
        return withLock(unitKey(workUnitId), async () => {
          const stored = await ctx.storage.get(unitKey(workUnitId));
          if (action !== "start") throw new Error("Routing action must be start, status, cancel, or list");
          if (stored !== undefined) throw new Error("workUnitId has already been used");
          const sourceSessionID = parseId(args.sourceSessionID, "sourceSessionID");
          const role = parseId(args.role, "role");
          const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
          if (!prompt) throw new Error("prompt must not be empty");
          if (signal.aborted) throw new Error("Routing cancelled before session creation");
          const selectedAgent = await resolveRoutingAgent(role);
          const policy = await readRole(role);
          if (!policy) throw new Error(`Role ${role} is not configured`);
          const requested = args.requestedTier === undefined
            ? (policy.strategy === "Fixed" ? policy.tier : policy.default)
            : parseTier(args.requestedTier);
          if (policy.strategy === "Fixed" && requested !== policy.tier) throw new Error("Fixed role tier cannot be overridden");
          const tier = clampMode(requested, policy);
          if (policy.strategy === "Auto" && MODES.indexOf(requested) > MODES.indexOf(policy.default) &&
              (args.escalationReason !== "task-complexity" || typeof args.complexityEvidence !== "string" || !args.complexityEvidence.trim())) {
            throw new Error("Escalation above default requires task-complexity evidence; operational failures never escalate");
          }
          const selected = selectModel(tier, await readPreset(tier), await catalog());
          const parent = await ctx.session.get({ sessionID: sourceSessionID });
          if (!parent.location?.directory) throw new Error("Source session has no usable directory");
          const requestHashBytes = new TextEncoder().encode(JSON.stringify([
            workUnitId,
            sourceSessionID,
            role,
            selectedAgent.id,
            tier,
            selected.providerID,
            selected.modelID,
            selected.variant ?? null,
            prompt,
          ]));
          const requestHashBuffer = await globalThis.crypto.subtle.digest("SHA-256", requestHashBytes);
          const requestHash = Array.from(new Uint8Array(requestHashBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
          const metadata = { workUnitId, sourceSessionID, role, agentID: selectedAgent.id, tier, requestHash };
          const sessionID = await sessionIdForWorkUnit(workUnitId);
          const messageID = await messageIdForWorkUnit(workUnitId);
          let childSessionID: string | undefined;
          let interruptPromise: Promise<unknown> | undefined;
          let abortRequested = false;
          let identityMismatch = false;
          const startState: { phase: "creating" | "admitting" | "running"; cancelRequested: boolean; admissionSettled: boolean; sessionID?: string } = {
            phase: "creating", cancelRequested: false, admissionSettled: false,
          };
          starts.set(workUnitId, startState);
          const cancel = () => {
            abortRequested = true;
            startState.cancelRequested = true;
            if (childSessionID && !interruptPromise) {
              interruptPromise = ctx.session.interrupt({ sessionID: childSessionID });
              void interruptPromise.catch(() => undefined);
            }
          };
          signal.addEventListener("abort", cancel, { once: true });
          const unit: WorkUnit = { workUnitId, kind: "manual", sourceSessionID, role, tier, sessionID, selectedModel: selected, status: "started" };
          try {
            await ctx.storage.set(unitKey(workUnitId), unit);
            if (signal.aborted) cancel();
            if (abortRequested || startState.cancelRequested) {
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
              return { workUnitId, sessionID, tier, status: unit.status };
            }
            const created = await ctx.session.create({
              id: sessionID,
              title: `Delegated ${role} · ${workUnitId}`,
              agent: selectedAgent.id,
              model: { id: selected.modelID, providerID: selected.providerID, variant: selected.variant },
              location: { directory: parent.location.directory },
              metadata,
            });
            if (created.id !== sessionID || created.metadata?.requestHash !== requestHash || created.metadata?.workUnitId !== workUnitId || created.metadata?.agentID !== selectedAgent.id) {
              throw new Error("Work-unit ID is already associated with a different session request");
            }
            childSessionID = created.id;
            startState.sessionID = created.id;
            const actualSession = await ctx.session.get({ sessionID: created.id });
              if (actualSession.agent !== selectedAgent.id || actualSession.model?.id !== selected.modelID ||
                actualSession.model?.providerID !== selected.providerID || (actualSession.model?.variant ?? undefined) !== (selected.variant ?? undefined)) {
              identityMismatch = true;
              unit.status = "failed";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
              throw new Error("Routed session agent or model/provider mismatch");
            }
            if (signal.aborted) cancel();
            if (abortRequested || startState.cancelRequested) {
              if (!interruptPromise) interruptPromise = ctx.session.interrupt({ sessionID: created.id });
              await interruptPromise;
              await ctx.session.wait({ sessionID: created.id }).catch(() => undefined);
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
              return { workUnitId, sessionID: created.id, tier, status: unit.status };
            }
            // Publish startup before prompt admission; management can set cancelRequested
            // without acquiring the start lock, and status does not infer failure from idle.
            startState.phase = "admitting";
            await ctx.storage.set(unitKey(workUnitId), unit);
            if (abortRequested || signal.aborted || startState.cancelRequested) {
              if (!interruptPromise) interruptPromise = ctx.session.interrupt({ sessionID: created.id });
              await interruptPromise;
              await ctx.session.wait({ sessionID: created.id }).catch(() => undefined);
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
              return { workUnitId, sessionID: created.id, tier, status: unit.status };
            }
            unit.status = "running";
            await ctx.storage.set(unitKey(workUnitId), unit);
            if (abortRequested || signal.aborted || startState.cancelRequested) {
              if (!interruptPromise) interruptPromise = ctx.session.interrupt({ sessionID: created.id });
              await interruptPromise;
              await ctx.session.wait({ sessionID: created.id }).catch(() => undefined);
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
              return { workUnitId, sessionID: created.id, tier, status: unit.status };
            }
            // The stable Session ID arbitrates concurrent creation through OpenCode's
            // session projector; the stable message ID makes Session.prompt admission idempotent.
            let promptTask: Promise<unknown> | undefined;
            const admitted = await withLock(`${unitKey(workUnitId)}.admission`, async () => {
              if (abortRequested || signal.aborted || startState.cancelRequested) return false;
              // Keep the state transition and prompt admission in one short critical
              // section. Management cancellation either prevents this call or observes
              // an admitted prompt and interrupts it after releasing the lock.
              startState.phase = "running";
              promptTask = ctx.session.prompt({
                sessionID: created.id,
                id: messageID,
                text: prompt,
                metadata: { workUnitId, agentID: selectedAgent.id },
              });
              return true;
            });
            if (!admitted || !promptTask) {
              if (!interruptPromise) interruptPromise = ctx.session.interrupt({ sessionID: created.id });
              await interruptPromise;
              await ctx.session.wait({ sessionID: created.id }).catch(() => undefined);
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
              return { workUnitId, sessionID: created.id, tier, status: unit.status };
            }
            void promptTask.then(async () => {
              startState.admissionSettled = true;
              if (startState.cancelRequested) {
                // A prior interrupt can precede the queued prompt admission. Repeat
                // it after the prompt promise settles before publishing cancellation.
                interruptPromise = ctx.session.interrupt({ sessionID: created.id });
                await interruptPromise;
                await ctx.session.wait({ sessionID: created.id }).catch(() => undefined);
                unit.status = "interrupted";
                await ctx.storage.set(unitKey(workUnitId), unit);
                starts.delete(workUnitId);
              } else {
                await syncUnitStatus(unit);
              }
            }).catch(async () => {
              try {
                startState.admissionSettled = true;
                if (startState.cancelRequested) {
                  interruptPromise = ctx.session.interrupt({ sessionID: created.id });
                  await interruptPromise;
                  await ctx.session.wait({ sessionID: created.id }).catch(() => undefined);
                  unit.status = "interrupted";
                  await ctx.storage.set(unitKey(workUnitId), unit);
                  starts.delete(workUnitId);
                } else {
                  // A rejected prompt request is an admission failure even if the
                  // session is idle without an outcome. Persist that fact instead
                  // of inferring status from the session's incomplete state.
                  unit.status = "failed";
                  await ctx.storage.set(unitKey(workUnitId), unit);
                  starts.delete(workUnitId);
                }
              } catch {
                unit.status = "failed";
                await ctx.storage.set(unitKey(workUnitId), unit);
              }
            });
            if (signal.aborted) {
              cancel();
              if (interruptPromise) await interruptPromise;
              await ctx.session.wait({ sessionID: created.id });
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
            }
            return { workUnitId, sessionID: created.id, tier, selectedModel: selected, status: unit.status };
          } catch (error) {
            if (childSessionID && signal.aborted) {
              cancel();
              await interruptPromise?.catch(() => undefined);
              await ctx.session.wait({ sessionID: childSessionID }).catch(() => undefined);
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
            } else if (!childSessionID && (signal.aborted || startState.cancelRequested)) {
              unit.status = "interrupted";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
            } else if (!childSessionID) {
              unit.status = "failed";
              await ctx.storage.set(unitKey(workUnitId), unit);
              starts.delete(workUnitId);
            } else if (childSessionID && !identityMismatch && unit.status !== "interrupted") {
              const current = await ctx.session.get({ sessionID: childSessionID });
              unit.status = current.time.idle === undefined ? "running"
                : current.outcome === "succeeded" ? "completed"
                  : current.outcome === "interrupted" ? "interrupted" : "failed";
              await ctx.storage.set(unitKey(workUnitId), unit);
              if (unit.status === "completed" || unit.status === "failed" || unit.status === "interrupted") starts.delete(workUnitId);
            }
            throw error;
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        });
      },
    });
    const nativeWorkUnitID = async (parentSessionID: string, toolCallID: string) => {
      const input = new TextEncoder().encode(JSON.stringify([parentSessionID, toolCallID]));
      const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
      const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `native_${hex}`;
    };
    const readNativeByCall = async (parentSessionID: string, toolCallID: string) => {
      const id = await nativeWorkUnitID(parentSessionID, toolCallID);
      const value = await ctx.storage.get(unitKey(id));
      if (value === undefined) return undefined;
      const unit = readUnit(value);
      return unit.kind === "native" && unit.parentSessionID === parentSessionID && unit.toolCallID === toolCallID ? unit : undefined;
    };
    const bindNativeChild = async (unit: WorkUnit, childSessionID: string) => {
      await withLock(unitKey(unit.workUnitId), async () => {
        const stored = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
        if (stored.childSessionID && stored.childSessionID !== childSessionID) {
          stored.status = "failed";
          await ctx.storage.set(unitKey(stored.workUnitId), stored);
          return;
        }
        stored.childSessionID = childSessionID;
        stored.sessionID = childSessionID;
        await ctx.storage.set(unitKey(stored.workUnitId), stored);
      });
      const linked = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
      let child: Awaited<ReturnType<typeof ctx.session.get>> | undefined;
      try { child = await ctx.session.get({ sessionID: childSessionID }); } catch { child = undefined; }
      if (!child || child.parentID !== linked.parentSessionID || child.agent !== linked.role ||
          child.model?.providerID !== linked.selectedModel?.providerID || child.model?.id !== linked.selectedModel?.modelID ||
          (child.model?.variant ?? undefined) !== (linked.selectedModel?.variant ?? undefined)) {
        await withLock(unitKey(unit.workUnitId), async () => {
          const latest = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
          latest.status = "failed";
          await ctx.storage.set(unitKey(latest.workUnitId), latest);
        });
        void ctx.session.interrupt({ sessionID: childSessionID }).catch(() => undefined);
        return;
      }
      const current = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
      if (current.cancelRequested) {
        await interruptNativeChild(current.workUnitId, childSessionID);
      } else if (child.time.idle === undefined) {
        await withLock(unitKey(unit.workUnitId), async () => {
          const latest = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
          if (latest.status === "started") latest.status = "running";
          await ctx.storage.set(unitKey(latest.workUnitId), latest);
        });
      } else {
        await withLock(unitKey(unit.workUnitId), async () => {
          const latest = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
          latest.status = child.outcome === "succeeded" ? "completed" : child.outcome === "interrupted" ? "interrupted" : "failed";
          await ctx.storage.set(unitKey(latest.workUnitId), latest);
        });
      }
    };
    const beforeRegistration = await ctx.tool.hook("execute.before", async (hook) => {
      if (hook.tool !== "subagent") return;
      let director;
      try { director = (await ctx.agent.get({ agentID: hook.agent })).data; } catch { throw new Error("Native routing requires the configured Director primary"); }
      if (!isAuthorizedDirector(hook.agent, director)) throw new Error("Native routing requires the configured Director primary");
      const input = hook.input as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid subagent input");
      const role = input.agent;
      if (typeof role !== "string" || !WORKER_ROLES.includes(role as typeof WORKER_ROLES[number])) throw new Error("Subagent role is not eligible for routed work");
      await resolveRoutingAgent(role);
      const policy = await readRole(role);
      if (!policy) throw new Error(`Role ${role} is not configured`);
      let requested: Mode;
      if (policy.strategy === "Fixed") requested = policy.tier;
      else if (input.model === undefined) requested = policy.default;
      else {
        const hints: Record<string, Mode> = { "routing/light": "Light", "routing/standard": "Standard", "routing/deep": "Deep" };
        if (typeof input.model !== "string" || !Object.hasOwn(hints, input.model)) throw new Error("Auto routing accepts only routing/light, routing/standard, or routing/deep hints");
        requested = hints[input.model];
      }
      const tier = clampMode(requested, policy);
      const selected = selectModel(tier, await readPreset(tier), await catalog());
       const workUnitId = await nativeWorkUnitID(hook.sessionID, hook.id);
      const unit: WorkUnit = {
        workUnitId, kind: "native", sourceSessionID: hook.sessionID, parentSessionID: hook.sessionID,
        toolCallID: hook.id, role, tier, sessionID: "", selectedModel: selected, status: "started",
      };
      await withLock(unitKey(workUnitId), async () => {
        const existing = await ctx.storage.get(unitKey(workUnitId));
        if (existing !== undefined) throw new Error("Native tool-call ID is already recorded");
        await ctx.storage.set(unitKey(workUnitId), unit);
      });
       input.model = `${selected.providerID}/${selected.modelID}${selected.variant ? `#${selected.variant}` : ""}`;
    });
    const afterRegistration = await ctx.tool.hook("execute.after", async (hook) => {
      if (hook.tool !== "subagent") return;
      const unit = await readNativeByCall(hook.sessionID, hook.id);
      if (!unit) return;
      const result = hook.status === "completed" ? hook.result : undefined;
      const childSessionID = result?.metadata?.sessionID;
      if (typeof childSessionID === "string") await bindNativeChild(unit, childSessionID);
      let child: Awaited<ReturnType<typeof ctx.session.get>> | undefined;
      const latest = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
      if (latest.childSessionID) {
        try { child = await ctx.session.get({ sessionID: latest.childSessionID }); } catch { child = undefined; }
      }
      await withLock(unitKey(unit.workUnitId), async () => {
        const stored = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
        if (!child || child.parentID !== stored.parentSessionID || child.agent !== stored.role ||
            child.model?.providerID !== stored.selectedModel?.providerID || child.model?.id !== stored.selectedModel?.modelID ||
            (child.model?.variant ?? undefined) !== (stored.selectedModel?.variant ?? undefined)) stored.status = "failed";
        else if (child.time.idle === undefined) stored.status = "running";
        else if (child.outcome === "interrupted") stored.status = "interrupted";
        else if (child.outcome === "succeeded" && hook.status === "completed") stored.status = "completed";
        else stored.status = "failed";
        await ctx.storage.set(unitKey(stored.workUnitId), stored);
      });
    });
    let eventStopped = false;
    const eventAbort = new AbortController();
    const eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
          if (eventStopped) break;
          const item = event as any;
          if (!item || !["session.tool.progress", "session.tool.success", "session.tool.failure"].includes(item.type)) continue;
          const data = item.data;
          const parentSessionID = data?.sessionID;
          const toolCallID = data?.id;
          if (typeof parentSessionID !== "string" || typeof toolCallID !== "string") continue;
          const unit = await readNativeByCall(parentSessionID, toolCallID);
          if (!unit) continue;
          const childID = data?.metadata?.sessionID;
          if (typeof childID !== "string") continue;
          await bindNativeChild(unit, childID);
          if (item.type === "session.tool.failure") {
            const latest = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
            if (latest.childSessionID && latest.cancelRequested) await interruptNativeChild(latest.workUnitId, latest.childSessionID);
            else await withLock(unitKey(unit.workUnitId), async () => {
              const stored = readUnit(await ctx.storage.get(unitKey(unit.workUnitId)));
              stored.status = "failed";
              await ctx.storage.set(unitKey(stored.workUnitId), stored);
            });
          }
        }
      } catch { /* Subscription loss does not invent a child or alter manual units. */ }
    })();
    const toolRegistration = await ctx.tool.transform((tools) => {
      // Preserve no model-callable wrapper during the native migration.
      tools.remove("route_work_unit");
    });
    return async () => {
      eventStopped = true;
      eventAbort.abort();
      await beforeRegistration.dispose();
      await afterRegistration.dispose();
      await toolRegistration.dispose();
      await registration.dispose();
      await eventTask;
    };
  },
};
