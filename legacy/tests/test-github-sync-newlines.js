const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const sync = require("../dist/sync/github-sync");
const conflicts = require("../dist/sync/github-sync-conflicts");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-sync-newlines-"));
const git = (cwd, args, binary = false) => execFileSync("git",
  ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: binary ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"] });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
let cases = 0;
(async () => {
  try {
    for (const autocrlf of ["false", "true"]) {
      const directory = path.join(root, autocrlf), seed = path.join(directory, "seed"), remote = path.join(directory, "remote.git");
      fs.mkdirSync(seed, { recursive: true });
      git(seed, ["init", "-q"]); git(seed, ["config", "user.name", "Fixture"]); git(seed, ["config", "user.email", "fixture@example.invalid"]);
      put(path.join(seed, "README.md"), "isolated fixture\n");
      git(seed, ["add", "."]); git(seed, ["commit", "-qm", "seed"]); git(seed, ["branch", "-M", "main"]);
      git(directory, ["clone", "--bare", "-q", seed, remote]);
      const store = path.join(directory, "store"), checkouts = path.join(directory, "checkouts");
      fs.mkdirSync(store);
      const catalog = Object.fromEntries(sync.GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
      const samples = [
        ["[CG] [AdsBrain] Partition Data/script.script", Buffer.from("\uFEFFfirst\r\nsecond\r\n"), Buffer.from("\uFEFFfirst\nsecond\n")],
        ["document.MD", Buffer.from("first\r\nsecond\n"), Buffer.from("first\nsecond\n")],
        ["README.rst", Buffer.from("title\r\n=====\r\n"), Buffer.from("title\n=====\n")],
        ["metadata.json", Buffer.from('{"value":1}\r\n'), Buffer.from('{"value":1}\n')],
        ["run.sh", Buffer.from("#!/bin/sh\r\necho fixture\r\n"), Buffer.from("#!/bin/sh\necho fixture\n")],
        ["opaque.unknown", Buffer.from("preserve\r\n"), Buffer.from("preserve\r\n")],
        ["binary.png", Buffer.from("looks text-like\r\n"), Buffer.from("looks text-like\r\n")],
        ["invalid.py", Buffer.from([255, 13, 10]), Buffer.from([255, 13, 10])],
        ["contains-nul.txt", Buffer.from("nul\0\r\n"), Buffer.from("nul\0\r\n")],
      ];
      for (const [name, original] of samples) {
        const relative = "scripts/" + name, source = path.join(store, relative);
        put(source, original);
        catalog.scripts.push({ id: name, cat: "", isPrivate: false, source, destination: relative });
      }
      const target = sync.normalizeGitHubSyncTarget({ name: "Fixture", repository: remote, branch: "main" }, () => "fixture");
      target.selection.public.scripts.folders = [""];
      const remember = result => { target.lastSync = { at: new Date().toISOString(), commit: result.commit,
        repository: remote, branch: "main", storeRoot: store, fingerprints: result.fingerprints }; };
      remember(await sync.syncGitHubTarget(target, catalog, checkouts, undefined, store));
      const checkout = path.join(checkouts, target.id, "repository");
      git(checkout, ["config", "core.autocrlf", autocrlf]);
      git(checkout, ["config", "core.eol", "crlf"]);
      remember(await sync.syncGitHubTarget(target, catalog, checkouts, undefined, store));
      const manifest = JSON.parse(git(directory, ["--git-dir", remote, "show", "main:.pkm-github-sync.json"]));
      for (const [name, original, expected] of samples) {
        const relative = "scripts/" + name;
        const actual = git(directory, ["--git-dir", remote, "show", "main:" + relative], true);
        assert(actual.equals(expected), relative);
        assert.equal(manifest.files.find(file => file.path === relative).digest, hash(actual));
        assert(fs.readFileSync(path.join(store, relative)).equals(original), "Sync must not bulk-rewrite unchanged Local sources");
        cases++;
      }
      assert.equal((await sync.syncGitHubTarget(target, catalog, checkouts, undefined, store)).changed, false);
      // Recreate an old, byte-valid CRLF Remote and prove normal guarded Pull writes LF.
      const editor = path.join(directory, "editor");
      git(directory, ["clone", "-q", remote, editor]); git(editor, ["config", "user.name", "Fixture"]); git(editor, ["config", "user.email", "fixture@example.invalid"]);
      const relative = "scripts/[CG] [AdsBrain] Partition Data/script.script";
      const remoteEdit = Buffer.from("\uFEFFfirst\r\nremote edited\r\n");
      put(path.join(editor, relative), remoteEdit);
      const edited = JSON.parse(fs.readFileSync(path.join(editor, ".pkm-github-sync.json")));
      edited.files.find(file => file.path === relative).digest = hash(remoteEdit);
      const ignoredPath = "scripts/document.MD", ignoredBytes = Buffer.from("ignored remote\r\n");
      put(path.join(editor, ignoredPath), ignoredBytes);
      edited.files.find(file => file.path === ignoredPath).digest = hash(ignoredBytes);
      put(path.join(store, ".gitignore"), ignoredPath + "\n");
      put(path.join(editor, ".pkm-github-sync.json"), JSON.stringify(edited));
      git(editor, ["-c", "core.autocrlf=false", "add", "."]); git(editor, ["commit", "-qm", "historical CRLF remote"]);
      git(editor, ["push", "-q", "origin", "main"]);
      const result = await sync.syncGitHubTarget(target, catalog, checkouts, undefined, store);
      remember(result);
      const expected = Buffer.from("\uFEFFfirst\nremote edited\n");
      assert(fs.readFileSync(path.join(store, relative)).equals(expected));
      assert(git(directory, ["--git-dir", remote, "show", "main:" + relative], true).equals(expected));
      assert(git(directory, ["--git-dir", remote, "show", "main:" + ignoredPath], true).equals(ignoredBytes),
        "Excluded Remote content must not be normalized");
      assert(fs.readFileSync(path.join(store, ignoredPath)).equals(samples[1][1]),
        "Ignored Local sources must not be replaced");
      assert.equal((await sync.syncGitHubTarget(target, catalog, checkouts, undefined, store)).changed, false);
      cases++;
      const record = new sync.GitHubSyncConflictError(result.commit, [{
        path: relative, type: "scripts", itemId: relative, category: "", privacy: "public",
        base: Buffer.from("base\n"), local: Buffer.from("local\r\n"), remote: Buffer.from("remote\n"),
      }]);
      conflicts.storeGitHubSyncConflict(directory, "candidate", record);
      conflicts.saveGitHubSyncManualCandidate(directory, "candidate", relative, "\uFEFFapproved\r\n");
      assert(conflicts.readGitHubSyncConflictCandidate(directory, "candidate", relative, true).equals(Buffer.from("\uFEFFapproved\n")));
      put(conflicts.gitHubSyncConflictVariantPath(directory, "candidate", "merged", relative), "\uFEFFtampered\r\n");
      assert.throws(() => conflicts.readGitHubSyncConflictCandidate(directory, "candidate", relative, true), /changed after validation/);
      cases++;
      const committed = git(directory, ["--git-dir", remote, "rev-parse", "main"]).trim();
      let injected = false;
      await assert.rejects(() => sync.syncGitHubTarget(target, catalog, checkouts, undefined, store, (phase, detail) => {
        if (!injected && detail.startsWith("Checking ")) {
          injected = true;
          put(path.join(checkout, ".git/info/attributes"), "scripts/opaque.unknown text\n");
          put(path.join(checkout, "scripts/opaque.unknown"), "preserve\r\n");
        }
      }), /Staged content differs from the validated Sync plan: scripts\/opaque.unknown/);
      assert(injected);
      assert.equal(git(directory, ["--git-dir", remote, "rev-parse", "main"]).trim(), committed,
        "A Git attribute changing preserve-policy bytes must fail before push");
      cases++;
    }
    console.log(`Sync LF policy passed: ${cases} checks across autocrlf true/false, BOM scripts, suffix rules, strict blob digests, byte-preserved exclusions, historical CRLF Pull, approved candidates and idempotent resync.`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
