import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { canonicalJson, compileWorkflowDefinitionV1 } from "../workflows/workflow-contracts";
import { PythonEnvironmentAuthority, type PythonEnvironmentHandle } from "./python-environment-authority";
import type { PyEnv } from "../servers/pyenvs";

export type PythonRecipeBinding = Readonly<{
  root: string; workspaceId: string; actorId: string; sourceFingerprint: string; namespace: string; chatId: string;
}>;
type Manifest = {
  binding: PythonRecipeBinding; cwd: string; environmentId: string; runId: string;
  request: { operation: "recipe.runtime.start"; args: {
    namespace: string; chatId: string; operationId: string; expectedDigest: string; recipeId: string; inputs: Record<string, unknown>;
  } };
  source: { kind: "recipe"; recipeId: string; revision: number; executableDigest: string; snapshotRevision: string };
  executableDigest: string; definition: unknown; inputs: Record<string, unknown>;
  steps: { nodeId: string; scriptSha256: string; argv: string[] }[];
};
export type PythonRecipeGrant = Readonly<{
  manifest: Manifest; manifestDigest: string;
  program: { handle: PythonEnvironmentHandle; cwd: string; source: Manifest["source"]; definition: unknown;
    executableDigest: string; inputs: Record<string, unknown> };
}>;
const fingerprint = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function freeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
}
/** Read the explicitly supplied private profile's old registry; never initializes or writes an old manager. */
export function readProfilePythonRegistry(file: string): PyEnv[] {
  const stat = fs.lstatSync(file);
  let directory = path.dirname(file), privateAncestor = false;
  for (;;) {
    const parent = fs.lstatSync(directory);
    if (parent.isDirectory() && parent.uid === process.getuid?.() && (parent.mode & 0o077) === 0) {
      privateAncestor = true; break;
    }
    const next = path.dirname(directory); if (next === directory) break; directory = next;
  }
  if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file
    || fs.realpathSync(path.dirname(file)) !== path.dirname(file) || !stat.isFile() || stat.nlink !== 1
    || stat.uid !== process.getuid?.() || stat.mode & 0o002 || !privateAncestor || stat.size > 65536)
    throw new Error("An owned unchanged private-profile Python registry is required.");
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(records) || records.length > 256 || records.some(record => !record || typeof record !== "object"
    || !["id", "name", "path", "python"].every(key => typeof record[key] === "string")
    || !["venv", "conda", "uv", "other"].includes(record.manager)))
    throw new Error("The existing private-profile Python registry is invalid.");
  return records;
}

/** Separate live native Python approval; a SQL Recipe/public-start grant is not environment authority. */
export class PythonRecipeAuthority {
  private readonly grants = new Set<PythonRecipeGrant>();
  private readonly approvals = new Map<PythonRecipeGrant, number>();
  constructor(private readonly options: {
    trusted(): boolean; environments: PythonEnvironmentAuthority; binding: PythonRecipeBinding; cwd: string;
  }) {}
  select(value: unknown): PythonRecipeGrant {
    if (!this.options.trusted()) throw new Error("Current private trusted Recipe host required.");
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error("Python Recipe review exceeds its bound.");
    const preview = JSON.parse(JSON.stringify(value)) as { manifest: Manifest; manifestDigest: string };
    const manifest = preview.manifest, request = manifest.request, source = manifest.source;
    if (fingerprint(manifest) !== preview.manifestDigest || fingerprint(manifest.binding) !== fingerprint(this.options.binding)
      || manifest.cwd !== this.options.cwd || request.operation !== "recipe.runtime.start"
      || request.args.namespace !== this.options.binding.namespace || request.args.chatId !== this.options.binding.chatId
      || !/^[a-f0-9-]{36}$/i.test(request.args.operationId) || !/^[a-f0-9]{64}$/.test(request.args.expectedDigest)
      || manifest.runId !== `recipe_native_${request.args.operationId.replace(/-/g, "").toLowerCase()}`
      || source.kind !== "recipe" || source.recipeId !== request.args.recipeId || !Number.isSafeInteger(source.revision)
      || source.revision < 1 || typeof source.snapshotRevision !== "string"
      || !/^[a-f0-9]{64}$/.test(source.executableDigest) || source.executableDigest !== manifest.executableDigest
      || fingerprint(manifest.inputs) !== fingerprint(request.args.inputs))
      throw new Error("Exact private SQL Python Recipe source/request binding rejected.");
    const compiled = compileWorkflowDefinitionV1(manifest.definition);
    if (!compiled.ok || compiled.executableDigest !== manifest.executableDigest
      || fingerprint(compiled.model) !== fingerprint(manifest.definition) || compiled.model.spec.nodes.length > 4)
      throw new Error("SQL Python Recipe definition/digest rejected.");
    const steps = compiled.model.spec.nodes.map(node => {
      if (node.kind !== "pkm.step.script/v1" || node.config.runtime !== "python"
        || node.config.environmentId !== manifest.environmentId || node.control && node.control.mode !== "single"
        || node.dependsOn.some(edge => edge.loop) || node.config.cwd && node.config.cwd !== "."
        || node.config.timeoutSeconds > 20 || node.config.maxOutputBytes > 4096
        || node.config.script.includes("\0") || Buffer.byteLength(node.config.script) > 16384 || (node.config.args ?? []).length > 12)
        throw new Error("SQL Recipe requires bounded Python steps in the exact existing environment.");
      const argv = (node.config.args ?? []).map(argument => argument.replace(/\{\{\s*inputs\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
        (_match, key: string) => {
          const item = manifest.inputs[key];
          if (!Object.prototype.hasOwnProperty.call(manifest.inputs, key) || !["string", "boolean", "number"].includes(typeof item))
            throw new Error("Python argv requires explicitly bound primitive inputs.");
          return String(item);
        }));
      if (argv.some(arg => arg.includes("\0") || arg.includes("{{") || Buffer.byteLength(arg) > 1024)
        || Buffer.byteLength(JSON.stringify(argv)) > 4096) throw new Error("Python argv exceeds its bound.");
      return { nodeId: node.nodeId, scriptSha256: createHash("sha256").update(node.config.script).digest("hex"), argv };
    });
    if (!steps.length || fingerprint(steps) !== fingerprint(manifest.steps)) throw new Error("Reviewed Python script/argv manifest changed.");
    const handle = this.options.environments.select(manifest.binding.workspaceId, manifest.binding.actorId, manifest.environmentId);
    const grant: PythonRecipeGrant = { manifest, manifestDigest: preview.manifestDigest,
      program: { handle, cwd: manifest.cwd, source, definition: compiled.model, executableDigest: compiled.executableDigest, inputs: manifest.inputs } };
    freeze(grant); this.grants.add(grant); return grant;
  }
  validate(grant: PythonRecipeGrant) {
    if (!this.options.trusted()) this.revoke();
    if (!this.grants.has(grant)) throw new Error("Native SQL Python Recipe authority absent or revoked.");
    this.options.environments.validate(grant.program.handle, this.options.binding.workspaceId, this.options.binding.actorId);
  }
  approve(grant: PythonRecipeGrant) { this.validate(grant); this.approvals.set(grant, Date.now() + 180000); }
  consume(grant: PythonRecipeGrant) {
    const expires = this.approvals.get(grant); this.approvals.delete(grant);
    this.validate(grant);
    if (!expires || expires <= Date.now()) throw new Error("Fresh native SQL Python Recipe approval absent, expired or consumed.");
    return { request: grant.manifest.request, manifestDigest: grant.manifestDigest, program: grant.program };
  }
  revoke() { this.approvals.clear(); this.grants.clear(); }
}
