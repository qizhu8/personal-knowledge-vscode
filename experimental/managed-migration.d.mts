import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ManagedMcpManifest } from "../../src/mcp/mcp-lifecycle";
export interface IsolatedManagedManifest extends ManagedMcpManifest {
  experimental: true;
  launcherSha256: string;
  interpreters: Record<"python" | "node", { path: string; sha256: string }>;
  pythonDistributions: string[];
  pythonDependencyProfile: "fastmcp" | "local-model";
  /** Build-declared policy for a new managed root; old roots and launchers are never upgraded in place. */
  startupValidation?: "core-then-background-v2";
  backendKind?: "native-public-mcp" | "standalone-core";
  backendAbi?: "pkm.mcp.api/1" | "pkm.shared-core-http/v1";
  coreHostProfileSha256?: string;
}
export interface PythonDependencyPlan {
  schema: "pkm.isolated-python-dependencies/v1";
  ready: boolean;
  profile: "fastmcp" | "local-model";
  issues: string[];
  totalBytes: number;
  maxPythonDependencyBytes: number;
  distributions: string[];
  distributionPins: Record<string, { version: string; files: Record<string, number> }>;
}
export interface SnapshotSchedulerEnrollment {
  schema: "pkm.native-snapshot-scheduler/v1";
  workspaceId: string;
  actorId: "mcp:external";
  admissionSha256: string;
}
export function planIsolatedPythonDependencies(options?: {
  repositoryRoot?: string; python?: string; modelDependencies?: boolean; maxPythonDependencyBytes?: number;
}): Promise<PythonDependencyPlan>;
export function stageIsolatedManagedGeneration(options: {
  managedRoot: string; data: string; repositoryRoot?: string; python?: string; node?: string; allowWrites?: boolean;
  modelDependencies?: boolean; maxPythonDependencyBytes?: number;
  snapshotScheduler?: SnapshotSchedulerEnrollment;
  maxTotalBytes?: number; minFreeBytes?: number;
  backendKind?: "native-public-mcp" | "standalone-core";
  coreHostProfile?: unknown;
}): Promise<IsolatedManagedManifest>;
/** Always runs the complete audit, including generations using staged normal startup. */
export function verifyIsolatedManagedGeneration(root: string, generation: string): Promise<IsolatedManagedManifest>;
export function publishIsolatedManagedGeneration(root: string, generation: string): Promise<IsolatedManagedManifest>;
export function isolatedManagedLaunch(root: string): Promise<StdioServerParameters>;
export interface IsolatedManagedRuntimeStatus {
  activeGeneration: string | null;
  candidates: string[];
  pendingCleanup: string[];
  leases: { schema: "pkm.managed-process-lease/v1"; pid: number; generation: string; live: boolean }[];
  history: {
    schema: "pkm.managed-runtime-history/v1";
    transitions: { sequence: number; from: string | null; to: string; phase: "prepared" | "switched" | "aborted"; dataRollback: false }[];
    retired: string[];
  };
}
export function inspectIsolatedManagedRuntime(root: string): Promise<IsolatedManagedRuntimeStatus>;
export function cleanupIsolatedManagedRuntime(root: string): Promise<IsolatedManagedRuntimeStatus>;
/** Full verification; descriptor alone does not reserve a live generation. */
export function isolatedManagedBackendLaunch(root: string, expectedKind?: "standalone-core"): Promise<StdioServerParameters>;
export function withIsolatedManagedGenerationAdmission<T>(
  root: string, generation: string, expectedKind: "standalone-core",
  start: (launch: StdioServerParameters) => Promise<{ pid: number; value: T }>,
): Promise<T>;
