import { inflateRawSync } from "node:zlib";
import { CoreError } from "./contracts.js";
import type { ActionModuleSnapshot } from "./domain/action-compiler-validation.js";

const maximum = 32 * 1024 * 1024;
const fail = (): never => { throw new CoreError("INVALID_DOCUMENT", "Invalid or unsupported portable Action package."); };
const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
function crc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function decodeLegacyActionPackage(bytes: Buffer): ActionModuleSnapshot & { enabled: false } {
  if (bytes.length > maximum || bytes.length < 22) return fail();
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50
    || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return fail();
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12);
  if (count > 500 || count !== bytes.readUInt16LE(end + 8) || offset + size !== end) return fail();
  const entries = new Map<string, Buffer>(), ranges: [number, number][] = [];
  let cursor = offset, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return fail();
    const flags = bytes.readUInt16LE(cursor + 8), compression = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    expanded += uncompressed;
    if (next > end || expanded > maximum || flags & 1 || ![0, 8].includes(compression)
      || bytes.readUInt16LE(cursor + 34) || ((external >>> 16) & 0xf000) === 0xa000
      || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50) return fail();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = text(nameBytes);
    if (!(flags & 0x800) && [...nameBytes].some(byte => byte > 127)) return fail();
    if (entries.has(name) || name.startsWith("/") || /[\\:\x00-\x1f]/.test(name)
      || name.split("/").some(part => !part || part === ".." || part.startsWith("."))) return fail();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength, finish = start + compressed;
    if (finish > offset || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== compression
      || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)
      || ranges.some(([from, to]) => local < to && finish > from)) return fail();
    ranges.push([local, finish]);
    const compressedBytes = bytes.subarray(start, finish);
    const content = compression === 0 ? compressedBytes : inflateRawSync(compressedBytes, { maxOutputLength: Math.max(1, uncompressed) });
    if (content.length !== uncompressed || crc32(content) !== crc) return fail();
    entries.set(name, content);
    cursor = next;
  }
  if (cursor !== end || !entries.has("manifest.json")) return fail();
  const manifest: unknown = JSON.parse(text(entries.get("manifest.json")!));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return fail();
  const files = (manifest as { files?: unknown }).files;
  if (!files || typeof files !== "object" || Array.isArray(files)
    || Object.keys(files).length + 1 !== entries.size || Object.keys(files).some(name => !entries.has(name))) return fail();
  return { kind: "moduleSet", manifest, enabled: false,
    files: Object.fromEntries(Object.keys(files).map(name => [name, text(entries.get(name)!)])) };
}
