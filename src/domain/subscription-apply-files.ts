import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256 } from "../file-write.js";
import { knowledgeArea, resourcePath } from "../document-path.js";
import { applyConflict, portable, type SubscriptionApplyEntry, type SubscriptionApplyPlan } from "./subscription-apply-plan.js";

export type SubscriptionApplyBoundary = (event: string) => void;
const missing = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
export function applyRoot(root: string): string {
  root = resolve(root);
  if (realpathSync(root) !== root) applyConflict("Workspace root cannot traverse symlinks.");
  const marker = safeRead(root, ".pkm-next-workspace");
  if (!marker || JSON.parse(marker.bytes.toString("utf8")).schema !== "pkm.next-workspace/v2") applyConflict("An isolated v2 workspace is required.");
  return root;
}
export function checkedApplyPath(root: string, path: string): string {
  let current = root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const component = parts[index]!;
    if (!component || component === "." || component === ".." || component.includes("\\") || component.includes("\0")) applyConflict("Unsafe filesystem path.");
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) applyConflict("Linked filesystem ancestor.");
    if (readdirSync(current).some(name => name !== component && portable(name) === portable(component))) applyConflict("Portable filesystem collision.");
    current = join(current, component);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !(entry.isDirectory() || entry.isFile())) applyConflict("Linked or special filesystem entry.");
    } catch (error) {
      if (!missing(error)) throw error;
      return join(current, ...parts.slice(index + 1));
    }
  }
  return current;
}
export function safeRead(root: string, path: string) {
  const full = checkedApplyPath(root, path);
  let stat;
  try { stat = lstatSync(full, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 33_554_432n) applyConflict("Expected a bounded regular file.");
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }), bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    if (before.ino !== stat.ino || before.dev !== stat.dev || before.ctimeNs !== stat.ctimeNs
      || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) applyConflict("File changed while reading.");
    return { bytes, sha256: sha256(bytes), stat: after };
  } finally { closeSync(fd); }
}
export function stagePath(plan: SubscriptionApplyPlan, index: number) {
  const change = plan.material.changes[index]!;
  return `${change.area}/${dirname(change.path)}/.pkm-write-${plan.material.operationId}-${index}`;
}
export function scanApplyWorkspace(root: string, ignored = new Set<string>()): SubscriptionApplyEntry[] {
  const entries: SubscriptionApplyEntry[] = [];
  let bytes = 0, count = 0;
  function walk(area: typeof knowledgeArea.options[number], dir: string, prefix: string, depth: number) {
    if (depth > 32) applyConflict("Workspace depth limit.");
    const folded = new Set<string>();
    for (const name of readdirSync(dir).sort()) {
      if (++count > 8192 || folded.has(portable(name))) applyConflict("Workspace count or portable collision.");
      folded.add(portable(name));
      const path = prefix ? `${prefix}/${name}` : name, address = `${area}/${path}`;
      const stat = lstatSync(join(dir, name));
      if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) applyConflict("Linked or special workspace entry.");
      if (ignored.has(address)) continue;
      if (!resourcePath.safeParse(path).success) applyConflict("Unsafe workspace path.");
      if (stat.isDirectory()) {
        entries.push({ area, path, sha256: null });
        walk(area, join(dir, name), path, depth + 1);
      } else {
        const file = safeRead(root, address)!;
        if (file.stat.nlink !== 1n || (bytes += file.bytes.length) > 33_554_432) applyConflict("Linked or oversized workspace.");
        entries.push({ area, path, sha256: file.sha256 });
      }
    }
  }
  for (const area of knowledgeArea.options) {
    const full = checkedApplyPath(root, area);
    try {
      const stat = lstatSync(full);
      if (!stat.isDirectory()) applyConflict("Workspace area is not a directory.");
      walk(area, full, "", 0);
    } catch (error) { if (!missing(error) || area === "notes") throw error; }
  }
  return entries;
}
export function observeApplyWorkspace(root: string, plan: SubscriptionApplyPlan) {
  const ignored = new Set<string>(), generatedDirectories = new Set<string>();
  const observed: Array<string | null> = [];
  const stages: number[] = [];
  plan.material.changes.forEach((change, index) => {
    const address = `${change.area}/${change.path}`, stage = stagePath(plan, index);
    ignored.add(address); ignored.add(stage);
    const target = safeRead(root, address), staged = safeRead(root, stage);
    if (staged) stages.push(index);
    if (staged && (staged.sha256 !== change.afterSha256 || (staged.stat.nlink !== 1n && staged.stat.nlink !== 2n))) applyConflict("Unknown staged bytes.");
    if (target && (target.sha256 !== change.afterSha256 || (target.stat.nlink !== 1n && !(staged
      && staged.stat.nlink === 2n && target.stat.nlink === 2n && staged.stat.ino === target.stat.ino && staged.stat.dev === target.stat.dev)))) applyConflict("Unknown destination bytes or links.");
    if (staged?.stat.nlink === 2n && (!target || staged.stat.ino !== target.stat.ino || staged.stat.dev !== target.stat.dev)) applyConflict("Staging has an unknown hard link.");
    observed.push(target?.sha256 ?? null);
    let parent = dirname(address);
    while (parent !== change.area && parent !== ".") { generatedDirectories.add(parent); parent = dirname(parent); }
  });
  const firstAbsent = observed.findIndex(value => value === null);
  if (stages.length > 1 || stages.some(index => index > (firstAbsent < 0 ? observed.length - 1 : firstAbsent))) applyConflict("Out-of-order staged state.");
  const baselineDirectories = new Set(plan.baseline.filter(item => item.sha256 === null).map(item => `${item.area}/${item.path}`));
  const actual = scanApplyWorkspace(root, ignored).filter(item =>
    item.sha256 !== null || !generatedDirectories.has(`${item.area}/${item.path}`) || baselineDirectories.has(`${item.area}/${item.path}`));
  if (JSON.stringify(actual) !== JSON.stringify(plan.baseline)) applyConflict("Workspace baseline changed.");
  return observed;
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function makeApplyParents(root: string, path: string, boundary: SubscriptionApplyBoundary) {
  const parts = path.split("/").slice(0, -1);
  for (let index = 1; index <= parts.length; index++) {
    const relative = parts.slice(0, index).join("/"), full = checkedApplyPath(root, relative);
    try { mkdirSync(full, { mode: 0o700 }); boundary(`mkdir:${relative}`); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    if (!lstatSync(full).isDirectory()) applyConflict("Parent is not a directory.");
    syncDirectory(dirname(full)); boundary(`mkdir-sync:${relative}`);
  }
}
export async function publishApplyFile(root: string, plan: SubscriptionApplyPlan, index: number, boundary: SubscriptionApplyBoundary, beforePublish: () => Promise<void>) {
  const change = plan.material.changes[index]!, address = `${change.area}/${change.path}`, stage = stagePath(plan, index);
  makeApplyParents(root, address, boundary);
  const temporary = checkedApplyPath(root, stage);
  if (!safeRead(root, stage) && !safeRead(root, address)) {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, Buffer.from(change.afterBase64, "base64")); boundary(`stage-write:${index}`); fsyncSync(fd); boundary(`stage-sync:${index}`); }
    finally { closeSync(fd); }
  }
  await beforePublish();
  const full = checkedApplyPath(root, address);
  const staged = safeRead(root, stage), target = safeRead(root, address);
  if (staged && staged.sha256 !== change.afterSha256 || target && target.sha256 !== change.afterSha256) applyConflict("Unknown file state before publication.");
  if (!target) {
    if (!staged) applyConflict("Missing staged bytes.");
    const fd = openSync(checkedApplyPath(root, stage), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    // link is atomic and exclusive, unlike rename, which can overwrite a concurrently-created file.
    linkSync(checkedApplyPath(root, stage), full); boundary(`publish:${index}`);
  }
  syncDirectory(checkedApplyPath(root, dirname(address))); boundary(`publish-sync:${index}`);
  if (staged) {
    const cleanup = safeRead(root, stage);
    if (!cleanup || cleanup.sha256 !== change.afterSha256) applyConflict("Staging changed before cleanup; preserve unknown bytes.");
    unlinkSync(checkedApplyPath(root, stage)); boundary(`stage-unlink:${index}`);
  }
  syncDirectory(checkedApplyPath(root, dirname(address))); boundary(`cleanup-sync:${index}`);
}
