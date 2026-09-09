import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getStorePath } from "./filestore";
import { resolveMcpPython } from "./mcp";

export interface PromptManagerAnalysis {
  available: boolean;
  pending?: boolean;
  format: string;
  syntaxValid: boolean;
  syntaxError: string;
  variables: string[];
  lineCount: number;
  charCount: number;
  chatTemplate: boolean;
  relatedFiles: string[];
  templateTree: PromptTemplateNode[];
  missingTemplates: string[];
}

export interface PromptTemplateNode {
  file: string;
  exists: boolean;
  selected: boolean;
  cycle: boolean;
  extends?: string;
  inheritedPlaceholders: string[];
  introducedVariables: string[];
  effectiveVariables: string[];
  children: PromptTemplateNode[];
}

export interface PromptIdentity { project: string; task: string; version: string; file: string; }

const promptAnalysisCache = new Map<string, { signature: string; analysis: PromptManagerAnalysis }>();
const promptAnalysisPending = new Map<string, Promise<PromptManagerAnalysis>>();

function resolvePromptPath(identity: PromptIdentity): string {
  const root = path.resolve(getStorePath(), "prompts");
  const target = path.resolve(root, identity.project, identity.task, identity.version, identity.file);
  if (!target.startsWith(root + path.sep)) throw new Error("Prompt path escapes the Prompt library.");
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error("Prompt file was not found.");
  return target;
}

function promptAnalysisKey(identity: PromptIdentity): string {
  return [identity.project, identity.task, identity.version, identity.file].join("|");
}

function promptVersionSignature(identity: PromptIdentity): string {
  const directory = path.dirname(resolvePromptPath(identity));
  return fs.readdirSync(directory).sort().map(name => {
    const target = path.join(directory, name);
    const stat = fs.statSync(target);
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
}

function invokePromptManager(extensionPath: string, payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    let python: string;
    try { python = resolveMcpPython(); }
    catch (error: any) { reject(new Error(error?.message || String(error))); return; }
    const bridge = path.join(extensionPath, "resources", "prompt_manager_bridge.py");
    const child = spawn(python, [bridge], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); callback(); };
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error("Prompt Manager timed out after 10 seconds."))); }, 10000);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", error => finish(() => reject(error)));
    child.on("close", code => finish(() => {
      try {
        const response = JSON.parse(stdout || "{}");
        if (code !== 0 || !response.ok) reject(new Error(response.error || stderr.trim() || "Prompt Manager failed."));
        else resolve(response.data);
      } catch (error: any) { reject(new Error(stderr.trim() || error?.message || "Prompt Manager returned invalid JSON.")); }
    }));
    child.stdin.end(JSON.stringify(payload));
  });
}

export function inspectPrompt(extensionPath: string, identity: PromptIdentity): Promise<PromptManagerAnalysis> {
  return invokePromptManager(extensionPath, { action: "inspect", path: resolvePromptPath(identity) });
}

export function cachedPromptAnalysis(identity: PromptIdentity): PromptManagerAnalysis | undefined {
  const cached = promptAnalysisCache.get(promptAnalysisKey(identity));
  if (!cached) return undefined;
  try { return cached.signature === promptVersionSignature(identity) ? cached.analysis : undefined; }
  catch { return undefined; }
}

export function inspectPromptCached(extensionPath: string, identity: PromptIdentity): Promise<PromptManagerAnalysis> {
  const key = promptAnalysisKey(identity);
  const cached = cachedPromptAnalysis(identity);
  if (cached) return Promise.resolve(cached);
  const pending = promptAnalysisPending.get(key);
  if (pending) return pending;
  const signature = promptVersionSignature(identity);
  const analysis = inspectPrompt(extensionPath, identity).then(result => {
    if (promptVersionSignature(identity) === signature) promptAnalysisCache.set(key, { signature, analysis: result });
    return result;
  }).finally(() => promptAnalysisPending.delete(key));
  promptAnalysisPending.set(key, analysis);
  return analysis;
}

export function renderPrompt(extensionPath: string, identity: PromptIdentity, context: Record<string, unknown>, mode: "completion" | "chat"): Promise<any> {
  return invokePromptManager(extensionPath, { action: "render", path: resolvePromptPath(identity), context, mode });
}