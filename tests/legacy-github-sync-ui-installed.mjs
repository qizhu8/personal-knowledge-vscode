import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import test from "node:test";

const digest = value => createHash("sha256").update(value).digest("hex");
const wait = ms => new Promise(done => setTimeout(done, ms));
const require = createRequire(import.meta.url);

function writeOriginalTarget(runtime, profile, target) {
  const ts = require("typescript");
  const source = readFileSync(join(runtime, "../legacy/src/extension.ts"), "utf8");
  const tree = ts.createSourceFile("extension.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["githubSyncStateDirectory", "githubSyncTargetsPath", "writeGitHubSyncTargets"];
  const functions = names.map(name => {
    const node = tree.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
    assert(node); return node.getText(tree);
  });
  const schema = tree.statements.find(value => ts.isVariableStatement(value)
    && value.declarationList.declarations.some(item => item.name.getText(tree) === "GITHUB_SYNC_TARGETS_SCHEMA"));
  assert(schema);
  const js = ts.transpileModule(`${schema.getText(tree)}\n${functions.join("\n")}\nglobalThis.writeTargets=writeGitHubSyncTargets;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = { fs: require("node:fs"), path: require("node:path"), process };
  vm.runInNewContext(js, scope);
  const original = require(join(runtime, "../legacy/dist/sync/github-sync.js"));
  scope.writeTargets({ globalStorageUri: { fsPath: profile } }, [original.normalizeGitHubSyncTarget(target)]);
}

test("installed private Next Sync panel compares, resolves and reconciles on the original synthetic root", { timeout: 240000 }, async () => {
  process.umask(0o077);
  const vsix = process.env.PKM_TEST_SYNC_VSIX, runtime = process.env.PKM_TEST_SYNC_RUNTIME;
  assert(vsix && runtime && resolve(vsix) === vsix && resolve(runtime) === runtime);
  const fixture = resolve(".migration-test-work", `pkm-native-sync-ui-${randomUUID()}`);
  const root = join(fixture, "root"), seed = join(fixture, "seed"), bare = join(fixture, "remote.git");
  const gitMode = process.env.PKM_TEST_SYNC_NATIVE_GIT;
  const nativeGit = gitMode === "ssh" || gitMode === "https";
  const privateSkills = process.env.PKM_TEST_PRIVATE_SKILLS === "1";
  const skillsMount = process.env.PKM_TEST_SKILLS_MOUNT === "1";
  const nativeTrash = process.env.PKM_TEST_NATIVE_TRASH_SYNC === "1";
  if (skillsMount) assert(privateSkills && nativeGit);
  if (nativeTrash) assert(skillsMount);
  const installedRace = process.env.PKM_TEST_INSTALLED_RACE || "";
  assert(["", "config", "cas"].includes(installedRace));
  if (installedRace) assert(privateSkills && nativeGit);
  if (privateSkills) assert(nativeGit);
  const profile = join(fixture, "u/User/globalStorage/uone.personal-knowledge");
  const remoteSkills = skillsMount ? "Skills" : "skills";
  const remoteManifest = skillsMount ? "Skills/.pkm-github-sync.json" : ".pkm-github-sync.json";
  for (const dir of [join(root, "skills"), join(root, "notes"), join(root, "prompts"),
    join(seed, remoteSkills), join(seed, "notes"), join(seed, "prompts"), profile,
    join(profile, "github-sync"), join(fixture, "provider"), join(fixture, "h"), join(fixture, "t"),
    join(fixture, "workspace"), join(fixture, "x"), join(fixture, "driver"), join(fixture, "bin")])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const short = resolve(`.sync-ui-${randomUUID().slice(0, 8)}`);
  const env = { PATH: process.env.PATH, HOME: join(fixture, "h"), TMPDIR: join(fixture, "t"),
    TMP: join(fixture, "t"), TEMP: join(fixture, "t"), XDG_RUNTIME_DIR: `/proc/${process.pid}/cwd/${short.split("/").at(-1)}`,
    DISPLAY: "127.0.0.1:93", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: nativeGit ? "file:ssh:https" : "file", GIT_TERMINAL_PROMPT: "0", PYTHONPATH: process.env.PYTHONPATH || "",
    PKM_PRIVATE_NATIVE_SYNC_UI: "1", PKM_PRIVATE_SYNC_UI_FAULTS: "1",
    PKM_PRIVATE_SYNC_UI_FIXTURE: fixture, PKM_PRIVATE_NATIVE_SYNC_UI_GRANT: join(profile, "native-sync-ui.json"),
    PKM_TEST_ISOLATED_NETWORK: process.env.PKM_TEST_ISOLATED_NETWORK || "",
    PKM_TEST_SYNC_NATIVE_GIT: gitMode || "",
    ...(nativeGit ? { PKM_PRIVATE_SYNC_UI_NATIVE_GIT: "1" } : {}),
    ...(nativeTrash ? { PKM_PRIVATE_SYNC_UI_NATIVE_TRASH: "1" } : {}) };
  const git = (cwd, args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const content = (name, body) => `---\nname: ${name}\n---\n${body}\n`;
  const item = (type, name, data) => ({ path: `${type}/${name}.md`, type, itemId: name,
    member: "", category: "", privacy: "public", digest: digest(data) });
  const remoteNote = "---\ntitle: Note\n---\nremote note unchanged\n";
  const remotePrompt = "---\ntitle: Prompt\n---\nremote prompt unchanged\n";
  const localNote = "---\ntitle: Note\ndocumentId: fixture-note\nrevision: 1\n---\nlocal note unchanged\n";
  const localPrompt = "---\ntitle: Prompt\n---\nlocal prompt unchanged\n";
  const remoteFiles = [["skills", "One", content("One", "remote conflict")],
    ["skills", "Remote", content("Remote", "remote only")], ["notes", "Note", remoteNote], ["prompts", "Prompt", remotePrompt]];
  for (const [type, name, value] of remoteFiles) writeFileSync(join(seed, type === "skills" ? remoteSkills : type, `${name}.md`), value);
  const privateItem = { path: "skills/Private/Secret.md", type: "skills", itemId: "Secret",
    member: "", category: "Private", privacy: "private", digest: digest(content("Secret", "shared")) };
  if (privateSkills) {
    mkdirSync(join(root, ".pkm"), { mode: 0o700 });
    writeFileSync(join(root, ".pkm/content-privacy.json"),
      JSON.stringify({ schema: 1, private: { skills: ["Private"] } }), { mode: 0o600 });
    mkdirSync(join(root, "skills/Private")); mkdirSync(join(seed, remoteSkills, "Private"));
    writeFileSync(join(root, "skills/Private/Secret.md"), content("Secret", "shared"), { mode: 0o600 });
    if (!skillsMount) writeFileSync(join(seed, remoteSkills, "Private/Secret.md"), content("Secret", "shared"), { mode: 0o600 });
  }
  if (skillsMount) {
    mkdirSync(join(root, "skills/One.assets")); mkdirSync(join(seed, remoteSkills, "One.assets"));
    writeFileSync(join(root, "skills/One.assets/icon.png"), "original synthetic asset");
    writeFileSync(join(seed, remoteSkills, "One.assets/icon.png"), "original synthetic asset");
  }
  if (!skillsMount) writeFileSync(join(seed, ".pkm-github-sync.json"), JSON.stringify({ schema: 3, minimumExtensionVersion: "4.0.22",
    capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity", "entity-partial-progress"] },
    files: [...remoteFiles.map(args => item(...args)), ...(privateSkills ? [privateItem] : [])], deletions: [] }) + "\n");
  writeFileSync(join(root, "skills/One.md"), content("One", "local conflict"));
  writeFileSync(join(root, "skills/Local.md"), content("Local", "local only"));
  writeFileSync(join(root, "notes/Note.md"), localNote); writeFileSync(join(root, "prompts/Prompt.md"), localPrompt);
  git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
  git(seed, ["add", "."]); git(seed, ["commit", "-qm", "base"]); git(seed, ["branch", "-M", "main"]);
  git(fixture, ["clone", "--bare", "-q", seed, bare]); git(seed, ["remote", "add", "origin", bare]);
  if (gitMode === "ssh") {
    writeFileSync(join(fixture, "identity"), "synthetic identity\n", { mode: 0o600 });
    writeFileSync(join(fixture, "bin/ssh"), `#!/bin/sh
if [ "$1" = "-T" ]; then printf "Hi fixture! You've successfully authenticated\\n" >&2; exit 1; fi
case "$*" in
 *git-upload-pack*) exec git-upload-pack '${bare}' ;;
 *git-receive-pack*) printf 'push\\n' >> '${fixture}/git-pushes'; if [ -f '${fixture}/git-race' ]; then git --git-dir '${bare}' update-ref refs/heads/main "$(git --git-dir '${bare}' rev-parse refs/heads/race)"; fi; git-receive-pack '${bare}'; result=$?; if [ -f '${fixture}/git-drop' ]; then rm '${fixture}/git-drop'; exit 1; fi; exit "$result" ;;
 *) exit 1 ;;
esac
`, { mode: 0o700 });
  }
  if (gitMode === "https") {
    assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1");
    assert.equal(process.getuid(), 0);
    assert.match(readFileSync("/proc/self/uid_map", "utf8"), /^\s*0\s+\d+\s+1\s*$/);
    assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal));
    writeFileSync(join(fixture, "bin/credential-helper"),
      "#!/bin/sh\ncat >/dev/null\nif [ \"$1\" = get ]; then printf 'username=fixture\\npassword=synthetic-https-token\\n\\n'; fi\n", { mode: 0o700 });
    writeFileSync(join(fixture, "h/.gitconfig"), `[credential]\n\thelper = ${join(fixture, "bin/credential-helper")}\n`, { mode: 0o600 });
    env.GIT_CONFIG_GLOBAL = join(fixture, "h/.gitconfig");
    const certificate = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", join(fixture, "tls-key.pem"), "-out", join(fixture, "tls-cert.pem"),
      "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com"], { env, encoding: "utf8" });
    assert.equal(certificate.status, 0, "Synthetic TLS certificate creation failed.");
    writeFileSync(join(fixture, "hosts"), "127.0.0.1 localhost github.com\n", { mode: 0o600 });
    git(fixture, ["--git-dir", bare, "config", "http.receivepack", "true"]);
  }
  const target = { schema: 1, id: "fixture-target", name: "Synthetic installed Sync",
    repository: gitMode === "ssh" ? "git@github.com:fixture/fixture.git" : "https://github.com/fixture/fixture.git", branch: "main",
    authentication: gitMode === "ssh" ? { method: "ssh", expectedLogin: "fixture", identityFile: join(fixture, "identity") }
      : { method: gitMode === "https" ? "https" : "vscode", expectedLogin: "fixture" },
    ...(skillsMount ? { skillsMount: { path: "Skills", adoption: "explicit" } } : {}),
    selection: { public: { skills: { items: [], folders: [""] } },
      private: privateSkills ? { skills: { items: [], folders: [""] } } : {} } };
  writeOriginalTarget(runtime, profile, target);
  const config = readFileSync(join(profile, "github-sync/targets.json"), "utf8");
  if (installedRace === "config") {
    const changed = JSON.parse(config);
    changed.targets[0].branch = "other";
    writeFileSync(join(fixture, "race-targets.json"), JSON.stringify(changed), { mode: 0o600 });
    const systemGit = spawnSync("which", ["git"], { env, encoding: "utf8" }).stdout.trim();
    assert(systemGit.startsWith("/") && !systemGit.includes("'"));
    writeFileSync(join(fixture, "bin/git"), `#!/bin/sh
'${systemGit}' "$@"
result=$?
case " $* " in
  *" commit-tree "*) if [ -f '${fixture}/config-race' ]; then rm '${fixture}/config-race'; cp '${fixture}/race-targets.json' '${profile}/github-sync/targets.json'; fi ;;
esac
exit "$result"
`, { mode: 0o700 });
  }
  const policy = { policyId: randomUUID(), owner: "fixture", repository: "fixture", branch: "main",
    secretRef: randomUUID(), expectedLogin: "fixture", visibility: privateSkills ? "private" : "public", allowPrivate: privateSkills,
    extensionVersion: "4.0.22", approvalId: randomUUID() };
  writeFileSync(join(fixture, "policy.json"), JSON.stringify(policy), { mode: 0o600 });
  const adoption = await import(pathToFileURL(join(runtime, "dist/legacy-root-adoption.js")));
  const adopted = await adoption.adoptLegacyRootInPlaceExperimental(root, privateSkills ? { snapshotAdmission: {
    authorityId: "synthetic-root-snapshot-authority", allowedTools: ["knowledge_snapshot_status"],
    authorize: binding => binding.workspaceRoot === root && binding.operation === "admit",
  } } : {});
  await adopted.storage.close();
  writeFileSync(join(fixture, "u/User/settings.json"), JSON.stringify({ "personalKnowledge.storePath": root,
    "personalKnowledge.openOnStartup": false, "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false }), { mode: 0o600 });
  writeFileSync(join(fixture, "driver/package.json"), JSON.stringify({ name: "native-sync-ui-driver", publisher: "fixture",
    version: "0.0.1", engines: { vscode: "^1.90.0" } }), { mode: 0o600 });
  const editor = process.env.PKM_VSCODE_EXECUTABLE || "/home/yuwang8/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code";
  const xvfb = process.env.PKM_TRIAL_XVFB || "/home/yuwang8/.cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb";
  let display, controller, code, httpsServer, hostsMounted = false, caMounted = false;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(done => child.once("exit", done));
    child.kill("SIGTERM"); await Promise.race([exited, wait(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  };
  const startController = async () => {
    rmSync(join(profile, "native-sync-ui.json"), { force: true });
    controller = spawn(process.execPath, [join(runtime, "dist/legacy-github-sync-ui-fixture.js")],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    controller.stdout.on("data", data => { output += data; });
    controller.stderr.on("data", data => { errors += data; });
    for (let attempt = 0; attempt < 300; attempt++) {
      if (output.includes("READY\n")) return;
      if (controller.exitCode !== null) throw new Error(`Sync controller exited: ${errors}`);
      await wait(100);
    }
    throw new Error(`Sync controller did not start: ${errors}`);
  };
  const startCode = async () => {
    rmSync(join(fixture, "driver-ready"), { force: true }); rmSync(join(fixture, "driver-done"), { force: true });
    code = spawn(editor, [join(fixture, "workspace"), "--no-sandbox", "--new-window",
      `--user-data-dir=${join(fixture, "u")}`, `--extensions-dir=${join(fixture, "x")}`,
      `--extensionDevelopmentPath=${join(fixture, "driver")}`, `--extensionTestsPath=${resolve("tests/legacy-github-sync-ui-secret.cjs")}`,
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-site-isolation-trials", "--disable-telemetry",
      "--disable-updates", "--skip-welcome", "--skip-release-notes", "--password-store=basic",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9337"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    for (const stream of [code.stdout, code.stderr]) stream.on("data", data => { if (errors.length < 8192) errors += data; });
    for (let attempt = 0; attempt < 300; attempt++) {
      if (code.exitCode !== null) throw new Error(`Private Code exited: ${errors}`);
      try { if (existsSync(join(fixture, "driver-ready")) && (await fetch("http://127.0.0.1:9337/json/list")).ok) return; } catch {}
      await wait(100);
    }
    throw new Error(`Private Code did not start: ${errors}`);
  };
  const ui = stage => {
    const run = spawnSync("python3", ["-B", resolve("tests/legacy-github-sync-ui.py"), stage],
      { env, encoding: "utf8", timeout: 90000 });
    assert.equal(run.status, 0, `${stage}: ${run.stderr}`);
  };
  const shutdownCode = async () => {
    writeFileSync(join(fixture, "driver-done"), "done", { mode: 0o600 });
    if (code.exitCode === null) {
      const exited = new Promise(done => code.once("exit", done));
      await Promise.race([exited, wait(15000)]);
      if (code.exitCode === null) await stop(code);
    }
    assert.equal(code.exitCode, 0, "Extension test host must exit cleanly.");
    code = undefined;
    await wait(1000);
  };
  const remoteEdit = text => {
    git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    const file = join(seed, remoteSkills, "One.md"), manifest = join(seed, remoteManifest);
    writeFileSync(file, readFileSync(file, "utf8") + text);
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    value.files.find(entry => entry.path === "skills/One.md").digest = digest(readFileSync(file));
    if (privateSkills && text === "remote pull\n") {
      const privateFile = join(seed, remoteSkills, "Private/Secret.md");
      writeFileSync(privateFile, content("Secret", "private remote pull"));
      value.files.find(entry => entry.path === privateItem.path).digest = digest(readFileSync(privateFile));
    }
    if (skillsMount && text === "remote pull\n") {
      const asset = join(seed, remoteSkills, "One.assets/icon.png");
      writeFileSync(asset, "remote synthetic asset");
      value.files.find(entry => entry.path === "skills/One.assets/icon.png").digest = digest(readFileSync(asset));
    }
    writeFileSync(manifest, JSON.stringify(value) + "\n");
    git(seed, ["add", "."]); git(seed, ["commit", "-qm", "remote"]); git(seed, ["push", "-q", "origin", "main"]);
  };
  symlinkSync(join(fixture, "t"), short, "dir");
  try {
    if (gitMode === "https") {
      const mountHosts = spawnSync("mount", ["--bind", join(fixture, "hosts"), "/etc/hosts"], { env, encoding: "utf8" });
      assert.equal(mountHosts.status, 0, "Private hosts mount failed."); hostsMounted = true;
      const mountCa = spawnSync("mount", ["--bind", join(fixture, "tls-cert.pem"), "/etc/ssl/certs/ca-certificates.crt"], { env, encoding: "utf8" });
      assert.equal(mountCa.status, 0, "Private CA mount failed."); caMounted = true;
      httpsServer = spawn(process.execPath, [resolve("tests/legacy-github-sync-https-server.mjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      httpsServer.stdout.on("data", data => { output += data; });
      for (let attempt = 0; attempt < 100 && !output.includes("READY\n"); attempt++) {
        if (httpsServer.exitCode !== null) throw new Error("Private HTTPS server exited.");
        await wait(50);
      }
      assert.match(output, /READY/);
    }
    const install = spawnSync(join(dirname(editor), "bin/code"), ["--no-sandbox", `--user-data-dir=${join(fixture, "u")}`,
      `--extensions-dir=${join(fixture, "x")}`, "--install-extension", vsix, "--force"],
    { env, encoding: "utf8", timeout: 120000 });
    assert.equal(install.status, 0, install.stderr);
    const installed = readdirSync(join(fixture, "x")).filter(name => /^uone\.personal-knowledge-/.test(name));
    assert.equal(installed.length, 1);
    const installedRuntime = join(fixture, "x", installed[0], "next-runtime/server");
    const compare = (source, target, relative = "") => {
      for (const entry of readdirSync(join(source, relative), { withFileTypes: true })) {
        const next = join(relative, entry.name);
        if (entry.isDirectory()) compare(source, target, next);
        else assert(entry.isFile() && readFileSync(join(source, next)).equals(readFileSync(join(target, next))),
          `Installed runtime differs at ${next}`);
      }
    };
    for (const name of ["dist", "compat", "browser"]) compare(join(runtime, name), join(installedRuntime, name));
    display = spawn(xvfb, [":93", "-screen", "0", "1440x1100x24", "-nolock", "-nolisten", "unix",
      "-nolisten", "local", "-listen", "tcp", "-ac"], { env, stdio: "ignore" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnSync("xdpyinfo", ["-display", "127.0.0.1:93"], { env, stdio: "ignore" }).status === 0) break;
      if (display.exitCode !== null || attempt === 99) throw new Error("Private X display unavailable.");
      await wait(50);
    }
    await startController(); await startCode();
    ui("initial");
    assert.equal(readFileSync(join(root, "skills/Remote.md"), "utf8"), content("Remote", "remote only"));
    assert.equal(git(fixture, ["--git-dir", bare, "show", `main:${remoteSkills}/One.md`]), content("One", "local conflict").trim());
    writeFileSync(join(root, "skills/One.md"), content("One", "local push"));
    if (skillsMount) writeFileSync(join(root, "skills/One.assets/icon.png"), "local synthetic asset");
    if (privateSkills) writeFileSync(join(root, "skills/Private/Secret.md"), content("Secret", "private local push"));
    ui("push"); assert.match(git(fixture, ["--git-dir", bare, "show", `main:${remoteSkills}/One.md`]), /local push/);
    if (privateSkills) assert.match(git(fixture, ["--git-dir", bare, "show", `main:${remoteSkills}/Private/Secret.md`]), /private local push/);
    if (skillsMount) assert.equal(git(fixture, ["--git-dir", bare, "show", `main:${remoteSkills}/One.assets/icon.png`]), "local synthetic asset");
    remoteEdit("remote pull\n"); ui("pull");
    assert.match(readFileSync(join(root, "skills/One.md"), "utf8"), /remote pull/);
    if (privateSkills) assert.match(readFileSync(join(root, "skills/Private/Secret.md"), "utf8"), /private remote pull/);
    if (skillsMount) assert.equal(readFileSync(join(root, "skills/One.assets/icon.png"), "utf8"), "remote synthetic asset");
    if (nativeTrash) {
      git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
      const manifestFile = join(seed, remoteManifest), value = JSON.parse(readFileSync(manifestFile, "utf8"));
      const members = value.files.filter(item => item.type === "skills" && item.itemId === "One");
      const document = readFileSync(join(seed, remoteSkills, "One.md"));
      const asset = readFileSync(join(seed, remoteSkills, "One.assets/icon.png"));
      value.files = value.files.filter(item => !(item.type === "skills" && item.itemId === "One"));
      value.deletions.push({ type: "skills", itemId: "One", category: "", privacy: "public", deletedAt: "2025-01-02T03:04:05.000Z" });
      rmSync(join(seed, remoteSkills, "One.md")); rmSync(join(seed, remoteSkills, "One.assets"), { recursive: true });
      writeFileSync(manifestFile, JSON.stringify(value) + "\n");
      git(seed, ["add", "-A"]); git(seed, ["commit", "-qm", "remote delete"]); git(seed, ["push", "-q", "origin", "main"]);
      ui("pull");
      const entries = readdirSync(join(root, "skills/.trash"));
      assert.equal(entries.length, 1);
      assert(readFileSync(join(root, "skills/.trash", entries[0], "payload")).equals(document));
      assert(readFileSync(join(root, "skills/.trash", entries[0], "assets/icon.png")).equals(asset));
      await shutdownCode(); await stop(controller); controller = undefined;
      await startController(); await startCode();
      git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
      const restored = JSON.parse(readFileSync(manifestFile, "utf8"));
      restored.deletions = restored.deletions.filter(item => !(item.type === "skills" && item.itemId === "One"));
      restored.files.push(...members);
      mkdirSync(join(seed, remoteSkills, "One.assets"));
      writeFileSync(join(seed, remoteSkills, "One.md"), document);
      writeFileSync(join(seed, remoteSkills, "One.assets/icon.png"), asset);
      writeFileSync(manifestFile, JSON.stringify(restored) + "\n");
      git(seed, ["add", "-A"]); git(seed, ["commit", "-qm", "remote restore"]); git(seed, ["push", "-q", "origin", "main"]);
      ui("pull");
      assert(readFileSync(join(root, "skills/One.md")).equals(document));
      assert(readFileSync(join(root, "skills/One.assets/icon.png")).equals(asset));
      assert.deepEqual(readdirSync(join(root, "skills/.trash")), []);
      assert.equal(readFileSync(join(root, "notes/Note.md"), "utf8"), localNote);
      assert.equal(readFileSync(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
    }
    writeFileSync(join(root, "skills/One.md"), readFileSync(join(root, "skills/One.md"), "utf8") + "later local conflict\n");
    remoteEdit("later remote conflict\n"); ui("conflict");
    assert.match(readFileSync(join(root, "skills/One.md"), "utf8"), /later remote conflict/);
    const grant = JSON.parse(readFileSync(join(profile, "native-sync-ui.json"), "utf8"));
    const armed = await fetch(`${grant.endpoint}sync`, { method: "POST",
      headers: { authorization: `Bearer ${grant.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "test-drop-response" }) });
    assert.equal(armed.status, 200);
    writeFileSync(join(root, "skills/One.md"), readFileSync(join(root, "skills/One.md"), "utf8") + "unknown result\n");
    ui("unknown");
    const pushed = git(fixture, ["--git-dir", bare, "rev-parse", "main"]);
    await shutdownCode(); await stop(controller); controller = undefined;
    await startController(); await startCode(); ui("recover");
    assert.equal(git(fixture, ["--git-dir", bare, "rev-parse", "main"]), pushed);
    const restartedGrant = JSON.parse(readFileSync(join(profile, "native-sync-ui.json"), "utf8"));
    const stateResponse = await fetch(`${restartedGrant.endpoint}sync`, { method: "POST",
      headers: { authorization: `Bearer ${restartedGrant.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "state" }) });
    assert.equal((await stateResponse.json()).value.pushes, 0, "Recovery must not repeat the unknown push.");
    assert.equal(readFileSync(join(root, "notes/Note.md"), "utf8"), localNote);
    assert.equal(readFileSync(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
    assert.equal(git(fixture, ["--git-dir", bare, "show", "main:notes/Note.md"]), remoteNote.trim());
    assert.equal(git(fixture, ["--git-dir", bare, "show", "main:prompts/Prompt.md"]), remotePrompt.trim());
    assert.equal(readFileSync(join(profile, "github-sync/targets.json"), "utf8"), config);
    if (installedRace) {
      const before = git(fixture, ["--git-dir", bare, "rev-parse", "main"]);
      const pushCount = readFileSync(join(fixture, "git-pushes"), "utf8").split("\n").filter(Boolean).length;
      if (installedRace === "cas") {
        git(seed, ["fetch", "-q", "origin", "main"]); git(seed, ["reset", "-q", "--hard", "FETCH_HEAD"]);
        git(seed, ["commit", "--allow-empty", "-qm", "concurrent"]);
        git(seed, ["push", "-q", "origin", "HEAD:refs/heads/race"]);
        writeFileSync(join(fixture, "git-race"), "race\n");
      } else writeFileSync(join(fixture, "config-race"), "race\n");
      writeFileSync(join(root, "skills/Private/Secret.md"), content("Secret", "race candidate"));
      ui("blocked");
      const expected = installedRace === "cas" ? git(seed, ["rev-parse", "HEAD"]) : before;
      assert.equal(git(fixture, ["--git-dir", bare, "rev-parse", "main"]), expected);
      assert.equal(readFileSync(join(fixture, "git-pushes"), "utf8").split("\n").filter(Boolean).length,
        pushCount + (installedRace === "cas" ? 1 : 0));
      if (installedRace === "config") writeFileSync(join(profile, "github-sync/targets.json"), config);
      rmSync(join(fixture, "git-race"), { force: true });
      await shutdownCode(); await stop(controller); controller = undefined;
      await startController(); await startCode(); ui("review");
      assert.equal(git(fixture, ["--git-dir", bare, "rev-parse", "main"]), expected);
      assert.equal(readFileSync(join(fixture, "git-pushes"), "utf8").split("\n").filter(Boolean).length,
        pushCount + (installedRace === "cas" ? 1 : 0));
    }
    if (process.env.PKM_TEST_LEGACY_DELETION_GUARD === "1") {
      assert(skillsMount);
      const state = join(root, ".pkm/state");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const journal = JSON.stringify({ schema: 1, records: [
        { path: "skills/One.md", deletedAt: "2025-01-02T03:04:05.000Z" },
        { path: "notes/Unknown.md", deletedAt: "2025-01-02T03:04:05.000Z", futureField: "preserve" },
      ], futureField: "preserve" }) + "\n";
      const file = join(state, "knowledge-deletions.json");
      const before = git(fixture, ["--git-dir", bare, "rev-parse", "main"]);
      const skill = readFileSync(join(root, "skills/One.md"));
      const asset = readFileSync(join(root, "skills/One.assets/icon.png"));
      const pushCount = readFileSync(join(fixture, "git-pushes"), "utf8");
      writeFileSync(file, journal, { mode: 0o600 });
      ui("blocked");
      assert.equal(readFileSync(file, "utf8"), journal);
      assert(readFileSync(join(root, "skills/One.md")).equals(skill));
      assert(readFileSync(join(root, "skills/One.assets/icon.png")).equals(asset));
      assert.equal(readFileSync(join(root, "notes/Note.md"), "utf8"), localNote);
      assert.equal(readFileSync(join(root, "prompts/Prompt.md"), "utf8"), localPrompt);
      assert.equal(readFileSync(join(fixture, "git-pushes"), "utf8"), pushCount);
      assert.equal(git(fixture, ["--git-dir", bare, "rev-parse", "main"]), before);
    }
    await shutdownCode();
  } finally {
    await stop(code); await stop(controller); await stop(display); await stop(httpsServer);
    if (caMounted) spawnSync("umount", ["/etc/ssl/certs/ca-certificates.crt"]);
    if (hostsMounted) spawnSync("umount", ["/etc/hosts"]);
    rmSync(short, { force: true });
  }
});
