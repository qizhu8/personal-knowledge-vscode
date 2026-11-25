import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { OriginalNativeChatMessage } from "./original-mcp-api-chat-contracts.js";
import { originalApiChatInputImageDdl as ddl } from "./original-mcp-api-chat-schema.js";

type Image = NonNullable<OriginalNativeChatMessage["images"]>[number];
type Source = { chatId: string; sourcePlanSha256: string; images: readonly Image[] };
type Claim = Readonly<Source & { requestId: string; messageId: string; inputSha256: string; imagesSha256: string }>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const table = "original_api_chat_input_images";
function fail(reason: string): never {
  throw Object.assign(new Error(`ORIGINAL_CHAT_DRAFT_IMAGE_RECONCILIATION_REQUIRED: ${reason}`), {
    code: "ORIGINAL_CHAT_DRAFT_IMAGE_RECONCILIATION_REQUIRED",
  });
}
function verify(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  const query = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY name,type";
  try {
    expected.exec(ddl);
    if (JSON.stringify(db.prepare(query).all(table)) !== JSON.stringify(expected.prepare(query).all(table)))
      fail("The durable image-binding schema or immutability guards changed.");
  } finally { expected.close(); }
}
function pinned(source: Source) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(source.chatId)
    || !/^[a-f0-9]{64}$/.test(source.sourcePlanSha256) || !Array.isArray(source.images) || !source.images.length)
    fail("An exact admitted source and nonempty preserved image collection are required.");
  const images = structuredClone(source.images).map(image => Object.freeze(image));
  return Object.freeze({ chatId: source.chatId, sourcePlanSha256: source.sourcePlanSha256,
    images: Object.freeze(images) });
}

/** Supplemental canonical transcript custody; no model or historical permission authority. */
export function createOriginalApiChatInputImageStore(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(ddl);
  verify(db);
  const read = (input: Source): Claim | undefined => {
    const source = pinned(input); verify(db);
    const row = db.prepare("SELECT * FROM original_api_chat_input_images WHERE chat_id=?").get(source.chatId);
    if (!row) return;
    const json = JSON.stringify(source.images);
    if (row.source_plan_sha256 !== source.sourcePlanSha256 || row.images_json !== json
      || row.images_sha256 !== hash(json) || typeof row.request_id !== "string"
      || !/^[a-f0-9]{64}$/.test(row.request_id) || row.message_id !== `api-input:${row.request_id}`
      || typeof row.input_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.input_sha256))
      fail("The recorded input/image/source identity changed. Preserve the owning request; never reassign its draft.");
    return Object.freeze({ ...source, requestId: row.request_id, messageId: String(row.message_id),
      inputSha256: row.input_sha256, imagesSha256: String(row.images_sha256) });
  };
  return Object.freeze({
    read,
    claim(input: Source & { requestId: string; prompt: string }) {
      const source = pinned(input);
      if (!db.isTransaction || !/^[a-f0-9]{64}$/.test(input.requestId) || typeof input.prompt !== "string")
        fail("Draft consumption must share the actual owned response-intent transaction.");
      verify(db);
      if (read(source)) fail("This source draft already belongs to an earlier input, including uncertain work.");
      const json = JSON.stringify(source.images), messageId = `api-input:${input.requestId}`;
      db.prepare("INSERT INTO original_api_chat_input_images VALUES(?,?,?,?,?,?,?)").run(source.chatId,
        input.requestId, messageId, source.sourcePlanSha256, hash(input.prompt), json, hash(json));
      return read(source)!;
    },
    restore(claim: Claim, message: { id: string; role: string; content: string }): OriginalNativeChatMessage {
      const actual = read(claim);
      if (!actual || actual.requestId !== claim.requestId || message.id !== actual.messageId
        || message.role !== "user" || hash(message.content) !== actual.inputSha256)
        fail("The native transcript input no longer matches its durable image binding.");
      return { role: "user", content: message.content, images: structuredClone(actual.images) };
    },
  });
}
