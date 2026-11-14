import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkedApplyPath, makeApplyParents, safeRead } from "./domain/subscription-apply-files.js";
import { bundleError, bundleHash, bundlePath } from "./domain/subscription-bundle-validation.js";
import type { SubscriptionBundleApplyBoundary, SubscriptionBundleApplyPlan } from "./subscription-bundle-apply-contracts.js";

export function bundleApplyScan(root: string, ignored = new Set<string>()): SubscriptionBundleApplyPlan["baseline"] {
  const out: SubscriptionBundleApplyPlan["baseline"] = [];
  let bytes = 0, count = 0;
  const walk = (relative: string, depth: number) => {
    if (depth > 32) bundleError("QUOTA_EXCEEDED");
    const names = readdirSync(checkedApplyPath(root, relative)).sort(), folded = new Set<string>();
    for (const name of names) {
      if (++count > 8192 || folded.has(name.normalize("NFC").toLowerCase())) bundleError("RECOVERY_CONFLICT");
      folded.add(name.normalize("NFC").toLowerCase());
      const path = bundlePath(`${relative}/${name}`), full = checkedApplyPath(root, path), stat = lstatSync(full);
      if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) bundleError("RECOVERY_CONFLICT");
      if (ignored.has(path)) continue;
      if (stat.isDirectory()) { out.push({ path, sha256: null }); walk(path, depth + 1); }
      else {
        const file = safeRead(root, path)!;
        if (file.stat.nlink !== 1n || (bytes += file.bytes.length) > 33_554_432) bundleError("RECOVERY_CONFLICT");
        out.push({ path, sha256: bundleHash(file.bytes) });
      }
    }
  };
  for (const area of ["notes", "skills", "papers", "packages"]) {
    const full = checkedApplyPath(root, area);
    try {
      const stat = lstatSync(full);
      if (!stat.isDirectory() || stat.isSymbolicLink()) bundleError("RECOVERY_CONFLICT");
      walk(area, 0);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return out;
}
export function bundleApplyStage(plan: SubscriptionBundleApplyPlan, index: number): string {
  return `${dirname(plan.changes[index]!.path)}/.pkm-write-${plan.operationId}-b-${index}`;
}
export function observeBundleApply(root: string, plan: SubscriptionBundleApplyPlan): boolean[] {
  const ignored = new Set<string>(), generated = new Set<string>(), observed: boolean[] = [], stages: number[] = [];
  for (const [index, change] of plan.changes.entries()) {
    const stage = bundleApplyStage(plan, index);
    ignored.add(change.path); ignored.add(stage);
    const target = safeRead(root, change.path), staged = safeRead(root, stage);
    if (staged) {
      stages.push(index);
      if (bundleHash(staged.bytes) !== change.afterSha256 || ![1n, 2n].includes(staged.stat.nlink)) bundleError("RECOVERY_CONFLICT");
    }
    if (target && (bundleHash(target.bytes) !== change.afterSha256 || !(target.stat.nlink === 1n || staged
      && staged.stat.nlink === 2n && target.stat.nlink === 2n && staged.stat.ino === target.stat.ino && staged.stat.dev === target.stat.dev))) bundleError("RECOVERY_CONFLICT");
    if (staged?.stat.nlink === 2n && (!target || target.stat.ino !== staged.stat.ino || target.stat.dev !== staged.stat.dev)) bundleError("RECOVERY_CONFLICT");
    observed.push(!!target);
    for (let parent = dirname(change.path); parent !== "."; parent = dirname(parent)) generated.add(parent);
  }
  const absent = observed.indexOf(false);
  if (absent !== -1 && observed.slice(absent).some(Boolean) || stages.length > 1
    || stages.some(index => index > (absent === -1 ? observed.length - 1 : absent))) bundleError("RECOVERY_CONFLICT");
  const originalDirs = new Set(plan.baseline.filter(e => e.sha256 === null).map(e => e.path));
  const actual = bundleApplyScan(root, ignored).filter(e => e.sha256 !== null || !generated.has(e.path) || originalDirs.has(e.path));
  if (JSON.stringify(actual) !== JSON.stringify(plan.baseline)) bundleError("RECOVERY_CONFLICT");
  return observed;
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function publishBundleApply(root: string, plan: SubscriptionBundleApplyPlan, index: number,
  boundary: SubscriptionBundleApplyBoundary, fence: () => Promise<void>) {
  const change = plan.changes[index]!, stage = bundleApplyStage(plan, index);
  makeApplyParents(root, change.path, boundary);
  const fullStage = checkedApplyPath(root, stage), fullTarget = checkedApplyPath(root, change.path);
  if (!safeRead(root, stage) && !safeRead(root, change.path)) {
    await fence();
    observeBundleApply(root, plan);
    const fd = openSync(checkedApplyPath(root, stage), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, Buffer.from(change.afterBase64, "base64")); fsyncSync(fd); } finally { closeSync(fd); }
    boundary(`stage-fsync:${index}`); syncDirectory(dirname(fullStage)); boundary(`stage-dir-fsync:${index}`);
  }
  observeBundleApply(root, plan);
  await fence();
  observeBundleApply(root, plan);
  if (!safeRead(root, change.path)) {
    linkSync(fullStage, fullTarget); boundary(`publish:${index}`); syncDirectory(dirname(fullTarget)); boundary(`publish-fsync:${index}`);
  }
  observeBundleApply(root, plan);
  if (safeRead(root, stage)) { unlinkSync(fullStage); boundary(`unlink-stage:${index}`); syncDirectory(dirname(fullStage)); }
}
