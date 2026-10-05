import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../index.js";

test("RPC routes work to a configured worker and does not expose the retired tool", async () => {
  const stored = new Map<string, unknown>([
    ["model-depth-routing.v1.preset.Standard", { providerID: "p", modelID: "m" }],
    ["model-depth-routing.v1.role.implementer", { strategy: "Fixed", tier: "Standard" }],
  ]);
  const sessions = new Map<string, any>();
  const tools = new Set<string>();
  let handlers: any;
  let beforeHook: ((hook: any) => Promise<void>) | undefined;

  const context: any = {
    storage: {
      get: async (key: string) => stored.get(key),
      set: async (key: string, value: unknown) => { stored.set(key, value); },
      remove: async (key: string) => { stored.delete(key); },
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...stored].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    rpc: { register: async (_definition: unknown, registered: unknown) => { handlers = registered; return { dispose: async () => undefined }; } },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
    model: { list: async () => ({ data: [{ providerID: "p", id: "m", variants: [] }] }) },
    agent: {
      list: async () => ({ data: [{ id: "implementer" }] }),
      get: async ({ agentID }: { agentID: string }) => ({ data: { id: agentID, mode: "subagent", hidden: false } }),
    },
    tool: {
      hook: async (name: string, callback: (hook: any) => Promise<void>) => {
        if (name === "execute.before") beforeHook = callback;
        return { dispose: async () => undefined };
      },
      transform: async (callback: (tools: any) => void) => {
        callback({ add: ({ name }: { name: string }) => tools.add(name), remove: (name: string) => tools.delete(name) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID) ?? {
        id: sessionID, location: { directory: "/project" }, time: { idle: Date.now() },
      },
      create: async (input: any) => {
        const session = { ...input, agent: input.agent, model: input.model, time: { idle: Date.now() } };
        sessions.set(input.id, session);
        return session;
      },
      prompt: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID);
        session.time.idle = Date.now();
        session.outcome = "succeeded";
      },
      interrupt: async () => undefined,
      wait: async () => undefined,
    },
  };

  const dispose = await plugin.setup(context);
  try {
    const started = await handlers.routing({
      action: "start", workUnitId: "unit-1", sourceSessionID: "parent", role: "implementer", prompt: "check the route",
    }, { signal: new AbortController().signal });
    assert.equal(started.tier, "Standard");
    assert.equal(sessions.get(started.sessionID).agent, "implementer");
    assert.ok(beforeHook);
    assert.equal(tools.has("route_work_unit"), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const status = await handlers.routing({ action: "status", workUnitId: "unit-1" }, { signal: new AbortController().signal });
    assert.equal(status.status, "completed");
  } finally {
    await dispose();
  }
});
