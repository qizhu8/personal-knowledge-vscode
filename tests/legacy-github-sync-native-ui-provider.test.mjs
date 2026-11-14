import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const dist = resolve(process.env.PKM_TEST_NEXT_DIST || "dist");
const { privateNativeGitUiProvider } = await import(pathToFileURL(join(dist, "legacy-github-sync-native-ui-provider.js")));

test("private Git fixture refuses symlinked legacy target sources before reading them", async t => {
  const dir = resolve(".migration-test-work", `git-ui-binding-${randomUUID()}`);
  const profile = join(dir, "profile"), sync = join(profile, "github-sync"), external = join(dir, "external.json");
  await mkdir(sync, { recursive: true, mode: 0o700 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(external, "not a target\n", { mode: 0o600 });
  await symlink(external, join(sync, "targets.json"));
  assert.throws(() => privateNativeGitUiProvider(dir, profile, {}), /Private Git target denied/);
  await rm(join(sync, "targets.json"));
  await rm(sync, { recursive: true });
  await symlink(dir, sync, "dir");
  assert.throws(() => privateNativeGitUiProvider(dir, profile, {}), /Private Git target directory denied/);
});
