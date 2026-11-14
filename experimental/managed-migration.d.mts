import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ManagedMcpManifest } from "../../src/mcp/mcp-lifecycle";
export interface IsolatedManagedManifest extends ManagedMcpManifest {
  experimental: true;
  launcherSha256: string;
  interpreters: Record<"python" | "node", { path: string; sha256: string }>;
  pythonDistributions: string[];
  pythonDependencyProfile: "fastmcp" | "local-model";
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
}): Promise<IsolatedManagedManifest>;
export function verifyIsolatedManagedGeneration(root: string, generation: string): Promise<IsolatedManagedManifest>;
export function publishIsolatedManagedGeneration(root: string, generation: string): Promise<IsolatedManagedManifest>;
export function isolatedManagedLaunch(root: string): Promise<StdioServerParameters>;
