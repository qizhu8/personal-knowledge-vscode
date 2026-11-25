import { createHash, randomUUID } from "node:crypto";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";
import { originalActionCompilerFixtures as actionFixture } from "./action-compiler-original-fixtures.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const syncContentMember = (path, itemId, bytes, extra = {}) => ({ path, type: path.split("/")[0], itemId,
  member: "", category: path.split("/").slice(1, -1).join("/"), privacy: "public",
  digest: hash(bytes), contentBase64: Buffer.from(bytes).toString("base64"), ...extra });
export function typedSyncFiles() {
  const recipeId = `recipe_${randomUUID()}`;
  const definition = { schema: "pkm.workflow.definition/v1", spec: { inputs: {}, outputs: {},
    nodes: [{ nodeId: "first", kind: "pkm.step.native/v1", config: { operation: "synthetic", arguments: {} }, dependsOn: [] }],
    completion: { requiredNodes: ["first"] } } };
  const recipe = { recipeId, name: "Synthetic", description: "", scope: "global", revision: 1, category: "", definition,
    executableDigest: compileWorkflowDefinitionV1(definition).executableDigest };
  const profileId = randomUUID(), profile = { schema: "pkm.profile/v1", id: profileId, revision: 1,
    updatedAt: "2026-11-24T00:00:00Z", kind: "user", name: "Synthetic", role: "", focus: "", preferences: "", boundaries: "" };
  const module = structuredClone(actionFixture.moduleSet), action = JSON.parse(actionFixture.moduleSetFile);
  const asset = Buffer.from([0, 255, 128, 1]);
  module.files["assets/example.bin"] = hash(asset);
  module.resources = { [action.action_id]: { "pkm://packages/synthetic/data.bin": "assets/example.bin" } };
  delete module.package_hash; module.package_hash = originalDigest(module);
  const id = `${module.module_set_id}/${module.version}`, prefix = `action-module-sets/${id}`, member = syncContentMember;
  return [
    member("packages/synthetic/data.bin", "synthetic", Buffer.from([0, 128, 255]), { member: "data.bin", category: "" }),
    member("servers/synthetic/config.json", "synthetic", JSON.stringify({ name: "Synthetic", command: "DO-NOT-EXECUTE" }),
      { member: "config.json", category: "" }),
    member("prompts/synthetic/task/prompt.txt", "synthetic/task", "opaque prompt\r\n", { member: "prompt.txt", category: "synthetic" }),
    member(`recipes/Uncategorized/Synthetic.${recipeId}.json`, recipeId, JSON.stringify(recipe), { category: "" }),
    member(`actions/${action.action_id}.json`, action.action_id, JSON.stringify(action)),
    member(`${prefix}/manifest.json`, id, JSON.stringify(module), { category: module.module_set_id }),
    member(`${prefix}/definitions/${action.action_id}.json`, id, actionFixture.moduleSetFile,
      { member: `${prefix}/definitions/${action.action_id}.json`, category: module.module_set_id }),
    member(`${prefix}/assets/example.bin`, id, asset, { member: `${prefix}/assets/example.bin`, category: module.module_set_id }),
    member(`profiles/user/${profileId}.json`, `user/${profileId}`, JSON.stringify(profile), { privacy: "private", category: "user" }),
  ];
}
