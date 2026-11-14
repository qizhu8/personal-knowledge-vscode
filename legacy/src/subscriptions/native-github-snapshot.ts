import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  fetchGitHubRemoteSnapshot, githubSyncRepositoryHttpsHost, normalizeGitHubSyncTarget, readGitHubRemoteFilesForSubscription,
  type GitHubSyncCredentials,
} from "../sync/github-sync";
import { MAX_SUBSCRIPTION_CACHE_BYTES } from "./subscriptions";

type OldGitHubRecord = { id: string; nodeId: string; shareId: string; endpoint: string; publisherUser: string;
  source: { type: "github"; repository: string; branch: string; credentialTargetId?: string; targetId?: string;
    selectedPaths?: string[]; selectedFolders?: string[] } };

/** VS Code's GitHub credential is valid only for github.com. */
export function privateGitHubSubscriptionEndpoint(repository: string): void {
  const host = githubSyncRepositoryHttpsHost(repository);
  const url = new URL(repository);
  if (url.username || url.password || url.search || url.hash) throw new Error("GitHub Subscription endpoint denied.");
  const match = /^https:\/\/github\.com(?::443)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/i.exec(repository);
  if (host !== "github.com" || url.port || !match || [".", ".."].includes(match[1]!) || [".", ".."].includes(match[2]!))
    throw new Error("GitHub Subscription endpoint denied.");
}

/** Only the private coordinator may use this transport. */
export async function fetchPrivateGitHubSubscription(
  fixture: string, record: OldGitHubRecord, account: string, credentials?: GitHubSyncCredentials,
) {
  const source = record.source;
  const credentialTargetId = source.credentialTargetId || source.targetId || null;
  if (process.env.PKM_PRIVATE_NATIVE_SUBSCRIPTION !== "1" || process.platform !== "linux"
    || !/^pkm-native-subscription-ui-[a-f0-9-]{36}$/.test(path.basename(fixture))
    || fs.realpathSync(fixture) !== fixture
    || record.endpoint !== source.repository || source.type !== "github"
    || !account || account.toLowerCase() !== record.publisherUser.toLowerCase()
    || (credentialTargetId
      ? !credentials?.accessToken || credentials.accessToken.length > 8192 || /[\x00-\x20\x7f]/.test(credentials.accessToken)
      : credentials !== undefined))
    throw new Error("Private GitHub Subscription binding denied.");
  privateGitHubSubscriptionEndpoint(source.repository);
  const runtime = path.join(fixture, "runtime");
  const stat = fs.lstatSync(runtime);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(runtime) !== runtime
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Private GitHub checkout directory denied.");
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")
    || ["PKM_GITHUB_SYNC_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
      "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"].includes(key)) delete process.env[key];
  Object.assign(process.env, {
    HOME: runtime, XDG_CONFIG_HOME: runtime, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "http.followRedirects", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "http.proxy", GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "protocol.file.allow", GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "credential.helper", GIT_CONFIG_VALUE_3: "",
  });
  const checkoutRoot = path.join(runtime, `github-subscription-${randomUUID()}`);
  fs.mkdirSync(checkoutRoot, { mode: 0o700 });
  const target = normalizeGitHubSyncTarget({ id: "subscription", name: source.repository, repository: source.repository,
    branch: source.branch, ...(credentialTargetId ? { authentication: { method: "vscode", expectedLogin: account } } : {}) });
  const snapshot = await fetchGitHubRemoteSnapshot(target, checkoutRoot, true, credentials);
  const paths = source.selectedPaths ?? [], folders = source.selectedFolders ?? [];
  if (!Array.isArray(paths) || !Array.isArray(folders) || [...paths, ...folders].some(value => typeof value !== "string"))
    throw new Error("GitHub Subscription selection denied.");
  const files = snapshot.files.filter(file => file.type !== "agentSnapshots"
    && (!(paths.length || folders.length) || paths.includes(file.path) || folders.some(folder => file.path.startsWith(`${folder}/`))));
  if (!files.length || files.reduce((total, file) => total + file.size, 0) > MAX_SUBSCRIPTION_CACHE_BYTES)
    throw new Error("GitHub Subscription selection is empty or too large.");
  const content = new Map<string, Buffer>();
  for (let index = 0; index < files.length;) {
    const batch = []; let size = 0;
    while (index < files.length && batch.length < 128 && (!batch.length || size + files[index]!.size <= 16 * 1024 * 1024)) {
      const file = files[index++]!; batch.push(file); size += file.size;
    }
    for (const [name, bytes] of await readGitHubRemoteFilesForSubscription(target, checkoutRoot, snapshot.commit, batch, MAX_SUBSCRIPTION_CACHE_BYTES))
      content.set(name, bytes);
  }
  const selected = files.map(file => {
    const bytes = content.get(file.path);
    if (!bytes || bytes.length !== file.size) throw new Error("GitHub Subscription content changed.");
    return { path: file.path, size: file.size, content: bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return { commit: snapshot.commit, files: selected };
}
