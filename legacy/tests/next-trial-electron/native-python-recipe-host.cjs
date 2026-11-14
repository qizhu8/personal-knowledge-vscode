"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
exports.create = async function ({ fixture, extension, storage, binding, recipes, recover = false, jobCreated }) {
  assert.equal(fs.realpathSync(fixture), fixture);
  const cwd = path.join(fixture, "workspace");
  assert.equal(fs.realpathSync(cwd), cwd);
  const profileStorage = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge");
  const registry = path.join(profileStorage, "environments/registry.json");
  const { PythonEnvironmentAuthority } = require(path.join(extension, "dist/runtime/python-environment-authority.js"));
  const { readProfilePythonRegistry } = require(path.join(extension, "dist/runtime/python-recipe-authority.js"));
  const { HostPythonRecipe } = await import(pathToFileURL(path.join(extension, "next-runtime/server/dist/host-python-recipe.js")).href);
  const database = storage.connectNative();
  const row = database.prepare("SELECT name FROM sqlite_master WHERE name='runtime_process_owner'").get()
    ? database.prepare("SELECT owner_id,closed FROM runtime_process_owner WHERE singleton=1").get() : undefined;
  if (row && row.closed !== 1 && !recover)
    throw new Error("Python Recipe Runtime has an interrupted owner; explicit native exact-owner recovery is required.");
  const trusted = () => { storage.assertWorkspaceLease(); return true; };
  const pythonRecipes = new HostPythonRecipe({ database, binding, cwd, recipes,
    assertOwner: () => storage.assertWorkspaceLease(),
    environmentIds: () => readProfilePythonRegistry(registry).map(record => record.id),
    checkEnvironment: program => {
      const authority = new PythonEnvironmentAuthority(trusted, () => readProfilePythonRegistry(registry));
      try {
        const fresh = authority.select(binding.workspaceId, binding.actorId, program.handle.environmentId);
        assert.deepEqual(program.handle, fresh, "Python Recipe original registry/root/interpreter mapping changed.");
        authority.validate(fresh, binding.workspaceId, binding.actorId);
      } finally { authority.revoke(); }
    },
    ...(row && row.closed !== 1 ? { recoverPreviousOwner: String(row.owner_id) } : {}),
    ...(jobCreated ? { jobCreated } : {}),
  });
  return { pythonRecipes, adapters: { "pkm.step.script/v1": pythonRecipes.adapter() },
    usesPython: approval => approval?.definition?.spec?.nodes?.some(node =>
      node.kind === "pkm.step.script/v1" && node.config?.runtime === "python") === true,
    authorizeCreate: (candidate, approval) => pythonRecipes.admit(candidate, approval),
    close: () => pythonRecipes.close() };
};
