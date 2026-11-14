import * as fs from "fs";
import * as path from "path";
import { githubSyncCoordinatorDirectory } from "./github-sync-coordinator";
import { readStoredGitHubSyncCredentials, GitHubSyncCredentialError } from "./github-sync-credentials";
import type { GitHubSyncTarget } from "./github-sync";

type RecoveryStatus = "absent" | "recorded" | "idle" | "pending" | "invalid";

function directory(base: string, components: string[]): string | undefined {
  let current = base;
  for (const component of ["", ...components]) {
    current = component ? path.join(current, component) : current;
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return current;
}

function readState(base: string, components: string[]): unknown | undefined {
  const parent = directory(base, components.slice(0, -1));
  if (!parent) return undefined;
  let fd: number;
  try { fd = fs.openSync(path.join(parent, components[components.length - 1]), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error("unsafe state file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid state");
  return value as Record<string, unknown>;
}

function inspectState(action: () => RecoveryStatus): RecoveryStatus {
  try { return action(); } catch { return "invalid"; }
}

function transactionStatus(globalStorage: string, root: string, target: GitHubSyncTarget): RecoveryStatus {
  return inspectState(() => {
    const state = readState(globalStorage, ["github-sync", "checkouts", target.id, "transactions", "latest.json"]);
    if (state === undefined) return "absent";
    const receipt = record(state), baseline = target.lastSync;
    if (receipt.schema !== 1 || receipt.targetId !== target.id || typeof receipt.transactionId !== "string"
      || receipt.operation !== "sync") return "invalid";
    if (receipt.state === "prepared" || receipt.state === "pushed") return "pending";
    if (receipt.state !== "recorded") return "invalid";
    return baseline && typeof baseline.storeRoot === "string" && fs.realpathSync(baseline.storeRoot) === fs.realpathSync(root)
      && typeof baseline.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseline.commit)
      && receipt.repository === target.repository && receipt.branch === target.branch
      && receipt.pushedCommit === baseline.commit && baseline.repository === target.repository
      && baseline.branch === target.branch ? "recorded" : "invalid";
  });
}

function coordinatorStatus(globalStorage: string, root: string): RecoveryStatus {
  return inspectState(() => {
    const coordinator = githubSyncCoordinatorDirectory(globalStorage, root);
    const relative = path.relative(globalStorage, coordinator).split(path.sep);
    const state = readState(globalStorage, [...relative, "coordinator.json"]);
    if (state === undefined) return "absent";
    const value = record(state);
    if (value.schema !== 1) return "invalid";
    for (const key of ["intents", "claims", "blocked"]) {
      if (Object.keys(record(value[key])).length) return "pending";
    }
    return "idle";
  });
}

function serviceStatus(globalStorage: string): RecoveryStatus {
  return inspectState(() => {
    const serviceRoot = directory(globalStorage, ["pkm-service"]);
    if (!serviceRoot) return "absent";
    const services = fs.readdirSync(serviceRoot);
    if (services.length > 10_000) return "invalid";
    for (const name of services) {
      const results = directory(globalStorage, ["pkm-service", name, "results"]);
      if (results && fs.readdirSync(results).length) return "pending";
    }
    return "idle";
  });
}

function journalStatus(globalStorage: string, targetId: string): RecoveryStatus {
  return inspectState(() => {
    const state = readState(globalStorage, ["github-sync", "experimental-next", `${targetId}.json`]);
    if (state === undefined) return "absent";
    const value = record(state);
    if (value.schema !== "pkm.experimental-legacy-sync/v1" || value.targetId !== targetId
      || typeof value.workspaceId !== "string" || !value.workspaceId
      || typeof value.configHash !== "string" || !/^[a-f0-9]{64}$/.test(value.configHash)
      || typeof value.policyId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.policyId)
      || typeof value.baseline !== "string" || !/^[a-f0-9]{40}$/.test(value.baseline)
      || typeof value.phase !== "string"
      || !["idle", "conflict", "applying", "publishing", "review"].includes(value.phase)) return "invalid";
    return value.phase === "idle" ? "idle" : "pending";
  });
}

/** Read-only observation; it is not an admission or evidence of writer exclusion. */
export async function inspectNextSyncHost(options: {
  globalStorage: string;
  root: string;
  targetId: string;
  readTargets(): GitHubSyncTarget[];
  readSecret(key: string): PromiseLike<string | undefined>;
}) {
  if (typeof options.targetId !== "string" || !/^[A-Za-z0-9._-]+$/.test(options.targetId)
    || options.targetId === "." || options.targetId === "..")
    throw new Error("Invalid GitHub Sync target identity.");
  const targets = options.readTargets().filter(target => target.id === options.targetId);
  if (targets.length !== 1) throw new Error("GitHub Sync target is missing or ambiguous.");
  const target = targets[0];
  let credential: "available" | "missing" | "invalid" | "unavailable" | "unsupported" = "unsupported";
  if (target.authentication?.method === "vscode") {
    try {
      await readStoredGitHubSyncCredentials(
        () => options.readSecret(`personalKnowledge.githubSync.vscode.${target.id}`), target);
      credential = "available";
    } catch (error) {
      const code = error instanceof GitHubSyncCredentialError ? error.code : "";
      credential = code === "CREDENTIAL_MISSING" ? "missing"
        : code === "CREDENTIAL_INVALID" || code === "CREDENTIAL_ACCOUNT_MISMATCH" ? "invalid" : "unavailable";
    }
  }
  return {
    schema: "pkm.next-sync-host-observation/v1" as const,
    targetId: target.id,
    credential,
    recovery: {
      transaction: transactionStatus(options.globalStorage, options.root, target),
      coordinator: coordinatorStatus(options.globalStorage, options.root),
      serviceResults: serviceStatus(options.globalStorage),
      experimentalJournal: journalStatus(options.globalStorage, target.id),
    },
    cutover: "BLOCKED_LEGACY_WRITER_EXCLUSION" as const,
  };
}

export function rejectNextSyncCutover(): never {
  throw new Error("Next Sync cutover is blocked: legacy writer exclusion and production transport are not established.");
}
