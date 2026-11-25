import { join } from "node:path";
import { lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { readOriginalMcpJournal, originalMcpPrivateBytes, originalMcpCommit, originalMcpCommitSchema,
  jsonDigest, type OriginalMcpJournal } from "./original-mcp-root-custody.js";
import { verifyOriginalMcpOptionalSchemaGroup, type OriginalMcpSqliteSchema } from "./original-mcp-sqlite-schema.js";
import { originalMcpActionOptionalSchemaGroups, verifyOriginalMcpActionNativeFootprint,
  readOriginalMcpActionDomainMetadata, verifyOriginalMcpActionDomainReadState } from "./original-mcp-action-domain.js";
import { originalActionInvocationDdl } from "./original-mcp-action-invocation.js";
import { legacyActionProposalDdl, verifyLegacyActionProposals } from "./legacy-action-mcp.js";
import { legacyActionCatalogDdl, verifyLegacyActionCatalog } from "./legacy-action-catalog.js";
import { legacyActionArtifactDdl, verifyLegacyActionArtifacts, legacyActionPackagePublicationDdl,
  verifyLegacyActionPackagePublications, nativeActionManagedBlobDdl,
  verifyNativeActionManagedBlobs } from "./legacy-action-artifacts.js";
import { verifyOriginalMcpActionMaintenanceMetadata } from "./original-mcp-action-maintenance.js";
import { originalMcpSourceProtocol } from "./original-mcp-source-protocol.js";
import { automaticActionSchemaGroups, verifyAutomaticActionCustody } from "./action-automatic-custody.js";
import { verifyOriginalMcpNativeHostReceiptDatabase } from "./original-mcp-native-host-receipt.js";

function fail(message: string): never { throw new CoreError("RECOVERY_REQUIRED", message); }

/** Exact passive schema/record custody only; callers must independently verify the remaining base schema. */
export function verifyOriginalMcpActionAuthoringReadSchema(root: string, database: DatabaseSync,
  actualSchema: OriginalMcpSqliteSchema, journal: OriginalMcpJournal | undefined): ReadonlySet<string> {
  if (!database.isTransaction) fail("Action metadata requires one current read transaction.");
  const currentSchema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  if (JSON.stringify(currentSchema) !== JSON.stringify(actualSchema))
    fail("Action schema verification requires the actual current SQLite snapshot.");
  const verified = new Set<string>();
  const present = (names: readonly string[]) => actualSchema.some(row => names.includes(String(row.tbl_name)));
  const actionNames = ["original_mcp_action_footprints", "original_mcp_action_domain_intents",
    "original_mcp_action_domain_commits", "original_mcp_action_invocations"];
  const proposalNames = ["legacy_action_mcp_proposals"];
  const catalogNames = ["legacy_action_catalog_admissions", "legacy_action_catalog_events"];
  const artifactNames = ["legacy_action_artifact_grants", "legacy_action_artifacts",
    "legacy_action_artifact_intent", "legacy_action_artifact_receipts"];
  const publicationNames = ["legacy_action_package_publications"], blobNames = ["native_action_managed_blobs"];
  const automaticNames = automaticActionSchemaGroups.flatMap(item => [...item.tables]);
  if (!journal && !present([...actionNames, ...proposalNames, ...catalogNames, ...artifactNames, ...publicationNames, ...blobNames, ...automaticNames]))
    return verified;
  const current = readOriginalMcpJournal(root);
  if (!journal || !current || journal.plan.root !== root || JSON.stringify(journal) !== JSON.stringify(current)
    || !originalMcpSourceProtocol.custody.includes(journal.plan.schema))
    fail("Action metadata requires its exact current root journal and supported source protocol.");
  const marker = JSON.parse(originalMcpPrivateBytes(join(root, ".pkm-next-workspace")).toString("utf8"));
  const commit = originalMcpCommitSchema.parse(JSON.parse(originalMcpPrivateBytes(join(root, originalMcpCommit)).toString("utf8")));
  const { receiptSha256, ...body } = commit;
  if (marker.schema !== "pkm.next-workspace/v2" || marker.id !== journal.workspaceId
    || commit.journalSha256 !== journal.journalSha256 || jsonDigest(body) !== receiptSha256)
    fail("Action metadata requires its completed current workspace custody.");
  const group = (ddl: string, names: readonly string[]) => {
    if (!present(names)) return false;
    for (const name of verifyOriginalMcpOptionalSchemaGroup(actualSchema, ddl, names)) verified.add(name);
    return true;
  };
  if (present(actionNames)) {
    for (const item of originalMcpActionOptionalSchemaGroups) group(item.ddl, item.tables);
    group(originalActionInvocationDdl, ["original_mcp_action_invocations"]);
    const footprint = verifyOriginalMcpActionNativeFootprint(root, database);
    if (present(actionNames.slice(1))) {
      const state = readOriginalMcpActionDomainMetadata(root, database);
      if (!state?.committed || !footprint || state.receipt.capsuleSha256 !== footprint.capsuleSha256)
        fail("Historical Action source requires its exact footprint and complete source commitment.");
      verifyOriginalMcpActionDomainReadState(root, database);
    }
  }
  if (group(legacyActionProposalDdl, proposalNames)) verifyLegacyActionProposals(database, journal.workspaceId);
  const stat = lstatSync(root), rootPin = `${stat.dev}:${stat.ino}`;
  if (group(legacyActionCatalogDdl, catalogNames)) {
    const catalog = verifyLegacyActionCatalog(database, journal.workspaceId);
    for (const admission of catalog.admissions.values())
      if (admission.binding.workspaceRoot !== root || admission.binding.workspaceRootPin !== rootPin)
        fail("Action catalog belongs to another physical root custody.");
  }
  if (group(legacyActionArtifactDdl, artifactNames)) {
    verifyLegacyActionArtifacts(database, journal.workspaceId, true);
    for (const row of database.prepare("SELECT payload FROM legacy_action_artifact_grants").all()) {
      const grant = JSON.parse(String(row.payload));
      if (grant.workspaceRoot !== root || grant.workspaceRootPin !== rootPin)
        fail("Action artifact metadata belongs to another physical root custody.");
    }
  }
  if (group(legacyActionPackagePublicationDdl, publicationNames))
    verifyLegacyActionPackagePublications(database, journal.workspaceId);
  if (group(nativeActionManagedBlobDdl, blobNames))
    verifyNativeActionManagedBlobs(database, journal.workspaceId);
  if (present(["action_runtime_receipts"])) verifyOriginalMcpActionMaintenanceMetadata(database, journal);
  if (present(automaticNames)) {
    for (const item of automaticActionSchemaGroups) {
      if (!group(item.ddl, item.tables)) fail("Native registered Action custody requires its complete closed schema.");
    }
    const epochs = new Set<string>();
    const rows = database.prepare("SELECT receipt_sha256 FROM original_mcp_native_host_admissions LIMIT 4097").all();
    if (rows.length > 4096) fail("Native registered Action host receipts exceed their bound.");
    for (const row of rows)
      epochs.add(verifyOriginalMcpNativeHostReceiptDatabase(database, journal, String(row.receipt_sha256)).epoch);
    verifyAutomaticActionCustody(database, journal.workspaceId, epochs);
  }
  return verified;
}
