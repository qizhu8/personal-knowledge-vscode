import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initialize } from "../dist/storage.js";

export const invocation = (operation, args) => ({ operation, version: 1, arguments: args });
export async function until(read, predicate = Boolean, message = "CLI fixture deadline exceeded") {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
export async function cliFixture(t, options = {}) {
  const root = resolve(import.meta.dirname, `.batch07-cli-${randomUUID()}`);
  const workspace = resolve(root, "workspace"), configPath = resolve(root, "host.json");
  await mkdir(root, { mode: 0o700 });
  await initialize(workspace);
  const identity = JSON.parse(await readFile(resolve(workspace, ".pkm-next-workspace"), "utf8"));
  const requests = [], children = [], sockets = new Set();
  const providerSecret = `synthetic-provider-${randomUUID()}`, token = `synthetic-machine-${randomUUID()}`;
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${providerSecret}`);
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push(payload);
      if (options.respond) return await options.respond(payload, response, requests);
      const toolResult = payload.messages.at(-1)?.role === "tool";
      const user = payload.messages.find(message => message.role === "user")?.content ?? "";
      if (user === "redirect") {
        response.writeHead(302, { location: "/redirect-target" }); response.end(); return;
      }
      if (user === "hold") { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); return; }
      const delta = toolResult ? { content: "Local socket answer." } : {
        tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: {
          name: "knowledge_document_create",
          arguments: JSON.stringify({ id: `document-${user}`, title: "Synthetic <img src=x onerror=evil()>",
            content: `Local socket content ${user}.` }),
        } }],
      };
      sendSse(response, delta, toolResult ? "stop" : "tool_calls");
    } catch { response.writeHead(500); response.end("Synthetic fixture failed."); }
  });
  provider.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  const config = { schema: "pkm.native-host-config/v1", provider: "openai-compatible", endpoint,
    secretRef: "secret:synthetic/provider", model: "synthetic-model", contextWindow: 131072,
    maxOutputTokens: 8192, outputTokenParameter: "max_tokens", includeUsage: true, tools: ["knowledge.document.create"] };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  t.after(async () => {
    for (const child of children) await child.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  async function launch(extra = [], configured = true) {
    const args = ["dist/cli.js", "http", "--data", workspace, "--port", "0"];
    if (configured) args.push("--config", configPath, "--allow-provider", config.provider,
      "--allow-endpoint", endpoint, "--allow-model", config.model, "--allow-tool", config.tools[0],
      "--secret-ref", `${config.secretRef}=PKM_SYNTHETIC_PROVIDER`, "--allow-insecure-loopback");
    args.push(...extra);
    const process = spawn(globalThis.process.execPath, args, { cwd: resolve(import.meta.dirname, ".."),
      env: { ...globalThis.process.env, PKM_NEXT_TOKEN: token, PKM_SYNTHETIC_PROVIDER: providerSecret, TMPDIR: root },
      stdio: ["pipe", "pipe", "pipe"] });
    const lines = [], diagnostics = [];
    let stdout = "", stderr = "", stderrText = "";
    const collect = (bytes, channel) => {
      if (channel === "stdout") stdout += bytes;
      else stderr += bytes;
      let text = channel === "stdout" ? stdout : stderr, index;
      while ((index = text.indexOf("\n")) !== -1) {
        const line = text.slice(0, index); text = text.slice(index + 1);
        try { (channel === "stdout" ? lines : diagnostics).push(JSON.parse(line)); } catch { /* SQLite diagnostic. */ }
      }
      if (channel === "stdout") stdout = text; else stderr = text;
    };
    process.stdout.on("data", bytes => collect(bytes.toString(), "stdout"));
    process.stderr.on("data", bytes => {
      stderrText += bytes.toString().replaceAll(providerSecret, "[redacted]").replaceAll(token, "[redacted]")
        .replaceAll(config.secretRef, "[redacted]").replaceAll(endpoint, "[redacted]");
      collect(bytes.toString(), "stderr");
    });
    let exited = false;
    const closed = new Promise(resolve => { process.once("close", (code, signal) => { exited = true; resolve({ code, signal }); }); });
    const child = { process, lines, diagnostics, closed, async stop() {
      if (!exited) process.kill("SIGTERM");
      const timer = setTimeout(() => { if (!exited) process.kill("SIGKILL"); }, 5000);
      await closed; clearTimeout(timer);
    }, send(value) { process.stdin.write(JSON.stringify(value) + "\n"); } };
    children.push(child);
    const ready = await until(() => {
      if (exited) throw new Error(`CLI exited before readiness: ${stderrText}`);
      return lines.find(line => line.ready && line.url);
    });
    child.url = ready.url;
    child.rpc = async (method, body) => {
      const response = await fetch(`${child.url}/v1/${method}`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await child.rpc("server_info", {})).status, 200, "Actual CLI socket responsive");
    return child;
  }
  return { root, workspace, identity, configPath, config, endpoint, providerSecret, token, requests, launch };
}
export function sendSse(response, delta, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`
    + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":100}}\n\ndata: [DONE]\n\n');
}
