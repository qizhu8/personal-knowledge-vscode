// Synthetic JSON-compatible examples; never sent to a tool or model.
export const executionStateFixture = Object.freeze({
  actor: "fixture-actor",
  create: {
    tool: "fixture-tool",
    arguments: { path: "example.txt", text: "example" },
    approvalRequired: true,
    operationId: "11111111-1111-4111-8111-111111111111",
  },
  approval: {
    operationId: "22222222-2222-4222-8222-222222222222",
    decisionId: "fixture-native-decision",
  },
});
