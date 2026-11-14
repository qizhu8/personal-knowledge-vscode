// Literal JSON cases, in order, for either the HTTP capability dispatcher or MCP.
// The authenticated actor must remain constant across this sequence.
export const workflowRuntimeTransportFixtures = [
  {
    "operation": "workflow.run.create",
    "args": {
      "operationId": "7e967dca-e56d-430d-8a7a-535bd10f4001",
      "runId": "fixture-run",
      "source": {
        "kind": "inline",
        "definition": {
          "schema": "pkm.workflow.definition/v1",
          "spec": {
            "inputs": {},
            "nodes": [{ "nodeId": "done", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [] }],
            "outputs": {},
            "completion": { "requiredNodes": ["done"] }
          }
        }
      },
      "expectedExecutableDigest": "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      "deadline": 100
    },
    "result": {
      "runId": "fixture-run", "version": 3, "state": "ready",
      "executableDigest": "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      "definitionDigest": "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      "definition": {
        "schema": "pkm.workflow.definition/v1",
        "spec": {
          "inputs": {},
          "nodes": [{ "nodeId": "done", "dependsOn": [], "kind": "pkm.step.noop/v1", "config": {} }],
          "outputs": {}, "completion": { "requiredNodes": ["done"] }
        }
      },
      "source": { "kind": "inline" },
      "nodes": [{ "nodeId": "done", "state": "pending", "version": 1 }],
      "deadline": 100, "execution": "host-only-noop"
    }
  },
  {
    "operation": "workflow.run.get", "args": { "runId": "fixture-run" },
    "result": {
      "runId": "fixture-run", "version": 3, "state": "ready",
      "executableDigest": "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      "definitionDigest": "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      "definition": {
        "schema": "pkm.workflow.definition/v1",
        "spec": {
          "inputs": {},
          "nodes": [{ "nodeId": "done", "dependsOn": [], "kind": "pkm.step.noop/v1", "config": {} }],
          "outputs": {}, "completion": { "requiredNodes": ["done"] }
        }
      },
      "source": { "kind": "inline" },
      "nodes": [{ "nodeId": "done", "state": "pending", "version": 1 }],
      "deadline": 100, "execution": "host-only-noop"
    }
  },
  {
    "operation": "workflow.run.ready-nodes",
    "args": { "runId": "fixture-run", "expectedVersion": 3 },
    "result": { "runId": "fixture-run", "version": 3, "nodes": ["done"] }
  },
  {
    "operation": "workflow.run.events",
    "args": { "runId": "fixture-run", "expectedVersion": 3, "after": 0, "limit": 10 },
    "result": {
      "runId": "fixture-run", "version": 3,
      "items": [{ "sequence": 1, "kind": "created", "version": 3, "state": "ready" }],
      "nextAfter": null
    }
  },
  {
    "operation": "workflow.run.cancel",
    "args": {
      "operationId": "7e967dca-e56d-430d-8a7a-535bd10f4002",
      "runId": "fixture-run", "expectedVersion": 3
    },
    "result": {
      "runId": "fixture-run", "version": 5, "state": "cancelled",
      "executableDigest": "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      "definitionDigest": "84f50fa7cc6433e8c96f4d067c0239699f6c05450cbee98e1f6515e6e4f76b5d",
      "definition": {
        "schema": "pkm.workflow.definition/v1",
        "spec": {
          "inputs": {},
          "nodes": [{ "nodeId": "done", "dependsOn": [], "kind": "pkm.step.noop/v1", "config": {} }],
          "outputs": {}, "completion": { "requiredNodes": ["done"] }
        }
      },
      "source": { "kind": "inline" },
      "nodes": [{ "nodeId": "done", "state": "cancelled", "version": 2 }],
      "deadline": 100, "execution": "host-only-noop"
    }
  }
];
