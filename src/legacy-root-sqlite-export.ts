import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Storage } from "./storage.js";
import { type WorkspaceBackupHostAdapter } from "./workspace-backup.js";

/**
 * Export a consistent SQLite snapshot, not an old-format workspace or a
 * reconciliation. The host must actually stop admission and drain its work.
 */
export async function exportLegacyRootSqliteSnapshotExperimental(
  storage: Storage, destination: string, host: WorkspaceBackupHostAdapter,
): Promise<{ path: string; workspaceId: string; sha256: string; qualification: "experimental-unqualified" }> {
  if (process.platform !== "linux" || !isAbsolute(destination) || resolve(destination) !== destination
    || !host || typeof host.acquireQuiescence !== "function")
    throw new Error("SQLite export requires Linux, an absolute destination, and a quiescence host.");
  const root = await realpath(storage.workspaceRoot());
  const member = relative(root, destination);
  if (!member || member !== ".." && !member.startsWith(`..${sep}`))
    throw new Error("SQLite export must be outside the source workspace.");
  const parent = dirname(destination), parentReal = await realpath(parent);
  const parentStat = await lstat(parent, { bigint: true });
  if (parentReal !== parent || !parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o077n) !== 0n || process.getuid === undefined
    || parentStat.uid !== BigInt(process.getuid()))
    throw new Error("SQLite export destination directory must be canonical, private, and owned by the current user.");
  const scheduler = await storage.acquireNativeSnapshotSchedulerQuiescence();
  let lease: Awaited<ReturnType<WorkspaceBackupHostAdapter["acquireQuiescence"]>> | undefined;
  try {
    lease = await host.acquireQuiescence();
    if (!lease || typeof lease.assertHeld !== "function" || typeof lease.release !== "function")
      throw new Error("SQLite export requires a live host quiescence lease.");
    return await storage.withWorkspaceExclusive(async () => {
      lease!.assertHeld();
      scheduler?.assertHeld();
      storage.assertWorkspaceLease();
      const workspaceId = await storage.workspaceId();
      const source = storage.connectNative();
      const stage = join(parent, `.pkm-sqlite-export-${randomUUID()}.sqlite`);
      let stageCreated = false;
      let stageIdentity: { dev: bigint; ino: bigint } | undefined;
      try {
        const main = source.prepare("PRAGMA database_list").all().find(row => row.name === "main");
        if (!main?.file || await realpath(String(main.file)) !== join(root, "core.sqlite"))
          throw new Error("SQLite export source is not the selected workspace database.");
        const before = source.prepare("PRAGMA data_version").get()?.data_version;
        const handle = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        stageCreated = true;
        try {
          const stat = await handle.stat({ bigint: true });
          stageIdentity = { dev: stat.dev, ino: stat.ino };
        } finally { await handle.close(); }
        await backup(source, stage);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          try {
            await lstat(stage + suffix);
            stageCreated = false;
            throw new Error("SQLite export left a sidecar; preserve the stage for reconciliation.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        lease!.assertHeld();
        scheduler?.assertHeld();
        storage.assertWorkspaceLease();
        if (source.prepare("PRAGMA data_version").get()?.data_version !== before)
          throw new Error("SQLite source changed during export; snapshot was not published.");
        const file = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat({ bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n
            || stat.uid !== BigInt(process.getuid!()) || stat.dev !== parentStat.dev
            || stat.dev !== stageIdentity?.dev || stat.ino !== stageIdentity.ino)
            throw new Error("SQLite export stage is unsafe.");
          await file.sync();
        } finally { await file.close(); }
        const snapshotUrl = pathToFileURL(stage);
        snapshotUrl.search = "?immutable=1";
        const snapshot = new DatabaseSync(snapshotUrl, { readOnly: true });
        try {
          if (snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
            throw new Error("SQLite export failed integrity check.");
        } finally { snapshot.close(); }
        const parentNow = await lstat(parent, { bigint: true });
        if (parentNow.dev !== parentStat.dev || parentNow.ino !== parentStat.ino || parentNow.mode !== parentStat.mode
          || parentNow.uid !== parentStat.uid || await realpath(parent) !== parent)
          throw new Error("SQLite export destination directory changed.");
        lease!.assertHeld();
        scheduler?.assertHeld();
        storage.assertWorkspaceLease();
        if (source.prepare("PRAGMA data_version").get()?.data_version !== before)
          throw new Error("SQLite source changed before publication; snapshot was not published.");
        const stageNow = await lstat(stage, { bigint: true });
        if (!stageNow.isFile() || stageNow.nlink !== 1n || stageNow.dev !== stageIdentity?.dev
          || stageNow.ino !== stageIdentity.ino || (stageNow.mode & 0o077n) !== 0n)
          throw new Error("SQLite export stage changed before publication.");
        const sha256 = await hashPrivateSqliteSnapshot(stage);
        lease!.assertHeld();
        scheduler?.assertHeld();
        storage.assertWorkspaceLease();
        if (source.prepare("PRAGMA data_version").get()?.data_version !== before)
          throw new Error("SQLite source changed during snapshot hashing; snapshot was not published.");
        await link(stage, destination);
        const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await directory.sync(); } finally { await directory.close(); }
        await unlink(stage);
        stageCreated = false;
        return { path: destination, workspaceId, sha256, qualification: "experimental-unqualified" as const };
      } finally {
        source.close();
        if (stageCreated) {
          try {
            const current = await lstat(stage, { bigint: true });
            if (stageIdentity && current.dev === stageIdentity.dev && current.ino === stageIdentity.ino && current.isFile())
              await unlink(stage);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
    });
  } finally {
    try { await lease?.release(); } finally { await scheduler?.release(); }
  }
}

        async function hashPrivateSqliteSnapshot(path: string): Promise<string> {
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const before = await file.stat({ bigint: true });
            if (!before.isFile() || before.nlink !== 1n || before.size > 536_870_912n
              || (before.mode & 0o077n) !== 0n || process.getuid === undefined || before.uid !== BigInt(process.getuid()))
              throw new Error("SQLite snapshot must be a bounded, private, owner-controlled regular file.");
            const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
            for (;;) {
              const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              hash.update(buffer.subarray(0, bytesRead));
            }
            const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
            if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
              || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink
              || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
              || named.dev !== before.dev || named.ino !== before.ino)
              throw new Error("SQLite snapshot changed while reading.");
            return hash.digest("hex");
          } finally { await file.close(); }
        }

        export async function inspectLegacyRootSqliteSnapshotExperimental(
          path: string, expectedSha256: string, query?: { table: string; offset: number; limit: number },
        ): Promise<{ tables: string[]; rows?: unknown[]; nextOffset?: number }> {
          if (process.platform !== "linux" || !isAbsolute(path) || resolve(path) !== path
            || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("A canonical path and exact snapshot digest are required.");
          const parent = dirname(path), info = await lstat(parent, { bigint: true });
          if (await realpath(parent) !== parent || !info.isDirectory() || info.isSymbolicLink()
            || (info.mode & 0o077n) !== 0n || process.getuid === undefined || info.uid !== BigInt(process.getuid()))
            throw new Error("SQLite snapshot directory is not private.");
          if (await hashPrivateSqliteSnapshot(path) !== expectedSha256) throw new Error("SQLite snapshot digest changed.");
          const url = pathToFileURL(path);
          url.search = "?immutable=1";
          const db = new DatabaseSync(url, { readOnly: true });
          try {
            if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("SQLite snapshot is corrupt.");
            const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
              .all().filter(row => typeof row.name === "string" && typeof row.sql === "string"
                && !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql)).map(row => String(row.name));
            if (!query) {
              if (await hashPrivateSqliteSnapshot(path) !== expectedSha256) throw new Error("SQLite snapshot changed during inspection.");
              return { tables };
            }
            if (!tables.includes(query.table) || !Number.isSafeInteger(query.offset) || query.offset < 0
              || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100
              || !Number.isSafeInteger(query.offset + query.limit))
              throw new Error("Snapshot query must select a known ordinary table and a bounded page.");
            const statement = db.prepare(`SELECT * FROM "${query.table.replaceAll('"', '""')}" LIMIT ? OFFSET ?`);
            statement.setReadBigInts(true);
            let bytes = 0, hasMore = false;
            const rows: unknown[] = [];
            for (const row of statement.iterate(query.limit + 1, query.offset)) {
              if (rows.length === query.limit) { hasMore = true; break; }
              const values = Object.entries(row).map(([name, value]) => {
                const encoded = value === null ? { type: "null" } : typeof value === "bigint" ? { type: "integer", value: value.toString() }
                  : typeof value === "number" ? { type: "real", value: Object.is(value, -0) ? "-0" : String(value) }
                    : typeof value === "string" ? { type: "text", value }
                      : value instanceof Uint8Array ? { type: "blob", base64: Buffer.from(value).toString("base64") }
                        : undefined;
                if (!encoded) throw new Error("Unsupported SQLite value.");
                return { name, ...encoded };
              });
              bytes += Buffer.byteLength(JSON.stringify(values));
              if (bytes > 1_048_576) throw new Error("Snapshot query exceeds the bounded output size.");
              rows.push(values);
            }
            if (await hashPrivateSqliteSnapshot(path) !== expectedSha256) throw new Error("SQLite snapshot changed during query.");
            return { tables, rows, ...(hasMore ? { nextOffset: query.offset + rows.length } : {}) };
          } finally { db.close(); }
        }
