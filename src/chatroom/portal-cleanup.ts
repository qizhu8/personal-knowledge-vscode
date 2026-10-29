import * as fs from "fs/promises";
import * as path from "path";
import type * as vscode from "vscode";

async function ifPresent<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function directoryAt(root: string, segments: string[]): Promise<string | undefined> {
  let directory = root;
  for (const segment of ["", ...segments]) {
    directory = path.join(directory, segment);
    const stat = await ifPresent(() => fs.lstat(directory));
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Legacy Portal cleanup cannot cross symbolic links or non-directories.");
  }
  return directory;
}

async function removeRegular(filename: string): Promise<void> {
  const stat = await ifPresent(() => fs.lstat(filename));
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Legacy Portal receipt is not a regular file; cleanup was not completed.");
  await ifPresent(() => fs.unlink(filename));
}

export async function cleanupLegacyPortals(state: vscode.Memento, secrets: vscode.SecretStorage, currentRoot: string): Promise<void> {
  const raw = await secrets.get("pkm.portal.resume.index");
  const ids: unknown = raw === undefined ? [] : JSON.parse(raw);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))) {
    throw new Error("Legacy Portal credential index is invalid; cleanup was not completed.");
  }
  const roots = new Set(currentRoot ? [currentRoot] : []);
  const keys = ids.map(id => `pkm.portal.resume.${id}`);
  for (const key of keys) {
    const value = await secrets.get(key);
    if (value === undefined) continue;
    const record: unknown = JSON.parse(value);
    if (!record || typeof record !== "object" || !("root" in record) || typeof record.root !== "string" || !path.isAbsolute(record.root)) {
      throw new Error("Legacy Portal credential root is invalid; cleanup was not completed.");
    }
    roots.add(record.root);
  }
  for (const value of roots) {
    const root = path.resolve(value);
    if (!path.isAbsolute(value) || path.parse(root).root === root) throw new Error("Refusing legacy Portal cleanup outside a Knowledge Root.");
    const directory = await directoryAt(root, [".pkm", "state", "peer-tasks"]);
    if (directory) {
      const names = await ifPresent(() => fs.readdir(directory)) || [];
      if (names.some(name => !/^[a-f0-9]{64}\.json$/.test(name))) throw new Error("Unexpected legacy Portal receipt file; cleanup was not completed.");
      for (const name of names) await removeRegular(path.join(directory, name));
      await ifPresent(() => fs.rmdir(directory));
    }
    const requests = await directoryAt(root, [".pkm", "state", "api-chat-control", "requests"]);
    if (!requests) continue;
    for (const host of await ifPresent(() => fs.readdir(requests)) || []) {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(host)) continue;
      const hostDirectory = await directoryAt(requests, [host]);
      if (!hostDirectory) continue;
      for (const name of await ifPresent(() => fs.readdir(hostDirectory)) || []) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const filename = path.join(hostDirectory, name);
        const stat = await ifPresent(() => fs.lstat(filename));
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Legacy Portal mailbox cleanup cannot cross symbolic links or non-files.");
        if (stat.size > 1024 * 1024) continue;
        const text = await ifPresent(() => fs.readFile(filename, "utf8"));
        if (text === undefined) continue;
        let record: Record<string, unknown>;
        try { record = JSON.parse(text); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          console.warn("Legacy Portal cleanup preserved a malformed shared IPC record.");
          continue;
        }
        if (record?.schema !== "pkm.api-chat.request/v1" || record.operation !== "portal"
          || record.hostId !== host || record.requestId + ".json" !== name) continue;
        await removeRegular(filename);
        await removeRegular(path.join(hostDirectory, name.replace(/\.json$/, ".submit.lock")));
      }
    }
  }
  for (const key of keys) await secrets.delete(key);
  await secrets.delete("pkm.portal.resume.index");
  await state.update("pkm.portal.connections.v1", undefined);
  await state.update("pkm.portal.windows.v1", undefined);
}
