import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const GITHUB_SYNC_CONTENT_TYPES = [
  "skills", "notes", "papers", "prompts", "scripts", "packages", "servers", "recipes", "agentSnapshots"
] as const;

export type GitHubSyncContentType = typeof GITHUB_SYNC_CONTENT_TYPES[number];
export type GitHubSyncPrivacy = "public" | "private";
export type GitHubSyncShield = "outline" | "yellow" | "green";
export type GitHubSyncAuthentication =
  | { method: "ssh"; identityFile: string; expectedLogin: string }
  | { method: "https"; expectedLogin: string }
  | { method: "vscode"; expectedLogin: string; accountId?: string };

export interface GitHubSyncCredentials {
  accessToken: string;
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
  };
  selection: Record<GitHubSyncPrivacy, GitHubSyncSelectionScope>;
  lastSync?: {
    at: string;
    commit: string;
    fingerprints: Partial<Record<GitHubSyncContentType, string>>;
  };
  lastFailure?: {
    at: string;
    error: string;
    reason: string;
  };
}

export interface GitHubSyncFingerprintEntry {
  path: string;
  digest: string;
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
  commit: string;
  changed: boolean;
  fingerprints: Record<GitHubSyncContentType, string>;
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
}

export interface GitHubSyncRemoteSnapshot {
  targetId: string;
  commit: string;
  files: GitHubSyncRemoteFile[];
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
  const target: GitHubSyncTarget = {
    schema: 1,
    id,
    name,
    repository,
    branch,
    automation: {
      enabled: value?.automation?.enabled !== false,
      intervalMinutes,
      syncOnChange: value?.automation?.syncOnChange !== false,
    },
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
      fingerprints
    };
  }
  if (value?.lastFailure?.at && value?.lastFailure?.error) {
    target.lastFailure = {
      at: String(value.lastFailure.at),
      error: String(value.lastFailure.error),
      reason: String(value.lastFailure.reason || "automatic"),
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
  return target?.authentication?.method === "https"
    ? ["-c", "credential.gitHubAccountFiltering=true", "-c", `credential.username=${target.authentication.expectedLogin}`, ...args]
    : target?.authentication?.method === "vscode"
      ? ["-c", "credential.helper=", "-c", `credential.helper=${VSCODE_GITHUB_CREDENTIAL_HELPER}`, "-c", "credential.username=x-access-token", ...args]
    : args;
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

function selectedItem(target: GitHubSyncTarget, type: GitHubSyncContentType, item: GitHubSyncCatalogItem): boolean {
  const selection = target.selection[item.isPrivate ? "private" : "public"][type];
  return selection.items.includes(item.id) || selection.folders.some(folder =>
    folder === "" || item.cat === folder || item.cat.startsWith(folder + "/")
  );
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

function collectItemFiles(item: GitHubSyncCatalogItem): Array<{ destination: string; content: Buffer }> {
  const destination = githubSyncSafeRelativePath(item.destination);
  if (item.content !== undefined) return [{ destination, content: Buffer.from(item.content, "utf8") }];
  if (!item.source) throw new Error(`Catalog item ${item.id} has no source.`);
  const source = path.resolve(item.source);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links cannot be synchronized: ${item.source}`);
  if (stat.isFile()) return [{ destination, content: fs.readFileSync(source) }];
  if (!stat.isDirectory()) throw new Error(`Unsupported catalog source: ${item.source}`);
  const files: Array<{ destination: string; content: Buffer }> = [];
  const walk = (directory: string, relative: string): void => {
    for (const name of fs.readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      if (name === ".git") continue;
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const childStat = fs.lstatSync(child);
      if (childStat.isSymbolicLink()) throw new Error(`Symbolic links cannot be synchronized: ${child}`);
      if (childStat.isDirectory()) walk(child, childRelative);
      else if (childStat.isFile()) files.push({ destination: `${destination}/${childRelative}`, content: fs.readFileSync(child) });
    }
  };
  walk(source, "");
  return files;
}

function selectedFiles(target: GitHubSyncTarget, catalog: GitHubSyncCatalog): {
  files: Array<{ destination: string; content: Buffer }>;
  fingerprints: Record<GitHubSyncContentType, string>;
} {
  const files: Array<{ destination: string; content: Buffer }> = [];
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
        files.push(file);
        entries.push({ path: file.destination, digest: createHash("sha256").update(file.content).digest("hex") });
      }
    }
    fingerprints[type] = fingerprintGitHubSyncEntries(entries);
  }
  return { files, fingerprints };
}

export function githubSyncTargetFingerprints(
  target: GitHubSyncTarget,
  catalog: GitHubSyncCatalog
): Record<GitHubSyncContentType, string> {
  return selectedFiles(target, catalog).fingerprints;
}

async function git(cwd: string, args: string[], target?: GitHubSyncTarget, allowFailure = false, credentials?: GitHubSyncCredentials): Promise<string> {
  try {
    const result = await execFileAsync("git", githubSyncGitArguments(args, target), { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: gitEnvironment(target, credentials), windowsHide: process.platform === "win32" });
    return String(result.stdout || "").trim();
  } catch (error: any) {
    if (allowFailure) return "";
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    const guidance = githubSyncAuthenticationFailureGuidance(target, detail);
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : "."}${guidance ? ` ${guidance}` : ""}`);
  }
}

async function gitBuffer(cwd: string, args: string[], target?: GitHubSyncTarget): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", githubSyncGitArguments(args, target), { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024, env: gitEnvironment(target), windowsHide: process.platform === "win32" });
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

async function fetchRemoteBranch(target: GitHubSyncTarget, checkoutRoot: string, credentials?: GitHubSyncCredentials): Promise<{ checkout: string; commit: string }> {
  const checkout = githubSyncCheckoutPath(target, checkoutRoot);
  if (!fs.existsSync(path.join(checkout, ".git"))) {
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    await git(path.dirname(checkout), ["clone", "--no-checkout", "--origin", "origin", target.repository, checkout], target, false, credentials);
  }
  const remote = await git(checkout, ["remote", "get-url", "origin"]);
  if (remote !== target.repository) throw new Error("Managed checkout points to a different repository. Delete the target and create it again.");
  await git(checkout, ["fetch", "origin", "--prune"], target, false, credentials);
  const remoteRef = `refs/remotes/origin/${target.branch}`;
  if (!(await hasRef(checkout, remoteRef))) throw new Error(`Remote branch ${target.branch} does not exist.`);
  return { checkout, commit: await git(checkout, ["rev-parse", remoteRef]) };
}

function remoteManifestFiles(raw: string, repositoryFiles: Set<string>): GitHubSyncRemoteFile[] {
  let manifest: any;
  try { manifest = JSON.parse(raw); } catch { throw new Error("Remote PKM manifest is not valid JSON."); }
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files)) throw new Error("Remote repository does not contain a supported PKM manifest.");
  if (manifest.files.length > 10000) throw new Error("Remote PKM manifest contains too many files.");
  const seen = new Set<string>();
  return manifest.files.map((value: unknown) => {
    const file = githubSyncSafeRelativePath(String(value));
    const portable = file.toLocaleLowerCase("en-US");
    if (seen.has(portable)) throw new Error(`Remote manifest paths differ only by case: ${file}.`);
    seen.add(portable);
    if (!repositoryFiles.has(file)) throw new Error(`Remote manifest references a missing file: ${file}.`);
    const type = file.split("/", 1)[0] as GitHubSyncContentType;
    if (!(GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(type)) throw new Error(`Remote manifest contains an unsupported content path: ${file}.`);
    return { path: file, type };
  }).sort((left: GitHubSyncRemoteFile, right: GitHubSyncRemoteFile) => left.path.localeCompare(right.path));
}

export async function fetchGitHubRemoteSnapshot(target: GitHubSyncTarget, checkoutRoot: string, allowRepositoryTree = false, credentials?: GitHubSyncCredentials): Promise<GitHubSyncRemoteSnapshot> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  const { checkout, commit } = await fetchRemoteBranch(normalized, checkoutRoot, credentials);
  const repositoryFiles = new Set((await git(checkout, ["ls-tree", "-r", "--name-only", "-z", commit])).split("\0").filter(Boolean));
  let manifest: string;
  try {
    manifest = await git(checkout, ["show", `${commit}:${MANIFEST_PATH}`]);
  } catch {
    if (allowRepositoryTree) {
      const files = [...repositoryFiles].filter(file => {
        const type = file.split("/", 1)[0];
        return (GITHUB_SYNC_CONTENT_TYPES as readonly string[]).includes(type) && file.split("/").length > 1;
      }).map(file => ({ path: githubSyncSafeRelativePath(file), type: file.split("/", 1)[0] as GitHubSyncContentType }))
        .sort((left, right) => left.path.localeCompare(right.path));
      if (files.length > 10000) throw new Error("Remote repository contains too many subscribable files.");
      return { targetId: normalized.id, commit, files };
    }
    throw new Error("Remote repository has no PKM sync manifest yet.");
  }
  return { targetId: normalized.id, commit, files: remoteManifestFiles(manifest, repositoryFiles) };
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
  return gitBuffer(checkout, ["show", `${commit}:${safe}`]);
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
  for (const item of contents) {
    fs.mkdirSync(path.dirname(item.destination), { recursive: true });
    const temporary = `${item.destination}.pkm-restore-${process.pid}-${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, item.content, { flag: "wx" });
      fs.renameSync(temporary, item.destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
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
  else await git(checkout, ["checkout", "--orphan", target.branch]);
  const hasHead = await hasRef(checkout, "HEAD");
  if (remoteExists && hasHead) {
    if (await isAncestor(checkout, `origin/${target.branch}`, "HEAD")) return;
    if (await isAncestor(checkout, "HEAD", `origin/${target.branch}`)) {
      await git(checkout, ["merge", "--ff-only", `origin/${target.branch}`]);
      return;
    }
    throw new Error(`Branch ${target.branch} has diverged from origin; synchronization stopped without merging or force-pushing.`);
  }
}

const MANIFEST_PATH = ".pkm-github-sync.json";

export async function syncGitHubTarget(
  target: GitHubSyncTarget,
  catalog: GitHubSyncCatalog,
  checkoutRoot: string,
  credentials?: GitHubSyncCredentials
): Promise<GitHubSyncResult> {
  const normalized = normalizeGitHubSyncTarget(target, () => target.id);
  const checkout = path.join(checkoutRoot, normalized.id, "repository");
  const materialized = selectedFiles(normalized, catalog);
  await prepareCheckout(normalized, checkout, credentials);
  let previousFiles: string[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(checkout, MANIFEST_PATH), "utf8"));
    if (manifest?.schema === 1 && Array.isArray(manifest.files)) previousFiles = manifest.files.map(String);
  } catch { /* first synchronization */ }
  for (const relative of previousFiles) {
    fs.rmSync(managedPath(checkout, relative), { force: true });
  }
  for (const file of materialized.files) {
    const destination = managedPath(checkout, file.destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
  const managedFiles = materialized.files.map(file => file.destination).sort((left, right) => left.localeCompare(right));
  fs.writeFileSync(path.join(checkout, MANIFEST_PATH), JSON.stringify({ schema: 1, files: managedFiles }, null, 2) + "\n");
  await git(checkout, ["add", "-A", "--", "."]);
  const changed = !!(await git(checkout, ["status", "--porcelain"]));
  if (changed) {
    await git(checkout, ["config", "user.name", "Personal Knowledge Manager"]);
    await git(checkout, ["config", "user.email", "pkm@localhost"]);
    await git(checkout, ["commit", "-m", `PKM sync ${new Date().toISOString()}`]);
  }
  await git(checkout, ["push", "origin", `HEAD:refs/heads/${normalized.branch}`], normalized, false, credentials);
  const commit = await git(checkout, ["rev-parse", "HEAD"]);
  return { commit, changed, fingerprints: materialized.fingerprints };
}