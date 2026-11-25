import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

test("Git-bearing original roots refuse private writes before backed protection and fence real Core writes if the retained policy changes", async t => {
  const directory = resolve("tests", `.private-native-state-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = String.raw`
  (async()=>{
  const assert=(await import("node:assert/strict")).default;
  const {createHash,randomUUID}=await import("node:crypto");
  const {mkdir,readFile,readdir,writeFile,lstat}=await import("node:fs/promises");
  const {join}=await import("node:path");
  const {execFileSync}=await import("node:child_process");
  const {acquireOriginalMcpRootFence,captureOriginalMcpCustody,openOriginalMcpRoot,prepareOriginalMcpRoot}
    =await import(${JSON.stringify(new URL("../dist/original-mcp-root.js", import.meta.url).href)});
  const {planOriginalMcpGitProtection,applyOriginalMcpGitProtection}
    =await import(${JSON.stringify(new URL("../dist/original-mcp-git-protection.js", import.meta.url).href)});
  const {acquireLinuxRootWriterFence}
    =await import(${JSON.stringify(new URL("../dist/linux-root-writer-fence.js", import.meta.url).href)});
  const directory=process.argv[1],root=join(directory,"root");
  async function run(){
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".pkm"), { mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal source.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  await writeFile(join(root, ".gitignore"), "# Retained original policy\n", { mode: 0o640 });
  execFileSync("/usr/bin/git", ["init", "--quiet", root], { env: { PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const request = { root, operatorId: "fixture-operator", profileSha256: createHash("sha256").update("profile").digest("hex"),
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } };
  const unprotected = await captureOriginalMcpCustody({ ...request, backup: join(directory, "before-protection-custody") });
  await assert.rejects(prepareOriginalMcpRoot(unprotected), /Git protection must be applied/);
  assert(!(await readdir(root)).includes(".pkm-next-original-mcp.json"));
  assert(!(await readdir(root)).includes("core.sqlite"));
  const fence = await acquireOriginalMcpRootFence(root);
  const guard = await applyOriginalMcpGitProtection(planOriginalMcpGitProtection(root), {
    writerFence: fence, backupDirectory: join(directory, "git-policy-backup"),
  });
  const plan = await captureOriginalMcpCustody({ ...request, backup: join(directory, "protected-custody") }, { writerFence: fence });
  const opened = await openOriginalMcpRoot(plan, { writerFence: fence, gitProtection: guard });
  const owner = opened.owner;
  const { runtime } = await owner.ensureFull();
  assert.equal(execFileSync("/usr/bin/git", ["-C", root, "check-ignore", "core.sqlite"], { encoding: "utf8" }).trim(), "core.sqlite");
  const protectedPolicy = await readFile(join(root, ".gitignore"));
  await writeFile(join(root, ".gitignore"), Buffer.concat([protectedPolicy, Buffer.from("# unexpected policy edit\n")]), { mode: 0o640 });
  const response = await runtime.core.dispatch("capability_call", {
    operation: "knowledge.document.create", version: 1, arguments: {
      operationId: randomUUID(), id: "refused-native-write", area: "notes", path: "Refused.md",
      title: "Refused", content: "No new private or business state may be written.",
    },
  }, { id: "mcp:external", canWrite: true });
  assert(response.error);
  await assert.rejects(lstat(join(root, "notes/Refused.md")), { code: "ENOENT" });
  assert.throws(() => opened.storage.assertWorkspaceLease());
  assert.match((await readFile(join(root, ".gitignore"))).toString(), /BEGIN PKM v5 private runtime state/);
  await assert.rejects(owner.close());
  await assert.rejects(acquireLinuxRootWriterFence(root,100),/fence/);
  }
  run().then(()=>process.stdout.write("guard-fenced-and-owned-crash-fixture-complete\n",()=>process.exit(0)),
    error=>{console.error(error);process.exit(1)});
  })().catch(error=>{console.error(error);process.exit(1)});
  `;
  const output = execFileSync(process.execPath, ["-e", script, directory],
    { encoding: "utf8", timeout: 20_000 });
  assert.match(output, /guard-fenced-and-owned-crash-fixture-complete/);
});
