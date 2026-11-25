import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "./contracts.js";
import { decodeMarkdown, type MarkdownRecord } from "./markdown.js";
import { originalMcpPrivateBytes, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalMcpDomainDirectory, originalMcpDomainFile, readOriginalMcpDomain,
  verifyOriginalMcpDomainFiles } from "./original-mcp-domain-state.js";

export function originalMemoryStore(root: string): boolean { return !!readOriginalMcpJournal(root); }
export function readOriginalMemoryDocument(root: string, id: string, path: string): MarkdownRecord | undefined {
  if (!/^explicit-[a-f0-9]{64}$/.test(id) || path !== `System/Memory/${id}.md`)
    throw new CoreError("INVALID_DOCUMENT", "Native private Memory identity/path changed.");
  if (!readOriginalMcpDomain(root, "memory")?.committed)
    throw new CoreError("RECOVERY_REQUIRED", "Private Memory hydration must complete before native requests.");
  const file = originalMcpDomainFile(root, "memory", id);
  if (!lstatSync(file, { throwIfNoEntry: false })) return;
  return decodeMarkdown(id, originalMcpPrivateBytes(file, 536_870_912).toString("utf8"), path);
}
/** Private physical placement; canonical root, scope, document identity and engine remain unchanged. */
export function scanOriginalMemoryDocuments(root: string): MarkdownRecord[] {
  if (!readOriginalMcpDomain(root, "memory")?.committed)
    throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "ORIGINAL_MEMORY_SCOPE_ADMISSION_REQUIRED: exact native source continuity is required.");
  verifyOriginalMcpDomainFiles(root, "memory");
  return readdirSync(join(root, originalMcpDomainDirectory("memory"))).sort().map(name => {
    if (!/^explicit-[a-f0-9]{64}\.md$/.test(name))
      throw new CoreError("RECOVERY_REQUIRED", "Unknown private Memory files require reconciliation.");
    const id = name.slice(0, -3);
    return readOriginalMemoryDocument(root, id, `System/Memory/${name}`)!;
  });
}
