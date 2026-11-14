import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { promisify } from "util";
import { tmpdir } from "os";

const execute = promisify(execFile);
export interface GitSource { url: string; branch: string; revision: string; }
const busy = new Set<string>();

async function git(directory: string, args: string[]): Promise<string> {
  const hooks = await fs.mkdtemp(path.join(tmpdir(), "pkm-empty-git-hooks-"));
  try {
    const { stdout } = await execute("git", [
    "-c", `core.hooksPath=${hooks}`,
    "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
    "-c", "filter.lfs.smudge=", "-c", "filter.lfs.required=false", ...args,
  ], { cwd:directory, timeout:120_000, maxBuffer:4 * 1024 * 1024,
    env:{ ...process.env, GIT_TERMINAL_PROMPT:"0", GIT_LFS_SKIP_SMUDGE:"1" }, windowsHide:true });
    return stdout.trim();
  } finally { await fs.rmdir(hooks); }
}

export function parseGitSource(value:unknown):GitSource {
  if (!value || typeof value !== "object" || !("url" in value) || !("branch" in value) || !("revision" in value)
    || typeof value.url !== "string" || typeof value.branch !== "string" || typeof value.revision !== "string"
    || !/^[a-f0-9]{40,64}$/.test(value.revision)) throw new Error("Invalid Git source provenance.");
  validateGitSource(value.url, value.branch);
  return { url:value.url, branch:value.branch, revision:value.revision };
}

export function validateGitSource(url: string, branch: string): void {
  if (!url || url !== url.trim() || /[\x00-\x20]/.test(url) || url.startsWith("-")) throw new Error("Enter a Git repository URL or absolute local path.");
  if (/^https:\/\//.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Do not embed credentials or tokens in repository URLs; use the host Git credential manager.");
  } else if (!/^git@[\w.-]+:[\w./-]+$/.test(url) && !/^ssh:\/\/git@[\w.-]+\/[\w./-]+$/.test(url) && !path.isAbsolute(url)) {
    throw new Error("Only HTTPS, Git SSH, and absolute local repositories are supported.");
  }
  if (!branch || branch.startsWith("-") || /[\s\x00-\x1f~^:?*[\]\\]/.test(branch) || branch.includes("..") || branch.includes("@{")) throw new Error("Enter an explicit valid branch name.");
}

/** A checkout is machine-local; importing never installs dependencies or starts code. */
export async function importGitSource(directory: string, url: string, branch: string): Promise<GitSource> {
  validateGitSource(url, branch);
  if (busy.has(directory)) throw new Error("This Git source is already being updated.");
  busy.add(directory);
  let created = false;
  try {
    await fs.mkdir(path.dirname(directory), { recursive:true });
    await git(path.dirname(directory), ["check-ref-format", "--branch", branch]);
    await fs.mkdir(directory);
    created = true;
    await git(path.dirname(directory), ["clone", "--no-checkout", "--no-local", "--single-branch", "--branch", branch, "--", url, directory]);
    if (/^160000 /m.test(await git(directory, ["ls-tree", "-r", "HEAD"]))) throw new Error("Repositories with submodules require a manually reviewed local checkout; recursive downloads are not automatic.");
    await git(directory, ["checkout", "--force", branch]);
    return { url, branch, revision:await git(directory, ["rev-parse", "HEAD"]) };
  } catch (error) {
    if (created) await fs.rm(directory, { recursive:true });
    throw error;
  } finally { busy.delete(directory); }
}

export async function updateGitSource(directory: string, source: GitSource): Promise<GitSource> {
  validateGitSource(source.url, source.branch);
  if (busy.has(directory)) throw new Error("This Git source is already being updated.");
  busy.add(directory);
  try {
    if (await git(directory, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Git source has local changes or untracked files. Commit, stash, or move them before updating.");
    if (await git(directory, ["symbolic-ref", "--short", "HEAD"]) !== source.branch) throw new Error("Checkout branch changed. Restore the configured branch before updating.");
    if (await git(directory, ["remote", "get-url", "origin"]) !== source.url) throw new Error("Git origin changed. Restore the configured origin before updating.");
    await git(directory, ["fetch", "--no-tags", "--", "origin", source.branch]);
    const remote = await git(directory, ["rev-parse", "FETCH_HEAD"]);
    if (/^160000 /m.test(await git(directory, ["ls-tree", "-r", remote]))) throw new Error("The remote branch contains submodules. Update refused; recursive downloads are not automatic.");
    const local = await git(directory, ["rev-parse", "HEAD"]);
    if (local !== remote) {
      try { await git(directory, ["merge-base", "--is-ancestor", local, remote]); }
      catch { throw new Error("Local history is ahead or diverged. Update refused; no reset, rebase, or merge was performed."); }
      await git(directory, ["merge", "--ff-only", "--no-edit", remote]);
    }

    return { ...source, revision:remote };
  } finally { busy.delete(directory); }
}

export async function assertGitSourceAncestor(directory:string, revision:string):Promise<void> {
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("Invalid recorded Git revision.");
  try { await git(directory, ["merge-base", "--is-ancestor", revision, "HEAD"]); }
  catch { throw new Error("The recorded package revision is no longer in this branch history. Update refused."); }
}
