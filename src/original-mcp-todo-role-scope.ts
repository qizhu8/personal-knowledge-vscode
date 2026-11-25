import type { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort } from "node:worker_threads";
import { CoreError } from "./contracts.js";

type Scope = Readonly<{ root: string; actorId: string; boardSlug: string }>;
const scopes = new WeakMap<DatabaseSync, Scope>();
export function readOriginalTodoRoleScope(root: string, db: DatabaseSync | undefined, actorId: string) {
  const value = db && scopes.get(db);
  return value?.root === root && value.actorId === actorId ? value : undefined;
}
/** The checked private worker gate alone brackets canonical synchronous planning/publication. */
export function withinOriginalTodoRoleScope<T>(db: DatabaseSync, scope: Scope, work: () => T): T {
  if (isMainThread || !parentPort || !db.isTransaction || scopes.has(db))
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Todo role authority requires its canonical private worker transaction.");
  scopes.set(db, Object.freeze({ ...scope }));
  try {
    const value = work();
    if (value && typeof (value as { then?: unknown }).then === "function")
      throw new CoreError("TRANSACTION_BOUNDARY", "Todo role scope cannot escape its synchronous transaction.");
    return value;
  } finally { scopes.delete(db); }
}
