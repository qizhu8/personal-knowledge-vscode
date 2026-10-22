import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { isMainThread, parentPort, Worker, workerData } from "worker_threads";
import { agentSnapshotIsEncrypted, listAgentSnapshots } from "../agent-sessions/agent-snapshots";
import { isContentItemPrivate, isTopLevelPrivate, PrivacyContentType, setPrivacyStoreRoot } from "../knowledge/content-privacy";
import { getStorePath, knowledgeFilePath, noteList, paperList, setStorePath as setFileStorePath, skillList } from "../knowledge/filestore";
import { GitHubSyncCatalog, GitHubSyncCatalogItem, githubSyncIsSystemItem, githubSyncIgnoredPath, githubSyncSafeRelativePath } from "./github-sync";
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
  const actionRoot = path.join(root, "actions");
  if (fs.existsSync(actionRoot) && fs.lstatSync(actionRoot).isSymbolicLink()) throw new Error("Action registry cannot be a symlink.");
  const actions: GitHubSyncCatalogItem[] = !fs.existsSync(actionRoot) ? [] : fs.readdirSync(actionRoot).filter(name => /^[a-z][a-z0-9_.-]+\.json$/.test(name)).map(name => {
    const source = path.join(actionRoot, name);
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Action definitions cannot be symlinks: ${name}`);
    const value = JSON.parse(fs.readFileSync(source, "utf8"));
    if (name !== `${value.action_id}.json`) throw new Error(`Action filename and identity disagree: ${name}`);
    return { id:value.action_id, label:value.display_name || value.action_id, cat:"", meta:`v${value.version} · definition only`,
      isPrivate:isTopLevelPrivate("actions", value.action_id), source, destination:`actions/${name}` };
  }).filter(item => !githubSyncIsSystemItem("actions", item));
  const moduleRoot = path.join(root, "action-module-sets");
  if (fs.existsSync(moduleRoot) && fs.lstatSync(moduleRoot).isSymbolicLink()) throw new Error("ModuleSet root cannot be a symlink.");
  const actionModules: GitHubSyncCatalogItem[] = [];
  if (fs.existsSync(moduleRoot)) for (const id of fs.readdirSync(moduleRoot)) {
    if (!/^[a-z][a-z0-9_.-]{2,100}$/.test(id) || /^(?:core|system)(?:[.]|$)/i.test(id)) continue;
    if (fs.lstatSync(path.join(moduleRoot, id)).isSymbolicLink()) throw new Error(`ModuleSet cannot be a symlink: ${id}`);
    for (const version of fs.readdirSync(path.join(moduleRoot, id))) {
      if (!/^[1-9]\d*$/.test(version)) continue;
      const destination = `action-module-sets/${id}/${version}`;
      const directory = path.join(root, destination);
      const source = path.join(directory, "manifest.json");
      if (!fs.existsSync(source)) continue;
      if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(source).isSymbolicLink()) throw new Error(`ModuleSet manifest cannot traverse symlinks: ${source}`);
      const manifest = JSON.parse(fs.readFileSync(source, "utf8"));
      if (manifest.schema !== "pkm.action.module-set/v1" || manifest.module_set_id !== id || manifest.version !== Number(version)
        || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error(`ModuleSet has an invalid file manifest: ${destination}`);
      const dependencies = Object.keys(manifest.files).map(member => {
        if (githubSyncSafeRelativePath(member) !== member || !/^(?:definitions|assets)\//.test(member)) throw new Error(`Invalid ModuleSet member: ${member}`);
        const file = path.join(directory, member);
        for (let current = file; current !== moduleRoot; current = path.dirname(current)) {
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`ModuleSet members cannot traverse symlinks: ${file}`);
        }
        if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== manifest.files[member]) throw new Error(`ModuleSet member hash mismatch: ${file}`);
        return { source:file, destination:`${destination}/${member}` };
      });
      actionModules.push({ id:`${id}/${version}`, label:manifest.name || id, cat:id, meta:`v${version} · loaded separately`,
        isPrivate:isTopLevelPrivate("action-module-sets", id), source, destination:`${destination}/manifest.json`, dependencies });
    }
  }
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
    actions,
    "action-module-sets":actionModules,
  };
}

if (!isMainThread) parentPort!.postMessage(buildCatalog(workerData as CatalogInput));