import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Persistent private-workspace lease. An abandoned or changed lease is never inferred dead. */
export function acquirePrivateNextMcpLease(parent: string) {
  const directory = path.join(parent, ".pkm-private-next-mcp-owner");
  fs.mkdirSync(directory, { mode: 0o700 });
  const syncDirectory = (filename: string) => {
    const fd = fs.openSync(filename, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  syncDirectory(parent);
  const record = JSON.stringify({ schema: "pkm.private-next-mcp-owner/v1", nonce: randomUUID() });
  const file = path.join(directory, "owner.json");
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, record); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(directory);
  const directoryStat = fs.lstatSync(directory), fileStat = fs.lstatSync(file);
  let released = false;
  return {
    release() {
      if (released) throw new Error("Private Next MCP lease is already released.");
      const currentDir = fs.lstatSync(directory), currentFile = fs.lstatSync(file);
      if (!currentDir.isDirectory() || currentDir.isSymbolicLink() || currentDir.dev !== directoryStat.dev
        || currentDir.ino !== directoryStat.ino || !currentFile.isFile() || currentFile.nlink !== 1
        || currentFile.dev !== fileStat.dev || currentFile.ino !== fileStat.ino
        || fs.readFileSync(file, "utf8") !== record
        || JSON.stringify(fs.readdirSync(directory)) !== '["owner.json"]')
        throw new Error("Private Next MCP lease changed; preserve it for review.");
      fs.unlinkSync(file);
      fs.rmdirSync(directory);
      syncDirectory(parent);
      released = true;
    },
  };
}
