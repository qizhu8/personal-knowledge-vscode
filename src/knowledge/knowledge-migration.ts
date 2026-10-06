import { createHash } from "crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { parseStoreFrontmatter, serializeStoreFrontmatter } from "./filestore";
import {
  compileKnowledgeIdentityV1, compileKnowledgeLinksV1, KnowledgeIdentityMetadata,
  KnowledgeKind, KnowledgeLinkV1, legacyKnowledgeAlias, validateKnowledgeIdentitySet,
} from "./knowledge-contracts";

export type KnowledgeMigrationPhase = "backed-up" | "staged" | "verified" | "cutover";

export interface KnowledgeMigrationReceipt {
  sourceDigest: string;
  projectedDigest: string;
  files: number;
  changed: number;
  citations: { total: number; linked: number; compatibilityOnly: number };
  diagnostics: Array<{ code: string; file: string; message: string }>;
}

interface SourceFile {
  area: "skills" | "notes" | "papers";
  kind: KnowledgeKind;
  full: string;
  rel: string;
  key: string;
  content: string;
  frontmatter: Record<string, any>;
  body: string;
}

interface ProjectedFile extends SourceFile {
  projected: string;
  identity: KnowledgeIdentityMetadata;
}

interface MigrationMarker extends KnowledgeMigrationReceipt {
  schema: 1;
  phase: KnowledgeMigrationPhase;
  updatedAt: string;
  filesList: string[];
  backupPath?: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableKnowledgeId(kind: KnowledgeKind, key: string): string {
  return `knowledge_${sha256(`pkm.knowledge/v1\0${kind}\0${key.normalize("NFC")}`).slice(0, 24)}`;
}

function walkMarkdown(root: string, area: SourceFile["area"], kind: KnowledgeKind): SourceFile[] {
  const areaRoot = join(root, area);
  if (!existsSync(areaRoot)) return [];
  const output: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const rel = relative(root, full).split(sep).join("/");
        const key = relative(areaRoot, full).split(sep).join("/").replace(/\.md$/i, "");
        const content = readFileSync(full, "utf8");
        const parsed = parseStoreFrontmatter(content);
        output.push({ area, kind, full, rel, key, content, frontmatter: parsed.fm, body: parsed.body });
      }
    }
  };
  walk(areaRoot);
  return output;
}

function inventory(root: string): SourceFile[] {
  return [
    ...walkMarkdown(root, "skills", "skill"),
    ...walkMarkdown(root, "notes", "note"),
    ...walkMarkdown(root, "papers", "research"),
  ].sort((a, b) => a.rel.localeCompare(b.rel));
}

function digestFiles(files: Array<{ rel: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.rel.normalize("NFC")).update("\0").update(sha256(file.content)).update("\n");
  }
  return hash.digest("hex");
}

function validExistingIdentity(file: SourceFile): KnowledgeIdentityMetadata | undefined {
  const candidate = {
    schema: file.frontmatter.schema,
    knowledgeId: file.frontmatter.knowledgeId,
    revision: file.frontmatter.revision,
    aliases: file.frontmatter.aliases,
  };
  const compiled = compileKnowledgeIdentityV1(candidate);
  return compiled.ok ? compiled.model : undefined;
}

function dedupeLinks(links: KnowledgeLinkV1[]): KnowledgeLinkV1[] {
  const byKey = new Map<string, KnowledgeLinkV1>();
  for (const link of links) {
    byKey.set(`${link.relation}\0${link.target}\0${link.mode}\0${link.required}\0${link.targetRevision || ""}`, link);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.relation}\0${a.target}\0${a.mode}`.localeCompare(`${b.relation}\0${b.target}\0${b.mode}`));
}

function project(files: SourceFile[]): { files: ProjectedFile[]; receipt: KnowledgeMigrationReceipt } {
  const diagnostics: KnowledgeMigrationReceipt["diagnostics"] = [];
  const identities = new Map<string, KnowledgeIdentityMetadata>();
  for (const file of files) {
    const existing = validExistingIdentity(file);
    const aliases = [...new Set([...(existing?.aliases || []), legacyKnowledgeAlias(file.kind, file.key)])].sort();
    identities.set(file.rel, {
      schema: "pkm.knowledge/v1",
      knowledgeId: existing?.knowledgeId || stableKnowledgeId(file.kind, file.key),
      revision: existing?.revision || 1,
      aliases,
    });
  }
  const setDiagnostics = validateKnowledgeIdentitySet([...identities.values()]);
  if (setDiagnostics.length) {
    throw new Error(`Knowledge identity collision: ${setDiagnostics.map(item => item.message).join("; ")}`);
  }

  const papers = files.filter(file => file.kind === "research");
  const paperTargets = new Map<string, SourceFile>();
  const ambiguous = new Set<string>();
  const addPaperTarget = (key: string, file: SourceFile): void => {
    const normalized = key.toLowerCase().replace(/\.md$/i, "").normalize("NFC");
    if (!normalized) return;
    const existing = paperTargets.get(normalized);
    if (existing && existing.rel !== file.rel) ambiguous.add(normalized);
    else paperTargets.set(normalized, file);
  };
  for (const file of papers) {
    addPaperTarget(file.key, file);
    addPaperTarget(String(file.frontmatter.title || ""), file);
  }

  let citations = 0;
  let linked = 0;
  const projected = files.map(file => {
    const identity = identities.get(file.rel)!;
    const existingLinks = file.frontmatter.links === undefined ? [] : file.frontmatter.links;
    const compiledLinks = compileKnowledgeLinksV1(existingLinks);
    if (!compiledLinks.ok) {
      diagnostics.push({ code: "invalid-links", file: file.rel, message: compiledLinks.diagnostics.map(item => item.message).join("; ") });
    }
    const links = compiledLinks.ok ? [...compiledLinks.links] : [];
    if (file.kind === "research") {
      for (const citation of Array.isArray(file.frontmatter.cites) ? file.frontmatter.cites : []) {
        citations++;
        const reference = String(citation?.paper || "").toLowerCase().replace(/\.md$/i, "").normalize("NFC");
        const targetFile = paperTargets.get(reference);
        if (!reference || ambiguous.has(reference) || !targetFile || targetFile.rel === file.rel) {
          diagnostics.push({
            code: ambiguous.has(reference) ? "ambiguous-citation" : "compatibility-only-citation",
            file: file.rel,
            message: `Citation ${String(citation?.paper || "<empty>")} could not be converted to a canonical internal link.`,
          });
          continue;
        }
        links.push({
          relation: "cites",
          target: `pkm://knowledge/${identities.get(targetFile.rel)!.knowledgeId}`,
          mode: "floating",
          required: false,
        });
        linked++;
      }
    }
    const nextFrontmatter = {
      ...file.frontmatter,
      schema: identity.schema,
      knowledgeId: identity.knowledgeId,
      revision: identity.revision,
      aliases: identity.aliases,
      ...(links.length ? { links: dedupeLinks(links) } : {}),
    };
    const content = serializeStoreFrontmatter(nextFrontmatter, file.body);
    return { ...file, identity, projected: content };
  });
  const receipt: KnowledgeMigrationReceipt = {
    sourceDigest: digestFiles(files),
    projectedDigest: digestFiles(projected.map(file => ({ rel: file.rel, content: file.projected }))),
    files: files.length,
    changed: projected.filter(file => file.content !== file.projected).length,
    citations: { total: citations, linked, compatibilityOnly: citations - linked },
    diagnostics,
  };
  return { files: projected, receipt };
}

export class KnowledgeV1Migration {
  private readonly migrationRoot: string;
  private readonly stageRoot: string;
  private readonly backupRoot: string;
  private readonly markerPath: string;

  constructor(private readonly root: string) {
    this.migrationRoot = join(root, ".pkm", "state", "knowledge-v1-migration");
    this.stageRoot = join(this.migrationRoot, "stage");
    this.backupRoot = join(this.migrationRoot, "backups");
    this.markerPath = join(this.migrationRoot, "marker.json");
  }

  preview(): KnowledgeMigrationReceipt {
    return project(inventory(this.root)).receipt;
  }

  status(): MigrationMarker | undefined {
    if (!existsSync(this.markerPath)) return undefined;
    return JSON.parse(readFileSync(this.markerPath, "utf8")) as MigrationMarker;
  }

  backup(sourceDigest: string): MigrationMarker {
    const projection = project(inventory(this.root));
    this.requireSource(sourceDigest, projection.receipt);
    mkdirSync(this.backupRoot, { recursive: true });
    const backupPath = join(this.backupRoot, sourceDigest);
    if (!existsSync(backupPath)) {
      mkdirSync(backupPath, { recursive: true, mode: 0o700 });
      for (const file of projection.files) {
        const destination = join(backupPath, file.rel);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const descriptor = openSync(destination, "wx", 0o400);
        try {
          writeFileSync(descriptor, file.content);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
      const directories = new Set<string>([
        backupPath,
        ...projection.files.flatMap(file => {
          const values: string[] = [];
          let current = dirname(join(backupPath, file.rel));
          while (current.startsWith(backupPath + sep)) {
            values.push(current);
            current = dirname(current);
          }
          return values;
        }),
      ]);
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) chmodSync(directory, 0o500);
    }
    const marker = this.marker("backed-up", projection.receipt, projection.files, backupPath);
    this.writeMarker(marker);
    return marker;
  }

  stage(sourceDigest: string): MigrationMarker {
    const projection = project(inventory(this.root));
    this.requireSource(sourceDigest, projection.receipt);
    const prior = this.status();
    if (!prior?.backupPath || prior.sourceDigest !== sourceDigest || !existsSync(prior.backupPath)) {
      throw new Error("An immutable backup for this source digest is required before staging.");
    }
    rmSync(this.stageRoot, { recursive: true, force: true });
    for (const file of projection.files) {
      const destination = join(this.stageRoot, file.rel);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.projected);
    }
    const marker = this.marker("staged", projection.receipt, projection.files, prior.backupPath);
    this.writeMarker(marker);
    return marker;
  }

  verify(sourceDigest: string): MigrationMarker {
    const marker = this.requireMarker(sourceDigest, ["staged", "verified"]);
    const sourceProjection = project(inventory(this.root));
    this.requireSource(sourceDigest, sourceProjection.receipt);
    const staged = marker.filesList.map(rel => {
      const full = join(this.stageRoot, rel);
      if (!existsSync(full)) throw new Error(`Staged file is missing: ${rel}`);
      return { rel, content: readFileSync(full, "utf8") };
    });
    if (digestFiles(staged) !== marker.projectedDigest) throw new Error("Staged Knowledge digest does not match preview.");
    for (const file of staged) {
      const parsed = parseStoreFrontmatter(file.content);
      const identity = compileKnowledgeIdentityV1({
        schema: parsed.fm.schema,
        knowledgeId: parsed.fm.knowledgeId,
        revision: parsed.fm.revision,
        aliases: parsed.fm.aliases,
      });
      if (!identity.ok) throw new Error(`Invalid staged Knowledge identity: ${file.rel}`);
      const links = parsed.fm.links === undefined ? { ok: true as const } : compileKnowledgeLinksV1(parsed.fm.links);
      if (!links.ok) throw new Error(`Invalid staged Knowledge links: ${file.rel}`);
    }
    const verified = { ...marker, phase: "verified" as const, updatedAt: new Date().toISOString() };
    this.writeMarker(verified);
    return verified;
  }

  cutover(sourceDigest: string): MigrationMarker {
    const marker = this.requireMarker(sourceDigest, ["verified", "cutover"]);
    if (marker.phase === "cutover") return this.restartVerify(sourceDigest);
    this.requireSource(sourceDigest, project(inventory(this.root)).receipt);
    for (const rel of marker.filesList) {
      const source = join(this.stageRoot, rel);
      const destination = join(this.root, rel);
      const temporary = `${destination}.knowledge-migration.tmp`;
      copyFileSync(source, temporary);
      renameSync(temporary, destination);
    }
    const cutover = { ...marker, phase: "cutover" as const, updatedAt: new Date().toISOString() };
    this.writeMarker(cutover);
    return this.restartVerify(sourceDigest);
  }

  restartVerify(sourceDigest: string): MigrationMarker {
    const marker = this.requireMarker(sourceDigest, ["cutover"]);
    const live = inventory(this.root);
    if (digestFiles(live) !== marker.projectedDigest) throw new Error("Live Knowledge digest does not match the verified cutover.");
    const projection = project(live);
    if (projection.receipt.changed !== 0 || projection.receipt.projectedDigest !== marker.projectedDigest) {
      throw new Error("Live Knowledge is not idempotent after restart.");
    }
    return marker;
  }

  rollback(sourceDigest: string): MigrationMarker {
    const marker = this.requireMarker(sourceDigest, ["backed-up", "staged", "verified", "cutover"]);
    if (!marker.backupPath || !existsSync(marker.backupPath)) throw new Error("Migration backup is unavailable.");
    for (const rel of marker.filesList) {
      const source = join(marker.backupPath, rel);
      const destination = join(this.root, rel);
      const temporary = `${destination}.knowledge-rollback.tmp`;
      copyFileSync(source, temporary);
      renameSync(temporary, destination);
    }
    rmSync(this.stageRoot, { recursive: true, force: true });
    rmSync(this.markerPath, { force: true });
    return marker;
  }

  private marker(
    phase: KnowledgeMigrationPhase,
    receipt: KnowledgeMigrationReceipt,
    files: ProjectedFile[],
    backupPath?: string,
  ): MigrationMarker {
    return {
      schema: 1,
      phase,
      ...receipt,
      updatedAt: new Date().toISOString(),
      filesList: files.map(file => file.rel),
      ...(backupPath ? { backupPath } : {}),
    };
  }

  private requireSource(sourceDigest: string, receipt: KnowledgeMigrationReceipt): void {
    if (!/^[a-f0-9]{64}$/.test(sourceDigest) || receipt.sourceDigest !== sourceDigest) {
      throw new Error("Knowledge source changed after preview.");
    }
  }

  private requireMarker(sourceDigest: string, phases: KnowledgeMigrationPhase[]): MigrationMarker {
    const marker = this.status();
    if (!marker || marker.sourceDigest !== sourceDigest || !phases.includes(marker.phase)) {
      throw new Error(`Knowledge migration must be in phase ${phases.join(" or ")} for this source digest.`);
    }
    return marker;
  }

  private writeMarker(marker: MigrationMarker): void {
    mkdirSync(this.migrationRoot, { recursive: true });
    const temporary = `${this.markerPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(marker, null, 2) + "\n");
    renameSync(temporary, this.markerPath);
  }
}
