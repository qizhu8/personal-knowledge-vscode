"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process"), { createHash } = require("node:crypto");
exports.prepare = ({ extension, fixture }) => {
  const prefix = path.join(fixture, "legacy-python");
  execFileSync("/usr/bin/python3", ["-m", "venv", "--without-pip", prefix], { env: {}, cwd: fixture });
  const registry = path.join(fixture, "u/User/globalStorage/uone.personal-knowledge/environments/registry.json");
  const old = require(path.join(extension, "dist/servers/pyenvs.js"));
  old.initPyenvs(path.dirname(registry));
  const record = old.pyenvAdd({ name: "legacy-python", manager: "venv", path: prefix, python: path.join(prefix, "bin/python"),
    description: "Explicit offline no-pip fixture, registered by the actual old VSIX before old-profile activation." });
  assert.equal(record.id, "legacy-python");
  assert.equal(execFileSync(record.python, ["-I", "-B", "-c", "import sys;print(sys.prefix)"],
    { env: {}, cwd: fixture, encoding: "utf8" }).trim(), prefix);
  const definition = { schema: "pkm.workflow.definition/v1", spec: {
    inputs: { value: { type: "string", required: true, nullable: false, schema: {} },
      mode: { type: "string", required: true, nullable: false, schema: {} } }, outputs: {},
    nodes: [{ nodeId: "inspect", kind: "pkm.step.script/v1", dependsOn: [], config: {
      runtime: "python", environmentId: record.id, args: ["{{ inputs.value }}", "{{ inputs.mode }}", "--not-cli", "$(touch never-created)", "two words", "中文", ""],
      timeoutSeconds: 20, maxOutputBytes: 4096,
      script: "import json,sys,os,time\nwith open('native-python-recipe-effects.jsonl','a') as f:\n"
        + " f.write(json.dumps({'value':sys.argv[1]})+'\\n');f.flush();os.fsync(f.fileno())\n"
        + "print(json.dumps({'argv':sys.argv[1:],'prefix':sys.prefix}),flush=True)\n"
        + "if sys.argv[2]=='hold':\n try:\n  for i in range(150):\n   print('alive',flush=True);time.sleep(.1)\n except BrokenPipeError: os._exit(0)" } },
    { nodeId: "record", kind: "pkm.step.script/v1", dependsOn: [{ from: "inspect", accept: ["succeeded"], required: true }],
      config: { runtime: "python", environmentId: record.id, script: "print('second-real-next-sql-python-step')", timeoutSeconds: 5, maxOutputBytes: 4096 } }],
    completion: { requiredNodes: ["record"] } } };
  const evidence = { prefix, registry, record, registrySha256: createHash("sha256").update(fs.readFileSync(registry)).digest("hex"),
    definition, offlineExplicitFixtureProvisioning: true, actualOldVsixRegistry: true, uvPositiveQualification: false };
  fs.writeFileSync(path.join(fixture, "native-python-recipe-old-environment.json"), JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
  return evidence;
};
