import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

type Command = { id: string; program: string; cwd: string; arguments: readonly (readonly string[])[] };

/** Profile key never leaves the owner/child IPC and authenticates only this exact selected command set. */
export function selectedChatPermissionStore(options: {
  database: DatabaseSync; secret: string; workspaceId: string; namespace: string; chatId: string;
  sourceFingerprint: string; commands: readonly Command[]; assertCurrent(): void;
}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.secret) || !/^[a-f0-9]{64}$/.test(options.sourceFingerprint))
    throw new Error("Invalid selected Chat permission identity.");
  const commandIdentity = options.commands.map(command => {
    const executable = statSync(command.program), cwd = statSync(command.cwd);
    return [command.id, command.program, command.cwd, command.arguments,
      executable.dev, executable.ino, executable.size, executable.mtimeMs, executable.ctimeMs,
      executable.mode, executable.uid, executable.gid, cwd.dev, cwd.ino];
  });
  const identity = createHash("sha256").update(JSON.stringify([
    "selected-chat-permissions-v1", options.workspaceId, options.namespace, options.chatId,
    options.sourceFingerprint, commandIdentity,
  ])).digest("hex");
  const sign = (scope: string) => createHmac("sha256", Buffer.from(options.secret, "base64url"))
    .update(JSON.stringify([identity, scope])).digest("hex");
  const assertScope = (scope: string) => {
    if (scope !== "allow-all" && !/^tool:[a-f0-9]{64}$/.test(scope))
      throw new Error("Invalid selected Chat permission scope.");
  };
  const exists = () => !!options.database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='selected_chat_permission_v1'").get();
  return {
    read(): { scopes: string[]; allowAll: boolean } {
      options.assertCurrent();
      if (!exists()) return { scopes: [], allowAll: false };
      const rows = options.database.prepare(
        "SELECT scope, mac FROM selected_chat_permission_v1 WHERE identity = ? LIMIT 514").all(identity);
      if (rows.length > 513) throw new Error("Selected Chat permission limit exceeded.");
      const scopes: string[] = [];
      let allowAll = false;
      for (const row of rows) {
        if (typeof row.scope !== "string" || typeof row.mac !== "string" || !/^[a-f0-9]{64}$/.test(row.mac))
          throw new Error("Invalid selected Chat permission record.");
        assertScope(row.scope);
        const actual = Buffer.from(row.mac, "hex"), expected = Buffer.from(sign(row.scope), "hex");
        if (!timingSafeEqual(actual, expected)) continue;
        if (row.scope === "allow-all") allowAll = true; else scopes.push(row.scope);
      }
      options.assertCurrent();
      return { scopes, allowAll };
    },
    remember(scope: string, choice: "approve" | "allow-all", assertCommitCurrent: () => void): void {
      const item = choice === "allow-all" ? "allow-all" : scope;
      assertScope(item);
      options.assertCurrent();
      options.database.exec("BEGIN IMMEDIATE");
      try {
        options.database.exec(`CREATE TABLE IF NOT EXISTS selected_chat_permission_v1 (
          identity TEXT NOT NULL, scope TEXT NOT NULL, mac TEXT NOT NULL, PRIMARY KEY (identity, scope)
        )`);
        const count = options.database.prepare(
          "SELECT COUNT(*) AS n FROM selected_chat_permission_v1 WHERE identity = ?").get(identity);
        if (typeof count?.n !== "number" || count.n >= 513) throw new Error("Reset remembered approvals before granting more permissions.");
        options.database.prepare(`INSERT INTO selected_chat_permission_v1 (identity, scope, mac) VALUES (?, ?, ?)
          ON CONFLICT(identity, scope) DO UPDATE SET mac = excluded.mac`).run(identity, item, sign(item));
        assertCommitCurrent();
        options.assertCurrent();
        options.database.exec("COMMIT");
      } catch (error) {
        try { options.database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
        throw error;
      }
    },
  };
}
