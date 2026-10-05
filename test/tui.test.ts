import assert from "node:assert/strict";
import { test } from "node:test";
import tuiPlugin from "../tui.js";

test("/routing opens a read-only overview of persisted routing state", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const alerts: Array<{ title: string; message: string }> = [];
  const persisted = {
    presets: {
      Light: { providerID: "provider-a", modelID: "luna", variant: "low" },
      Standard: { providerID: "provider-a", modelID: "luna", variant: "high" },
      Deep: { providerID: "provider-b", modelID: "sol", variant: "high" },
    },
    roles: {
      director: { strategy: "Fixed", tier: "Standard" },
      general: { strategy: "Auto", min: "Light", default: "Standard", max: "Deep" },
      implementer: { strategy: "Auto", min: "Light", default: "Standard", max: "Deep" },
      researcher: { strategy: "Fixed", tier: "Standard" },
      reviewer: null,
    },
  };
  const persistedBeforeOverview = structuredClone(persisted);
  let slotClaim: any;
  let routingMenu: any;
  const context: any = {
    client: {
      rpc: () => ({
        presets: async (input?: Record<string, unknown>) => {
          calls.push(["presets", input]);
          return {
            presets: persisted.presets,
            catalog: [
              { providerID: "provider-a", modelID: "luna", name: "GPT-6 Luna", variants: ["low", "high"] },
              { providerID: "provider-b", modelID: "sol", name: "GPT-6 Sol", variants: ["high"] },
            ],
          };
        },
        roles: async (input?: Record<string, unknown>) => {
          calls.push(["roles", input]);
          return { roles: persisted.roles };
        },
      }),
    },
    ui: {
      slot: (claim: any) => { slotClaim = claim; return () => undefined; },
      router: { current: () => ({ type: "session", sessionID: "primary" }) },
      dialog: {
        select: async (input: any) => {
          if (input.title === "Routing") {
            routingMenu = input.options;
            return "overview";
          }
          return undefined;
        },
        alert: async (input: any) => { alerts.push(input); },
      },
      toast: { show: async () => undefined },
      tabs: { enabled: () => false, focus: () => false },
    },
    keymap: { layer: (resolve: () => any) => { context.commands = resolve().commands; return () => undefined; } },
  };

  tuiPlugin.setup(context);
  slotClaim.render({});
  const routing = context.commands.find((command: any) => command.id === "model-depth-routing.routing");
  await routing.run();

  assert.deepEqual(routingMenu.map((option: any) => option.value), ["overview", "start", "manage"]);
  assert.equal(alerts.length, 1);
  const overview = alerts[0].message;
  const overviewLines = overview.split("\n");
  assert.doesNotMatch(overview, /Auto: min → default → max =/);
  const columnHeader = "  Role         Strategy  Min → Default → Max";
  const columnHeaderIndex = overviewLines.indexOf(columnHeader);
  assert.notEqual(columnHeaderIndex, -1);
  const firstRoleRow = overviewLines.findIndex((line) => /^\s+director\s/.test(line));
  assert.equal(firstRoleRow, columnHeaderIndex + 1);
  assert.match(overview, /Light\s+GPT-6 Luna \(provider-a\) \/ low/);
  assert.match(overview, /Standard\s+GPT-6 Luna \(provider-a\) \/ high/);
  assert.match(overview, /Deep\s+GPT-6 Sol \(provider-b\) \/ high/);
  assert.match(overview, /director\s+Fixed\s+Standard/);
  assert.match(overview, /general\s+Auto\s+Light → Standard → Deep/);
  assert.match(overview, /implementer\s+Auto\s+Light → Standard → Deep/);
  assert.match(overview, /researcher\s+Fixed\s+Standard/);
  assert.match(overview, /reviewer\s+Not configured/);
  assert.match(overview, /Workers\s+general, implementer, researcher, reviewer/);
  assert.match(overview, /Fallback\s+Disabled/);
  assert.match(overview, /Failure\s+Fail closed/);
  assert.doesNotMatch(overview, /build|plan|explore|compaction|title|summary/i);
  assert.deepEqual(calls, [["presets", {}], ["roles", {}]]);
  assert.deepEqual(persisted, persistedBeforeOverview);
});
