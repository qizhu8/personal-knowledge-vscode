import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { compileWorkflowDefinitionV1 } from "../workflows/workflow-contracts";
import { PythonEnvironmentAuthority, type PythonEnvironmentHandle } from "./python-environment-authority";

export type PythonProgramGrant = Readonly<{
  handle: PythonEnvironmentHandle; cwd: string; definition: unknown; inputs: Record<string, unknown>;
  executableDigest: string; source: { kind: "inline" };
  sourceFile: { root: string; file: string; identity: string; pin: string; sha256: string };
}>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function source(root: string, file: string) {
  const directory = fs.lstatSync(root), stat = fs.lstatSync(file, { bigint: true }), child = path.relative(root, file);
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root || !directory.isDirectory()
    || !child || child.startsWith("..") || path.isAbsolute(child) || fs.realpathSync(file) !== file
    || fs.realpathSync(path.dirname(file)) !== path.dirname(file) || !stat.isFile() || stat.nlink !== 1n
    || stat.size > 32768n || stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o022n)
    throw new Error("Select a bounded owned regular Workflow JSON file inside this trusted workspace, without links.");
  const bytes = fs.readFileSync(file, "utf8");
  return { bytes, descriptor: { root, file, identity: `${directory.dev}:${directory.ino}`,
    pin: ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].map(key => String(stat[key as keyof typeof stat])).join(":"),
    sha256: sha(bytes) } };
}
/** Fresh native approval objects; neither files, environment IDs nor IPC JSON are executable grants. */
export class PythonProgramAuthority {
  private readonly grants = new Set<PythonProgramGrant>();
  private readonly approvals = new Map<PythonProgramGrant, number>();
  constructor(private readonly trusted: () => boolean, private readonly environments: PythonEnvironmentAuthority) {}
  select(handle: PythonEnvironmentHandle, root: string, file: string, cwd: string, inputs: Record<string, unknown>): PythonProgramGrant {
    if (!this.trusted()) throw new Error("A current trusted experimental Python host is required.");
    this.environments.validate(handle, handle.workspaceId, handle.actorId);
    const snapshot = source(root, file), compiled = compileWorkflowDefinitionV1(JSON.parse(snapshot.bytes));
    if (!compiled.ok) throw new Error(`Reviewed Python Workflow failed compilation: ${
      compiled.diagnostics.slice(0, 4).map(item => `${item.code} ${item.pointer}`).join("; ")}. Correct the source and approve again.`);
    if (compiled.model.spec.nodes.length > 4 || compiled.model.spec.nodes.some(node =>
      node.kind !== "pkm.step.script/v1" || node.config.runtime !== "python" || node.config.environmentId !== handle.environmentId
      || node.control && node.control.mode !== "single" || node.dependsOn.some(dependency => dependency.loop)
      || node.config.cwd && node.config.cwd !== "." || node.config.timeoutSeconds > 20 || node.config.maxOutputBytes > 4096
      || Buffer.byteLength(node.config.script) > 16384 || (node.config.args ?? []).length > 12))
      throw new Error("Approve at most four bounded Python script steps for this exact environment (20 seconds, 4096 output bytes each).");
    const grant: PythonProgramGrant = Object.freeze({ handle, cwd, definition: compiled.model,
      inputs: JSON.parse(JSON.stringify(inputs)), executableDigest: compiled.executableDigest,
      source: { kind: "inline" as const }, sourceFile: snapshot.descriptor });
    const freeze = (value: any) => { if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze); Object.freeze(value);
    } };
    Object.values(grant).forEach(freeze);
    if (Buffer.byteLength(JSON.stringify(grant)) > 49152) throw new Error("Python approval payload exceeds its bound.");
    this.grants.add(grant); return grant;
  }
  validate(grant: PythonProgramGrant, workspaceId: string): void {
    if (!this.trusted()) this.revoke();
    if (!this.grants.has(grant)) throw new Error("Native Python program authority is absent or revoked.");
    this.environments.validate(grant.handle, workspaceId, "local:owner");
    if (JSON.stringify(source(grant.sourceFile.root, grant.sourceFile.file).descriptor) !== JSON.stringify(grant.sourceFile))
      throw new Error("Reviewed Python source changed; reselect and approve the new bytes.");
  }
  approve(grant: PythonProgramGrant, workspaceId: string) {
    this.validate(grant, workspaceId); this.approvals.set(grant, Date.now() + 180000);
  }
  consume(grant: PythonProgramGrant, workspaceId: string) {
    this.validate(grant, workspaceId);
    const expires = this.approvals.get(grant); this.approvals.delete(grant);
    if (!expires || expires <= Date.now()) throw new Error("Fresh exact one-run Python approval is absent, expired or consumed.");
  }
  revoke() { this.grants.clear(); this.approvals.clear(); }
}
