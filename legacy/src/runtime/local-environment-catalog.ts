import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

export interface LocalExecutor { id: string; executable: string }
export interface LocalEnvironment {
  id: string;
  name: string;
  description?: string;
  language: string;
  kind: "environment" | "runtime" | "executor-set";
  manager: string;
  root?: string;
  executors: LocalExecutor[];
  legacyPython?: Record<string, unknown>;
}
export interface EnvironmentCatalog {
  schema: "pkm.local-environments/v1";
  revision: number;
  previous: string;
  entries: LocalEnvironment[];
  legacyImports: string[];
}
export interface CatalogView { digest: string; catalog: EnvironmentCatalog }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const canonicalPath = (value: unknown): value is string => typeof value === "string" && !value.includes("\0")
  && path.isAbsolute(value) && path.resolve(value) === value;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= 256 && !/[\0\r\n]/.test(value);

function validateEntry(value: LocalEnvironment): void {
  if (!value || typeof value.id !== "string" || !identifier.test(value.id) || !text(value.name)
    || value.description !== undefined && (typeof value.description !== "string" || value.description.length > 8192 || value.description.includes("\0"))
    || typeof value.language !== "string" || !identifier.test(value.language)
    || !text(value.manager) || !["environment", "runtime", "executor-set"].includes(value.kind)
    || value.root !== undefined && !canonicalPath(value.root)
    || !Array.isArray(value.executors) || value.executors.length < 1 || value.executors.length > 32
    || new Set(value.executors.map(item => item?.id)).size !== value.executors.length
    || value.executors.some(item => !item || typeof item.id !== "string" || !identifier.test(item.id) || !canonicalPath(item.executable)))
    throw new Error("Invalid local environment entry; canonical absolute executor paths are required.");
  if (value.legacyPython !== undefined && (!value.legacyPython || typeof value.legacyPython !== "object"
    || Array.isArray(value.legacyPython) || value.language !== "python" || value.kind !== "environment"
    || value.legacyPython.id !== value.id))
    throw new Error("Legacy Python snapshot must retain its original environment ID.");
  if (value.legacyPython) {
    const original = value.legacyPython;
    validateEntry({ id: original.id as string, name: original.name as string, language: "python", kind: "environment",
      manager: original.manager as string, root: original.path as string,
      executors: [{ id: "python", executable: original.python as string }] });
  }
}
function validateCatalog(value: EnvironmentCatalog): void {
  if (!value || value.schema !== "pkm.local-environments/v1" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !/^[a-f0-9]{64}$/.test(value.previous) || !Array.isArray(value.entries) || value.entries.length > 1000
    || !Array.isArray(value.legacyImports) || value.legacyImports.some(item => !/^[a-f0-9]{64}$/.test(item))
    || new Set(value.entries.map(item => item?.id)).size !== value.entries.length)
    throw new Error("Invalid environment catalog; no automatic recovery or overwrite.");
  value.entries.forEach(validateEntry);
}
const empty = (): CatalogView => ({ digest: "0".repeat(64), catalog: {
  schema: "pkm.local-environments/v1", revision: 0, previous: "0".repeat(64), entries: [], legacyImports: [],
} });

/** Machine-local metadata only. It never grants execution authority or invokes a package manager. */
export class LocalEnvironmentCatalog {
  constructor(private readonly directory: string) {
    if (!canonicalPath(directory)) throw new Error("Catalog directory must be canonical and absolute.");
  }
  private checkDirectory(): void {
    if (fs.realpathSync(this.directory) !== this.directory || !fs.lstatSync(this.directory).isDirectory())
      throw new Error("Catalog directory must not be a symlink.");
  }
  private readFile(file: string): Buffer {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 2_000_000) throw new Error("Catalog input is not a bounded regular file.");
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0, count: number;
      while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
      if (length !== stat.size) throw new Error("Catalog input changed during read; preview it again.");
      return buffer.subarray(0, length);
    } finally { fs.closeSync(fd); }
  }
  read(revision?: number): CatalogView {
    if (!fs.existsSync(this.directory)) {
      if (revision !== undefined && revision !== 0) throw new Error("Unknown catalog revision.");
      return empty();
    }
    this.checkDirectory();
    const names = fs.readdirSync(this.directory).filter(name => /^\d{8}\.json$/.test(name)).sort();
    let view = empty();
    for (const name of names) {
      const bytes = this.readFile(path.join(this.directory, name));
      const catalog = JSON.parse(bytes.toString("utf8")) as EnvironmentCatalog;
      validateCatalog(catalog);
      if (catalog.revision !== view.catalog.revision + 1 || name !== this.filename(catalog.revision)
        || catalog.previous !== view.digest) throw new Error("Environment catalog history is incomplete or changed; repair explicitly.");
      view = { digest: hash(bytes), catalog };
      if (revision === catalog.revision) return view;
    }
    if (revision === 0) return empty();
    if (revision !== undefined && revision !== view.catalog.revision) throw new Error("Unknown catalog revision.");
    return view;
  }
  private filename(revision: number): string {
    if (revision > 99_999_999) throw new Error("Catalog history capacity exceeded.");
    return `${String(revision).padStart(8, "0")}.json`;
  }
  private commit(expected: string, entries: LocalEnvironment[], legacyImports: string[]): CatalogView {
    const current = this.read();
    if (current.digest !== expected) throw new Error("Catalog changed; review the current revision before retrying.");
    const catalog: EnvironmentCatalog = { schema: "pkm.local-environments/v1", revision: current.catalog.revision + 1,
      previous: current.digest, entries, legacyImports };
    validateCatalog(catalog);
    const bytes = `${JSON.stringify(catalog, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > 2_000_000) throw new Error("Catalog capacity exceeded; no changes committed.");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.checkDirectory();
    const pending = path.join(this.directory, `.pending-${randomUUID()}`);
    const fd = fs.openSync(pending, "wx", 0o600);
    let published = false, open = true;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      open = false;
      // Exclusive hard-link publication is the revision CAS: two hosts cannot overwrite each other.
      fs.linkSync(pending, path.join(this.directory, this.filename(catalog.revision)));
      published = true;
      const dir = fs.openSync(this.directory, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return { digest: hash(bytes), catalog };
    } catch (error) {
      if (published) throw new Error("Catalog commit may have succeeded; reopen and inspect it. Do not retry automatically.");
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Catalog changed in another host; reopen and review before retrying.");
      throw error;
    } finally {
      if (open) fs.closeSync(fd);
      fs.unlinkSync(pending);
    }
  }
  previewLegacy(registryFile: string): { sourceDigest: string; entries: LocalEnvironment[] } {
    if (!canonicalPath(registryFile) || fs.realpathSync(path.dirname(registryFile)) !== path.dirname(registryFile))
      throw new Error("Choose a canonical local legacy registry file.");
    const bytes = this.readFile(registryFile);
    const legacy: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(legacy) || legacy.length > 1000) throw new Error("Legacy registry is not an environment array.");
    const entries: LocalEnvironment[] = legacy.map(item => {
      if (!item || typeof item !== "object" || !["venv", "uv", "conda", "other"].includes(item.manager))
        throw new Error("Unsupported legacy environment record.");
      const entry: LocalEnvironment = { id: item.id, name: item.name, language: "python", kind: "environment",
        manager: item.manager, root: item.path, executors: [{ id: "python", executable: item.python }], legacyPython: item };
      validateEntry(entry);
      if (!entry.root) throw new Error("Legacy environment root is missing.");
      return entry;
    });
    if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error("Legacy environment IDs are ambiguous.");
    return { sourceDigest: hash(bytes), entries };
  }
  importLegacy(registryFile: string, sourceDigest: string, expected: string): CatalogView {
    const preview = this.previewLegacy(registryFile), current = this.read();
    if (preview.sourceDigest !== sourceDigest) throw new Error("Legacy registry changed after preview; review it again.");
    if (current.digest !== expected) throw new Error("Catalog changed; review the current revision before retrying.");
    if (current.catalog.legacyImports.includes(sourceDigest)) return current;
    if (preview.entries.some(entry => current.catalog.entries.some(existing => existing.id === entry.id)))
      throw new Error("Legacy environment ID conflicts with the catalog; no records imported.");
    return this.commit(expected, [...current.catalog.entries, ...preview.entries], [...current.catalog.legacyImports, sourceDigest]);
  }
  register(entry: LocalEnvironment, expected: string): CatalogView {
    validateEntry(entry);
    const current = this.read();
    if (current.catalog.entries.some(item => item.id === entry.id)) throw new Error("Environment ID already registered.");
    return this.commit(expected, [...current.catalog.entries, entry], current.catalog.legacyImports);
  }
  unregister(id: string, expected: string): CatalogView {
    const current = this.read();
    if (!current.catalog.entries.some(item => item.id === id)) throw new Error("Unknown environment ID.");
    return this.commit(expected, current.catalog.entries.filter(item => item.id !== id), current.catalog.legacyImports);
  }
  editPython(id: string, name: string, description: string, expected: string): CatalogView {
    const current = this.read(), entry = current.catalog.entries.find(item => item.id === id);
    if (!entry || entry.language !== "python" || entry.kind !== "environment") throw new Error("Choose a registered Python environment.");
    return this.commit(expected, current.catalog.entries.map(item => item.id === id ? { ...item, name, description } : item),
      current.catalog.legacyImports);
  }
  rebindPython(id: string, root: string, expected: string): CatalogView {
    const current = this.read(), entry = current.catalog.entries.find(item => item.id === id);
    if (!entry || entry.language !== "python" || entry.kind !== "environment")
      throw new Error("Choose a registered Python environment.");
    return this.commit(expected, current.catalog.entries.map(item => item.id === id
      ? { ...item, root, executors: [{ id: "python", executable: path.join(root, "bin", "python") }] } : item),
    current.catalog.legacyImports);
  }
  configureRuntime(id: string, name: string, executors: LocalExecutor[], expected: string, root?: string): CatalogView {
    const current = this.read(), entry = current.catalog.entries.find(item => item.id === id);
    if (!entry || !(entry.language === "csharp" && entry.kind === "executor-set"
      || entry.language === "javascript" && (entry.kind === "runtime" || entry.kind === "environment" && entry.manager === "node-project")))
      throw new Error("Choose a registered Node runtime/project or C# executor set.");
    const updated = { ...entry, name, executors, ...(root !== undefined ? { root } : {}) };
    return this.commit(expected, current.catalog.entries.map(item => item.id === id ? updated : item), current.catalog.legacyImports);
  }
  restore(revision: number, expected: string): CatalogView {
    const current = this.read(), historical = this.read(revision);
    return this.commit(expected, historical.catalog.entries, current.catalog.legacyImports);
  }
}

export function inspectLocalEnvironment(entry: LocalEnvironment): { available: boolean; issues: string[] } {
  validateEntry(entry);
  const issues: string[] = [];
  if (entry.root) {
    try {
      if (fs.realpathSync(entry.root) !== entry.root || !fs.statSync(entry.root).isDirectory()) throw new Error();
    } catch { issues.push("Environment root is missing or noncanonical; explicitly re-register after repair."); }
  }
  for (const executor of entry.executors) {
    try {
      if (!fs.statSync(executor.executable).isFile()) throw new Error();
      fs.accessSync(executor.executable, fs.constants.X_OK);
    } catch { issues.push(`Executor ${executor.id} is missing or not executable.`); }
  }
  return { available: issues.length === 0, issues };
}
