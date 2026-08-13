#!/usr/bin/env node
const assert = require("assert");
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
  const filestore = require("../dist/filestore");
  filestore.setStorePath(path.join(root, "store"));
  const projection = require("../dist/pkm-skill-projection");

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
  assert.strictEqual(status.routerVersion, "1.1.3");
  assert.strictEqual(status.minimumMcpSchema, "2.2.3");
  assert.strictEqual(status.targets.find(target => target.id === "copilot").state, "missing");

  const injected = projection.injectPkmSkill(context, "copilot");
  assert.strictEqual(injected.state, "current");
  assert(fs.existsSync(injected.skillPath));
  const generated = fs.readFileSync(injected.skillPath, "utf8");
  assert.match(generated, /^---\nname: pkm-skills/m);
  assert.match(generated, /<!-- pkm-managed /);
  assert(fs.existsSync(status.sourcePath), "inject must create the canonical PKM source");

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

  const custom = path.join(root, "custom-skills");
  projection.addPkmSkillCustomTarget(context, custom, "Custom Test").then(target => {
    assert.strictEqual(target.root, custom);
    console.log("PKM Skill projection: inject, hash update, conflict protection, remove, and custom target OK");
  });
} finally {
  process.env.HOME = previousHome;
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
}
