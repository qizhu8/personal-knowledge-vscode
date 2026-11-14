import type { MemoryRecord } from "../memory-contracts.js";
export const projectMemoryPreview = (record: MemoryRecord) => ({
      id: record.id, revision: record.revision, status: record.status, updated_at: record.updated_at,
      preview: record.content.slice(0, 800), contentCharacters: record.content.length, truncated: record.content.length > 800,
      sourceCount: record.sources.length, readOperation: "memory.record.get",
    });
