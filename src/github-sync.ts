import { execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { compileWorkflowDefinitionV1 } from "./workflow-contracts";
import { compareVersionOrder } from "./version-order";

const execFileAsync = promisify(execFile);

export const GITHUB_SYNC_CONTENT_TYPES = [
  "skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes", "agentSnapshots"
] as const;

export type GitHubSyncContentType = typeof GITHUB_SYNC_CONTENT_TYPES[number];
export type GitHubSyncPrivacy = "public" | "private";
export type GitHubSyncShield = "outline" | "yellow" | "green";
export type GitHubSyncResolutionRule =
  | "authoritative-migration"
  | "force-local-authority"
  | "built-in-authority"
  | "identical-convergence"
  | "move-edit"
  | "deterministic-three-way"
  | "remote-only"
  | "local-only"
  | "unchanged"
  | "human-required";

export interface GitHubSyncResolutionReport {
  totalFiles: number;
  rules: Partial<Record<GitHubSyncResolutionRule, number>>;
  generatedAt: string;
}
export type GitHubSyncAuthentication =
  | { method: "ssh"; identityFile: string; expectedLogin: string }
  | { method: "https"; expectedLogin: string }
  | { method: "vscode"; expectedLogin: string; accountId?: string };

export interface GitHubSyncCredentials {
  accessToken: string;
}

export class GitHubSyncExtensionCompatibilityError extends Error {
  constructor(
    readonly requiredVersion: string,
    readonly installedVersion: string,
  ) {
    super(
      `This Knowledge repository requires Personal Knowledge Manager ${requiredVersion} or newer. `
      + `Installed version: ${installedVersion}. Upgrade the extension before syncing; no local content was changed.`,
    );
    this.name = "GitHubSyncExtensionCompatibilityError";
  }
}

export function githubSyncAuthenticationSessionOptions(selectAccount = false): {
  createIfNone: true;
  clearSessionPreference?: true;
} {
  return selectAccount ? { createIfNone: true, clearSessionPreference: true } : { createIfNone: true };
}

export interface GitHubSyncTypeSelection {
  items: string[];
  folders: string[];
}

export type GitHubSyncSelectionScope = Record<GitHubSyncContentType, GitHubSyncTypeSelection>;

export interface GitHubSyncTarget {
  schema: 1;
  id: string;
  name: string;
  repository: string;
  branch: string;
  authentication?: GitHubSyncAuthentication;
  automation: {
    enabled: boolean;
    intervalMinutes: number;
    syncOnChange: boolean;
    initialSyncCompleted: boolean;
  };
  conflictResolution: "manual" | "agent";
  selection: Record<GitHubSyncPrivacy, GitHubSyncSelectionScope>;
  lastSync?: {
    at: string;
    commit: string;
    fingerprints: Partial<Record<GitHubSyncContentType, string>>;
    repository?: string;
    branch?: string;
    storeRoot?: string;
  };
  lastFailure?: {
    at: string;
    error: string;
    reason: string;
  };
  lastResolutionReport?: GitHubSyncResolutionReport;
  pendingDeletions?: GitHubSyncDeletionEvidence[];
  publication?: {
    requiredCapability: "stable-entity-identity";
    sourceCommit: string;
    sourceDigest: string;
    manualVerificationCompleted: boolean;
  };
}

export interface GitHubSyncDeletionEvidence {
  type: GitHubSyncContentType;
  itemId: string;
  deletedAt: string;
  category?: string;
  privacy?: GitHubSyncPrivacy;
}

export interface GitHubSyncFingerprintEntry {
  path: string;
  digest: string;
}

export function githubSyncManagedContent(type: GitHubSyncContentType, content: Buffer): Buffer {
  if (type !== "recipes") return content;
  const recipe = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
  delete recipe.editorLayout;
  return Buffer.from(`${JSON.stringify(recipe, null, 2)}\n`, "utf8");
}

export interface GitHubSyncCatalogItem {
  id: string;
  label: string;
  cat: string;
  meta?: string;
  isPrivate: boolean;
  source?: string;
  destination: string;
  content?: string;
}

export type GitHubSyncCatalog = Record<GitHubSyncContentType, GitHubSyncCatalogItem[]>;

export interface GitHubSyncResult {
  transactionId: string;
  commit: string;
  changed: boolean;
  fingerprints: Record<GitHubSyncContentType, string>;
  pulled: string[];
  deletedLocal: string[];
  privateTopLevels: Partial<Record<GitHubSyncContentType, string[]>>;
  recipePulls: GitHubSyncRecipePull[];
  recipeDeletes: string[];
  acknowledgedDeletions: GitHubSyncDeletionEvidence[];
  resolutionReport: GitHubSyncResolutionReport;
}

export interface GitHubSyncTransactionReceipt {
  schema: 1;
  transactionId: string;
  targetId: string;
  repository: string;
  branch: string;
  baseCommit: string;
  pushedCommit: string;
  pushedAt: string;
  operation: "sync" | "force-local-authority";
  actor?: string;
  comment?: string;
  state: "pushed" | "recorded";
  recordedAt?: string;
}

export interface GitHubSyncRecipePull {
  path: string;
  itemId: string;
  content: Buffer;
  expectedLocal?: Buffer;
}

export interface GitHubSyncConflict {
  path: string;
  type: GitHubSyncContentType;
  itemId: string;
  category: string;
  privacy: GitHubSyncPrivacy;
  base?: Buffer;
  local?: Buffer;
  remote?: Buffer;
}

export class GitHubSyncConflictError extends Error {
  constructor(
    public readonly remoteCommit: string,
    public readonly conflicts: GitHubSyncConflict[],
    public readonly pulled: string[] = [],
    public readonly deletedLocal: string[] = [],
    public readonly privateTopLevels: Partial<Record<GitHubSyncContentType, string[]>> = {},
    public readonly recipePulls: GitHubSyncRecipePull[] = [],
    public readonly recipeDeletes: string[] = [],
    public readonly resolutionReport: GitHubSyncResolutionReport = { totalFiles: conflicts.length, rules: { "human-required": conflicts.length }, generatedAt: new Date().toISOString() },
  ) {
    const paths = conflicts.map(conflict => conflict.path);
    super(`GitHub Sync found ${paths.length} conflicting file${paths.length === 1 ? "" : "s"}: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, and ${paths.length - 5} more` : ""}. Resolve and approve them before pushing.`);
    this.name = "GitHubSyncConflictError";
  }
}

export interface GitHubSyncAuthenticationResult {
  host: string;
  login: string;
  fingerprint: string;
}

export interface GitHubSyncCreatedIdentity {
  identityFile: string;
  publicKey: string;
}

export interface GitHubSyncAuthenticationOptions {
  accounts: string[];
  identities: string[];
}

export function githubSyncAuthenticationFailureGuidance(target: GitHubSyncTarget | undefined, detail: string): string {
  if (!target?.authentication || !/(?:authentication failed|repository not found)/i.test(detail)) return "";
  if (target.authentication.method === "https") {
    return `Credential Manager did not authenticate as ${target.authentication.expectedLogin}. Reconnect that exact account or switch this target to VS Code GitHub Authentication.`;
  }
  if (target.authentication.method === "vscode") {
    return `Reconnect the VS Code GitHub account ${target.authentication.expectedLogin} for this target.`;
  }
  return "";
}

export interface GitHubSyncRemoteFile {
  path: string;
  type: GitHubSyncContentType;
  size: number;
}

export interface GitHubSyncRemoteValidation {
  repositoryFiles: number;
  importableFiles: number;
  ignoredFiles: number;
  invalidFiles: number;
  invalidExamples: string[];
  importableBytes: number;
  largestFileBytes: number;
  filesOverPreviewLimit: number;
}

export interface GitHubSyncRemoteSnapshot {
  targetId: string;
  commit: string;
  files: GitHubSyncRemoteFile[];
  validation: GitHubSyncRemoteValidation;
}

export interface GitHubSyncRestoreResult {
  restored: string[];
  conflicts: string[];
}

function emptyScope(includeAll: boolean): GitHubSyncSelectionScope {
  const scope = {} as GitHubSyncSelectionScope;
  for (const type of GITHUB_SYNC_CONTENT_TYPES) {
    const selectedByDefault = type !== "packages" && type !== "servers" && type !== "agentSnapshots";
    scope[type] = { items: [], folders: includeAll && selectedByDefault ? [""] : [] };
  }
  return scope;
}

export function defaultGitHubSyncSelection(): GitHubSyncTarget["selection"] {
  return { public: emptyScope(true), private: emptyScope(false) };
}

function normalizeValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value).trim().replace(/\\/g, "/")).filter(value => value === "" || (!value.startsWith("/") && !value.split("/").includes(".."))))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeScope(value: any): GitHubSyncSelectionScope {
  return Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, {
    items: normalizeValues(value?.[type]?.items),
    folders: normalizeValues(value?.[type]?.folders)
  }])) as GitHubSyncSelectionScope;
}

export function normalizeGitHubSyncTarget(value: any, createId: () => string = randomUUID): GitHubSyncTarget {
  const name = String(value?.name || "").trim();
  const repository = String(value?.repository || "").trim();
  const branch = String(value?.branch || "main").trim();
  if (!name) throw new Error("Target name is required.");
  if (!repository || /[\0\r\n]/.test(repository)) throw new Error("Repository is required.");
  if (!branch || branch.startsWith("-") || branch.endsWith(".") || branch.includes("..") || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch)) {
    throw new Error("Branch is not a valid Git branch name.");
  }
  const selection = value?.selection
    ? { public: normalizeScope(value.selection.public), private: normalizeScope(value.selection.private) }
    : defaultGitHubSyncSelection();
  const id = String(value?.id || createId()).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Target ID is invalid.");
  const configuredInterval = value?.automation?.intervalMinutes;
  const intervalMinutes = configuredInterval === undefined ? 5 : Number(configuredInterval);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
    throw new Error("Automatic sync interval must be between 1 and 1440 minutes.");
  }
  const hasAutomation = !!value?.automation;
  const initialSyncCompleted = value?.automation?.initialSyncCompleted === true
    || (value?.automation?.initialSyncCompleted === undefined && !!value?.lastSync?.at);
  const requestedAutomation = hasAutomation ? value.automation.enabled !== false : false;
  const target: GitHubSyncTarget = {
    schema: 1,
    id,
    name,
    repository,
    branch,
    automation: {
      enabled: requestedAutomation && initialSyncCompleted,
      intervalMinutes,
      syncOnChange: value?.automation?.syncOnChange !== false,
      initialSyncCompleted,
    },
    conflictResolution: value?.conflictResolution === "agent" ? "agent" : "manual",
    selection
  };
  if (value?.authentication) {
    const method = value.authentication.method === "https" ? "https" : value.authentication.method === "vscode" ? "vscode" : "ssh";
    const identityFile = String(value.authentication.identityFile || "").trim().replace(/^~(?=$|[\\/])/, os.homedir());
    const expectedLogin = String(value.authentication.expectedLogin || "").trim();
    if (!/^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(expectedLogin)) throw new Error("Expected GitHub login is required.");
    if (method === "https" || method === "vscode") {
      githubSyncRepositoryHttpsHost(repository);
      target.authentication = method === "vscode"
        ? { method, expectedLogin, ...(value.authentication.accountId ? { accountId: String(value.authentication.accountId) } : {}) }
        : { method, expectedLogin };
    } else {
      if (!identityFile || /[\0\r\n]/.test(identityFile)) throw new Error("SSH identity file is required.");
      githubSyncRepositorySshHost(repository);
      target.authentication = { method, identityFile, expectedLogin };
    }
  }
  if (value?.lastSync) {
    const fingerprints = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES
      .filter(type => typeof value.lastSync.fingerprints?.[type] === "string")
      .map(type => [type, value.lastSync.fingerprints[type]]));
    target.lastSync = {
      at: String(value.lastSync.at || ""),
      commit: String(value.lastSync.commit || ""),
      fingerprints,
      ...(value.lastSync.repository ? { repository: String(value.lastSync.repository) } : {}),
      ...(value.lastSync.branch ? { branch: String(value.lastSync.branch) } : {}),
      ...(value.lastSync.storeRoot ? { storeRoot: path.resolve(String(value.lastSync.storeRoot)) } : {}),
    };
  }
  if (value?.lastResolutionReport && typeof value.lastResolutionReport === "object") {
    const rules = Object.fromEntries(Object.entries(value.lastResolutionReport.rules || {})
      .filter(([, count]) => Number.isInteger(count) && Number(count) >= 0)
      .map(([rule, count]) => [rule, Number(count)])) as GitHubSyncResolutionReport["rules"];
    target.lastResolutionReport = {
      totalFiles: Math.max(0, Number(value.lastResolutionReport.totalFiles) || 0),
      rules,
      generatedAt: String(value.lastResolutionReport.generatedAt || ""),
    };
  }
  if (value?.lastFailure?.at && value?.lastFailure?.error) {
    target.lastFailure = {
      at: String(value.lastFailure.at),
      error: String(value.lastFailure.error),
      reason: String(value.lastFailure.reason || "automatic"),
    };
  }
  if (Array.isArray(value?.pendingDeletions)) {
    target.pendingDeletions = value.pendingDeletions.map((entry: any): GitHubSyncDeletionEvidence => {
      const type = String(entry?.type || "") as GitHubSyncContentType;
      const itemId = String(entry?.itemId || "");
      const deletedAt = String(entry?.deletedAt || "");
      if (!(GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(type) || !itemId || !Number.isFinite(Date.parse(deletedAt))) {
        throw new Error("GitHub Sync pending deletion evidence is invalid.");
      }
      return {
        type,
        itemId,
        deletedAt,
        ...(entry.category === undefined ? {} : { category: String(entry.category) }),
        ...(entry.privacy === "private" ? { privacy: "private" as const } : entry.privacy === "public" ? { privacy: "public" as const } : {}),
      };
    });
  }
  if (value?.publication) {
    if (value.publication.requiredCapability !== "stable-entity-identity"
      || !/^[0-9a-f]{40,64}$/i.test(String(value.publication.sourceCommit || ""))
      || !/^[0-9a-f]{64}$/i.test(String(value.publication.sourceDigest || ""))) {
      throw new Error("GitHub publication capability state is invalid.");
    }
    target.publication = {
      requiredCapability: "stable-entity-identity",
      sourceCommit: String(value.publication.sourceCommit),
      sourceDigest: String(value.publication.sourceDigest),
      manualVerificationCompleted: value.publication.manualVerificationCompleted === true,
    };
  }
  return target;
}

export function githubSyncRepositorySshHost(repository: string): string {
  const value = String(repository || "").trim();
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "ssh:" && parsed.hostname) return parsed.hostname;
  } catch { /* handled below */ }
  if (value.includes("://")) throw new Error("SSH account selection requires an SSH repository URL such as git@github.com:owner/repository.git.");
  const scp = /^(?:[^@/:\s]+@)?([^/:\s]+):[^\s]+$/.exec(value);
  if (scp) return scp[1];
  throw new Error("SSH account selection requires an SSH repository URL such as git@github.com:owner/repository.git.");
}

export function githubSyncRepositoryHttpsHost(repository: string): string {
  try {
    const parsed = new URL(String(repository || "").trim());
    if (parsed.protocol === "https:" && parsed.hostname && !parsed.username && !parsed.password) return parsed.hostname;
  } catch { /* handled below */ }
  throw new Error("Credential Manager authentication requires an HTTPS repository URL such as https://github.com/owner/repository.git.");
}

function shellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function githubSyncSshCommand(identityFile: string): string {
  return `ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -i ${shellArgument(identityFile)}`;
}

export function parseGitHubSshLogin(output: string): string {
  return /Hi\s+([^!\s]+)!\s+You've successfully authenticated/i.exec(String(output || ""))?.[1] || "";
}

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

export function parseGitHubCredentialManagerAccounts(output: string): string[] {
  const accounts = new Set<string>();
  for (const line of String(output || "").split(/\r?\n/)) {
    const cleaned = line.replace(/\x1b\[[0-9;]*m/g, "").trim().replace(/^[-*]\s*/, "");
    if (!cleaned || /^(?:https?:\/\/)?[^\s:]+:\s*$/.test(cleaned)) continue;
    const candidate = cleaned.split(/\s+/).pop()!.replace(/^['"]|['"]$/g, "");
    if (GITHUB_LOGIN_PATTERN.test(candidate)) accounts.add(candidate);
  }
  return [...accounts].sort((left, right) => left.localeCompare(right));
}

export async function discoverGitHubCredentialManagerAccounts(): Promise<string[]> {
  try {
    const result = await execFileAsync("git", ["credential-manager", "github", "list", "--url", "https://github.com", "--no-ui"], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000, windowsHide: process.platform === "win32",
    });
    return parseGitHubCredentialManagerAccounts(String(result.stdout || ""));
  } catch { return []; }
}

function expandedIdentityPath(value: string, sshDirectory: string): string | undefined {
  const unquoted = value.trim().replace(/^['"]|['"]$/g, "").replace(/%d/g, os.homedir());
  if (!unquoted || /%[A-Za-z%]/.test(unquoted)) return undefined;
  if (unquoted === "~") return os.homedir();
  if (unquoted.startsWith(`~${path.sep}`) || unquoted.startsWith("~/") || unquoted.startsWith("~\\")) return path.join(os.homedir(), unquoted.slice(2));
  return path.isAbsolute(unquoted) ? path.normalize(unquoted) : path.resolve(sshDirectory, unquoted);
}

export function discoverGitHubSshIdentities(sshDirectory = path.join(os.homedir(), ".ssh")): string[] {
  const identities = new Set<string>();
  const addIfPrivateKey = (candidate: string): void => {
    try {
      if (!fs.statSync(candidate).isFile()) return;
      const header = fs.readFileSync(candidate, { encoding: "utf8", flag: "r" }).slice(0, 256);
      if (/-----BEGIN (?:OPENSSH |RSA |DSA |EC )?PRIVATE KEY-----/.test(header)) identities.add(path.resolve(candidate));
    } catch { /* inaccessible files are not selectable */ }
  };
  try {
    for (const entry of fs.readdirSync(sshDirectory, { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.endsWith(".pub")) addIfPrivateKey(path.join(sshDirectory, entry.name));
    }
    const configPath = path.join(sshDirectory, "config");
    if (fs.existsSync(configPath)) {
      for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
        const match = /^\s*IdentityFile\s+(.+?)\s*(?:#.*)?$/i.exec(line);
        const candidate = match && expandedIdentityPath(match[1], sshDirectory);
        if (candidate) addIfPrivateKey(candidate);
      }
    }
  } catch { /* missing or inaccessible SSH directory */ }
  return [...identities].sort((left, right) => left.localeCompare(right));
}

export async function createGitHubSyncIdentity(expectedLogin: string, sshDirectory: string): Promise<GitHubSyncCreatedIdentity> {
  const login = String(expectedLogin || "").trim();
  if (!/^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/.test(login)) throw new Error("Enter the GitHub account before creating an SSH key.");
  fs.mkdirSync(sshDirectory, { recursive: true, mode: 0o700 });
  const identityFile = path.join(sshDirectory, `pkm_github_${login}_${randomUUID().slice(0, 8)}`);
  try {
    await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `pkm:${login}`, "-f", identityFile], { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: process.platform === "win32" });
    return { identityFile, publicKey: fs.readFileSync(`${identityFile}.pub`, "utf8").trim() };
  } catch (error) {
    fs.rmSync(identityFile, { force: true });
    fs.rmSync(`${identityFile}.pub`, { force: true });
    throw error;
  }
}

const VSCODE_GITHUB_CREDENTIAL_HELPER = "!f() { if [ \"$1\" = get ]; then printf '%s\\n' 'username=x-access-token' \"password=$PKM_GITHUB_SYNC_TOKEN\"; fi; }; f";

function gitEnvironment(target?: GitHubSyncTarget, credentials?: GitHubSyncCredentials): NodeJS.ProcessEnv {
  return target?.authentication?.method === "ssh"
    ? { ...process.env, GIT_SSH_COMMAND: githubSyncSshCommand(target.authentication.identityFile), GIT_SSH_VARIANT: "ssh" }
    : target?.authentication?.method === "https"
      ? { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      : target?.authentication?.method === "vscode"
        ? { ...process.env, GIT_TERMINAL_PROMPT: "0", PKM_GITHUB_SYNC_TOKEN: credentials?.accessToken || "" }
      : process.env;
}

export function githubSyncGitArguments(args: string[], target?: GitHubSyncTarget): string[] {
  const platformSafety = ["-c", "core.longpaths=true"];
  return target?.authentication?.method === "https"
    ? [...platformSafety, "-c", "credential.gitHubAccountFiltering=true", "-c", `credential.username=${target.authentication.expectedLogin}`, ...args]
    : target?.authentication?.method === "vscode"
      ? [...platformSafety, "-c", "credential.helper=", "-c", `credential.helper=${VSCODE_GITHUB_CREDENTIAL_HELPER}`, "-c", "credential.username=x-access-token", ...args]
      : [...platformSafety, ...args];
}

export async function probeGitHubSyncAuthentication(repository: string, selectedIdentityFile: string, expectedLogin = ""): Promise<GitHubSyncAuthenticationResult> {
  const identityFile = String(selectedIdentityFile || "").trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!identityFile) throw new Error("Select an SSH identity first.");
  if (!fs.existsSync(identityFile) || !fs.statSync(identityFile).isFile()) throw new Error(`SSH identity file does not exist: ${identityFile}`);
  const host = githubSyncRepositorySshHost(repository);
  let output = "";
  try {
    const result = await execFileAsync("ssh", ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10", "-i", identityFile, `git@${host}`], { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: process.platform === "win32" });
    output = `${result.stdout || ""}\n${result.stderr || ""}`;
  } catch (error: any) {
    output = `${error?.stdout || ""}\n${error?.stderr || ""}`;
  }
  const login = parseGitHubSshLogin(output);
  if (!login) throw new Error(`SSH authentication failed for ${host}. Select a key registered with GitHub.`);
  if (expectedLogin && login.toLowerCase() !== expectedLogin.toLowerCase()) {
    throw new Error(`SSH key authenticates as ${login}, not ${expectedLogin}. Select the correct account key.`);
  }
  const fingerprint = await execFileAsync("ssh-keygen", ["-lf", identityFile], { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: process.platform === "win32" });
  return { host, login, fingerprint: String(fingerprint.stdout || "").trim() };
}

export async function probeGitHubSyncHttpsAuthentication(repository: string, expectedLogin: string): Promise<GitHubSyncAuthenticationResult> {
  const target = normalizeGitHubSyncTarget({
    id: "authentication-test",
    name: "Authentication test",
    repository,
    branch: "main",
    authentication: { method: "https", expectedLogin }
  });
  const host = githubSyncRepositoryHttpsHost(repository);
  try {
    await execFileAsync("git", githubSyncGitArguments(["ls-remote", repository], target), {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: process.platform === "win32",
      env: gitEnvironment(target)
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`The configured credential helper could not access this repository as ${expectedLogin}${detail ? `: ${detail}` : "."}`);
  }
  return { host, login: expectedLogin, fingerprint: "HTTPS credential helper · repository access verified" };
}

export async function probeGitHubSyncVscodeAuthentication(repository: string, expectedLogin: string, credentials: GitHubSyncCredentials): Promise<GitHubSyncAuthenticationResult> {
  const target = normalizeGitHubSyncTarget({
    id: "authentication-test",
    name: "Authentication test",
    repository,
    branch: "main",
    authentication: { method: "vscode", expectedLogin }
  });
  const host = githubSyncRepositoryHttpsHost(repository);
  try {
    await execFileAsync("git", githubSyncGitArguments(["ls-remote", repository], target), {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: process.platform === "win32",
      env: gitEnvironment(target, credentials)
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`The VS Code GitHub account could not access this repository as ${expectedLogin}${detail ? `: ${detail}` : "."}`);
  }
  return { host, login: expectedLogin, fingerprint: "VS Code GitHub Authentication · repository access verified" };
}

export async function testGitHubSyncAuthentication(target: GitHubSyncTarget, credentials?: GitHubSyncCredentials): Promise<GitHubSyncAuthenticationResult> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  if (!normalized.authentication) throw new Error("Choose an authentication method and GitHub account first.");
  return normalized.authentication.method === "https"
    ? probeGitHubSyncHttpsAuthentication(normalized.repository, normalized.authentication.expectedLogin)
    : normalized.authentication.method === "vscode"
      ? probeGitHubSyncVscodeAuthentication(normalized.repository, normalized.authentication.expectedLogin, credentials || { accessToken: "" })
      : probeGitHubSyncAuthentication(normalized.repository, normalized.authentication.identityFile, normalized.authentication.expectedLogin);
}

export function selectionIncludesType(target: GitHubSyncTarget, type: GitHubSyncContentType): boolean {
  return (["public", "private"] as const).some(privacy => {
    const selection = target.selection[privacy][type];
    return selection.items.length > 0 || selection.folders.length > 0;
  });
}

export function fingerprintGitHubSyncEntries(entries: GitHubSyncFingerprintEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path.replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(entry.digest);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function githubSyncShield(
  targets: GitHubSyncTarget[],
  type: GitHubSyncContentType,
  currentFingerprints: Readonly<Record<string, Partial<Record<GitHubSyncContentType, string>>>>
): GitHubSyncShield {
  const covering = targets.filter(target => selectionIncludesType(target, type));
  if (!covering.length) return "outline";
  return covering.every(target => {
    const previous = target.lastSync?.fingerprints[type];
    const current = currentFingerprints[target.id]?.[type];
    return !!previous && !!current && previous === current;
  }) ? "green" : "yellow";
}

function selectionMatches(
  target: GitHubSyncTarget,
  type: GitHubSyncContentType,
  privacy: GitHubSyncPrivacy,
  itemId: string,
  category: string
): boolean {
  const selection = target.selection[privacy][type];
  return selection.items.includes(itemId) || selection.folders.some(folder =>
    folder === "" || category === folder || category.startsWith(folder + "/")
  );
}

function selectedItem(target: GitHubSyncTarget, type: GitHubSyncContentType, item: GitHubSyncCatalogItem): boolean {
  return selectionMatches(target, type, item.isPrivate ? "private" : "public", item.id, item.cat);
}

export function githubSyncSafeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (!normalized || /^[A-Za-z]:/.test(normalized) || segments.some(segment =>
    !segment || segment === ".." || segment === "." || /[\x00-\x1f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || windowsReserved.test(segment)
  ) || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Managed destination is invalid: ${value}`);
  }
  return normalized;
}

function managedPath(root: string, relative: string): string {
  const safe = githubSyncSafeRelativePath(relative);
  const segments = safe.split("/");
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Managed destination crosses a symbolic link: ${relative}`);
    }
  }
  return current;
}

function collectItemFiles(item: GitHubSyncCatalogItem): Array<{ destination: string; member: string; content: Buffer }> {
  const destination = githubSyncSafeRelativePath(item.destination);
  if (item.content !== undefined) return [{ destination, member: "", content: Buffer.from(item.content, "utf8") }];
  if (!item.source) throw new Error(`Catalog item ${item.id} has no source.`);
  const source = path.resolve(item.source);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be synchronized: ${item.source}`);
  if (stat.isFile()) return [{ destination, member: "", content: fs.readFileSync(source) }];
  if (!stat.isDirectory()) throw new Error(`Unsupported catalog source: ${item.source}`);
  const files: Array<{ destination: string; member: string; content: Buffer }> = [];
  const walk = (directory: string, relative: string): void => {
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      if (name === ".git") continue;
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const childStat = fs.lstatSync(child);
      if (childStat.isSymbolicLink()) throw new Error(`Symbolic links cannot be synchronized: ${child}`);
      if (childStat.isDirectory()) walk(child, childRelative);
      else if (childStat.isFile()) files.push({ destination: `${destination}/${childRelative}`, member: childRelative, content: fs.readFileSync(child) });
    }
  };
  walk(source, "");
  return files;
}

interface GitHubSyncManagedFile {
  path: string;
  type: GitHubSyncContentType;
  itemId: string;
  member: string;
  category: string;
  privacy: GitHubSyncPrivacy;
  digest: string;
  content?: Buffer;
}

interface GitHubSyncManifest {
  schema: 1 | 2 | 3;
  minimumExtensionVersion?: string;
  files: GitHubSyncManagedFile[];
  deletions: GitHubSyncDeletionEvidence[];
}

const GITHUB_SYNC_MANIFEST_SCHEMA = 3;
const GITHUB_SYNC_EXTENSION_VERSION = String(require("../package.json").version || "");
const GITHUB_SYNC_REQUIRED_CAPABILITIES = ["explicit-deletions", "stable-entity-identity"] as const;
const GITHUB_SYNC_SUPPORTED_CAPABILITIES = new Set<string>(GITHUB_SYNC_REQUIRED_CAPABILITIES);

function legacyManifestMetadata(filePath: string, type: GitHubSyncContentType): Pick<GitHubSyncManagedFile, "itemId" | "category" | "privacy"> {
  const relative = filePath.slice(type.length + 1);
  const segments = relative.split("/");
  const filename = segments[segments.length - 1];
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const category = segments.slice(0, -1).join("/");
  let itemId: string;
  switch (type) {
    case "skills":
      itemId = withoutExtension;
      break;
    case "notes":
    case "papers":
    case "scripts":
      itemId = [...segments.slice(0, -1), withoutExtension].join("/");
      break;
    case "prompts":
      itemId = segments.slice(0, Math.min(2, segments.length)).join("/");
      break;
    case "packages":
    case "servers":
      itemId = segments[0];
      break;
    case "recipes":
      itemId = /\.([^.]+)\.json$/i.exec(filename)?.[1] || withoutExtension;
      break;
    case "agentSnapshots":
      itemId = withoutExtension;
      break;
  }
  if (!itemId) throw new Error(`Cannot infer legacy manifest identity for ${filePath}.`);
  return { itemId, category, privacy: "public" };
}

function selectedFiles(target: GitHubSyncTarget, catalog: GitHubSyncCatalog): {
  files: GitHubSyncManagedFile[];
  fingerprints: Record<GitHubSyncContentType, string>;
} {
  const files: GitHubSyncManagedFile[] = [];
  const fingerprints = {} as Record<GitHubSyncContentType, string>;
  const destinations = new Set<string>();
  const portableDestinations = new Set<string>();
  for (const type of GITHUB_SYNC_CONTENT_TYPES) {
    const entries: GitHubSyncFingerprintEntry[] = [];
    for (const item of catalog[type].filter(candidate => selectedItem(target, type, candidate))) {
      for (const file of collectItemFiles(item)) {
        if (destinations.has(file.destination)) throw new Error(`Multiple items map to ${file.destination}.`);
        const portableDestination = file.destination.toLocaleLowerCase("en-US");
        if (portableDestinations.has(portableDestination)) throw new Error(`Managed destinations differ only by case: ${file.destination}.`);
        destinations.add(file.destination);
        portableDestinations.add(portableDestination);
        const content = githubSyncManagedContent(type, file.content);
        const digest = createHash("sha256").update(content).digest("hex");
        files.push({
          path: file.destination,
          type,
          itemId: item.id,
          member: file.member,
          category: item.cat,
          privacy: item.isPrivate ? "private" : "public",
          digest,
          content,
        });
        entries.push({ path: file.destination, digest });
      }
    }
    fingerprints[type] = fingerprintGitHubSyncEntries(entries);
  }
  return { files, fingerprints };
}

export function manifestJson(files: GitHubSyncManagedFile[], deletions: GitHubSyncDeletionEvidence[] = []): string {
  const ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  const members = new Set<string>();
  for (const file of ordered) {
    const portable = file.path.toLocaleLowerCase("en-US");
    if (paths.has(portable)) throw new Error(`Managed destinations differ only by case: ${file.path}.`);
    paths.add(portable);
    const member = `${file.type}\0${file.itemId}\0${file.member}`;
    if (members.has(member)) throw new Error(`Managed content repeats stable member identity for ${file.itemId}.`);
    members.add(member);
  }
  return JSON.stringify({
    schema: GITHUB_SYNC_MANIFEST_SCHEMA,
    minimumExtensionVersion: GITHUB_SYNC_EXTENSION_VERSION,
    capabilities: {
      required: [...GITHUB_SYNC_REQUIRED_CAPABILITIES],
      storage: "pkm.github.publication/v1",
    },
    files: ordered.map(({ content, ...file }) => file),
    deletions: [...deletions].sort((left, right) =>
      `${left.type}\0${left.itemId}`.localeCompare(`${right.type}\0${right.itemId}`)),
  }, null, 2) + "\n";
}

function inferLegacyMembers(files: GitHubSyncManagedFile[]): void {
  const groups = new Map<string, GitHubSyncManagedFile[]>();
  for (const file of files) {
    const key = `${file.type}\0${file.itemId}`;
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      group[0].member = "";
      continue;
    }
    const segments = group.map(file => file.path.split("/"));
    let common = 0;
    while (segments.every(parts => parts[common] && parts[common] === segments[0][common])) common += 1;
    for (const file of group) file.member = file.path.split("/").slice(common).join("/");
  }
}

export function parseManagedManifest(raw: string): GitHubSyncManifest {
  let manifest: any;
  try { manifest = JSON.parse(raw); } catch { throw new Error("Remote PKM manifest is not valid JSON."); }
  if (!Array.isArray(manifest?.files) || ![1, 2, 3].includes(manifest.schema)) {
    throw new Error("Remote repository does not contain a supported PKM manifest.");
  }
  if (manifest.schema === 3) {
    const minimumExtensionVersion = String(manifest.minimumExtensionVersion || "").trim();
    if (minimumExtensionVersion) {
      const order = compareVersionOrder(GITHUB_SYNC_EXTENSION_VERSION, minimumExtensionVersion);
      if (order === undefined) throw new Error("Remote PKM manifest has an invalid minimum extension version.");
      if (order < 0) {
        throw new GitHubSyncExtensionCompatibilityError(minimumExtensionVersion, GITHUB_SYNC_EXTENSION_VERSION);
      }
    }
    const required = manifest?.capabilities?.required;
    if (!Array.isArray(required) || manifest?.capabilities?.storage !== "pkm.github.publication/v1") {
      throw new Error("Remote PKM manifest capabilities are invalid.");
    }
    const unsupported = required.map(String).filter((capability: string) => !GITHUB_SYNC_SUPPORTED_CAPABILITIES.has(capability));
    if (unsupported.length) throw new Error(`Remote PKM manifest requires an unsupported required capability: ${unsupported.join(", ")}.`);
    for (const capability of GITHUB_SYNC_REQUIRED_CAPABILITIES) {
      if (!required.includes(capability)) throw new Error(`Remote PKM manifest is missing required capability ${capability}.`);
    }
  }
  if (manifest.files.length > 10000) throw new Error("Remote PKM manifest contains too many files.");
  const seen = new Set<string>();
  const files = manifest.files.map((value: any): GitHubSyncManagedFile => {
    const filePath = githubSyncSafeRelativePath(String(manifest.schema >= 2 ? value?.path : value));
    const portable = filePath.toLocaleLowerCase("en-US");
    if (seen.has(portable)) throw new Error(`Remote manifest paths differ only by case: ${filePath}.`);
    seen.add(portable);
    const pathType = filePath.split("/", 1)[0] as GitHubSyncContentType;
    if (!(GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(pathType)) {
      throw new Error(`Remote manifest contains an unsupported content path: ${filePath}.`);
    }
    if (pathType === "recipes" && filePath.split("/").includes(".trash")) {
      throw new Error(`Remote manifest cannot contain local Recipe Trash: ${filePath}.`);
    }
    if (manifest.schema === 1) {
      return { path: filePath, type: pathType, ...legacyManifestMetadata(filePath, pathType), member: "", digest: "" };
    }
    const type = String(value?.type || "") as GitHubSyncContentType;
    const privacy = value?.privacy as GitHubSyncPrivacy;
    const itemId = String(value?.itemId || "");
    const member = manifest.schema === 3 ? String(value?.member ?? "") : "";
    const category = String(value?.category || "").replace(/\\/g, "/");
    const digest = String(value?.digest || "");
    if (type !== pathType || !itemId || (privacy !== "public" && privacy !== "private") || !/^[0-9a-f]{64}$/.test(digest)
      || (member && githubSyncSafeRelativePath(member) !== member)) {
      throw new Error(`Remote manifest metadata is invalid for ${filePath}.`);
    }
    return { path: filePath, type, itemId, member, category, privacy, digest };
  });
  if (manifest.schema < 3) inferLegacyMembers(files);
  const deletionValues = manifest.schema === 3 ? manifest.deletions : [];
  if (!Array.isArray(deletionValues) || deletionValues.length > 10000) throw new Error("Remote PKM manifest deletion evidence is invalid.");
  const deletions = deletionValues.map((value: any): GitHubSyncDeletionEvidence => {
    const type = String(value?.type || "") as GitHubSyncContentType;
    const itemId = String(value?.itemId || "");
    const deletedAt = String(value?.deletedAt || "");
    const privacy = value?.privacy;
    if (!(GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(type) || !itemId || !Number.isFinite(Date.parse(deletedAt))
      || (privacy !== undefined && privacy !== "public" && privacy !== "private")) {
      throw new Error("Remote PKM manifest deletion evidence is invalid.");
    }
    return { type, itemId, deletedAt, category: value?.category === undefined ? undefined : String(value.category), privacy };
  });
  const identityMembers = new Set<string>();
  for (const file of files) {
    const identityMember = `${file.type}\0${file.itemId}\0${file.member}`;
    if (identityMembers.has(identityMember)) throw new Error(`Remote manifest repeats stable member identity for ${file.itemId}.`);
    identityMembers.add(identityMember);
  }
  return {
    schema: manifest.schema,
    ...(manifest.minimumExtensionVersion ? { minimumExtensionVersion: String(manifest.minimumExtensionVersion) } : {}),
    files,
    deletions,
  };
}

export function githubSyncTargetFingerprints(
  target: GitHubSyncTarget,
  catalog: GitHubSyncCatalog
): Record<GitHubSyncContentType, string> {
  return selectedFiles(target, catalog).fingerprints;
}

async function git(cwd: string, args: string[], target?: GitHubSyncTarget, allowFailure = false, credentials?: GitHubSyncCredentials): Promise<string> {
  try {
    const result = await execFileAsync("git", githubSyncGitArguments(args, target), { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000, env: gitEnvironment(target, credentials), windowsHide: process.platform === "win32" });
    return String(result.stdout || "").trim();
  } catch (error: any) {
    if (allowFailure) return "";
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    const guidance = githubSyncAuthenticationFailureGuidance(target, detail);
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : "."}${guidance ? ` ${guidance}` : ""}`);
  }
}

async function gitBuffer(cwd: string, args: string[], target?: GitHubSyncTarget, maximumBytes = 8 * 1024 * 1024): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", githubSyncGitArguments(args, target), { cwd, encoding: "buffer", maxBuffer: maximumBytes + 64 * 1024, timeout: 120_000, env: gitEnvironment(target), windowsHide: process.platform === "win32" });
    return Buffer.from(result.stdout);
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : "."}`);
  }
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", ref], { cwd, windowsHide: process.platform === "win32" });
    return true;
  } catch { return false; }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, windowsHide: process.platform === "win32" });
    return true;
  } catch { return false; }
}

function githubSyncCheckoutPath(target: GitHubSyncTarget, checkoutRoot: string): string {
  return path.join(checkoutRoot, target.id, "repository");
}

export type GitHubRemoteSnapshotStage = "cloning" | "fetching" | "inventory" | "validating";

async function fetchRemoteBranch(
  target: GitHubSyncTarget,
  checkoutRoot: string,
  credentials?: GitHubSyncCredentials,
  onProgress?: (stage: GitHubRemoteSnapshotStage) => void
): Promise<{ checkout: string; commit: string }> {
  const checkout = githubSyncCheckoutPath(target, checkoutRoot);
  if (!fs.existsSync(path.join(checkout, ".git"))) {
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    onProgress?.("cloning");
    await git(path.dirname(checkout), ["clone", "--no-checkout", "--origin", "origin", target.repository, checkout], target, false, credentials);
  }
  const remote = await git(checkout, ["remote", "get-url", "origin"]);
  if (remote !== target.repository) throw new Error("Managed checkout points to a different repository. Delete the target and create it again.");
  onProgress?.("fetching");
  await git(checkout, ["fetch", "origin", "--prune"], target, false, credentials);
  const remoteRef = `refs/remotes/origin/${target.branch}`;
  if (!(await hasRef(checkout, remoteRef))) throw new Error(`Remote branch ${target.branch} does not exist.`);
  return { checkout, commit: await git(checkout, ["rev-parse", remoteRef]) };
}

function remoteManifestFiles(raw: string, repositoryFiles: Map<string, number>): GitHubSyncRemoteFile[] {
  return parseManagedManifest(raw).files.map(entry => {
    const file = entry.path;
    if (!repositoryFiles.has(file)) throw new Error(`Remote manifest references a missing file: ${file}.`);
    return { path: file, type: entry.type, size: repositoryFiles.get(file) || 0 };
  }).sort((left: GitHubSyncRemoteFile, right: GitHubSyncRemoteFile) => left.path.localeCompare(right.path));
}

export async function fetchGitHubRemoteSnapshot(
  target: GitHubSyncTarget,
  checkoutRoot: string,
  allowRepositoryTree = false,
  credentials?: GitHubSyncCredentials,
  onProgress?: (stage: GitHubRemoteSnapshotStage) => void
): Promise<GitHubSyncRemoteSnapshot> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  const { checkout, commit } = await fetchRemoteBranch(normalized, checkoutRoot, credentials, onProgress);
  onProgress?.("inventory");
  const repositoryFiles = new Map<string, number>();
  for (const entry of (await git(checkout, ["ls-tree", "-r", "-l", "-z", commit])).split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) continue;
    const metadata = entry.slice(0, separator).trim().split(/\s+/);
    const size = Number(metadata[3]);
    repositoryFiles.set(entry.slice(separator + 1), Number.isSafeInteger(size) && size >= 0 ? size : 0);
  }
  const snapshot = (files: GitHubSyncRemoteFile[], invalidPaths: string[] = []): GitHubSyncRemoteSnapshot => ({
    targetId: normalized.id,
    commit,
    files,
    validation: {
      repositoryFiles: repositoryFiles.size,
      importableFiles: files.length,
      ignoredFiles: Math.max(0, repositoryFiles.size - files.length - invalidPaths.length),
      invalidFiles: invalidPaths.length,
      invalidExamples: invalidPaths.slice(0, 5),
      importableBytes: files.reduce((sum, file) => sum + file.size, 0),
      largestFileBytes: files.reduce((largest, file) => Math.max(largest, file.size), 0),
      filesOverPreviewLimit: files.filter(file => file.size > 1024 * 1024).length,
    },
  });
  let manifest: string;
  onProgress?.("validating");
  try {
    manifest = (await gitBuffer(checkout, ["cat-file", "blob", `${commit}:${MANIFEST_PATH}`], undefined, 16 * 1024 * 1024)).toString("utf8");
  } catch {
    if (allowRepositoryTree) {
      const files: GitHubSyncRemoteFile[] = [];
      const invalidPaths: string[] = [];
      for (const [file, size] of repositoryFiles) {
        const type = file.split("/", 1)[0];
        if (!(GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(type) || file.split("/").length <= 1) continue;
        try {
          files.push({ path: githubSyncSafeRelativePath(file), type: type as GitHubSyncContentType, size });
        } catch {
          invalidPaths.push(file);
        }
      }
      files.sort((left, right) => left.path.localeCompare(right.path));
      if (files.length > 10000) throw new Error("Remote repository contains too many subscribable files.");
      return snapshot(files, invalidPaths);
    }
    throw new Error("Remote repository has no PKM sync manifest yet.");
  }
  return snapshot(remoteManifestFiles(manifest, repositoryFiles));
}

async function assertRemoteCommit(target: GitHubSyncTarget, checkoutRoot: string, commit: string): Promise<string> {
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error("Remote snapshot commit is invalid.");
  const checkout = githubSyncCheckoutPath(target, checkoutRoot);
  const current = await git(checkout, ["rev-parse", `refs/remotes/origin/${target.branch}`]);
  if (current !== commit) throw new Error("Remote content changed. Refresh the remote browser before continuing.");
  return checkout;
}

export async function readGitHubRemoteFile(
  target: GitHubSyncTarget,
  checkoutRoot: string,
  commit: string,
  relative: string,
  maximumBytes = 1024 * 1024
): Promise<Buffer> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  const safe = githubSyncSafeRelativePath(relative);
  const checkout = await assertRemoteCommit(normalized, checkoutRoot, commit);
  const size = Number(await git(checkout, ["cat-file", "-s", `${commit}:${safe}`]));
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error(`Remote file exceeds the ${maximumBytes}-byte preview limit.`);
  return gitBuffer(checkout, ["cat-file", "blob", `${commit}:${safe}`], undefined, maximumBytes);
}

export async function readGitHubRemoteManifest(
  target: GitHubSyncTarget,
  checkoutRoot: string,
  commit: string,
): Promise<string> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  const checkout = await assertRemoteCommit(normalized, checkoutRoot, commit);
  return (await gitBuffer(checkout, ["cat-file", "blob", `${commit}:${MANIFEST_PATH}`], undefined, 16 * 1024 * 1024)).toString("utf8");
}

export async function readGitHubRemoteFileForSubscription(
  target: GitHubSyncTarget,
  checkoutRoot: string,
  commit: string,
  relative: string,
  maximumBytes: number
): Promise<Buffer> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  const safe = githubSyncSafeRelativePath(relative);
  const checkout = await assertRemoteCommit(normalized, checkoutRoot, commit);
  const size = Number(await git(checkout, ["cat-file", "-s", `${commit}:${safe}`]));
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error(`Remote file exceeds the ${maximumBytes}-byte subscription cache limit.`);
  return gitBuffer(checkout, ["cat-file", "blob", `${commit}:${safe}`], undefined, maximumBytes);
}

export async function readGitHubRemoteFilesForSubscription(
  target: GitHubSyncTarget,
  checkoutRoot: string,
  commit: string,
  files: { path: string; size: number }[],
  maximumBytes: number
): Promise<Map<string, Buffer>> {
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error("Remote snapshot commit is invalid.");
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  const checkout = githubSyncCheckoutPath(normalized, checkoutRoot);
  const requested = files.map(file => {
    const safe = githubSyncSafeRelativePath(file.path);
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      throw new Error(`Remote file exceeds the ${maximumBytes}-byte subscription cache limit.`);
    }
    return { path: safe, size };
  });
  const totalBytes = requested.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > maximumBytes) throw new Error(`Remote files exceed the ${maximumBytes}-byte subscription cache limit.`);
  if (!requested.length) return new Map();

  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", githubSyncGitArguments(["cat-file", "--batch"], normalized), {
      cwd: checkout,
      env: gitEnvironment(normalized),
      windowsHide: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maximumOutputBytes = totalBytes + requested.length * 256 + 1024;
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result || Buffer.alloc(0));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("git cat-file batch timed out."));
    }, 120_000);
    child.on("error", error => finish(new Error(`git cat-file failed: ${error.message}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        child.kill();
        finish(new Error("git cat-file batch exceeded the expected output size."));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("close", code => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`git cat-file failed${detail ? `: ${detail}` : "."}`));
        return;
      }
      finish(undefined, Buffer.concat(stdout));
    });
    child.stdin.on("error", error => finish(new Error(`git cat-file failed: ${error.message}`)));
    child.stdin.end(requested.map(file => `${commit}:${file.path}\n`).join(""));
  });

  const result = new Map<string, Buffer>();
  let offset = 0;
  for (const file of requested) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file returned an incomplete header for ${file.path}.`);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]+) blob ([0-9]+)$/i.exec(header);
    if (!match) throw new Error(`git cat-file could not read ${file.path}: ${header}`);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size !== file.size) throw new Error(`Remote file size changed for ${file.path}. Test the repository again.`);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) throw new Error(`git cat-file returned incomplete content for ${file.path}.`);
    result.set(file.path, Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== output.length) throw new Error("git cat-file returned unexpected trailing output.");
  return result;
}

export async function restoreGitHubRemoteFiles(
  target: GitHubSyncTarget,
  checkoutRoot: string,
  storeRoot: string,
  commit: string,
  selectedPaths: string[],
  overwrite: boolean,
  credentials?: GitHubSyncCredentials
): Promise<GitHubSyncRestoreResult> {
  const snapshot = await fetchGitHubRemoteSnapshot(target, checkoutRoot, false, credentials);
  if (snapshot.commit !== commit) throw new Error("Remote content changed. Refresh the remote browser before restoring.");
  const available = new Set(snapshot.files.map(file => file.path));
  const selected = [...new Set(selectedPaths.map(githubSyncSafeRelativePath))].sort((left, right) => left.localeCompare(right));
  if (!selected.length) throw new Error("Select at least one remote file to restore.");
  for (const file of selected) if (!available.has(file)) throw new Error(`Remote file is not in the PKM manifest: ${file}`);
  const destinations = selected.map(file => ({
    file,
    destination: file.startsWith("agentSnapshots/")
      ? managedPath(path.join(storeRoot, ".pkm", "state"), `agent-snapshots/${file.slice("agentSnapshots/".length)}`)
      : managedPath(storeRoot, file),
  }));
  const conflicts = destinations.filter(item => fs.existsSync(item.destination)).map(item => item.file);
  if (conflicts.length && !overwrite) return { restored: [], conflicts };
  const contents = await Promise.all(destinations.map(async item => ({
    ...item,
    content: await readGitHubRemoteFile(target, checkoutRoot, commit, item.file, 8 * 1024 * 1024)
  })));
  replaceGitHubSyncFilesAtomically(contents.map(item => ({ destination: item.destination, content: item.content })), "GitHub Sync restore");
  return { restored: selected, conflicts };
}

async function prepareCheckout(target: GitHubSyncTarget, checkout: string, credentials?: GitHubSyncCredentials): Promise<void> {
  if (!fs.existsSync(path.join(checkout, ".git"))) {
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    await git(path.dirname(checkout), ["clone", "--origin", "origin", target.repository, checkout], target, false, credentials);
  }
  const remote = await git(checkout, ["remote", "get-url", "origin"]);
  if (remote !== target.repository) throw new Error("Managed checkout points to a different repository. Delete the target and create it again.");
  if (await git(checkout, ["status", "--porcelain"])) throw new Error("Managed checkout has uncommitted changes; synchronization stopped.");
  await git(checkout, ["fetch", "origin", "--prune"], target, false, credentials);
  const localRef = `refs/heads/${target.branch}`;
  const remoteRef = `refs/remotes/origin/${target.branch}`;
  const localExists = await hasRef(checkout, localRef);
  const remoteExists = await hasRef(checkout, remoteRef);
  if (localExists) await git(checkout, ["checkout", target.branch]);
  else if (remoteExists) await git(checkout, ["checkout", "--track", "-b", target.branch, `origin/${target.branch}`]);
  else {
    await git(checkout, ["checkout", "--orphan", target.branch]);
    await git(checkout, ["rm", "-rf", "--ignore-unmatch", "--", "."]);
    await git(checkout, ["clean", "-fdx"]);
  }
  const hasHead = await hasRef(checkout, "HEAD");
  if (remoteExists && hasHead) {
    if (await isAncestor(checkout, "HEAD", `origin/${target.branch}`)) {
      await git(checkout, ["merge", "--ff-only", `origin/${target.branch}`]);
      return;
    }
    await git(checkout, ["reset", "--hard", `origin/${target.branch}`]);
    await git(checkout, ["clean", "-fd"]);
  }
}

const MANIFEST_PATH = ".pkm-github-sync.json";

function fileDigest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isBuiltInRecipe(file: GitHubSyncManagedFile | undefined): boolean {
  if (file?.type !== "recipes" || !file.content) return false;
  try {
    return JSON.parse(file.content.toString("utf8"))?.systemKind === "built-in";
  } catch {
    return false;
  }
}

async function manifestAtCommit(checkout: string, commit: string): Promise<GitHubSyncManifest> {
  const raw = (await gitBuffer(checkout, ["cat-file", "blob", `${commit}:${MANIFEST_PATH}`], undefined, 16 * 1024 * 1024)).toString("utf8");
  const manifest = parseManagedManifest(raw);
  for (const file of manifest.files) {
    if (!file.digest) file.digest = fileDigest(await gitBuffer(checkout, ["cat-file", "blob", `${commit}:${file.path}`], undefined, 64 * 1024 * 1024));
  }
  return manifest;
}

function enrichLegacyFiles(files: GitHubSyncManagedFile[], known: Map<string, GitHubSyncManagedFile>): void {
  for (const file of files) {
    if (file.itemId) continue;
    const metadata = known.get(file.path);
    if (!metadata) continue;
    file.type = metadata.type;
    file.itemId = metadata.itemId;
    file.category = metadata.category;
    file.privacy = metadata.privacy;
  }
}

function syncLocalPath(storeRoot: string, relative: string): string {
  return relative.startsWith("agentSnapshots/")
    ? managedPath(path.join(storeRoot, ".pkm", "state"), `agent-snapshots/${relative.slice("agentSnapshots/".length)}`)
    : managedPath(storeRoot, relative);
}

function validateManagedContent(file: GitHubSyncManagedFile, content: Buffer): void {
  if (fileDigest(content) !== file.digest) throw new Error(`GitHub Sync content digest does not match the manifest: ${file.path}`);
  if (file.type !== "skills" && file.type !== "recipes") return;
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content) || text.includes("\0")) throw new Error(`GitHub Sync content is not valid UTF-8 text: ${file.path}`);
  if (file.type === "recipes") {
    let parsed: any;
    try { parsed = JSON.parse(text); }
    catch { throw new Error(`Recipe is not valid JSON: ${file.path}`); }
    if (!parsed || typeof parsed !== "object" || typeof parsed.recipeId !== "string" || typeof parsed.name !== "string" || !parsed.definition) {
      throw new Error(`Recipe is missing recipeId, name, or definition: ${file.path}`);
    }
    const compiled = compileWorkflowDefinitionV1(parsed.definition);
    if (!compiled.ok) throw new Error(`Recipe definition is invalid: ${file.path}`);
    if (compiled.executableDigest !== parsed.executableDigest) throw new Error(`Recipe executable digest is invalid: ${file.path}`);
    const segments = file.path.split("/");
    const filename = segments.pop() || "";
    const category = segments.slice(1).join("/") === "Uncategorized" ? "" : segments.slice(1).join("/");
    if (!filename.endsWith(`.${parsed.recipeId}.json`)) throw new Error(`Recipe path identity is invalid: ${file.path}`);
    if (String(parsed.category || "") !== category) throw new Error(`Recipe path category is invalid: ${file.path}`);
    return;
  }
  if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(text)) throw new Error(`Skill still contains merge conflict markers: ${file.path}`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!frontmatter) throw new Error(`Skill has invalid or missing frontmatter: ${file.path}`);
  const name = /^name:\s*(.+?)\s*$/m.exec(frontmatter[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!name || !frontmatter[2].trim()) throw new Error(`Skill must have a name and non-empty body: ${file.path}`);
}

export function validateGitHubSyncCandidate(relative: string, content: Buffer): void {
  const safe = githubSyncSafeRelativePath(relative);
  const type = safe.split("/", 1)[0] as GitHubSyncContentType;
  if (!(GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(type)) throw new Error(`Unsupported GitHub Sync content path: ${safe}`);
  if (type === "recipes" && safe.split("/").includes(".trash")) throw new Error(`Recipe Trash is local-only: ${safe}`);
  validateManagedContent({
    path: safe,
    type,
    itemId: safe,
    member: "",
    category: "",
    privacy: "public",
    digest: fileDigest(content),
  }, content);
}

function writeAtomic(destination: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.pkm-sync-${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function replaceGitHubSyncFilesAtomically(
  replacements: Array<{ destination: string; content: Buffer }>,
  operation = "GitHub Sync"
): void {
  const originals = replacements.map(item => ({
    destination: item.destination,
    content: fs.existsSync(item.destination) ? fs.readFileSync(item.destination) : undefined,
  }));
  const completed: number[] = [];
  try {
    for (let index = 0; index < replacements.length; index++) {
      writeAtomic(replacements[index].destination, replacements[index].content);
      completed.push(index);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const index of completed.reverse()) {
      const original = originals[index];
      try {
        if (original.content) writeAtomic(original.destination, original.content);
        else fs.rmSync(original.destination, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${original.destination}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length) throw new Error(`${operation} failed: ${primary}. Rollback also failed for ${rollbackErrors.join("; ")}`);
    throw error;
  }
}

interface GitHubSyncLocalWrite {
  file: GitHubSyncManagedFile;
  content: Buffer;
  expectedLocal?: Buffer;
}

function applyLocalChanges(
  storeRoot: string | undefined,
  localWrites: GitHubSyncLocalWrite[],
  localDeletes: Array<{ file: GitHubSyncManagedFile; expectedLocal?: Buffer }>
): { pulled: string[]; deletedLocal: string[]; privateTopLevels: Partial<Record<GitHubSyncContentType, string[]>>; recipePulls: GitHubSyncRecipePull[]; recipeDeletes: string[] } {
  const pulled: string[] = [];
  const deletedLocal: string[] = [];
  const recipePulls = localWrites
    .filter(item => item.file.type === "recipes")
    .map(item => ({ path: item.file.path, itemId: item.file.itemId, content: item.content, expectedLocal: item.expectedLocal }));
  const recipeDeletes = [...new Set(localDeletes
    .filter(item => item.file.type === "recipes")
    .map(item => item.file.itemId))];
  const privateTopLevels = new Map<GitHubSyncContentType, Set<string>>();
  if (!storeRoot) return { pulled, deletedLocal, privateTopLevels: {}, recipePulls: [], recipeDeletes: [] };
  const replacements = localWrites.filter(item => item.file.type !== "recipes").map(item => ({
    item,
    destination: syncLocalPath(storeRoot, item.file.path),
  }));
  for (const { item, destination } of replacements) {
    const exists = fs.existsSync(destination);
    if (!item.expectedLocal) {
      if (exists) throw new Error(`Local content changed during synchronization: ${item.file.path}`);
      continue;
    }
    if (!exists || !fs.readFileSync(destination).equals(item.expectedLocal)) {
      throw new Error(`Local content changed during synchronization: ${item.file.path}`);
    }
  }
  const deletions = localDeletes.filter(item => item.file.type !== "recipes").map(item => ({
    item,
    destination: syncLocalPath(storeRoot, item.file.path),
  }));
  for (const { item, destination } of deletions) {
    const exists = fs.existsSync(destination);
    if (!item.expectedLocal) {
      if (exists) throw new Error(`Local content changed during synchronization: ${item.file.path}`);
      continue;
    }
    if (!exists || !fs.readFileSync(destination).equals(item.expectedLocal)) {
      throw new Error(`Local content changed during synchronization: ${item.file.path}`);
    }
  }
  const mutations = [
    ...replacements.map(({ item, destination }) => ({ destination, content: item.content })),
    ...deletions.map(({ destination }) => ({ destination, content: undefined })),
  ];
  const originals = mutations.map(item => ({
    destination: item.destination,
    content: fs.existsSync(item.destination) ? fs.readFileSync(item.destination) : undefined,
  }));
  const completed: number[] = [];
  try {
    for (let index = 0; index < mutations.length; index++) {
      const mutation = mutations[index];
      if (mutation.content) writeAtomic(mutation.destination, mutation.content);
      else fs.rmSync(mutation.destination, { force: true });
      completed.push(index);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const index of completed.reverse()) {
      try {
        const original = originals[index];
        if (original.content) writeAtomic(original.destination, original.content);
        else fs.rmSync(original.destination, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(`${originals[index].destination}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`GitHub Sync local update failed: ${error instanceof Error ? error.message : String(error)}. Rollback also failed for ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
  for (const item of localWrites) {
    pulled.push(item.file.path);
    if (item.file.privacy === "private" && item.file.type !== "agentSnapshots") {
      const topLevel = item.file.category.split("/").filter(Boolean)[0];
      if (topLevel) {
        const values = privateTopLevels.get(item.file.type) || new Set<string>();
        values.add(topLevel);
        privateTopLevels.set(item.file.type, values);
      }
    }
  }
  for (const { file } of localDeletes) if (file.type !== "recipes") deletedLocal.push(file.path);
  return {
    pulled,
    deletedLocal,
    privateTopLevels: Object.fromEntries([...privateTopLevels].map(([type, values]) => [type, [...values].sort()])),
    recipePulls,
    recipeDeletes,
  };
}

type GitHubSyncEntityMap = Map<string, GitHubSyncManagedFile[]>;

function entityKey(type: GitHubSyncContentType, itemId: string): string {
  return `${type}\0${itemId}`;
}

function groupManagedFiles(files: Iterable<GitHubSyncManagedFile>): GitHubSyncEntityMap {
  const groups: GitHubSyncEntityMap = new Map();
  for (const file of files) {
    const key = entityKey(file.type, file.itemId);
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort((left, right) => left.member.localeCompare(right.member));
  return groups;
}

function entityState(files: GitHubSyncManagedFile[] | undefined): string | undefined {
  if (!files) return undefined;
  return JSON.stringify(files.map(file => ({
    member: file.member,
    path: file.path,
    digest: file.digest,
    category: file.category,
    privacy: file.privacy,
  })));
}

function entityContentState(files: GitHubSyncManagedFile[] | undefined): string | undefined {
  if (!files) return undefined;
  return JSON.stringify(files.map(file => ({ member: file.member, digest: file.digest })));
}

function entityPathState(files: GitHubSyncManagedFile[] | undefined): string | undefined {
  if (!files) return undefined;
  return JSON.stringify(files.map(file => ({ member: file.member, path: file.path })));
}

function entityPathContentState(files: GitHubSyncManagedFile[] | undefined): string | undefined {
  if (!files) return undefined;
  return JSON.stringify(files.map(file => ({
    type: file.type,
    member: file.member,
    path: file.path,
    digest: file.digest,
  })));
}

function reconcileMigratedEntityIdentities(
  localEntities: GitHubSyncEntityMap,
  entities: GitHubSyncEntityMap,
  finalRemote?: Map<string, GitHubSyncManagedFile>,
): number {
  const localByPathContent = new Map<string, Array<{ key: string; files: GitHubSyncManagedFile[] }>>();
  for (const [key, files] of localEntities) {
    const signature = entityPathContentState(files)!;
    const matches = localByPathContent.get(signature) || [];
    matches.push({ key, files });
    localByPathContent.set(signature, matches);
  }
  let reconciled = 0;
  for (const [legacyKey, files] of [...entities]) {
    if (localEntities.has(legacyKey)) continue;
    const matches = localByPathContent.get(entityPathContentState(files)!) || [];
    if (matches.length !== 1 || entities.has(matches[0].key)) continue;
    const canonical = matches[0];
    const localByMember = new Map(canonical.files.map(file => [file.member || "", file]));
    const canonicalized = files.map(file => {
      const local = localByMember.get(file.member || "");
      if (!local || local.path !== file.path || local.digest !== file.digest) return file;
      return {
        ...file,
        itemId: local.itemId,
        category: local.category,
        privacy: local.privacy,
        member: local.member,
      };
    });
    entities.delete(legacyKey);
    entities.set(canonical.key, canonicalized);
    if (finalRemote) {
      for (const file of canonicalized) finalRemote.set(file.path, file);
    }
    reconciled++;
  }
  return reconciled;
}

function entityFileByMember(files: GitHubSyncManagedFile[] | undefined, member: string): GitHubSyncManagedFile | undefined {
  return files?.find(file => file.member === member);
}

async function deterministicTextMerge(base: Buffer, local: Buffer, remote: Buffer): Promise<Buffer | undefined> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-github-merge-"));
  const localPath = path.join(directory, "local");
  const basePath = path.join(directory, "base");
  const remotePath = path.join(directory, "remote");
  try {
    fs.writeFileSync(localPath, local);
    fs.writeFileSync(basePath, base);
    fs.writeFileSync(remotePath, remote);
    try {
      const result = await execFileAsync("git", ["merge-file", "-p", localPath, basePath, remotePath], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: process.platform === "win32",
      });
      return Buffer.from(result.stdout);
    } catch (error: any) {
      if (error?.code === 1) return undefined;
      const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
      throw new Error(`git merge-file failed${detail ? `: ${detail}` : "."}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function recoverManagedCheckout(checkout: string, remoteCommit: string): Promise<void> {
  if (!remoteCommit) {
    fs.rmSync(path.dirname(checkout), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  }
  await git(checkout, ["reset", "--hard", remoteCommit]);
  await git(checkout, ["clean", "-fd"]);
}

function fingerprintsForManifest(target: GitHubSyncTarget, files: GitHubSyncManagedFile[]): Record<GitHubSyncContentType, string> {
  const byType = {} as Record<GitHubSyncContentType, GitHubSyncFingerprintEntry[]>;
  for (const type of GITHUB_SYNC_CONTENT_TYPES) byType[type] = [];
  for (const file of files) {
    if (file.itemId && selectionMatches(target, file.type, file.privacy, file.itemId, file.category)) {
      byType[file.type].push({ path: file.path, digest: file.digest });
    }
  }
  return Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, fingerprintGitHubSyncEntries(byType[type])])) as Record<GitHubSyncContentType, string>;
}

function transactionReceiptPath(checkoutRoot: string, targetId: string): string {
  return path.join(checkoutRoot, targetId, "transactions", "latest.json");
}

function writeTransactionReceipt(checkoutRoot: string, receipt: GitHubSyncTransactionReceipt): void {
  const destination = transactionReceiptPath(checkoutRoot, receipt.targetId);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
}

export function completeGitHubSyncTransaction(checkoutRoot: string, targetId: string, transactionId: string): void {
  const destination = transactionReceiptPath(checkoutRoot, targetId);
  const receipt = JSON.parse(fs.readFileSync(destination, "utf8")) as GitHubSyncTransactionReceipt;
  if (receipt.schema !== 1 || receipt.targetId !== targetId || receipt.transactionId !== transactionId) {
    throw new Error("GitHub Sync transaction receipt does not match the completed synchronization.");
  }
  receipt.state = "recorded";
  receipt.recordedAt = new Date().toISOString();
  writeTransactionReceipt(checkoutRoot, receipt);
}

async function syncGitHubTargetAttempt(
  target: GitHubSyncTarget,
  catalog: GitHubSyncCatalog,
  checkoutRoot: string,
  credentials?: GitHubSyncCredentials,
  storeRoot?: string,
  onProgress?: (phase: "fetch" | "resolve-conflicts" | "commit" | "push", detail: string) => void,
  options?: { mode?: "normal" | "force-local-authority"; actor?: string; comment?: string },
): Promise<GitHubSyncResult> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  if (normalized.lastSync?.repository && normalized.lastSync.repository !== normalized.repository) {
    throw new Error("GitHub Sync repository changed after the last synchronization. Save the target again to start from a new reconciliation base.");
  }
  if (normalized.lastSync?.branch && normalized.lastSync.branch !== normalized.branch) {
    throw new Error("GitHub Sync branch changed after the last synchronization. Save the target again to start from a new reconciliation base.");
  }
  if (storeRoot && normalized.lastSync?.storeRoot && path.resolve(normalized.lastSync.storeRoot) !== path.resolve(storeRoot)) {
    throw new Error("Knowledge Root changed after the last synchronization. Re-save the target to reconcile this root as a new machine.");
  }
  const checkout = path.join(checkoutRoot, normalized.id, "repository");
  const localMaterialized = selectedFiles(normalized, catalog);
  for (const file of localMaterialized.files) validateManagedContent(file, file.content!);
  const localFiles = new Map(localMaterialized.files.map(file => [file.path, file]));
  onProgress?.("fetch", `Fetching origin/${normalized.branch} and updating the managed checkout`);
  await prepareCheckout(normalized, checkout, credentials);
  const remoteCommit = await hasRef(checkout, "HEAD") ? await git(checkout, ["rev-parse", "HEAD"]) : "";
  const authoritativeMigrationCutover = normalized.publication?.manualVerificationCompleted === false;
  const forceLocalAuthority = options?.mode === "force-local-authority";
  const forceActor = options?.actor?.trim().replace(/[\r\n]+/g, " ") || "local-user";
  const forceComment = options?.comment?.trim().replace(/[\r\n]+/g, " ") || "";
  if (authoritativeMigrationCutover && !forceLocalAuthority && normalized.publication?.sourceCommit !== remoteCommit) {
    throw new Error("GitHub changed after migration cutover. Run Preview, Stage, Verify, and Cutover again before the authoritative migration sync.");
  }
  let remoteManifest: GitHubSyncManifest;
  let remoteManifestRaw: string | undefined;
  try {
    remoteManifestRaw = fs.readFileSync(path.join(checkout, MANIFEST_PATH), "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (remoteManifestRaw === undefined) {
    remoteManifest = { schema: GITHUB_SYNC_MANIFEST_SCHEMA, files: [], deletions: [] };
  } else {
    remoteManifest = parseManagedManifest(remoteManifestRaw);
    for (const file of remoteManifest.files) {
      const content = fs.readFileSync(managedPath(checkout, file.path));
      if (!file.digest) file.digest = fileDigest(content);
      validateManagedContent(file, content);
    }
    const trackedManagedFiles = (await git(checkout, ["ls-files", "-z", "--cached", "--", ...GITHUB_SYNC_CONTENT_TYPES]))
      .split("\0")
      .filter(Boolean)
      .map(githubSyncSafeRelativePath);
    const manifestPaths = new Set(remoteManifest.files.map(file => file.path.toLocaleLowerCase("en-US")));
    const omitted = trackedManagedFiles.find(file => !manifestPaths.has(file.toLocaleLowerCase("en-US")));
    if (omitted) throw new Error(`Remote managed file is missing from the manifest: ${omitted}`);
  }
  enrichLegacyFiles(remoteManifest.files, localFiles);
  const remoteFiles = new Map(remoteManifest.files.map(file => [file.path, file]));

  let baseManifest: GitHubSyncManifest = { schema: GITHUB_SYNC_MANIFEST_SCHEMA, files: [], deletions: [] };
  if (normalized.lastSync?.commit) {
    baseManifest = await manifestAtCommit(checkout, normalized.lastSync.commit);
    enrichLegacyFiles(baseManifest.files, new Map([...remoteFiles, ...localFiles]));
  }
  const baseFiles = new Map(baseManifest.files.map(file => [file.path, file]));
  if (storeRoot) {
    for (const managed of [...remoteFiles.values(), ...baseFiles.values()]) {
      if (managed.type === "recipes" || localFiles.has(managed.path)) continue;
      const source = syncLocalPath(storeRoot, managed.path);
      if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) continue;
      const content = fs.readFileSync(source);
      localFiles.set(managed.path, {
        ...managed,
        digest: fileDigest(content),
        content,
      });
    }
  }

  const localEntities = groupManagedFiles(localFiles.values());
  const remoteEntities = groupManagedFiles(remoteFiles.values());
  const baseEntities = groupManagedFiles(baseFiles.values());
  const finalRemote = new Map(remoteFiles);
  reconcileMigratedEntityIdentities(localEntities, baseEntities);
  reconcileMigratedEntityIdentities(localEntities, remoteEntities, finalRemote);
  const localDeletionMap = new Map((normalized.pendingDeletions || []).map(deletion => [entityKey(deletion.type, deletion.itemId), deletion]));
  const remoteDeletionMap = new Map(remoteManifest.deletions.map(deletion => [entityKey(deletion.type, deletion.itemId), deletion]));
  const baseDeletionMap = new Map(baseManifest.deletions.map(deletion => [entityKey(deletion.type, deletion.itemId), deletion]));
  const finalDeletions = new Map(remoteDeletionMap);
  const identities = new Set<string>([
    ...localEntities.keys(),
    ...remoteEntities.keys(),
    ...baseEntities.keys(),
    ...localDeletionMap.keys(),
    ...remoteDeletionMap.keys(),
    ...baseDeletionMap.keys(),
  ]);
  const localWrites: GitHubSyncLocalWrite[] = [];
  const localDeletes: Array<{ file: GitHubSyncManagedFile; expectedLocal?: Buffer }> = [];
  const conflicts: GitHubSyncConflict[] = [];
  const acknowledgedDeletions: GitHubSyncDeletionEvidence[] = [];
  const resolutionRules: GitHubSyncResolutionReport["rules"] = {};
  const recordResolution = (rule: GitHubSyncResolutionRule, files: GitHubSyncManagedFile[] | undefined, ...others: Array<GitHubSyncManagedFile[] | undefined>): void => {
    const paths = new Set([...(files || []), ...others.flatMap(items => items || [])].map(file => file.path));
    resolutionRules[rule] = (resolutionRules[rule] || 0) + Math.max(1, paths.size);
  };
  const resolutionReport = (): GitHubSyncResolutionReport => ({
    totalFiles: Object.values(resolutionRules).reduce((sum, count) => sum + (count || 0), 0),
    rules: { ...resolutionRules },
    generatedAt: new Date().toISOString(),
  });

  const replaceRemoteEntity = (key: string, files: GitHubSyncManagedFile[] | undefined): void => {
    for (const [relative, file] of finalRemote) if (entityKey(file.type, file.itemId) === key) finalRemote.delete(relative);
    if (files) for (const file of files) finalRemote.set(file.path, file);
  };
  const conflictEntity = async (
    base: GitHubSyncManagedFile[] | undefined,
    local: GitHubSyncManagedFile[] | undefined,
    remote: GitHubSyncManagedFile[] | undefined,
  ): Promise<void> => {
    const metadata = local?.[0] || remote?.[0] || base?.[0];
    if (!metadata) return;
    const baseFile = base?.[0];
    const localFile = local?.[0];
    const remoteFile = remote?.[0];
    conflicts.push({
      path: localFile?.path || remoteFile?.path || baseFile!.path,
      type: metadata.type,
      itemId: metadata.itemId,
      category: metadata.category,
      privacy: metadata.privacy,
      base: baseFile && normalized.lastSync?.commit
        ? await gitBuffer(checkout, ["cat-file", "blob", `${normalized.lastSync.commit}:${baseFile.path}`], undefined, 64 * 1024 * 1024)
        : undefined,
      local: localFile?.content,
      remote: remoteFile ? fs.readFileSync(managedPath(checkout, remoteFile.path)) : undefined,
    });
  };
  const applyRemoteEntity = (base: GitHubSyncManagedFile[] | undefined, local: GitHubSyncManagedFile[] | undefined, remote: GitHubSyncManagedFile[] | undefined): void => {
    if (!storeRoot) return;
    const remotePaths = new Set((remote || []).map(file => file.path));
    for (const file of remote || []) {
      const content = file.content || fs.readFileSync(managedPath(checkout, file.path));
      validateManagedContent(file, content);
      const localFile = entityFileByMember(local, file.member);
      localWrites.push({ file, content, expectedLocal: localFile?.path === file.path ? localFile.content : undefined });
    }
    for (const file of local || base || []) {
      if (file.type === "recipes" && remote?.length) continue;
      if (!remotePaths.has(file.path)) localDeletes.push({ file, expectedLocal: file.content });
    }
  };

  if (authoritativeMigrationCutover || forceLocalAuthority) {
    const deletedAt = new Date().toISOString();
    for (const [key, remote] of remoteEntities) {
      const metadata = remote[0];
      if (!selectionMatches(normalized, metadata.type, metadata.privacy, metadata.itemId, metadata.category)) continue;
      replaceRemoteEntity(key, undefined);
      if (!localEntities.has(key)) {
        finalDeletions.set(key, {
          type: metadata.type,
          itemId: metadata.itemId,
          deletedAt,
          category: metadata.category,
          privacy: metadata.privacy,
        });
      }
    }
    for (const [key, local] of localEntities) {
      const metadata = local[0];
      if (!selectionMatches(normalized, metadata.type, metadata.privacy, metadata.itemId, metadata.category)) continue;
      replaceRemoteEntity(key, local);
      finalDeletions.delete(key);
    }
    const selectedPaths = new Set<string>();
    for (const files of [...remoteEntities.values(), ...localEntities.values()]) {
      for (const file of files) {
        if (selectionMatches(normalized, file.type, file.privacy, file.itemId, file.category)) selectedPaths.add(file.path);
      }
    }
    resolutionRules[forceLocalAuthority ? "force-local-authority" : "authoritative-migration"] = selectedPaths.size;
  } else {
    for (const key of [...identities].sort((left, right) => left.localeCompare(right))) {
    const base = baseEntities.get(key);
    const local = localDeletionMap.has(key) ? undefined : localEntities.get(key);
    const remote = remoteDeletionMap.has(key) ? undefined : remoteEntities.get(key);
    const metadata = local?.[0] || remote?.[0] || base?.[0];
    const deletion = localDeletionMap.get(key) || remoteDeletionMap.get(key) || baseDeletionMap.get(key);
    if (!metadata && !deletion) continue;
    const type = metadata?.type || deletion!.type;
    const itemId = metadata?.itemId || deletion!.itemId;
    const category = metadata?.category || deletion?.category || "";
    const privacy = metadata?.privacy || deletion?.privacy || "public";
    if (!selectionMatches(normalized, type, privacy, itemId, category)) continue;

    if (local?.some(isBuiltInRecipe)) {
      recordResolution("built-in-authority", local, base, remote);
      replaceRemoteEntity(key, local);
      finalDeletions.delete(key);
      continue;
    }

    if (base && !local && !localDeletionMap.has(key) && remote) {
      recordResolution("remote-only", remote, base);
      replaceRemoteEntity(key, remote);
      finalDeletions.delete(key);
      applyRemoteEntity(base, local, remote);
      continue;
    }
    if (base && !remote && !remoteDeletionMap.has(key) && local) {
      recordResolution("local-only", local, base);
      replaceRemoteEntity(key, local);
      finalDeletions.delete(key);
      continue;
    }

    const baseState = entityState(base);
    const localState = localDeletionMap.has(key) ? `deleted:${localDeletionMap.get(key)!.deletedAt}` : entityState(local);
    const remoteState = remoteDeletionMap.has(key) ? `deleted:${remoteDeletionMap.get(key)!.deletedAt}` : entityState(remote);
    const localChanged = localDeletionMap.has(key) || localState !== baseState;
    const remoteChanged = remoteDeletionMap.has(key) || remoteState !== baseState;

    if (localChanged && remoteChanged && localState !== remoteState) {
      if (!local || !remote) {
        recordResolution("human-required", local, base, remote);
        await conflictEntity(base, local, remote);
        continue;
      }
      const sameContent = entityContentState(local) === entityContentState(remote);
      const basePaths = entityPathState(base);
      const localPaths = entityPathState(local);
      const remotePaths = entityPathState(remote);
      const divergentMove = sameContent && base && localPaths !== basePaths && remotePaths !== basePaths && localPaths !== remotePaths;
      if (!sameContent && base?.length === 1 && local.length === 1 && remote.length === 1
        && base[0].member === local[0].member && base[0].member === remote[0].member) {
        const basePath = base[0].path;
        const localPath = local[0].path;
        const remotePath = remote[0].path;
        const chosenMetadata = localPath === remotePath
          ? local[0]
          : localPath !== basePath && remotePath === basePath
            ? local[0]
            : remotePath !== basePath && localPath === basePath
              ? remote[0]
              : undefined;
        if (chosenMetadata && normalized.lastSync?.commit) {
          const mergedContent = await deterministicTextMerge(
            await gitBuffer(checkout, ["cat-file", "blob", `${normalized.lastSync.commit}:${basePath}`], undefined, 64 * 1024 * 1024),
            local[0].content!,
            fs.readFileSync(managedPath(checkout, remotePath)),
          );
          if (mergedContent) {
            const mergedFile = { ...chosenMetadata, digest: fileDigest(mergedContent), content: mergedContent };
            validateManagedContent(mergedFile, mergedContent);
            replaceRemoteEntity(key, [mergedFile]);
            finalDeletions.delete(key);
            applyRemoteEntity(base, local, [mergedFile]);
            recordResolution(localPath !== remotePath ? "move-edit" : "deterministic-three-way", [mergedFile], base, local, remote);
            continue;
          }
        }
      }
      if (!sameContent || divergentMove) {
        recordResolution("human-required", local, base, remote);
        await conflictEntity(base, local, remote);
        continue;
      }
      const chosen = remotePaths !== basePaths ? remote : local;
      recordResolution(base && (localPaths !== basePaths || remotePaths !== basePaths) ? "move-edit" : "identical-convergence", chosen, base, local, remote);
      replaceRemoteEntity(key, chosen);
      finalDeletions.delete(key);
      if (chosen === remote) applyRemoteEntity(base, local, remote);
      continue;
    }

    if (remoteChanged && !localChanged) {
      recordResolution("remote-only", remote, base, local);
      replaceRemoteEntity(key, remote);
      if (remote) finalDeletions.delete(key);
      else finalDeletions.set(key, remoteDeletionMap.get(key)!);
      applyRemoteEntity(base, local, remote);
      continue;
    }
    if (localChanged && !remoteChanged) {
      recordResolution("local-only", local, base, remote);
      replaceRemoteEntity(key, local);
      if (local) finalDeletions.delete(key);
      else {
        const evidence = localDeletionMap.get(key)!;
        finalDeletions.set(key, {
          ...evidence,
          category: evidence.category ?? base?.[0]?.category,
          privacy: evidence.privacy ?? base?.[0]?.privacy,
        });
        acknowledgedDeletions.push(evidence);
      }
      continue;
    }
      recordResolution("unchanged", remote, base, local);
      if (!remote && remoteDeletionMap.has(key)) finalDeletions.set(key, remoteDeletionMap.get(key)!);
    }
  }

  if (conflicts.length) {
    onProgress?.("resolve-conflicts", `${conflicts.length} conflicting file${conflicts.length === 1 ? "" : "s"} require resolution`);
    const applied = applyLocalChanges(storeRoot, localWrites, localDeletes);
    throw new GitHubSyncConflictError(remoteCommit, conflicts, applied.pulled, applied.deletedLocal,
      applied.privateTopLevels, applied.recipePulls, applied.recipeDeletes, resolutionReport());
  }

  const managedFiles = [...finalRemote.values()];
  let changed = false;
  let commit = remoteCommit;
  const transactionId = randomUUID();
  try {
    for (const file of finalRemote.values()) {
      if (!file.content) continue;
      const destination = managedPath(checkout, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content);
    }
    for (const relative of remoteFiles.keys()) {
      if (!finalRemote.has(relative)) fs.rmSync(managedPath(checkout, relative), { force: true });
    }
    fs.writeFileSync(path.join(checkout, MANIFEST_PATH), manifestJson(managedFiles, [...finalDeletions.values()]));
    onProgress?.("commit", "Staging managed changes and creating a commit when needed");
    await git(checkout, ["add", "-A", "--", "."]);
    changed = !!(await git(checkout, ["status", "--porcelain"]));
    if (changed || forceLocalAuthority) {
      await git(checkout, ["config", "user.name", forceLocalAuthority ? forceActor : "Personal Knowledge Manager"]);
      await git(checkout, ["config", "user.email", forceLocalAuthority
        ? `${forceActor.replace(/[^a-zA-Z0-9_.-]+/g, "-")}@users.noreply.github.com`
        : "pkm@localhost"]);
      if (forceLocalAuthority) {
        if (!forceComment) throw new Error("Force Update requires a non-empty user comment.");
        await git(checkout, [
          "commit",
          "--allow-empty",
          "-m", `PKM force update by ${forceActor}`,
          "-m", `PKM-Operation: force-local-authority\nPKM-Actor: ${forceActor}\nPKM-Comment: ${forceComment}\nPKM-Base-Commit: ${remoteCommit || "(empty branch)"}\nPKM-Transaction-ID: ${transactionId}`,
        ]);
        changed = true;
      } else {
        await git(checkout, ["commit", "-m", `PKM sync ${new Date().toISOString()}`]);
      }
    }
    onProgress?.("push", `Compare-and-swap HEAD onto origin/${normalized.branch}`);
    await git(checkout, [
      "push",
      `--force-with-lease=refs/heads/${normalized.branch}:${remoteCommit}`,
      "origin",
      `HEAD:refs/heads/${normalized.branch}`,
    ], normalized, false, credentials);
    commit = await git(checkout, ["rev-parse", "HEAD"]);
    writeTransactionReceipt(checkoutRoot, {
      schema: 1,
      transactionId,
      targetId: normalized.id,
      repository: normalized.repository,
      branch: normalized.branch,
      baseCommit: remoteCommit,
      pushedCommit: commit,
      pushedAt: new Date().toISOString(),
      operation: forceLocalAuthority ? "force-local-authority" : "sync",
      ...(forceLocalAuthority ? { actor: forceActor } : {}),
      ...(forceLocalAuthority ? { comment: forceComment } : {}),
      state: "pushed",
    });
  } catch (error) {
    try {
      await recoverManagedCheckout(checkout, remoteCommit);
    } catch (recoveryError) {
      const primary = error instanceof Error ? error.message : String(error);
      const recovery = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      throw new Error(`${primary} Managed checkout recovery also failed: ${recovery}`);
    }
    throw error;
  }
  const applied = applyLocalChanges(storeRoot, localWrites, localDeletes);
  return {
    transactionId,
    commit,
    changed,
    fingerprints: fingerprintsForManifest(normalized, managedFiles),
    pulled: applied.pulled,
    deletedLocal: applied.deletedLocal,
    privateTopLevels: applied.privateTopLevels,
    recipePulls: applied.recipePulls,
    recipeDeletes: applied.recipeDeletes,
    acknowledgedDeletions,
    resolutionReport: resolutionReport(),
  };
}

function concurrentPushFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /git push failed/i.test(message)
    && /(?:stale info|non-fast-forward|fetch first|failed to push some refs|rejected)/i.test(message);
}

export async function syncGitHubTarget(
  target: GitHubSyncTarget,
  catalog: GitHubSyncCatalog,
  checkoutRoot: string,
  credentials?: GitHubSyncCredentials,
  storeRoot?: string,
  onProgress?: (phase: "fetch" | "resolve-conflicts" | "commit" | "push", detail: string) => void,
  options?: { mode?: "normal" | "force-local-authority"; actor?: string; comment?: string },
): Promise<GitHubSyncResult> {
  const maximumAttempts = target.publication?.manualVerificationCompleted === false && options?.mode !== "force-local-authority" ? 1 : 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    try {
      return await syncGitHubTargetAttempt(target, catalog, checkoutRoot, credentials, storeRoot, onProgress, options);
    } catch (error) {
      if (attempt >= maximumAttempts || !concurrentPushFailure(error)) throw error;
      onProgress?.("fetch", `GitHub advanced during push; fetching and reconciling again (${attempt + 1}/${maximumAttempts})`);
    }
  }
  throw new Error("GitHub Sync exhausted its reconciliation attempts.");
}

export type GitHubPublicationMigrationPhase = "previewed" | "staged" | "verified" | "cutover" | "rolled-back";

export interface GitHubPublicationMigrationSource {
  target: GitHubSyncTarget;
  remoteCommit: string;
  manifest: string;
  repositoryFiles: string[];
  repositoryDigests?: Record<string, string>;
  canonicalFiles?: GitHubSyncMigrationCanonicalFile[];
  activeCount: number;
  trashCount: number;
  folderCount: number;
  idCount: number;
}

export interface GitHubSyncMigrationCanonicalFile {
  path: string;
  type: GitHubSyncContentType;
  itemId: string;
  member: string;
  category: string;
  privacy: GitHubSyncPrivacy;
}

export function githubSyncMigrationCanonicalFiles(
  catalog: GitHubSyncCatalog,
  target?: GitHubSyncTarget,
): GitHubSyncMigrationCanonicalFile[] {
  const files: GitHubSyncMigrationCanonicalFile[] = [];
  const destinations = new Set<string>();
  for (const type of GITHUB_SYNC_CONTENT_TYPES) {
    for (const item of catalog[type].filter(candidate => !target || selectedItem(target, type, candidate))) {
      for (const file of collectItemFiles(item)) {
        const portable = file.destination.toLocaleLowerCase("en-US");
        if (destinations.has(portable)) throw new Error(`Multiple catalog items map to ${file.destination}.`);
        destinations.add(portable);
        files.push({
          path: file.destination,
          type,
          itemId: item.id,
          member: file.member,
          category: item.cat,
          privacy: item.isPrivate ? "private" : "public",
        });
      }
    }
  }
  return files;
}

export interface GitHubPublicationMigrationReceipt {
  phase: GitHubPublicationMigrationPhase;
  targetId: string;
  repository: string;
  branch: string;
  remoteCommit: string;
  sourceDigest: string;
  stagedDigest: string;
  activeCount: number;
  trashCount: number;
  folderCount: number;
  idCount: number;
  collisions: string[];
}

interface GitHubPublicationMigrationMarker extends GitHubPublicationMigrationReceipt {
  targetBackup: GitHubSyncTarget;
}

export class GitHubPublicationMigration {
  private readonly migrationRoot: string;
  private readonly markerPath: string;

  constructor(stateRoot: string, private readonly targetId: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(targetId)) throw new Error("GitHub migration target ID is invalid.");
    this.migrationRoot = path.join(stateRoot, "migrations", targetId);
    this.markerPath = path.join(this.migrationRoot, "migration.json");
  }

  stagedManifestPath(): string {
    return path.join(this.migrationRoot, "stage", MANIFEST_PATH);
  }

  preview(source: GitHubPublicationMigrationSource): GitHubPublicationMigrationReceipt {
    const receipt = this.buildPreview(source);
    const existing = this.readMarker();
    if (existing && existing.sourceDigest === receipt.sourceDigest && existing.phase !== "rolled-back") return this.receipt(existing);
    if (existing && existing.phase !== "rolled-back" && existing.sourceDigest !== receipt.sourceDigest) {
      throw new Error("GitHub migration source changed after preview.");
    }
    const marker: GitHubPublicationMigrationMarker = {
      ...receipt,
      targetBackup: JSON.parse(JSON.stringify(source.target)),
    };
    fs.mkdirSync(this.migrationRoot, { recursive: true });
    this.writeMarker(marker);
    return receipt;
  }

  private buildPreview(source: GitHubPublicationMigrationSource): GitHubPublicationMigrationReceipt {
    this.validateSource(source);
    const collisions: string[] = [];
    try {
      const parsed = this.migrationManifest(source);
      const singleFileTypes = new Set<GitHubSyncContentType>(["skills", "notes", "papers", "scripts", "recipes", "agentSnapshots"]);
      for (const [key, files] of groupManagedFiles(parsed.files)) {
        if (singleFileTypes.has(files[0].type) && files.length > 1) {
          collisions.push(`Stable identity ${key.replace("\0", ":")} maps to ${files.length} files.`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/differ only by case|repeats stable member identity/i.test(message)) collisions.push(message);
      else throw error;
    }
    return {
      phase: "previewed",
      targetId: this.targetId,
      repository: source.target.repository,
      branch: source.target.branch,
      remoteCommit: source.remoteCommit,
      sourceDigest: this.sourceDigest(source),
      stagedDigest: "",
      activeCount: source.activeCount,
      trashCount: source.trashCount,
      folderCount: source.folderCount,
      idCount: source.idCount,
      collisions: [...new Set(collisions)].sort(),
    };
  }

  stage(source: GitHubPublicationMigrationSource): GitHubPublicationMigrationReceipt {
    const preview = this.buildPreview(source);
    const existing = this.readMarker();
    if (existing && (existing.repository !== preview.repository || existing.branch !== preview.branch)) {
      throw new Error("GitHub migration repository or branch changed after the transaction started.");
    }
    if (existing && existing.sourceDigest === preview.sourceDigest && ["staged", "verified", "cutover"].includes(existing.phase)
      && fs.existsSync(this.stagedManifestPath())) {
      source.target.automation.enabled = false;
      source.target.automation.initialSyncCompleted = false;
      return this.receipt(existing);
    }
    if (existing && existing.phase !== "rolled-back" && existing.sourceDigest !== preview.sourceDigest
      && !(existing.phase === "previewed" && existing.remoteCommit === preview.remoteCommit)) {
      throw new Error(existing.phase === "previewed"
        ? "GitHub remote changed after preview. Run Preview again before staging."
        : "GitHub migration source changed after preview.");
    }
    const parsed = this.migrationManifest(source);
    for (const file of parsed.files) {
      if (file.digest) continue;
      const digest = source.repositoryDigests?.[file.path];
      if (!/^[0-9a-f]{64}$/.test(digest || "")) {
        throw new Error(`GitHub migration requires a verified content digest for legacy manifest file ${file.path}.`);
      }
      file.digest = digest!;
    }
    if (preview.collisions.length) throw new Error(`GitHub migration has unresolved collisions: ${preview.collisions.join("; ")}`);
    const stagedManifest = manifestJson(parsed.files, parsed.deletions);
    const stagedDigest = createHash("sha256").update(stagedManifest).digest("hex");
    fs.rmSync(this.migrationRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(this.stagedManifestPath()), { recursive: true });
    writeAtomic(this.stagedManifestPath(), Buffer.from(stagedManifest, "utf8"));
    writeAtomic(path.join(this.migrationRoot, "backup", MANIFEST_PATH), Buffer.from(source.manifest, "utf8"));
    const marker: GitHubPublicationMigrationMarker = {
      ...preview,
      phase: "staged",
      stagedDigest,
      targetBackup: existing?.targetBackup || JSON.parse(JSON.stringify(source.target)),
    };
    source.target.automation.enabled = false;
    source.target.automation.initialSyncCompleted = false;
    this.writeMarker(marker);
    return this.receipt(marker);
  }

  verify(source: GitHubPublicationMigrationSource): GitHubPublicationMigrationReceipt {
    const marker = this.requireMarker();
    this.fenceSource(marker, source);
    const content = fs.readFileSync(this.stagedManifestPath(), "utf8");
    if (createHash("sha256").update(content).digest("hex") !== marker.stagedDigest) {
      throw new Error("GitHub migration staged manifest digest does not match the transaction.");
    }
    const parsed = parseManagedManifest(content);
    if (parsed.schema !== GITHUB_SYNC_MANIFEST_SCHEMA) throw new Error("GitHub migration staged manifest did not upgrade to schema 3.");
    marker.phase = "verified";
    this.writeMarker(marker);
    return this.receipt(marker);
  }

  cutover(source: GitHubPublicationMigrationSource): GitHubPublicationMigrationReceipt {
    const marker = this.requireMarker();
    this.fenceSource(marker, source);
    if (marker.phase === "cutover") {
      source.target.automation.enabled = false;
      source.target.automation.initialSyncCompleted = false;
      source.target.publication = {
        requiredCapability: "stable-entity-identity",
        sourceCommit: marker.remoteCommit,
        sourceDigest: marker.sourceDigest,
        manualVerificationCompleted: source.target.publication?.manualVerificationCompleted === true,
      };
      return this.receipt(marker);
    }
    if (marker.phase !== "verified") throw new Error("GitHub migration must be verified before cutover.");
    source.target.automation.enabled = false;
    source.target.automation.initialSyncCompleted = false;
    source.target.publication = {
      requiredCapability: "stable-entity-identity",
      sourceCommit: marker.remoteCommit,
      sourceDigest: marker.sourceDigest,
      manualVerificationCompleted: false,
    };
    marker.phase = "cutover";
    this.writeMarker(marker);
    return this.receipt(marker);
  }

  completeManualVerification(source: GitHubPublicationMigrationSource): GitHubPublicationMigrationReceipt {
    const marker = this.requireMarker();
    this.fenceSource(marker, source);
    if (marker.phase !== "cutover") throw new Error("GitHub migration cutover is required before manual publication verification.");
    if (!source.target.publication || source.target.publication.sourceDigest !== marker.sourceDigest) {
      throw new Error("GitHub migration capability authority is not active.");
    }
    source.target.publication.manualVerificationCompleted = true;
    source.target.automation.enabled = false;
    return this.receipt(marker);
  }

  rollback(source: GitHubPublicationMigrationSource): GitHubPublicationMigrationReceipt {
    const marker = this.requireMarker();
    if (marker.repository !== source.target.repository || marker.branch !== source.target.branch) {
      throw new Error("GitHub migration repository or branch changed; rollback refused.");
    }
    for (const key of Object.keys(source.target)) delete (source.target as any)[key];
    Object.assign(source.target, JSON.parse(JSON.stringify(marker.targetBackup)));
    marker.phase = "rolled-back";
    this.writeMarker(marker);
    fs.rmSync(path.join(this.migrationRoot, "stage"), { recursive: true, force: true });
    return this.receipt(marker);
  }

  status(): GitHubPublicationMigrationReceipt | undefined {
    const marker = this.readMarker();
    return marker ? this.receipt(marker) : undefined;
  }

  private validateSource(source: GitHubPublicationMigrationSource): void {
    if (source.target.id !== this.targetId) throw new Error("GitHub migration target identity changed.");
    if (!/^[0-9a-f]{40,64}$/i.test(source.remoteCommit)) throw new Error("GitHub migration remote commit is invalid.");
    if (!Array.isArray(source.repositoryFiles) || source.repositoryFiles.length > 10000) throw new Error("GitHub migration repository inventory is invalid.");
    if (source.repositoryDigests) {
      for (const [file, digest] of Object.entries(source.repositoryDigests)) {
        if (!source.repositoryFiles.includes(file) || !/^[0-9a-f]{64}$/.test(digest)) {
          throw new Error("GitHub migration repository digest inventory is invalid.");
        }
      }
      for (const file of source.canonicalFiles || []) {
        githubSyncSafeRelativePath(file.path);
        if (!(GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(file.type)
          || !file.itemId || typeof file.member !== "string" || typeof file.category !== "string"
          || (file.privacy !== "public" && file.privacy !== "private")) {
          throw new Error("GitHub migration canonical identity inventory is invalid.");
        }
      }
    }
    for (const value of [source.activeCount, source.trashCount, source.folderCount, source.idCount]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("GitHub migration preview counts are invalid.");
    }
  }

  private sourceDigest(source: GitHubPublicationMigrationSource): string {
    return createHash("sha256").update(JSON.stringify({
      targetId: source.target.id,
      repository: source.target.repository,
      branch: source.target.branch,
      remoteCommit: source.remoteCommit,
      manifest: source.manifest,
      repositoryFiles: [...source.repositoryFiles].sort(),
      activeCount: source.activeCount,
      trashCount: source.trashCount,
      folderCount: source.folderCount,
    })).digest("hex");
  }

  private migrationManifest(source: GitHubPublicationMigrationSource): GitHubSyncManifest {
    const parsed = parseManagedManifest(source.manifest);
    const canonicalByPath = new Map((source.canonicalFiles || []).map(file => [`${file.type}\0${file.path}`, file]));
    const canonicalized = new Set<GitHubSyncManagedFile>();
    for (const file of parsed.files) {
      const canonical = canonicalByPath.get(`${file.type}\0${file.path}`);
      if (!canonical) continue;
      file.itemId = canonical.itemId;
      file.member = canonical.member;
      file.category = canonical.category;
      file.privacy = canonical.privacy;
      canonicalized.add(file);
    }
    if (parsed.schema === 1) {
      const singleFileTypes = new Set<GitHubSyncContentType>(["skills", "notes", "papers", "scripts", "recipes", "agentSnapshots"]);
      for (const files of groupManagedFiles(parsed.files).values()) {
        if (!singleFileTypes.has(files[0].type) || files.length < 2) continue;
        for (const file of files) {
          if (canonicalized.has(file)) continue;
          const relative = file.path.slice(file.type.length + 1).replace(/\.[^.]+$/, "");
          file.itemId = relative;
          file.member = "";
        }
      }
    }
    return parsed;
  }

  private fenceSource(marker: GitHubPublicationMigrationMarker, source: GitHubPublicationMigrationSource): void {
    if (marker.repository !== source.target.repository || marker.branch !== source.target.branch) {
      throw new Error("GitHub migration repository or branch changed after staging.");
    }
    if (marker.sourceDigest !== this.sourceDigest(source)) throw new Error("GitHub migration source changed after staging.");
  }

  private readMarker(): GitHubPublicationMigrationMarker | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.markerPath, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private requireMarker(): GitHubPublicationMigrationMarker {
    const marker = this.readMarker();
    if (!marker) throw new Error("GitHub migration has not been staged.");
    return marker;
  }

  private writeMarker(marker: GitHubPublicationMigrationMarker): void {
    writeAtomic(this.markerPath, Buffer.from(JSON.stringify(marker, null, 2) + "\n", "utf8"));
  }

  private receipt(marker: GitHubPublicationMigrationMarker): GitHubPublicationMigrationReceipt {
    const { targetBackup: _targetBackup, ...receipt } = marker;
    return JSON.parse(JSON.stringify(receipt));
  }
}