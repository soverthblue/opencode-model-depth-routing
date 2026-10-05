export const definition = {
  id: "model-depth-routing",
  methods: {
    presets: { input: { type: "object", properties: { tier: { type: "string", enum: ["Light", "Standard", "Deep"] }, model: { type: "object", additionalProperties: true } }, additionalProperties: false }, output: { type: "object", additionalProperties: true } },
    roles: { input: { type: "object", properties: { role: { type: "string" }, policy: { type: "object", additionalProperties: true }, sessionID: { type: "string" } }, additionalProperties: false }, output: { type: "object", additionalProperties: true } },
    routing: { input: { type: "object", properties: { action: { type: "string", enum: ["start", "status", "cancel", "list"] }, workUnitId: { type: "string" }, sourceSessionID: { type: "string" }, role: { type: "string" }, requestedTier: { type: "string", enum: ["Light", "Standard", "Deep"] }, escalationReason: { type: "string", enum: ["task-complexity", "tool-failure", "auth-failure", "provider-failure"] }, complexityEvidence: { type: "string" }, prompt: { type: "string" } }, required: ["action"], additionalProperties: false }, output: { type: "object", additionalProperties: true } },
  },
  events: {},
} as const;
