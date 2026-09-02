export interface StorePathCandidates {
  machinePath?: string;
  configuredPath?: string;
  previousPath?: string;
}

export interface ResolvedStorePath {
  path: string;
  source: "machine" | "configuration" | "previous";
  rejected: string[];
}

export function extensionHostDescription(platform: NodeJS.Platform, hostName: string, remoteName = ""): string {
  const osName = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";
  return remoteName
    ? `Remote extension host ${hostName} (${osName}, ${remoteName})`
    : `Local ${osName} machine ${hostName}`;
}

export function isForeignAbsolutePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = String(value || "").trim();
  if (!path) return false;
  if (platform === "win32") return /^\//.test(path);
  return /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path);
}

/** Resolve only an existing path owned by this machine; never invent a fallback store. */
export function resolveMachineStorePath(
  candidates: StorePathCandidates,
  isDirectory: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): ResolvedStorePath | undefined {
  const rejected: string[] = [];
  const ordered: Array<[ResolvedStorePath["source"], string]> = [
    ["machine", String(candidates.machinePath || "").trim()],
    ["configuration", String(candidates.configuredPath || "").trim()],
    ["previous", String(candidates.previousPath || "").trim()],
  ];
  for (const [source, path] of ordered) {
    if (!path) continue;
    if (isForeignAbsolutePath(path, platform) || !isDirectory(path)) { rejected.push(path); continue; }
    return { path, source, rejected };
  }
  return undefined;
}
