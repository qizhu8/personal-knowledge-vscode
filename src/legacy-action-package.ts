import { inflateRawSync } from "node:zlib";
import { readSync } from "node:fs";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import type { ActionModuleSnapshot } from "./domain/action-compiler-validation.js";
import { actionModuleFileBytes, nativeActionModuleSourceProtocol, type ActionModuleFileContent } from "./action-module-bytes.js";

export function readBoundedActionPackageFile(descriptor: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024)
    throw new TypeError("Invalid bounded Action package file size.");
  const bytes = Buffer.alloc(size + 1);
  let used = 0;
  while (used < bytes.length) {
    const count = readSync(descriptor, bytes, used, bytes.length - used, used);
    if (!count) break;
    used += count;
  }
  if (used !== size) throw new TypeError("Action package file changed during its bounded read.");
  return bytes.subarray(0, size);
}

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
  let binary = false;
  const contents: Record<string, ActionModuleFileContent> = {};
  for (const name of Object.keys(files)) {
    const value = entries.get(name)!;
    try { contents[name] = text(value); }
    catch {
      if (!name.startsWith("assets/")) return fail();
      contents[name] = { schema: "pkm.action.module-bytes/v1", base64: value.toString("base64") }; binary = true;
    }
  }
  return { kind: "moduleSet", manifest, enabled: false, files: contents,
    ...(binary ? { fileEncoding: nativeActionModuleSourceProtocol } : {}) };
}

export function encodeLegacyActionPackage(source: ActionModuleSnapshot): Buffer {
  const entries = Object.entries({ "manifest.json": JSON.stringify(source.manifest), ...source.files });
  if (entries.length > 500) return fail();
  const local: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0, expanded = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), content = actionModuleFileBytes(value);
    expanded += content.length;
    if (expanded > maximum || filename.length > 65535) return fail();
    const crc = crc32(content), header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    const executable = (source.manifest as { executables?: string[] }).executables?.includes(name) ?? false;
    central.writeUInt32LE(((executable ? 0o100700 : 0o100600) << 16) >>> 0, 38);
    local.push(header, filename, content); directory.push(central, filename);
    offset += header.length + filename.length + content.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...local, central, end]);
  decodeLegacyActionPackage(bytes);
  return bytes;
}
