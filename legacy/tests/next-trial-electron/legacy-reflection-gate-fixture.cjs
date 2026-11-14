"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

exports.create = ({ extension, root, fixture }) => {
  if (!fs.existsSync(path.join(fixture, "native-ui-fixture-token")))
    throw new Error("Private fixture token is required.");
  const { ProjectStore } = require(path.join(extension, "dist/workflows/project-store.js"));
  const store = new ProjectStore(path.join(root, ".pkm/state"));
  const recipes = store.list().recipes;
  const reflection = recipes.find(recipe => recipe.name === "Reflection");
  const release = recipes.find(recipe => recipe.name === "Publish Personal Knowledge VSIX");
  if (!reflection || !release) throw new Error("Original installed built-in Recipes are required.");
  const source = fs.readFileSync(path.join(extension, "dist/mcp/mcp.js"), "utf8");
  const match = /fs\.writeFileSync\(serverPy, `([\s\S]*?)`\);\s*fs\.writeFileSync\(reqTxt/.exec(source);
  if (!match) throw new Error("Original installed MCP generator is required.");
  const python = new Function("exports", "KNOWLEDGE_MCP_VERSION", "CHAT_MCP_VERSION", "RECIPE_MCP_VERSION",
    "AGENT_SESSION_MCP_VERSION", "storeFwd", "subscriptionCacheFwd", "environmentsRegistryFwd",
    "retrievalStateFwd", "context", `return \`${match[1]}\`;`)(
    { UNIFIED_MCP_VERSION: "fixture" }, "fixture", "fixture", "fixture", "fixture",
    root, path.join(root, "subscriptions/cache"), path.join(fixture, "environments.json"),
    path.join(fixture, "retrieval"), { extensionPath: extension });
  fs.writeFileSync(path.join(fixture, "original-installed-knowledge-server.py"), python, { flag: "wx", mode: 0o600 });
  fs.mkdirSync(path.join(root, "skills"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "skills/Reflection.md"),
    "---\nname: Fixture Reflection Evidence\ndescription: Reflection validation evidence synthetic fixture\ntags: [reflection, evidence]\n---\nOnly retain verified reusable evidence.\n",
    { flag: "wx", mode: 0o600 });
  const originalGate = release.definition.spec.nodes.find(node => node.kind === "pkm.gate.human/v1");
  if (!originalGate) throw new Error("Original release human gate is required.");
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: {}, outputs: {}, completion: { requiredNodes: ["record-approved"] },
    nodes: [{ ...originalGate, dependsOn: [] }, {
      nodeId: "record-approved", kind: "pkm.step.noop/v1", config: {},
      generalInstruction: "Synthetic evidence only. Never dispatch or publish anything.",
      dependsOn: [{ from: originalGate.nodeId, accept: ["approved"], required: true,
        fromOutput: "approved", toInput: "approval" }],
      ports: { inputs: ["approval"], outputs: ["evidence"] },
    }],
  } };
  const command = () => ({ commandId: randomUUID(), fingerprint: randomUUID(), expectedStoreVersion: store.list().storeVersion });
  const created = store.createRecipe(command(), { kind: "global" }, "SATURN isolated original human gate", "Synthetic");
  store.updateRecipe(command(), created.entityId, {
    name: "SATURN isolated original human gate", category: "Synthetic",
    description: "Synthetic gate fixture with explicit approved dependency; original release Recipe is untouched.", definition,
  });
  const gate = store.list().recipes.find(recipe => recipe.recipeId === created.entityId);
  const evidence = { reflection, release, gate };
  fs.writeFileSync(path.join(fixture, "reflection-gate-source.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
  return evidence;
};
