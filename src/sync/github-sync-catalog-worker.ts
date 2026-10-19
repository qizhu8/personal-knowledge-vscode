import * as fs from "fs";
import * as path from "path";
import { isMainThread, parentPort, Worker, workerData } from "worker_threads";
import { agentSnapshotIsEncrypted, listAgentSnapshots } from "../agent-sessions/agent-snapshots";
import { isContentItemPrivate, PrivacyContentType, setPrivacyStoreRoot } from "../knowledge/content-privacy";
import { getStorePath, knowledgeFilePath, noteList, paperList, setStorePath as setFileStorePath, skillList } from "../knowledge/filestore";
import { GitHubSyncCatalog, GitHubSyncCatalogItem, githubSyncIsSystemItem, githubSyncIgnoredPath } from "./github-sync";
import { readSyncScriptIdentity } from "./github-sync-script-identity";
import { referencedMarkdownAssets } from "../knowledge/markdown-assets";
import { packageList, promptList, scriptGet, scriptIdentityFile, scriptList, setStorePath as setStoragePath } from "../knowledge/storage";

interface CatalogInput {
  root: string;
  servers: Array<{ slug: string; name: string; category: string; tags: string[] }>;
  recipes: GitHubSyncCatalogItem[];
}

export function githubSyncCatalogInWorker(input: CatalogInput): Promise<GitHubSyncCatalog> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: input });
    worker.once("message", (result: GitHubSyncCatalog) => resolve(result));
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`GitHub Sync catalog worker exited with code ${code}.`));
      else reject(new Error("GitHub Sync catalog worker exited without a result."));
    });
  });
}

function compactTags(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value !== "string") return "";
  try { return compactTags(JSON.parse(value)); } catch { return value; }
}

function githubSyncDestination(source: string): string {
  return path.relative(path.resolve(getStorePath()), path.resolve(source)).replace(/\\/g, "/");
}

function githubSyncItem(row: any, type: PrivacyContentType, source: string, destination = githubSyncDestination(source)): GitHubSyncCatalogItem {
  const dependencies = (["skills", "notes", "papers"] as PrivacyContentType[]).includes(type) && fs.existsSync(source)
    ? referencedMarkdownAssets(getStorePath(), type as "skills" | "notes" | "papers", destination.replace(new RegExp(`^${type}/`), ""), fs.readFileSync(source, "utf8"))
      .map(asset => ({ source: asset.fullPath, destination: `${type}/${asset.path}` }))
    : [];
  return {
    id: type === "skills" ? row.name : type === "prompts" ? `${row.project}/${row.task}` : type === "scripts" ? row.path : type === "packages" ? row.name : type === "servers" ? row.slug : row.slug,
    label: type === "skills" || type === "packages" ? row.name : type === "prompts" ? row.task : type === "scripts" ? row.file : type === "servers" ? row.name : row.title,
    cat: type === "prompts" ? row.project : type === "scripts" ? (row.category === "(root)" ? "" : row.category || "") : row.category || row.topic || "",
    meta: type === "skills" ? compactTags(row.tags) : type === "papers" ? [row.topic, row.year].filter(Boolean).join(" · ") : type === "scripts" ? row.lang : type === "packages" ? row.lang : type === "servers" ? (row.tags || []).join(", ") : row.type || row.latest || "",
    isPrivate: isContentItemPrivate(type, row),
    source,
    destination,
    ...(dependencies.length ? { dependencies } : {}),
  };
}

function buildCatalog({ root, servers, recipes }: CatalogInput): GitHubSyncCatalog {
  setFileStorePath(root);
  setStoragePath(root);
  setPrivacyStoreRoot(root);
  const skills = (skillList() as any[]).flatMap(row => {
    const source = knowledgeFilePath("skills", row.name);
    return source ? [githubSyncItem(row, "skills", source)] : [];
  });
  const notes = (noteList(undefined, Number.MAX_SAFE_INTEGER) as any[]).flatMap(row => {
    const source = knowledgeFilePath("notes", row.slug);
    return source ? [githubSyncItem(row, "notes", source)] : [];
  });
  const papers = (paperList() as any[]).flatMap(row => {
    const source = knowledgeFilePath("papers", row.slug);
    return source ? [githubSyncItem(row, "papers", source)] : [];
  });
  const prompts = promptList().map(row => githubSyncItem(row, "prompts", path.join(root, "prompts", row.project, row.task)));
  const scripts = (scriptList() as any[]).filter(row => !githubSyncIgnoredPath(`scripts/${row.path}`)).map(row => {
    let script: ReturnType<typeof scriptGet>;
    try { script = scriptGet(row.path); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      script = null;
    }
    const item = githubSyncItem(row, "scripts", path.join(root, "scripts", row.path));
    const sidecar = scriptIdentityFile(row.path);
    const identity = script || (fs.existsSync(sidecar) ? readSyncScriptIdentity(fs.readFileSync(sidecar)) : undefined);
    item.id = identity?.knowledgeId || row.path;
    item.identityAliases = identity?.aliases;
    item.legacyIds = [row.path];
    item.dependencies = [{ source: sidecar, destination: githubSyncDestination(sidecar) }];
    return item;
  });
  const packages = packageList().map((row: any) => githubSyncItem(row, "packages", path.join(root, "packages", row.name)));
  const serverItems = servers.map(row => githubSyncItem(row, "servers", path.join(root, "servers", row.slug)));
  const agentSnapshots = listAgentSnapshots(root).flatMap(snapshot => {
    if (!agentSnapshotIsEncrypted(root, snapshot.snapshotId)) return [];
    const source = path.join(root, ".pkm", "state", "agent-snapshots", `${snapshot.snapshotId}.json`);
    return [{
      id: snapshot.snapshotId,
      label: snapshot.task,
      cat: snapshot.agent?.name || "Agent",
      meta: `${snapshot.createdAt} · locally obfuscated`,
      isPrivate: true,
      source,
      destination: `agentSnapshots/${snapshot.snapshotId}.json`,
    }];
  });
  return {
    skills: skills.filter(item => !githubSyncIsSystemItem("skills", item)),
    notes: notes.filter(item => !githubSyncIsSystemItem("notes", item)),
    papers,
    prompts: prompts.filter(item => !githubSyncIsSystemItem("prompts", item)),
    scripts, packages, servers: serverItems,
    recipes: recipes.filter(item => !githubSyncIsSystemItem("recipes", item)),
    agentSnapshots,
  };
}

if (!isMainThread) parentPort!.postMessage(buildCatalog(workerData as CatalogInput));