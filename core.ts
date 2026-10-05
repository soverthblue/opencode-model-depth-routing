export const MODES = ["Light", "Standard", "Deep"] as const;
export type Mode = (typeof MODES)[number];
export type ModelRef = { providerID: string; modelID: string; variant?: string };
export type Preset = ModelRef;
export type RolePolicy = { strategy: "Fixed"; tier: Mode } |
  { strategy: "Auto"; min: Mode; default: Mode; max: Mode };
export type WorkUnit = { workUnitId: string; kind?: "manual" | "native"; sourceSessionID: string; parentSessionID?: string; toolCallID?: string; childSessionID?: string; role: string; tier: Mode; sessionID: string; selectedModel?: ModelRef; cancelRequested?: boolean; status: "created" | "started" | "running" | "completed" | "failed" | "interrupted" };

export const DIRECTOR_AUTH_MARKER = "DIRECTOR_ROUTED_DELEGATION_AUTHORITY: model-depth-routing.v1";

export function isAuthorizedDirector(agentID: unknown, agent: { id?: unknown; mode?: unknown; hidden?: unknown; system?: unknown } | null | undefined): boolean {
  return agentID === "director" && agent?.id === "director" && agent.mode === "primary" && agent.hidden === false &&
    typeof agent.system === "string" && agent.system.includes(DIRECTOR_AUTH_MARKER);
}

const index = (mode: unknown) => MODES.indexOf(mode as Mode);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseModel(value: unknown): ModelRef {
  if (!record(value) || Object.keys(value).some((key) => !["providerID", "modelID", "variant"].includes(key)) || typeof value.providerID !== "string" || !value.providerID.trim() || typeof value.modelID !== "string" || !value.modelID.trim() || (value.variant !== undefined && (typeof value.variant !== "string" || !value.variant.trim()))) {
    throw new Error("Model requires providerID, modelID, and an optional non-empty variant");
  }
  return { providerID: value.providerID, modelID: value.modelID, ...(value.variant === undefined ? {} : { variant: value.variant }) };
}

export function parseRolePolicy(value: unknown): RolePolicy {
  if (!record(value)) throw new Error("Role policy must be an object");
  if (value.strategy === "Fixed" && MODES.includes(value.tier as Mode) && Object.keys(value).every((key) => ["strategy", "tier"].includes(key))) {
    return { strategy: "Fixed", tier: value.tier as Mode };
  }
  if (value.strategy === "Auto" && Object.keys(value).every((key) => ["strategy", "min", "default", "max"].includes(key))) {
    const min = index(value.min), middle = index(value.default), max = index(value.max);
    if (min >= 0 && middle >= min && max >= middle) return { strategy: "Auto", min: value.min as Mode, default: value.default as Mode, max: value.max as Mode };
  }
  throw new Error("Policy must be Fixed with a tier, or Auto with valid min <= default <= max");
}

export function parseTier(value: unknown): Mode {
  if (!MODES.includes(value as Mode)) throw new Error("Tier must be Light, Standard, or Deep");
  return value as Mode;
}

export function parseId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${field} must be 1-128 ASCII letters, digits, _ or -`);
  return value;
}

export async function sessionIdForWorkUnit(workUnitId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`model-depth-routing:v1:session:${workUnitId}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ses_${hex}`;
}

export async function messageIdForWorkUnit(workUnitId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`model-depth-routing:v1:message:${workUnitId}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `msg_${hex}`;
}

export function clampMode(mode: Mode, policy: RolePolicy): Mode {
  if (policy.strategy === "Fixed") return policy.tier;
  return MODES[Math.max(index(policy.min), Math.min(index(mode), index(policy.max)))];
}

export function selectModel(tier: Mode, preset: unknown, catalog: readonly { id: string; providerID: string; variants: readonly { id: string }[] }[]): ModelRef {
  const model = parseModel(preset);
  if (!Array.isArray(catalog)) throw new Error("Live model catalog is unavailable");
  const match = catalog.find((entry) => entry.providerID === model.providerID && entry.id === model.modelID);
  if (!match) throw new Error(`${tier} preset is not in the live model catalog`);
  if (!Array.isArray(match.variants) || match.variants.some((variant: { id: string }) => !variant || typeof variant.id !== "string")) throw new Error(`${tier} model has an invalid live variant list`);
  if (model.variant && !match.variants.some((variant: { id: string }) => variant.id === model.variant)) throw new Error(`${tier} variant is not in the live model catalog`);
  return model;
}
