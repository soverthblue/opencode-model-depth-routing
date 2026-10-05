import type { Context, Definition } from "@opencode/plugin/tui/plugin";
import { definition as rpcDefinition } from "./rpc.js";

const TIERS = ["Light", "Standard", "Deep"] as const;
const ROLE_NAMES = ["director", "general", "implementer", "researcher", "reviewer"] as const;
type Tier = (typeof TIERS)[number];
type RolePolicy =
  | { strategy: "Fixed"; tier: Tier }
  | { strategy: "Auto"; min: Tier; default: Tier; max: Tier };
const definition: Definition = {
  id: "model-depth-routing",
  setup(context: Context) {
    const rpc = context.client.rpc(rpcDefinition);
    const call = async (method: "presets" | "roles" | "routing", input: Record<string, unknown> = {}) =>
      (rpc[method] as (input?: Record<string, unknown>) => Promise<unknown>)(input) as Promise<any>;

    const chooseTier = (tiers: readonly Tier[], title: string, current?: Tier) => context.ui.dialog.select<Tier>({
      title,
      current,
      options: tiers.map((tier) => ({ title: tier, value: tier })),
    });

    const chooseRole = async (includeDirector = true) => {
      return context.ui.dialog.select({
        title: "Role",
        options: ROLE_NAMES.filter((role) => includeDirector || role !== "director").map((role) => ({ title: role, value: role })),
      });
    };

    const setPreset = async () => {
      const catalog = await call("presets");
      const models = catalog.catalog as Array<{ providerID: string; modelID: string; variants: string[] }>;
      if (!models.length) {
        await context.ui.dialog.alert({ title: "Presets", message: "No models are available in the current server catalog." });
        return;
      }
      const tier = await chooseTier(TIERS, "Configure tier preset");
      if (!tier) return;
      const model = await context.ui.dialog.select({
        title: `${tier} model`,
        placeholder: "Choose a model from the current server catalog",
        options: models.map((entry) => ({ title: `${entry.providerID}/${entry.modelID}`, value: entry })),
      });
      if (!model) return;
      let variant: string | undefined;
      if (model.variants.length) {
        const selected = await context.ui.dialog.select<string | null>({
          title: "Model variant",
          options: [{ title: "Provider default", value: null }, ...model.variants.map((id) => ({ title: id, value: id }))],
        });
        if (selected === undefined) return;
        variant = selected ?? undefined;
      }
      await call("presets", { tier, model: { providerID: model.providerID, modelID: model.modelID, ...(variant ? { variant } : {}) } });
      await context.ui.toast.show({ message: `${tier} preset saved`, variant: "success" });
    };

    const configureRole = async () => {
      const role = await chooseRole();
      if (!role) return;
      if (role === "director") {
        const tier = await chooseTier(TIERS, "Director fixed tier");
        if (!tier) return;
        const current = context.ui.router.current();
        const result = await call("roles", {
          role,
          policy: { strategy: "Fixed", tier },
          ...(current.type === "session" ? { sessionID: current.sessionID } : {}),
        });
        await context.ui.toast.show({
          message: result.applied ? `Director fixed tier saved and applied: ${tier}` : `Director fixed tier saved: ${tier}${result.reason ? ` · ${result.reason}` : " · open a Director session to apply"}`,
          variant: result.applied ? "success" : "info",
        });
        return;
      }
      const strategy = await context.ui.dialog.select<"Fixed" | "Auto">({
        title: `${role} routing policy`,
        options: [{ title: "Fixed tier", value: "Fixed" }, { title: "Auto within bounds", value: "Auto" }],
      });
      if (!strategy) return;
      if (strategy === "Fixed") {
        const tier = await chooseTier(TIERS, "Fixed tier");
        if (!tier) return;
        await call("roles", { role, policy: { strategy, tier } });
      } else {
        const min = await chooseTier(TIERS, "Minimum tier");
        if (!min) return;
        const defaults = TIERS.slice(TIERS.indexOf(min));
        const defaultTier = await chooseTier(defaults, "Default tier");
        if (!defaultTier) return;
        const maxima = TIERS.slice(TIERS.indexOf(defaultTier));
        const max = await chooseTier(maxima, "Maximum tier");
        if (!max) return;
        await call("roles", { role, policy: { strategy, min, default: defaultTier, max } });
      }
      await context.ui.toast.show({ message: `${role} routing policy saved`, variant: "success" });
    };

    const startWork = async () => {
      const current = context.ui.router.current();
      if (current.type !== "session") {
        await context.ui.dialog.alert({ title: "Routing", message: "Open a session before starting a routed work unit." });
        return;
      }
      const role = await chooseRole(false);
      if (!role) return;
      const roleState = await call("roles");
      const policy = roleState.roles?.[role] as RolePolicy | null | undefined;
      if (!policy) {
        await context.ui.dialog.alert({ title: "Routing", message: `Configure ${role} with /roles first.` });
        return;
      }
      let requestedTier: Tier;
      let escalationEvidence: string | undefined;
      if (policy.strategy === "Fixed") {
        requestedTier = policy.tier;
      } else {
        const choices = TIERS.slice(TIERS.indexOf(policy.min), TIERS.indexOf(policy.max) + 1);
        const selected = await chooseTier(choices, `${role} tier · default ${policy.default}`, policy.default);
        if (!selected) return;
        requestedTier = selected;
        if (TIERS.indexOf(selected) > TIERS.indexOf(policy.default)) {
          escalationEvidence = await context.ui.dialog.prompt({
            title: "Why is a higher tier needed?",
            description: "Describe task complexity that requires escalation. Tool, authentication, or provider failures are not escalation reasons.",
            placeholder: "Concrete task-capability evidence",
          });
          if (!escalationEvidence?.trim()) return;
        }
      }
      const prompt = await context.ui.dialog.prompt({ title: "Delegated task", description: "Describe the independent work unit." });
      if (!prompt?.trim()) return;
      const confirmed = await context.ui.dialog.confirm({ title: "Start routed work", message: `Create an isolated ${role} session at ${requestedTier}?` });
      if (!confirmed) return;
      const workUnitId = `${current.sessionID}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const result = await call("routing", {
        action: "start",
        workUnitId,
        sourceSessionID: current.sessionID,
        role,
        requestedTier,
        ...(escalationEvidence ? { escalationReason: "task-complexity", complexityEvidence: escalationEvidence } : {}),
        prompt: prompt.trim(),
      });
      if (context.ui.tabs.enabled()) context.ui.tabs.focus(result.sessionID);
      await context.ui.toast.show({ message: `Work unit started in ${result.sessionID} (${result.tier})`, variant: "success" });
    };

    const manageWork = async () => {
      const result = await call("routing", { action: "list" });
      const units = result.units as Array<{ workUnitId: string; kind?: "manual" | "native"; sessionID: string; childSessionID?: string; role: string; tier: Tier; status: string }>;
      if (!units.length) {
        await context.ui.dialog.alert({ title: "Routing", message: "No routed work units are recorded." });
        return;
      }
      const selected = await context.ui.dialog.select({
        title: "Routed work units",
        options: units.map((unit) => ({ title: `${unit.kind === "native" ? "Native" : "Manual"} · ${unit.role} · ${unit.tier} · ${unit.status}`, description: `${unit.workUnitId}${unit.childSessionID ? ` · ${unit.childSessionID}` : " · child pending"}`, value: unit.workUnitId })),
      });
      if (!selected) return;
      const action = await context.ui.dialog.select<"status" | "cancel">({
        title: "Work unit action",
        options: [{ title: "Check status", value: "status" }, { title: "Cancel running work", value: "cancel" }],
      });
      if (!action) return;
      if (action === "cancel") {
        const confirmed = await context.ui.dialog.confirm({ title: "Cancel work unit?", message: `Interrupt ${selected}?` });
        if (!confirmed) return;
      }
      const state = await call("routing", { action, workUnitId: selected });
      const focusID = state.kind === "native" ? state.childSessionID : state.sessionID;
      if (action === "status" && focusID && context.ui.tabs.enabled()) context.ui.tabs.focus(focusID);
      await context.ui.toast.show({ message: `${selected}: ${state.status}${state.childSessionID ? ` · ${state.childSessionID}` : ""}`, variant: action === "cancel" ? "warning" : "info" });
    };

    const showOverview = async () => {
      const [presetState, roleState] = await Promise.all([call("presets"), call("roles")]);
      const models = presetState.catalog as Array<{ providerID: string; modelID: string; name: string; variants: string[] }>;
      const presets = presetState.presets as Record<Tier, { providerID: string; modelID: string; variant?: string } | null>;
      const modelText = (tier: Tier) => {
        const preset = presets[tier];
        if (!preset) return "Not configured";
        const catalogModel = models.find((item) => item.providerID === preset.providerID && item.modelID === preset.modelID);
        if (!catalogModel || (preset.variant && !catalogModel.variants.includes(preset.variant))) {
          return `Unavailable · ${preset.providerID}/${preset.modelID}${preset.variant ? ` / ${preset.variant}` : ""}`;
        }
        return `${catalogModel.name} (${catalogModel.providerID})${preset.variant ? ` / ${preset.variant}` : ""}`;
      };
      const roles = roleState.roles as Record<string, RolePolicy | null>;
      const roleLines = ROLE_NAMES.map((role) => {
        const policy = roles[role];
        const value = !policy ? "Not configured"
          : policy.strategy === "Fixed" ? `Fixed  ${policy.tier}`
            : `Auto   ${policy.min} → ${policy.default} → ${policy.max}`;
        return `  ${role.padEnd(12)}${value}`;
      });
      const message = [
        "Presets",
        ...TIERS.map((tier) => `  ${tier.padEnd(10)}${modelText(tier)}`),
        "",
        "Roles",
        "  Role         Strategy  Min → Default → Max",
        ...roleLines,
        "",
        "Policy",
        "  Workers    general, implementer, researcher, reviewer",
        "  Fallback   Disabled",
        "  Failure    Fail closed",
      ].join("\n");
      await context.ui.dialog.alert({ title: "Model-depth routing overview", message });
    };

    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            { id: "model-depth-routing.presets", title: "Configure model-depth presets", description: "Choose exact catalog models and variants", palette: true, slash: { name: "presets" }, run: () => setPreset() },
            { id: "model-depth-routing.roles", title: "Configure model-depth roles", description: "Set Fixed or bounded Auto routing", palette: true, slash: { name: "roles" }, run: () => configureRole() },
            { id: "model-depth-routing.routing", title: "Routing overview and work units", description: "Review presets and roles, or manage isolated work units", palette: true, slash: { name: "routing" }, run: async () => {
              const action = await context.ui.dialog.select<"overview" | "start" | "manage">({
                title: "Routing",
                options: [
                  { title: "Overview", value: "overview" },
                  { title: "Start work unit", value: "start" },
                  { title: "Work units / history · Status / Cancel", value: "manage" },
                ],
              });
              if (action === "overview") await showOverview();
              if (action === "start") await startWork();
              if (action === "manage") await manageWork();
            } },
          ],
        }));
        return null;
      },
    });
  },
};

export default definition;
