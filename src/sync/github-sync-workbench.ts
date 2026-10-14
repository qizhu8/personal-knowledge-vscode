import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { diffArrays } from "diff";
import type { GitHubSyncStoredConflict } from "./github-sync-conflicts";

export interface GitHubSyncDifferenceBlock {
  local: string;
  remote: string;
  localLine: number;
  remoteLine: number;
  contextBefore: string;
  contextAfter: string;
  resultStart?: number;
  resultEnd?: number;
}

export interface GitHubSyncWorkbenchComparison {
  blocks: GitHubSyncDifferenceBlock[];
  warning?: string;
}

export function githubSyncWorkbenchComparison(local: string, remote: string, result: string): GitHubSyncWorkbenchComparison {
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const localLines = lines(local), remoteLines = lines(remote), resultLines = lines(result);
  if ([local, remote, result].some(text => text.length > 200_000) ||
      [localLines, remoteLines, resultLines].some(parts => parts.length > 12_000)) {
    return { blocks: [], warning: "This file is too large for inline difference picking. Use native compare or edit the result directly." };
  }
  const options = { maxEditLength: 4096, timeout: 75 };
  const changes = diffArrays(localLines, remoteLines, options);
  const resultChanges = diffArrays(localLines, resultLines, options);
  if (!changes || !resultChanges) return { blocks: [], warning: "Inline comparison exceeded its calculation limit. Use native compare or edit the result directly." };
  const before: Array<number | undefined> = [], after: Array<number | undefined> = [];
  let left = 0, right = 0;
  for (let index = 0; index < resultChanges.length;) {
    const change = resultChanges[index];
    if (!change.added && !change.removed) {
      for (let offset = 0; offset <= change.value.length; offset++) {
        before[left + offset] ??= right + offset;
        after[left + offset] ??= right + offset;
      }
      left += change.value.length; right += change.value.length; index++;
    } else {
      const startLeft = left, startRight = right;
      while (index < resultChanges.length && (resultChanges[index].added || resultChanges[index].removed)) {
        const edit = resultChanges[index++];
        if (edit.removed) left += edit.value.length;
        if (edit.added) right += edit.value.length;
      }
      before[startLeft] = startRight; after[startLeft] = startRight;
      before[left] = right; after[left] = right;
      if (startLeft === left) { before[left] = startRight; after[left] = right; }
    }
  }
  before[localLines.length] ??= resultLines.length; after[localLines.length] ??= resultLines.length;
  const offsets = [0];
  for (const line of resultLines) offsets.push(offsets[offsets.length - 1] + line.length);
  const blocks: GitHubSyncDifferenceBlock[] = [];
  left = 0; right = 0;
  let contextBefore = "";
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      contextBefore = change.value.slice(-3).join("");
      left += change.value.length; right += change.value.length; index++; continue;
    }
    const startLeft = left, startRight = right;
    const localParts: string[] = [], remoteParts: string[] = [];
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const edit = changes[index++];
      if (edit.removed) { localParts.push(...edit.value); left += edit.value.length; }
      if (edit.added) { remoteParts.push(...edit.value); right += edit.value.length; }
    }
    const start = before[startLeft], end = startLeft === left ? after[left] : before[left];
    blocks.push({ local: localParts.join(""), remote: remoteParts.join(""),
      localLine: startLeft + 1, remoteLine: startRight + 1, contextBefore,
      contextAfter: changes[index]?.value.slice(0, 3).join("") || "",
      ...(start !== undefined && end !== undefined ? { resultStart: offsets[start], resultEnd: offsets[end] } : {}) });
    contextBefore = "";
  }
  if (blocks.length > 200) return { blocks: [], warning: "This file has more than 200 difference blocks. Use native compare or edit the result directly." };
  return { blocks };
}

export interface GitHubSyncWorkbenchState {
  record: GitHubSyncStoredConflict;
  files: Array<{
    path: string;
    base?: string;
    local?: string;
    remote?: string;
    merged?: string;
    binary: boolean;
    mime?: string;
    previews?: Partial<Record<"base" | "local" | "remote" | "merged", string>>;
    comparison?: GitHubSyncWorkbenchComparison;
  }>;
}

export interface GitHubSyncWorkbenchRequest {
  command: "choose" | "delete-remote" | "delete-local" | "save" | "agent" | "apply" | "compare" | "refresh";
  conflictId: string;
  revision: number;
  path?: string;
  source?: "base" | "local" | "remote";
  content?: string;
}

interface WorkbenchOptions {
  getState: () => Promise<GitHubSyncWorkbenchState | undefined>;
  perform: (request: GitHubSyncWorkbenchRequest) => Promise<void>;
  initialPath?: string;
}

const panels = new WeakMap<vscode.ExtensionContext, Map<string, { panel: vscode.WebviewPanel; options: WorkbenchOptions }>>();
const commands = new Set(["choose", "delete-remote", "delete-local", "save", "agent", "apply", "compare", "refresh"]);

export function escapeGitHubSyncWorkbenchHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

export function renderGitHubSyncWorkbenchHtml(webview: vscode.Webview, scriptUri: vscode.Uri, nonce: string): string {
  const esc = escapeGitHubSyncWorkbenchHtml;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${esc(webview.cspSource)} data:; style-src 'nonce-${esc(nonce)}'; script-src 'nonce-${esc(nonce)}'; connect-src 'none';">
<title>GitHub Sync conflict workbench</title>
<style nonce="${esc(nonce)}">
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:10px;margin:0}
button,select,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border, var(--vscode-panel-border));padding:7px}
button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:disabled{opacity:.45;cursor:default}
button:focus-visible,textarea:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--vscode-focusBorder)}
header,.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}h1{font-size:1.4em}h2{font-size:1em;margin:0 0 8px}
.layout{display:grid;grid-template-columns:minmax(140px,190px) minmax(0,1fr);gap:10px;margin-top:12px}.layout.files-collapsed{grid-template-columns:minmax(0,1fr)}
nav{display:flex;flex-direction:column;gap:6px}nav button{text-align:left;overflow-wrap:anywhere}.active{outline:2px solid var(--vscode-focusBorder)}
nav[hidden]{display:none}nav details{min-width:0}nav summary{cursor:pointer;overflow-wrap:anywhere;padding:4px 0}.file-tree-children{padding-left:10px;display:flex;flex-direction:column;gap:5px}nav small{display:block;opacity:.75}
.variants{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.variant,.result{border:1px solid var(--vscode-panel-border);padding:10px;min-width:0}.base-preview{margin:10px 0}.base-preview summary{cursor:pointer}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;font-family:var(--vscode-editor-font-family)}
textarea{width:100%;box-sizing:border-box;min-height:240px;font-family:var(--vscode-editor-font-family);resize:vertical}
img{max-width:100%;max-height:220px;object-fit:contain}a{color:var(--vscode-textLink-foreground)}
.error{color:var(--vscode-errorForeground);white-space:pre-wrap}.muted{color:var(--vscode-descriptionForeground)}#status{white-space:pre-wrap}
.differences{margin:12px 0;border:1px solid var(--vscode-panel-border);padding:10px}.difference-block{border:1px solid var(--vscode-panel-border);margin:12px 0;padding:8px}
.difference-sides{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.difference-sides section{min-width:0}
.difference-headings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.difference-headings section{min-width:0;display:flex;flex-wrap:wrap;gap:5px}.difference-headings h2{width:100%}
.difference-local{background:var(--vscode-diffEditor-removedTextBackground,#d34b4b26);border-left:3px solid var(--vscode-editorGutter-deletedBackground,#c74e39);padding:6px}
.difference-remote{background:var(--vscode-diffEditor-insertedTextBackground,#43a66326);border-left:3px solid var(--vscode-editorGutter-addedBackground,#3e9460);padding:6px}
.difference-context{font-size:.9em;opacity:.7;max-height:90px}.difference-sides pre{min-height:2em;margin:6px 0}
.difference-block h3{font-size:1em;margin:0}.difference-choice{font-weight:bold}.difference-sides button{max-width:100%;white-space:normal}
@media(max-width:850px){.variants{grid-template-columns:1fr}.layout{grid-template-columns:1fr}nav{max-height:180px;overflow:auto}}
@media(max-width:600px){.difference-sides{grid-template-columns:1fr}}
</style></head><body>
<header><h1>GitHub Sync conflict workbench</h1><span id="count" aria-live="polite"></span></header>
<p class="muted">Base is the actual ancestor (when available), Local is the captured source snapshot, and GitHub is the upstream version. A prepared result is a separate pending operation, not a fabricated ancestor. Review missing entities and all their members together. Save &amp; validate stores a candidate only; it does not change your knowledge or approve a push. Interrupted local application is revalidated on retry.</p>
<div class="toolbar"><button id="toggle-files" aria-expanded="true" aria-controls="files">Hide file tree</button><button id="previous">Previous</button><button id="next">Next</button><button id="refresh">Refresh</button><button id="apply">Review &amp; apply all…</button></div>
<p id="status" role="status" aria-live="polite">Loading conflict…</p><p id="error" class="error" role="alert"></p>
<div id="layout" class="layout"><nav id="files" aria-label="Conflict files"></nav><main id="detail"></main></div>
<script nonce="${esc(nonce)}" src="${esc(scriptUri.toString())}"></script></body></html>`;
}

export async function openGitHubSyncConflictWorkbench(
  context: vscode.ExtensionContext,
  targetId: string,
  options: WorkbenchOptions,
): Promise<void> {
  let targets = panels.get(context);
  if (!targets) { targets = new Map(); panels.set(context, targets); }
  const existing = targets.get(targetId);
  if (existing) {
    existing.options = options;
    existing.panel.reveal();
    if (options.initialPath) void existing.panel.webview.postMessage({ type: "navigate", path: options.initialPath });
    return;
  }
  const root = vscode.Uri.joinPath(context.extensionUri, "resources");
  const panel = vscode.window.createWebviewPanel("personalKnowledge.githubSyncConflictWorkbench", "GitHub Sync conflicts", vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true,
  });
  const entry = { panel, options };
  targets.set(targetId, entry);
  let disposed = false;
  let busy = false;
  let state: GitHubSyncWorkbenchState | undefined;
  const validated = new Map<string, string>();
  const fingerprint = (path: string) => JSON.stringify([
    state?.record.files.find(file => file.path === path)?.candidateSource,
    state?.files.find(file => file.path === path),
  ]);
  const publish = async (completed?: string, error?: string, actionPath?: string) => {
    const previousId = state?.record.id;
    const latest = await entry.options.getState();
    state = latest && { ...latest, files: latest.files.map(file => {
      const metadata = latest.record.files.find(entry => entry.path === file.path);
      return { ...file, comparison: !file.binary && metadata?.hasLocal && metadata.hasRemote
        ? githubSyncWorkbenchComparison(file.local ?? "", file.remote ?? "", file.merged ?? "") : undefined };
    }) };
    if (previousId !== state?.record.id) validated.clear();
    for (const [path, signature] of validated) if (fingerprint(path) !== signature) validated.delete(path);
    if (state && actionPath && ["save", "delete-local", "delete-remote"].includes(completed || "")) {
      validated.set(actionPath, fingerprint(actionPath));
    }
    if (!disposed) await panel.webview.postMessage({
      type: "state", state, validatedPaths: [...validated.keys()], completed, error, initialPath: entry.options.initialPath,
    });
  };
  const reportError = async (error: unknown) => {
    if (!disposed) await panel.webview.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
  };
  const receive = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (disposed) return;
    const request = message as GitHubSyncWorkbenchRequest;
    if ((message as { command?: string })?.command === "ready") {
      try { await publish(); } catch (error) { await reportError(error); }
      return;
    }
    if (busy) { await reportError(new Error("Another conflict action is still running.")); return; }
    busy = true;
    try {
      if (!request || !commands.has(request.command) || typeof request.conflictId !== "string" ||
          !Number.isSafeInteger(request.revision) || request.revision < 0) throw new Error("Invalid conflict request.");
      if ((request.source !== undefined && !["base", "local", "remote"].includes(request.source)) ||
          (request.content !== undefined && (request.command !== "save" || typeof request.content !== "string"))) {
        throw new Error("Invalid conflict source or content.");
      }
      if (!state || request.conflictId !== state.record.id ||
          request.revision !== ((state.record as GitHubSyncStoredConflict & { revision?: number }).revision ?? 0)) {
        throw new Error("This conflict changed. Refresh and review it again.");
      }
      const file = state.files.find(file => file.path === request.path);
      const metadata = state.record.files.find(file => file.path === request.path);
      const applied = !!(state.record as GitHubSyncStoredConflict & { appliedAt?: string }).appliedAt;
      if (applied && !["apply", "refresh", "compare"].includes(request.command)) {
        throw new Error("Decisions are already applied locally. Retry sync or refresh to check completion.");
      }
      if (!["refresh", "apply"].includes(request.command) && (!file || !metadata)) throw new Error("Unknown conflict file.");
      if (request.command === "choose" && (!["base", "local", "remote"].includes(request.source || "") ||
          !metadata?.[request.source === "base" ? "hasBase" : request.source === "local" ? "hasLocal" : "hasRemote"])) {
        throw new Error("That source is absent. Use an explicit deletion decision instead.");
      }
      if (request.command === "save" && (file?.binary ? request.content !== undefined : typeof request.content !== "string")) {
        throw new Error("Binary candidates cannot be edited; text saves require content.");
      }
      if (request.command === "save" && (["delete", "delete-local"].includes(metadata?.candidateSource || "") ||
          (file?.binary && metadata?.candidateSource === "unresolved"))) throw new Error("Choose a non-deletion result before saving.");
      if ((request.command === "delete-local" && !metadata?.hasLocal) ||
          (request.command === "delete-remote" && !metadata?.hasRemote)) throw new Error("That file is already absent on the selected side.");
      if (request.command === "agent" && (file?.binary || metadata?.candidateSource !== "unresolved" ||
          !["skill", "recipe"].includes(metadata?.type || ""))) throw new Error("Ask Agent supports unresolved text skills and recipes only.");
      if (request.command === "apply" && !applied && (!state.record.files.length || state.record.files.some(file =>
        file.candidateSource === "unresolved" || !validated.has(file.path)))) throw new Error("Save & validate every result before applying.");
      // Forward only the documented fields; the integration owns filesystem and stale-revision checks.
      await entry.options.perform({
        command: request.command, conflictId: request.conflictId, revision: request.revision,
        ...(file ? { path: file.path } : {}),
        ...(request.source ? { source: request.source } : {}),
        ...(request.content !== undefined ? { content: request.content } : {}),
      });
      if (request.path && ["choose", "agent"].includes(request.command)) validated.delete(request.path);
      await publish(request.command, undefined, request.path);
    } catch (error) {
      let detail = error instanceof Error ? error.message : String(error);
      try { await publish(); } catch (refreshError) {
        detail += `\nUnable to refresh conflict state: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`;
      }
      await reportError(new Error(detail));
    } finally { busy = false; }
  });
  const close = panel.onDidDispose(() => {
    disposed = true;
    targets!.delete(targetId);
    receive.dispose();
    close.dispose();
    const index = context.subscriptions.indexOf(panel);
    if (index >= 0) context.subscriptions.splice(index, 1);
  });
  context.subscriptions.push(panel);
  panel.webview.html = renderGitHubSyncWorkbenchHtml(panel.webview,
    panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "github-sync-workbench.js")), randomBytes(24).toString("hex"));
}
