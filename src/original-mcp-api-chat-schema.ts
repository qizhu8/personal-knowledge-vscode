import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { originalApiChatSourcePlanSchema, type OriginalApiChatSourcePlan } from "./original-mcp-source-policy-contracts.js";
import { verifyOriginalMcpNativeHostReceiptDatabase } from "./original-mcp-native-host-receipt.js";
import { verifyOriginalMcpOptionalSchemaGroup, type OriginalMcpSqliteSchema } from "./original-mcp-sqlite-schema.js";
import type { OriginalMcpJournal } from "./original-mcp-root-custody.js";

export const originalApiChatSourceDdl = `
CREATE TABLE original_api_chat_source_chats(
 namespace TEXT NOT NULL,id TEXT PRIMARY KEY,metadata_path TEXT NOT NULL,metadata_sha256 TEXT NOT NULL,
 title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,message_count INTEGER NOT NULL,
 last_assistant INTEGER,uncertain INTEGER NOT NULL,source_status TEXT NOT NULL,summary TEXT NOT NULL,group_id TEXT NOT NULL,trashed_at TEXT);
CREATE TABLE original_api_chat_source_messages(
 chat_id TEXT NOT NULL,sequence INTEGER NOT NULL,id TEXT NOT NULL,descriptor TEXT NOT NULL,sha256 TEXT NOT NULL,
 PRIMARY KEY(chat_id,sequence),UNIQUE(chat_id,id));
CREATE TABLE original_api_chat_source_controls(
 host_id TEXT NOT NULL,request_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,
 PRIMARY KEY(host_id,request_id));
CREATE TABLE original_api_chat_source_library(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL);`;
export const originalApiChatSourceTables = ["original_api_chat_source_chats", "original_api_chat_source_messages",
  "original_api_chat_source_controls", "original_api_chat_source_library"] as const;
export const originalApiChatImmutableSourceDdl = originalApiChatSourceTables.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation =>
  `CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT,'original Chat source immutable'); END;`)).join("\n");
export const originalApiChatSourceAdmissionDdl = `CREATE TABLE original_api_chat_source_admission(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL,sha256 TEXT NOT NULL,
 native_host_sha256 TEXT NOT NULL,decision_id TEXT NOT NULL);
 CREATE TRIGGER original_api_chat_source_admission_no_update BEFORE UPDATE ON original_api_chat_source_admission
 BEGIN SELECT RAISE(ABORT,'original Chat source immutable'); END;
 CREATE TRIGGER original_api_chat_source_admission_no_delete BEFORE DELETE ON original_api_chat_source_admission
 BEGIN SELECT RAISE(ABORT,'original Chat source immutable'); END;`;
export const originalApiChatRequestDdl = `CREATE TABLE IF NOT EXISTS original_api_chat_requests(
      request_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,command_id TEXT NOT NULL,operation TEXT NOT NULL,
      arguments TEXT NOT NULL,payload_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS original_api_chat_request_state(
      request_id TEXT PRIMARY KEY,status TEXT NOT NULL,result TEXT,error TEXT,epoch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS original_api_chat_current_chats(
      id TEXT PRIMARY KEY,namespace TEXT NOT NULL,model_selection TEXT NOT NULL,create_request_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS original_api_chat_responses(
      chat_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,request_id TEXT NOT NULL,selection TEXT NOT NULL,
      active INTEGER NOT NULL,status TEXT NOT NULL,engine TEXT NOT NULL DEFAULT 'bounded',history_published INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER IF NOT EXISTS original_api_chat_requests_no_update BEFORE UPDATE ON original_api_chat_requests
      BEGIN SELECT RAISE(ABORT,'original Chat submission immutable'); END;
      CREATE TRIGGER IF NOT EXISTS original_api_chat_requests_no_delete BEFORE DELETE ON original_api_chat_requests
      BEGIN SELECT RAISE(ABORT,'original Chat submission immutable'); END;`;
export const originalApiChatInputImageDdl = `CREATE TABLE original_api_chat_input_images(
 chat_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,message_id TEXT NOT NULL UNIQUE,
 source_plan_sha256 TEXT NOT NULL,input_sha256 TEXT NOT NULL,images_json TEXT NOT NULL,images_sha256 TEXT NOT NULL);
 CREATE TRIGGER original_api_chat_input_images_no_update BEFORE UPDATE ON original_api_chat_input_images
 BEGIN SELECT RAISE(ABORT,'original Chat input images immutable'); END;
 CREATE TRIGGER original_api_chat_input_images_no_delete BEFORE DELETE ON original_api_chat_input_images
 BEGIN SELECT RAISE(ABORT,'original Chat input images immutable'); END;`;
export const originalNativeChatExecutionDdl = `CREATE TABLE IF NOT EXISTS original_native_chat_executions(
      request_id TEXT PRIMARY KEY,plan_sha256 TEXT NOT NULL,plan TEXT NOT NULL,native_model_id TEXT NOT NULL,
      status TEXT NOT NULL,current_inference TEXT,round INTEGER NOT NULL,output_bytes INTEGER NOT NULL,
      failure TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS original_native_chat_inferences(
      request_id TEXT NOT NULL,inference_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,payload TEXT NOT NULL,
      authorized INTEGER NOT NULL,native_output INTEGER,reported_output INTEGER,
      PRIMARY KEY(request_id,inference_id));
      CREATE TABLE IF NOT EXISTS original_native_chat_events(
      request_id TEXT NOT NULL,sequence INTEGER NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,
      previous_sha256 TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(request_id,sequence));
      CREATE TABLE IF NOT EXISTS original_native_chat_text(
      request_id TEXT NOT NULL,sequence INTEGER NOT NULL,inference_id TEXT NOT NULL,text TEXT NOT NULL,
      PRIMARY KEY(request_id,sequence));
      CREATE TRIGGER IF NOT EXISTS original_native_chat_events_no_update BEFORE UPDATE ON original_native_chat_events
      BEGIN SELECT RAISE(ABORT,'native Chat event immutable'); END;
      CREATE TRIGGER IF NOT EXISTS original_native_chat_events_no_delete BEFORE DELETE ON original_native_chat_events
      BEGIN SELECT RAISE(ABORT,'native Chat event immutable'); END;`;
export const originalApiChatOptionalSchemaGroups = [
  { name: "source", ddl: originalApiChatSourceDdl + originalApiChatImmutableSourceDdl + originalApiChatSourceAdmissionDdl,
    tables: [...originalApiChatSourceTables, "original_api_chat_source_admission"] },
  { name: "requests", ddl: originalApiChatRequestDdl,
    tables: ["original_api_chat_requests", "original_api_chat_request_state", "original_api_chat_current_chats", "original_api_chat_responses"] },
  { name: "images", ddl: originalApiChatInputImageDdl, tables: ["original_api_chat_input_images"] },
  { name: "execution", ddl: originalNativeChatExecutionDdl,
    tables: ["original_native_chat_executions", "original_native_chat_inferences", "original_native_chat_events", "original_native_chat_text"] },
] as const;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function fail(): never {
  throw new CoreError("RECOVERY_REQUIRED", "ORIGINAL_API_CHAT_SOURCE_REQUIRED: Historical Chat schema requires exact same-root source and native Host receipts.");
}
export function parseOriginalApiChatSourcePlan(input: OriginalApiChatSourcePlan) {
  const parsed = originalApiChatSourcePlanSchema.safeParse(input);
  if (!parsed.success) fail();
  const plan = parsed.data, { planSha256, ...body } = plan;
  if (hash(body) !== planSha256) fail();
  return plan;
}
export function verifyOriginalApiChatSourceSchema(database: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'original_api_chat_source_%' ORDER BY name";
  try {
    expected.exec(originalApiChatOptionalSchemaGroups[0].ddl);
    if (canonicalJson(database.prepare(query).all()) !== canonicalJson(expected.prepare(query).all())) fail();
  } finally { expected.close(); }
}
/** Reads historical custody metadata only; no external source-index access or live source activation. */
export function readOriginalApiChatSourceReceipt(database: DatabaseSync, journal: OriginalMcpJournal) {
  verifyOriginalApiChatSourceSchema(database);
  const receipts = database.prepare("SELECT * FROM original_api_chat_source_admission").all();
  if (receipts.length !== 1 || receipts[0].singleton !== 1 || typeof receipts[0].payload !== "string") fail();
  const row = receipts[0];
  let parsed: OriginalApiChatSourcePlan;
  try { parsed = JSON.parse(String(row.payload)); }
  catch { fail(); }
  const plan = parseOriginalApiChatSourcePlan(parsed);
  if (row.payload !== canonicalJson(plan) || row.sha256 !== plan.planSha256
    || typeof row.decision_id !== "string" || !row.decision_id.trim() || row.decision_id.length > 256
    || plan.root !== journal.plan.root || plan.workspaceId !== journal.workspaceId
    || plan.custodyPlanSha256 !== journal.plan.planSha256 || plan.profileSha256 !== journal.plan.profileSha256
    || plan.chats > plan.limits.maxChats || plan.messages > plan.limits.maxMessages) fail();
  verifyOriginalMcpNativeHostReceiptDatabase(database, journal, String(row.native_host_sha256));
  const count = (table: string) => Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  if (count("original_api_chat_source_chats") !== plan.chats || count("original_api_chat_source_messages") !== plan.messages
    || count("original_api_chat_source_controls") !== plan.controls || count("original_api_chat_source_library") !== 1
    || !database.prepare("SELECT 1 FROM original_api_chat_source_library WHERE singleton=1").get()
    || database.prepare(`SELECT 1 FROM original_api_chat_source_messages m
      LEFT JOIN original_api_chat_source_chats c ON c.id=m.chat_id
      WHERE c.id IS NULL OR m.sequence<1 OR m.sequence>c.message_count LIMIT 1`).get()
    || database.prepare(`SELECT 1 FROM original_api_chat_source_chats c
      WHERE c.message_count<0 OR c.message_count>? OR c.message_count<>(
        SELECT count(*) FROM original_api_chat_source_messages m WHERE m.chat_id=c.id) LIMIT 1`).get(plan.limits.maxMessagesPerChat)) fail();
  return plan;
}
export function verifyOriginalApiChatOptionalReadSchema(database: DatabaseSync, schema: OriginalMcpSqliteSchema,
  journal: OriginalMcpJournal | undefined): Set<string> {
  const groups = originalApiChatOptionalSchemaGroups.filter(group => schema.some(row =>
    (group.tables as readonly string[]).includes(String(row.tbl_name))));
  const verified = new Set<string>();
  if (!groups.length) return verified;
  const names = new Set(groups.map(group => group.name));
  if (!journal || !names.has("source") || (names.has("images") || names.has("execution")) && !names.has("requests")) fail();
  for (const group of groups)
    for (const name of verifyOriginalMcpOptionalSchemaGroup(schema, group.ddl, group.tables)) verified.add(name);
  readOriginalApiChatSourceReceipt(database, journal);
  return verified;
}
