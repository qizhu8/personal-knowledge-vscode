import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor, type StorageRequest } from "./contracts.js";
import type { Storage } from "./storage.js";
import { scanMarkdown } from "./markdown.js";
import { readDocumentAssets } from "./assets.js";
import {
  buildLegacyScriptProjectSnapshot, resolveLegacyScriptProjectLocator, validateNativeAssetOwnership,
  LegacyAssetProviderError, type LegacyScriptProjectSnapshotInput, type NativeAssetOwnershipSnapshot,
} from "./legacy-asset-provider.js";
import { assertSharedSourceRecoveryScope, inspectPausedSnapshotJournal } from "./host-composition-legacy-snapshot-restore.js";
import { resourcePath } from "./document-path.js";
import { batch15Definitions } from "./host-composition-legacy-batch15-contracts.js";

export interface NativeBatch15AssetPolicy {
  scope: "exclusive-native-disposable-fixture";
  sourceRelative: string;
  assertFixtureOwnership(): void;
  authorize(actor: Readonly<Actor>, operation: string): boolean;
  /** Native reader of original Script/Project source, never request supplied inventory. */
  inventory(actor: Readonly<Actor>): Pick<LegacyScriptProjectSnapshotInput, "scripts" | "projects">;
  authorizeEntry(actor: Readonly<Actor>, area: "scripts" | "projects", path: string): boolean;
  authorizeDocument(actor: Readonly<Actor>, id: string): boolean;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createBatch15AssetComposition(storage: Storage, db: DatabaseSync, workspaceId: string,
  policy: NativeBatch15AssetPolicy, assertSqlOwner: () => void) {
  if (policy.scope !== "exclusive-native-disposable-fixture" || !policy.sourceRelative.startsWith("packages/")
    || !resourcePath.safeParse(policy.sourceRelative).success
    || !["assertFixtureOwnership", "authorize", "inventory", "authorizeEntry", "authorizeDocument"].every(key =>
      typeof policy[key as keyof NativeBatch15AssetPolicy] === "function"))
    throw new CoreError("INVALID_CONFIGURATION", "Legacy inventory requires native-owned disposable source and actor policy.");
  const root = storage.workspaceRoot(), source = join(root, policy.sourceRelative);
  const identity = () => {
    let path = root;
    const chain = [];
    for (const part of ["", ...policy.sourceRelative.split("/")]) {
      path = join(path, part);
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("CONFLICT", "Original inventory root has an unsafe parent.");
      chain.push({ dev: String(stat.dev), ino: String(stat.ino) });
    }
    return hash({ workspaceId, source, chain });
  };
  const pinned = identity();
  const guard = (actor: Actor, operation: string) => {
    assertSqlOwner();
    if (db.isTransaction) throw new CoreError("TRANSACTION_BOUNDARY", "Original source callbacks cannot run inside SQL.");
    policy.assertFixtureOwnership();
    if (identity() !== pinned) throw new CoreError("CONFLICT", "Original inventory root changed.");
    if (!policy.authorize(Object.freeze({ ...actor }), operation)) throw new CoreError("ACCESS_DENIED", "Native inventory policy denied this actor.");
    assertSharedSourceRecoveryScope(db);
    if (inspectPausedSnapshotJournal(db)) throw new CoreError("RECOVERY_REQUIRED", "Unknown Snapshot blocks original inventory.", "unknown");
  };
  const context = (actor: Actor) => ({ actor, workspaceId, sourceRootId: pinned, sourceRootPath: source });
  function inventory(actor: Actor) {
    const entries = policy.inventory(Object.freeze({ ...actor }));
    return buildLegacyScriptProjectSnapshot({
      scope: { workspaceId, sourceRootId: pinned },
      scripts: entries.scripts.filter(entry => policy.authorizeEntry(actor, "scripts", entry.relativePath)),
      projects: entries.projects.filter(entry => policy.authorizeEntry(actor, "projects", entry.relativePath)),
    });
  }
  function assets(actor: Actor): NativeAssetOwnershipSnapshot[] {
    return scanMarkdown(root).filter(document => policy.authorizeDocument(actor, document.record.id)).map(document => {
      const items: NativeAssetOwnershipSnapshot["items"] = [];
      let offset = 0, revision: string | undefined;
      do {
        const page = readDocumentAssets(root, document, { operation: "knowledge.asset.list",
          args: { id: document.record.id, offset, limit: 100, ...(revision ? { revision } : {}) }, actorId: actor.id } as StorageRequest) as {
            revision: string; items: Array<{ path: string; digest: string; size: number }>; nextOffset: number | null;
          };
        revision ??= page.revision;
        const area = document.record.area;
        items.push(...page.items.map(item => ({ area, path: item.path, digest: item.digest, size: item.size })));
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      } while (true);
      return { id: document.record.id, workspaceId, sourceRootId: pinned,
        area: document.record.area,
        documentSha256: document.record.sha256, revision: revision!, items };
    });
  }
  return {
    available(actor: Readonly<Actor> | undefined, operation: string) {
      if (!actor) return false;
      try { guard(actor, operation); return true; } catch { return false; }
    },
    dispatch(operation: string, args: Record<string, unknown>, actor: Actor) {
      return storage.withWorkspaceExclusive(() => {
        guard(actor, operation);
        try {
          const definition = batch15Definitions.find(item => item.id === operation)!;
          const input = definition.input.parse(args);
          if (operation === "knowledge.legacy-links.resolve") {
            const before = inventory(actor);
            const result = resolveLegacyScriptProjectLocator({ ...input, snapshot: before } as never, context(actor));
            guard(actor, operation);
            if (hash(inventory(actor)) !== hash(before)) throw new CoreError("CONFLICT", "Actor inventory changed during original locator resolution.");
            return result;
          }
          const before = assets(actor);
          const result = validateNativeAssetOwnership({ ...input, snapshots: before } as never, context(actor));
          guard(actor, operation);
          if (hash(assets(actor)) !== hash(before)) throw new CoreError("CONFLICT", "Document asset inventory changed during ownership validation.");
          return result;
        } catch (error) {
          if (error instanceof LegacyAssetProviderError) throw new CoreError(
            /not_found|not-found|not found|not-found/i.test(error.code) ? "NOT_FOUND" : "CONFLICT", error.message);
          throw error;
        }
      });
    },
  };
}
