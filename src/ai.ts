import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";
import { getStorePath } from "./filestore";
import { scriptGet } from "./storage";

// ── AI Summary for scripts ──────────────────────────────────────────────────
// ── AI backends ─────────────────────────────────────────────────────────────
export interface AiBackend { id: string; label: string; kind: "copilot" | "azure-openai" | "openai-compatible"; model: string; }

/** Scan for available AI backends: live Copilot models + configured HTTP endpoints. */
export async function listAiBackends(context: vscode.ExtensionContext): Promise<AiBackend[]> {
  const out: AiBackend[] = [];

  // Copilot — enumerate the actual models the VS Code LM API offers
  const lm = (vscode as any).lm;
  if (lm?.selectChatModels) {
    try {
      const models = await lm.selectChatModels({ vendor: "copilot" });
      for (const m of models || []) {
        out.push({ id: `copilot:${m.id}`, label: `Copilot · ${m.name || m.id}`, kind: "copilot", model: m.id });
      }
    } catch { /* Copilot not available */ }
  }

  // HTTP backends — available when an endpoint + API key are configured
  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const endpoint = cfg.get<string>("aiEndpoint")?.trim();
  const model = cfg.get<string>("aiModel")?.trim() || "gpt-4o-mini";
  const backend = cfg.get<string>("aiBackend");
  const key = await context.secrets.get("personalKnowledge.aiApiKey");
  if (endpoint && key) {
    if (backend === "azure-openai")
      out.push({ id: `azure:${model}`, label: `Azure OpenAI · ${model}`, kind: "azure-openai", model });
    else
      out.push({ id: `openai:${model}`, label: `OpenAI-compatible · ${model}`, kind: "openai-compatible", model });
  } else if (endpoint) {
    // Endpoint set but no key — surface as needing configuration
    const kind = backend === "azure-openai" ? "azure-openai" : "openai-compatible";
    out.push({ id: `${kind}:${model}:needkey`, label: `${kind === "azure-openai" ? "Azure OpenAI" : "OpenAI-compatible"} · ${model} (set API key)`, kind, model });
  }
  return out;
}

/** Run a prompt against a specific backend and return the text response. */
export async function runAiPrompt(context: vscode.ExtensionContext, backend: AiBackend, prompt: string): Promise<string> {
  if (backend.kind === "copilot") {
    const lm = (vscode as any).lm;
    if (!lm?.selectChatModels) throw new Error("Language Model API unavailable (needs VS Code 1.90+ with Copilot).");
    let models = await lm.selectChatModels({ vendor: "copilot", id: backend.model });
    if (!models?.length) models = await lm.selectChatModels({ vendor: "copilot" });
    const model = models?.[0];
    if (!model) throw new Error("No Copilot chat model available. Sign in to GitHub Copilot.");
    const messages = [ (vscode as any).LanguageModelChatMessage.User(prompt) ];
    const resp = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let out = ""; for await (const chunk of resp.text) out += chunk;
    return out.trim();
  }

  // HTTP backends (Azure OpenAI / OpenAI-compatible)
  const cfg = vscode.workspace.getConfiguration("personalKnowledge");
  const endpoint = (cfg.get<string>("aiEndpoint") ?? "").trim().replace(/\/$/, "");
  const apiKey = await context.secrets.get("personalKnowledge.aiApiKey");
  if (!endpoint) throw new Error("No AI endpoint configured (personalKnowledge.aiEndpoint).");
  if (!apiKey) throw new Error('No API key set. Run "Personal Knowledge Manager: Set AI API Key".');

  let url: string; const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (backend.kind === "azure-openai") {
    const ver = cfg.get<string>("aiAzureApiVersion") || "2024-06-01";
    url = `${endpoint}/openai/deployments/${backend.model}/chat/completions?api-version=${ver}`;
    headers["api-key"] = apiKey;
  } else {
    url = `${endpoint}/chat/completions`;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const body = { model: backend.model, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 700 };
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`Endpoint returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const j: any = await resp.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

// ── AI Summary for scripts ──────────────────────────────────────────────────
/** Per-script cache directory under scripts/.ai-cache/<sanitized-path>/ */
export function scriptCacheDir(relPath: string): string {
  const slug = relPath.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(getStorePath(), "scripts", ".ai-cache", slug);
}

export async function aiSummarizeScript(
  context: vscode.ExtensionContext, relPath: string, backendId?: string, cacheOnly = false
): Promise<{ summary?: string; cached?: boolean; error?: string; backend?: string; miss?: boolean }> {
  const r = scriptGet(relPath);
  if (!r) return cacheOnly ? { miss: true } : { error: `Script not found: ${relPath}` };

  // Resolve the backend: requested id, else first available
  const backends = await listAiBackends(context);
  if (!backends.length) {
    return cacheOnly ? { miss: true } : { error: "No AI backend available. Enable Copilot, or set an endpoint + API key in Settings." };
  }
  const backend = backends.find(b => b.id === backendId) ?? backends[0];
  if (backend.id.endsWith(":needkey")) {
    return cacheOnly ? { miss: true } : { error: 'API key not set. Run "Personal Knowledge Manager: Set AI API Key".', backend: backend.label };
  }

  // Cache key includes the backend id so switching model/provider regenerates.
  // Files live in a per-script subfolder so they can be removed on delete/edit.
  const hash = createHash("sha256").update(backend.id + "\0" + r.content).digest("hex").slice(0, 16);
  const cacheDir = scriptCacheDir(relPath);
  const cacheFile = path.join(cacheDir, `${hash}.md`);
  if (fs.existsSync(cacheFile)) {
    return { summary: fs.readFileSync(cacheFile, "utf-8"), cached: true, backend: backend.label };
  }
  // Cache-only peek (used when opening a script): don't call the AI on a miss
  if (cacheOnly) return { miss: true, backend: backend.label };

  const prompt = [
    `You are analyzing a data-processing script written in: ${r.lang}.`,
    `File: ${r.path}`,
    ``,
    `Produce a concise Markdown summary with these sections:`,
    `- **Purpose**: what this script does (1-2 sentences)`,
    `- **How it works**: key steps / data flow`,
    `- **Inputs**: source streams/tables/files it reads`,
    `- **Output**: what it produces and where`,
    `- **Potential issues**: correctness, performance, or maintenance concerns`,
    ``,
    `Keep it under 250 words. Here is the script:`,
    ``,
    "```",
    r.content.slice(0, 24000),
    "```",
  ].join("\n");

  try {
    const out = await runAiPrompt(context, backend, prompt);
    if (!out) return { error: "The model returned an empty response.", backend: backend.label };
    // Prepend a machine-readable header noting which backend produced this
    const withHeader = `<!-- backend: ${backend.id} | generated: ${new Date().toISOString()} -->\n\n${out}`;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, withHeader);
    return { summary: withHeader, cached: false, backend: backend.label };
  } catch (e: any) {
    return { error: `AI request failed: ${e?.message ?? e}`, backend: backend.label };
  }
}


