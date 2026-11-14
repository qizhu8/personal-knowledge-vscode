export const workflowCompilerTransportFixtures = [
  {
    operation: "workflow.definition.compile",
    args: { source: { kind: "inline", definition: {
      schema: "pkm.workflow.definition/v1",
      spec: {
        inputs: {}, nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1", config: {}, dependsOn: [] }],
        outputs: {}, completion: { requiredNodes: ["done"] },
      },
    } } },
    result: {
      status: "valid", source: { kind: "inline" }, diagnostics: [],
      executableDigest: "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      bindings: { status: "none", nodes: 0, knowledge: 0 }, runtimeStatus: "not-runnable-here",
      availability: [{
        kind: "pkm.step.noop/v1", runtimeAvailable: false, reason: "execution-not-migrated",
        adapterClass: "none", requiredCapabilities: [], builtInOnly: false,
      }],
      definition: {
        schema: "pkm.workflow.definition/v1",
        spec: {
          inputs: {}, nodes: [{ nodeId: "done", dependsOn: [], kind: "pkm.step.noop/v1", config: {} }],
          outputs: {}, completion: { requiredNodes: ["done"] },
        },
      },
      canonicalJson: '{"schema":"pkm.workflow.definition/v1","spec":{"completion":{"requiredNodes":["done"]},"inputs":{},"nodes":[{"config":{},"dependsOn":[],"kind":"pkm.step.noop/v1","nodeId":"done"}],"outputs":{}}}',
      plan: {
        schema: "pkm.workflow.plan/v1", execution: "unavailable",
        nodes: [{ nodeId: "done", kind: "pkm.step.noop/v1" }], edges: [],
        order: ["done"], layers: [["done"]], depth: 1, requiredNodes: ["done"], traversalStrategy: "breadth-first",
        sourceMap: [{ nodeId: "done", sourcePointer: "/spec/nodes/0", canonicalPointer: "/spec/nodes/0", dependencies: [] }],
      },
    },
  },
  {
    operation: "workflow.definition.compile",
    args: { source: { kind: "inline", definition: null } },
    result: {
      status: "invalid", source: { kind: "inline" }, diagnostics: [{
        phase: "P3", code: "E3003", severity: "error", pointer: "", details: { expected: "object" },
        messageTemplateId: "workflow.schema.type", remediationClass: "author",
      }],
    },
  },
];
