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
  const filestore = require("../dist/filestore");
  filestore.setStorePath(path.join(root, "store"));
  const projection = require("../dist/pkm-skill-projection");
  const bundledSource = fs.readFileSync(path.join(__dirname, "..", "resources", "pkm-skills-router.md"), "utf8");
  assert.match(bundledSource, /^router_version:\s*1\.1\.6$/m);
  const legacySource = bundledSource.replace("router_version: 1.1.6", "router_version: 1.1.5").replace(/\n## Unified Retrieval[\s\S]*?(?=\n## Maintaining Skills)/, "");
  assert.strictEqual(crypto.createHash("sha256").update(legacySource, "utf8").digest("hex"), "614f9aec0acd2f90d4072d83649b7cfc1b0625723ede396505c82c11a86e49aa");
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
  assert.strictEqual(status.routerVersion, "1.1.6");
  assert.strictEqual(status.minimumMcpSchema, "2.8.0");
  assert.strictEqual(status.targets.find(target => target.id === "copilot").state, "missing");

  const injected = projection.injectPkmSkill(context, "copilot");
  assert.strictEqual(injected.state, "current");
  assert(fs.existsSync(injected.skillPath));
  assert.match(fs.readFileSync(canonicalSource, "utf8"), /^router_version:\s*1\.1\.6$/m);
  const generated = fs.readFileSync(injected.skillPath, "utf8");
  assert.match(generated, /^---\nname: pkm-skills/m);
  assert.match(generated, /<!-- pkm-managed /);
  assert(fs.existsSync(status.sourcePath), "inject must create the canonical PKM source");

  const newerGenerated = generated.replace('"routerVersion":"1.1.6"', '"routerVersion":"1.1.7"');
  fs.writeFileSync(injected.skillPath, newerGenerated, "utf8");
  status = projection.pkmSkillProjectionStatus(context);
  assert.strictEqual(status.targets.find(target => target.id === "copilot").state, "newer");
  assert.throws(() => projection.injectPkmSkill(context, "copilot"), /Refusing to replace newer PKM Skill Router/);
  assert.strictEqual(fs.readFileSync(injected.skillPath, "utf8"), newerGenerated, "older PKM must not rewrite a newer Router");
  fs.writeFileSync(injected.skillPath, generated, "utf8");

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
