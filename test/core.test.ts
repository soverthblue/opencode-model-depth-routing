import assert from "node:assert/strict";
import { test } from "node:test";
import { clampMode, parseId, parseModel, parseRolePolicy, selectModel } from "../core.js";
import { DIRECTOR_AUTH_MARKER, isAuthorizedDirector } from "../core.js";

const catalog = [{ id: "m", providerID: "p", variants: [{ id: "reasoning" }] }];

test("validates model identity and catalog variants as arrays of ids", () => {
  assert.deepEqual(selectModel("Deep", { providerID: "p", modelID: "m", variant: "reasoning" }, catalog), { providerID: "p", modelID: "m", variant: "reasoning" });
  assert.throws(() => selectModel("Deep", { providerID: "p", modelID: "m", variant: "missing" }, catalog), /variant/);
  assert.throws(() => selectModel("Deep", { providerID: "wrong", modelID: "m" }, catalog), /catalog/);
  assert.throws(() => parseModel({ providerID: "p", modelID: "m", surprise: true }), /optional non-empty/);
});

test("validates Fixed and ordered Auto policies and clamps safely", () => {
  assert.deepEqual(parseRolePolicy({ strategy: "Fixed", tier: "Standard" }), { strategy: "Fixed", tier: "Standard" });
  const auto = parseRolePolicy({ strategy: "Auto", min: "Light", default: "Standard", max: "Deep" });
  assert.equal(clampMode("Deep", auto), "Deep");
  assert.throws(() => parseRolePolicy({ strategy: "Auto", min: "Deep", default: "Light", max: "Deep" }), /min <= default/);
  assert.throws(() => parseRolePolicy({ strategy: "Fixed", tier: "Standard", unexpected: true }), /Policy/);
  assert.throws(() => parseId("bad id", "id"), /ASCII/);
});

test("tool identity predicate accepts configured Director only", () => {
  const director = { id: "director", mode: "primary", hidden: false, system: `instructions\n${DIRECTOR_AUTH_MARKER}` };
  assert.equal(isAuthorizedDirector("director", director), true);
  assert.equal(isAuthorizedDirector("build", { id: "build", mode: "primary", hidden: false, system: null }), false);
  assert.equal(isAuthorizedDirector("implementer", { id: "implementer", mode: "subagent", hidden: false, system: DIRECTOR_AUTH_MARKER }), false);
  assert.equal(isAuthorizedDirector("director", { ...director, system: null }), false);
});
