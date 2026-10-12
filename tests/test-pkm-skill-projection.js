#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-skill-projection-"));
const previousHome = process.env.HOME;
process.env.HOME = path.join(root, "home");

const states = new Map();
const context = {
  extensionPath: path.join(__dirname, ".."),
  extension: { packageJSON: { version: "test" } },
  globalState: {
    get(key, fallback) { return states.has(key) ? states.get(key) : fallback; },
    async update(key, value) { states.set(key, value); },
  },
};

try {
  const filestore = require("../dist/knowledge/filestore");
  filestore.setStorePath(path.join(root, "store"));
  const projection = require("../dist/skills/pkm-skill-projection");
  const bundledSource = fs.readFileSync(path.join(__dirname, "..", "resources", "pkm-skills-router.md"), "utf8");
  assert.match(bundledSource, /^router_version:\s*1\.7\.2$/m);
  const routerDescription = bundledSource.match(/^description: "(.+)"$/m)[1];
  assert.match(routerDescription, /Use at the start of every multi-step agent task/);
  for (const trigger of ["coding", "implementation", "bug fixes", "refactoring", "research", "analysis", "diagnosis", "code review"]) {
    assert(routerDescription.includes(trigger), `discovery must include ${trigger}`);
  }
  assert.match(routerDescription, /even for read-only work/);
  assert.match(routerDescription, /skip quick answers, trivial commands, and casual conversation/);
  assert.match(bundledSource, /Agent Snapshot Creation Fast Path/);
  assert.match(bundledSource, /`Create Agent Snapshot` Recipe/);
  assert.match(bundledSource, /No\s+recovery password exists/);
  assert.match(bundledSource, /fixed local\s+`uone` obfuscation key/);
  assert.match(bundledSource, /Do not replace a missing built-in with an ad hoc Recipe/);
  assert.match(bundledSource, /Agent Snapshot Recovery Fast Path/);
  assert.match(bundledSource, /call\s+`pkm\.agent_session_snapshot_recover` immediately/);
  assert.match(bundledSource, /do not call\s+`agent_session_start` first/);
  assert.match(bundledSource, /does not contain the locally\s+obfuscated payload/);
  assert.match(bundledSource, /agent_session_todo_append/);
  assert.match(bundledSource, /start of every later user turn/);
  assert.match(bundledSource, /agent_session_todo_replan/);
  assert.match(bundledSource, /`report_status` action/);
  assert.match(bundledSource, /do not abandon, reorder, or preempt/);
  assert.match(bundledSource, /A mature linear Recipe is a valid match/);
  assert.match(bundledSource, /validated reusable solution, reliable Script automation/);
  assert.match(bundledSource, /Checkpoint or save an Agent Snapshot only for an explicit/);
  assert.match(bundledSource, /A failed attempt is a valid result/);
  assert.match(bundledSource, /never create a one-node noop Recipe/);
  assert.match(bundledSource, /before the first\s+substantive investigation, edit, or operational mutation/);
  assert.match(bundledSource, /do not wait for an explicit tracking request or\s+the first code edit/);
  assert.match(bundledSource, /read-only work alone does not/);
  assert.doesNotMatch(bundledSource, /Do not start an Agent Session for assessment/);
  const projectionSource = fs.readFileSync(path.join(__dirname, "..", "src", "skills/pkm-skill-projection.ts"), "utf8");
  assert.match(projectionSource, /c60be52f524bae0d853ac98785a3be39f038c0d2c9d9629da6c6901211695c8b.*Router 1\.5\.0 canonical/);
  assert.match(projectionSource, /b6dbcf44509a2c4c240d99a2e6573b83b21b3bc6e546c2d0a1ef707657be1325.*Router 1\.5\.1 bundled canonical/);
  assert.match(projectionSource, /46d9c22107cfc09eaec54fdfbe98af4c2ad9ace5bb5c05fd8ec492de3f146d1a.*Router 1\.6\.0 bundled canonical/);
  assert.match(projectionSource, /f8f28f95af02e8f15dbcd632452af46b020267dac89e7b036e383ef171e8cf49.*Router 1\.6\.1 canonical/);
  const legacySource = bundledSource
    .replace("router_version: 1.7.2", "router_version: 1.1.6")
    .replace(routerDescription, "Use when: starting substantial coding, research, debugging, or workflow tasks that may benefit from personal conventions or domain knowledge; also use when reusable knowledge should be added to or updated in PKM.")
    .replace(/\n## Agent Snapshot Creation Fast Path[\s\S]*?(?=\n## Agent Snapshot Recovery Fast Path)/, "")
    .replace(/\n## Agent Snapshot Recovery Fast Path[\s\S]*?(?=\n## Managed Task Routing)/, "")
    .replace(/\n## Managed Task Routing[\s\S]*?(?=\n## Before Substantial Work)/, "")
    .replace(/\n## Recipe Discovery and Evolution[\s\S]*?(?=\n## Broker Skills)/, "");
  assert.strictEqual(crypto.createHash("sha256").update(legacySource, "utf8").digest("hex"), "ad2a744488a399d9bf93bce64364ec0cf62fe318352830b13689690df9cffb24");
  const canonicalSource = path.join(root, "store", "skills", "System", "PKM", "PKM Skills.md");
  fs.mkdirSync(path.dirname(canonicalSource), { recursive: true });
  fs.writeFileSync(canonicalSource, legacySource, "utf8");

  assert.strictEqual(
    projection.resolvePkmSkillTargetPath('%USERPROFILE%\\.copilot\\skills', 'win32', { USERPROFILE: 'C:\\Users\\Amy' }, 'C:\\Users\\Amy'),
    'C:\\Users\\Amy\\.copilot\\skills',
  );
  assert.strictEqual(
    projection.resolvePkmSkillTargetPath('\\\\server\\share\\agent-skills', 'win32', {}, 'C:\\Users\\Amy'),
    '\\\\server\\share\\agent-skills',
  );
  assert.strictEqual(
    projection.resolvePkmSkillTargetPath('~/.copilot/skills', 'linux', { HOME: '/home/amy' }, '/home/amy'),
    '/home/amy/.copilot/skills',
  );
  assert.throws(
    () => projection.resolvePkmSkillTargetPath('C:\\Users\\Amy\\.copilot\\skills', 'linux', {}, '/home/amy'),
    /Windows path/,
  );
  assert.throws(
    () => projection.resolvePkmSkillTargetPath('%UNKNOWN%\\skills', 'win32', {}, 'C:\\Users\\Amy'),
    /unknown environment variable/,
  );

  let status = projection.pkmSkillProjectionStatus(context);
  assert.strictEqual(status.routerVersion, "1.7.2");
  assert.strictEqual(status.minimumMcpSchema, "2.8.0");
  assert.strictEqual(status.targets.find(target => target.id === "copilot").state, "missing");

  const injected = projection.injectPkmSkill(context, "copilot");
  assert.strictEqual(injected.state, "current");
  assert(fs.existsSync(injected.skillPath));
  assert.match(fs.readFileSync(canonicalSource, "utf8"), /^router_version:\s*1\.7\.2$/m);
  const generated = fs.readFileSync(injected.skillPath, "utf8");
  assert.match(generated, /^---\nname: pkm-skills/m);
  assert.match(generated, /<!-- pkm-managed /);
  assert(generated.includes(routerDescription), "native discovery must retain the multi-step task triggers");
  assert(fs.existsSync(status.sourcePath), "inject must create the canonical PKM source");

  const newerGenerated = generated.replace('"routerVersion":"1.7.2"', '"routerVersion":"1.7.3"');
  fs.writeFileSync(injected.skillPath, newerGenerated, "utf8");
  status = projection.pkmSkillProjectionStatus(context);
  assert.strictEqual(status.targets.find(target => target.id === "copilot").state, "newer");
  assert.throws(() => projection.injectPkmSkill(context, "copilot"), /Refusing to replace newer PKM Skill Router/);
  assert.strictEqual(fs.readFileSync(injected.skillPath, "utf8"), newerGenerated, "older PKM must not rewrite a newer Router");
  fs.writeFileSync(injected.skillPath, generated, "utf8");

  const previousRouterSource = bundledSource
    .replace("router_version: 1.7.2", "router_version: 1.7.1")
    .replace("graph when they add a reusable solution, automation, or useful task structure.", "graph only when they add control value.")
    .replace(/Checkpoint or save an Agent Snapshot[\s\S]*?(?=outcomes already contain the evidence)/,
      "Checkpoint only at useful recovery boundaries. End the Agent Session after the\noverall user outcome is validated. Omit the Session-end summary when Todo\n")
    .replace(/Use a Recipe when it provides[\s\S]*?(?=\n\nFor a Todo)/, [
      "Use a Recipe only when its executable graph adds a guardrail that ordinary Todo",
      "tracking does not provide: branching, bounded repetition, a mandatory human",
      "gate, a pinned reusable procedure, a background command, or an allowlisted",
      "native operation. Linear inspect → edit → validate work should stay in the",
      "Agent Session Todo and native tools.",
    ].join("\n"))
    .replace("For a Todo that could reuse a solution or benefit from structure, call", "For a Todo that needs those controls, call")
    .replace(/A no-match result is valid\.[\s\S]*?(?=represent work already tracked by a Todo)/,
      "A no-match result is valid. Create an ad hoc Recipe only when the required\ncontrol graph still exists; never create a one-node noop Recipe merely to\n")
    .replace(/\nA failed attempt is a valid result,[\s\S]*?(?=\nAfter execution, record concrete friction)/, "");
  const previousBundledSource = previousRouterSource
    .replace("router_version: 1.7.1", "router_version: 1.7.0")
    .replace(routerDescription, "Route substantial work into PKM guardrails without adding orchestration that does not change execution.")
    .replace(/For every multi-step task,[\s\S]*?(?=At the start of every later user turn)/, `For a substantial mutating task, call \`pkm.agent_session_start\` before the first
substantive edit or operational mutation. Call \`agent_session_capabilities\`
only when the tool contract is not already available in the current
conversation or its version changed. A substantial task is a user goal that
needs multiple execution or validation steps and benefits from durable
progress/recovery state. Use one Agent Session for the user goal.

Do not start an Agent Session for assessment, explanation, code review, or
read-only diagnosis, even when several reads or tests are needed, unless the
user asks for durable tracking or the work is likely to continue across turns.
Also skip it for a quick answer, trivial command, or casual conversation. When
the host chat/session ID is available, pass it as \`host_session_id\`.

`);
  const previousCanonicalSource = previousBundledSource
    .replace(/\nFor a qualified recurring Recipe,[\s\S]*?(?=\nRecipe action tools)/, "");
  for (const [previousSource, expectedHash] of [
    [previousRouterSource, "0cd7549ee9b7ee3c5d8da25d38056dc1772354db64b2adc83a7b88a13356738a"],
    [previousBundledSource, "269e06b053f5d48b31bac2823068c3a55a8681801c68222352116c65209ae193"],
    [previousCanonicalSource, "a819465ccec50d589891fe12a86d1bfd003eeee0bcf1e725048c4338208b2d67"],
  ]) {
    assert.strictEqual(crypto.createHash("sha256").update(previousSource, "utf8").digest("hex"), expectedHash);
    fs.writeFileSync(canonicalSource, previousSource, "utf8");
    projection.injectPkmSkill(context, "copilot");
    assert.strictEqual(fs.readFileSync(canonicalSource, "utf8"), bundledSource, "unmodified older Router must migrate");
    assert.strictEqual(fs.readFileSync(injected.skillPath, "utf8"), generated);
  }
  const customSource = `${previousCanonicalSource}\nUser-specific routing guidance.\n`;
  fs.writeFileSync(canonicalSource, customSource, "utf8");
  projection.injectPkmSkill(context, "copilot");
  assert.strictEqual(fs.readFileSync(canonicalSource, "utf8"), customSource, "customized Router must not be overwritten");
  fs.writeFileSync(canonicalSource, bundledSource, "utf8");
  projection.injectPkmSkill(context, "copilot");

  fs.appendFileSync(status.sourcePath, "\nNew canonical guidance.\n");
  status = projection.pkmSkillProjectionStatus(context);
  assert.strictEqual(status.targets.find(target => target.id === "copilot").state, "content-outdated");
  assert.strictEqual(projection.injectPkmSkill(context, "copilot").state, "current");

  fs.appendFileSync(injected.skillPath, "\nmanual edit\n");
  status = projection.pkmSkillProjectionStatus(context);
  assert.strictEqual(status.targets.find(target => target.id === "copilot").state, "modified");
  projection.injectPkmSkill(context, "copilot");

  projection.removeInjectedPkmSkill(context, "copilot");
  assert(!fs.existsSync(injected.skillPath));

  const conflictPath = injected.skillPath;
  fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
  fs.writeFileSync(conflictPath, "---\nname: pkm-skills\n---\nuser owned\n");
  assert.strictEqual(projection.pkmSkillProjectionStatus(context).targets.find(target => target.id === "copilot").state, "conflict");
  assert.throws(() => projection.injectPkmSkill(context, "copilot"), /Refusing to overwrite/);
  assert.throws(() => projection.removeInjectedPkmSkill(context, "copilot"), /Refusing to remove/);

  projection.connectPkmSkill(context, "agents").then(async connected => {
    assert.strictEqual(connected.connected, true);
    const connectedPath = connected.skillPath;
    const canonicalProjection = fs.readFileSync(connectedPath, "utf8");
    const currentMtime = fs.statSync(connectedPath).mtimeMs;
    const unchanged = await projection.reconcilePkmSkillProjections(context);
    assert.strictEqual(unchanged.updated.length, 0, "current projections must not be rewritten");
    assert.strictEqual(fs.statSync(connectedPath).mtimeMs, currentMtime);
    fs.rmSync(connectedPath);
    const restored = await projection.reconcilePkmSkillProjections(context);
    assert.deepStrictEqual(restored.updated.map(target => target.id), ["agents"]);
    assert.strictEqual(fs.readFileSync(connectedPath, "utf8"), canonicalProjection, "a missing connected projection must be restored");

    fs.appendFileSync(connectedPath, "\nmanual edit\n");
    const repaired = await projection.reconcilePkmSkillProjections(context);
    assert.deepStrictEqual(repaired.updated.map(target => target.id), ["agents"]);
    assert.strictEqual(fs.readFileSync(connectedPath, "utf8"), canonicalProjection, "a modified PKM-managed projection must return to canonical content");

    await projection.disconnectPkmSkill(context, "agents");
    await projection.reconcilePkmSkillProjections(context);
    assert(!fs.existsSync(connectedPath), "an explicitly disconnected target must remain absent");

    const custom = path.join(root, "custom-skills");
    const target = await projection.addPkmSkillCustomTarget(context, custom, "Custom Test");
    assert.strictEqual(target.root, custom);
    const legacy = await projection.connectPkmSkill(context, "agents");
    fs.appendFileSync(legacy.skillPath, "\nkeep this modification in the backup\n");
    const legacyContent = fs.readFileSync(legacy.skillPath, "utf8");
    const canonicalContent = fs.readFileSync(canonicalSource, "utf8");
    const userSkill = projection.pkmSkillProjectionStatus(context).targets.find(item => item.id === "copilot").skillPath;
    const userContent = fs.readFileSync(userSkill, "utf8");
    const backupDirectory = path.join(root, "retired");
    const retired = await projection.retirePkmSkillProjections(context, backupDirectory);
    assert.deepStrictEqual(retired.removed, [legacy.skillPath]);
    assert(retired.preserved.includes(userSkill));
    assert.strictEqual(fs.readFileSync(userSkill, "utf8"), userContent, "user-authored Skills must remain unchanged");
    assert.strictEqual(fs.readFileSync(canonicalSource, "utf8"), canonicalContent, "retirement must not change canonical Skills");
    assert(!fs.existsSync(legacy.skillPath));
    const backups = fs.readdirSync(backupDirectory);
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(backupDirectory, backups[0]), "utf8"), legacyContent);
    assert.deepStrictEqual(states.get("pkm.skillProjection.connectedTargets.v1"), []);
    const secondRetirement = await projection.retirePkmSkillProjections(context, backupDirectory);
    assert.strictEqual(secondRetirement.removed.length, 0, "retirement must be idempotent");
    await projection.reconcilePkmSkillProjections(context);
    assert(!fs.existsSync(legacy.skillPath), "cleared legacy connections must not re-inject");
    console.log("PKM Skill projection: legacy fixtures, backed-up retirement, canonical/user file preservation, and idempotence OK");
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => {
    process.env.HOME = previousHome;
  });
} finally {
  process.on("exit", () => {
    process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
}
