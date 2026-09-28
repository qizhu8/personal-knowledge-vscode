const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const command = path.join(repoRoot, "scripts", "migrate-knowledge-v1.js");

function write(root, rel, frontmatter, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${typeof value === "string" || Array.isArray(value) ? JSON.stringify(value) : value}`);
  }
  lines.push("---", "", body);
  fs.writeFileSync(full, lines.join("\n"));
}

function run(root, operation, sourceDigest) {
  const args = [command, operation, "--root", root];
  if (sourceDigest) args.push("--source-digest", sourceDigest);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ? JSON.parse(result.stdout) : undefined,
    stderr: result.stderr ? JSON.parse(result.stderr) : undefined,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-migration-"));
  write(root, "skills/General/Useful Skill.md", { name: "Useful Skill", tags: ["test"] }, "Skill body.\n");
  write(root, "notes/Project/Decision.md", { title: "Decision", type: "general" }, "Note body.\n");
  write(root, "papers/Foundations/Parent.md", { title: "Parent", authors: ["A"] }, "Parent body.\n");
  write(root, "papers/Work/Child.md", {
    title: "Child",
    cites: [{ paper: "Parent", note: "uses it" }, { paper: "External Reference", note: "compatibility" }],
  }, "Child body.\n");
  return root;
}

function removeFixture(root) {
  const makeWritable = directory => {
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory()) return;
    fs.chmodSync(directory, 0o700);
    for (const name of fs.readdirSync(directory)) makeWritable(path.join(directory, name));
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

(() => {
  const root = fixture();
  try {
    const original = fs.readFileSync(path.join(root, "notes/Project/Decision.md"), "utf8");
    const preview = run(root, "preview");
    assert.strictEqual(preview.status, 0);
    assert.strictEqual(preview.stdout.receipt.files, 4);
    assert.deepStrictEqual(preview.stdout.receipt.citations, { total: 2, linked: 1, compatibilityOnly: 1 });
    const digest = preview.stdout.receipt.sourceDigest;

    assert.strictEqual(run(root, "stage", digest).status, 1, "stage must require an immutable backup");
    const backup = run(root, "backup", digest);
    assert.strictEqual(backup.status, 0);
    assert.strictEqual(backup.stdout.receipt.phase, "backed-up");
    for (const rel of backup.stdout.receipt.filesList) {
      assert.strictEqual(fs.statSync(path.join(backup.stdout.receipt.backupPath, rel)).mode & 0o777, 0o400);
    }

    assert.strictEqual(run(root, "stage", digest).status, 0);
    const verify = run(root, "verify", digest);
    assert.strictEqual(verify.status, 0, JSON.stringify(verify.stderr));
    const cutover = run(root, "cutover", digest);
    assert.strictEqual(cutover.status, 0, JSON.stringify(cutover.stderr));
    assert.strictEqual(run(root, "restart-verify", digest).status, 0);

    const migrated = fs.readFileSync(path.join(root, "papers/Work/Child.md"), "utf8");
    assert.match(migrated, /schema: "pkm\.knowledge\/v1"/);
    assert.match(migrated, /knowledgeId: "knowledge_[a-f0-9]{24}"/);
    assert.match(migrated, /"relation":"cites"/);
    assert.match(migrated, /"paper":"External Reference"/, "unresolved citations must remain as compatibility metadata");
    assert.match(migrated, /Child body\./);

    assert.strictEqual(run(root, "rollback", digest).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(root, "notes/Project/Decision.md"), "utf8"), original);
  } finally {
    removeFixture(root);
  }
})();

(() => {
  const root = fixture();
  try {
    const digest = run(root, "preview").stdout.receipt.sourceDigest;
    assert.strictEqual(run(root, "backup", digest).status, 0);
    fs.appendFileSync(path.join(root, "notes/Project/Decision.md"), "changed\n");
    const staged = run(root, "stage", digest);
    assert.strictEqual(staged.status, 1);
    assert.match(staged.stderr.error.message, /source changed/i);
  } finally {
    removeFixture(root);
  }
})();

console.log("Knowledge migration command tests passed.");
