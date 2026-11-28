import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { startBrowserHttpsListener } from "../dist/browser-https-listener.js";
import { createOriginalBrowserRoute } from "../dist/browser-original-owner.js";

const require = createRequire(import.meta.url);
const store = require("../legacy/dist/knowledge/filestore.js");
const { bindOriginalBrowserNotes } = require("../legacy/dist/runtime/pkm-browser-original-notes.js");

test("detached HTTPS serves the exact ordinary Notes Webview against Original files while Chat remains pinned", async t => {
  const root = join(import.meta.dirname, `.browser-original-notes-tls-${randomUUID()}`);
  await mkdir(join(root, "notes"), { recursive: true, mode: 0o700 });
  t.after(() => rm(root, { force: true, recursive: true }));
  const keyFile = join(root, "key.pem"), certFile = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=pkm.test", "-addext", "subjectAltName=DNS:pkm.test", "-keyout", keyFile, "-out", certFile],
  { stdio: "pipe" });
  const tls = { key: await readFile(keyFile), cert: await readFile(certFile) };
  store.setStorePath(root);
  store.noteUpsert({ slug: "Existing", title: "Existing", type: "general", tags: [], content: "Desktop Original body" });
  const token = randomUUID(), chatId = randomUUID();
  let allowed = true, transcriptCalls = 0;
  const assertCurrent = () => { if (!allowed) throw Error(`private diagnostic ${root}`); };
  const binding = {
    token, transcriptOnly: true, detachedChatId: chatId,
    grant: { actorId: "browser", workspaceRoot: root, generation: "fixture", chatHostId: randomUUID() },
    assertCurrent,
    originalNotes: bindOriginalBrowserNotes({ root, expiresAt: Date.now() + 60_000, allowWrite: true,
      assertCurrent, withWriter: work => work() }),
    async readChatTranscript(_grant, input) {
      transcriptCalls++;
      assert.equal(input.chatId, chatId);
      return { chatId, start: 0, total: 1, nextCursor: null,
        messages: [{ id: "original-reply", role: "assistant", content: "Pinned Original reply", status: "complete" }] };
    },
  };
  const previous = process.env.PKM_BROWSER_WEBVIEW_DIR;
  process.env.PKM_BROWSER_WEBVIEW_DIR = resolve(import.meta.dirname, "../legacy/dist/webview");
  let handler, chatOnly, readOnly;
  const listener = await startBrowserHttpsListener({ address: "127.0.0.1", port: 0, tls,
    route: (req, res) => handler(req, res) });
  t.after(() => listener.close());
  const origin = `https://127.0.0.1:${listener.port}`;
  try {
    handler = await createOriginalBrowserRoute(binding, { allowDevelopment: true, httpsOrigin: origin });
    const { originalNotes: _notes, ...withoutNotes } = binding;
    chatOnly = await createOriginalBrowserRoute(withoutNotes, { allowDevelopment: true, httpsOrigin: origin });
    readOnly = await createOriginalBrowserRoute({ ...binding,
      originalNotes: bindOriginalBrowserNotes({ root, expiresAt: Date.now() + 60_000, allowWrite: false,
        assertCurrent, withWriter: work => work() }),
    }, { allowDevelopment: true, httpsOrigin: origin });
  } finally {
    if (previous === undefined) delete process.env.PKM_BROWSER_WEBVIEW_DIR;
    else process.env.PKM_BROWSER_WEBVIEW_DIR = previous;
  }
  const request = (path, body, cookie) => new Promise((ok, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port: listener.port, servername: "pkm.test", ca: tls.cert,
      path, agent: false, method: body === undefined ? "GET" : "POST",
      headers: { host: new URL(origin).host, origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) } }, res => {
      const chunks = [];
      res.on("data", bytes => chunks.push(bytes));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const session = await request("/webview/session", { token, remember: false });
  assert.equal(session.status, 200);
  const cookie = session.headers["set-cookie"][0].split(";")[0];
  const panel = await request("/webview/", undefined, cookie);
  assert.equal(panel.status, 200);
  assert.match(panel.body, /id="pkm-original-browser"/);
  assert.match(panel.body, /data-notes-access="write"/);
  const send = async input => {
    const reply = await request("/webview/message", input, cookie);
    return { ...reply, value: JSON.parse(reply.body) };
  };
  assert.equal((await send({ command: "list", q: "Desktop Original", caseSensitive: false })).value.total, 1);
  const item = (await send({ command: "detail", path: "Existing.md" })).value;
  assert.equal(item.content, "Desktop Original body");
  assert.ok(item.editPin);
  const edit = { command: "updateNote", operationId: randomUUID(), ...item.editPin, content: "HTTPS Original body" };
  assert.equal((await send(edit)).status, 200);
  assert.equal(store.noteGet("Existing").content, "HTTPS Original body");
  assert.equal((await send(edit)).status, 200);
  const create = { command: "saveNote", operationId: randomUUID(), title: "Created", category: "Browser",
    type: "general", tags: [], content: "Created in the same store" };
  assert.equal((await send(create)).status, 200);
  assert.equal(store.noteGet("Browser/Created").content, create.content);
  assert.equal((await send({ ...create, operationId: randomUUID() })).status, 409);
  const chats = (await send({ command: "chatList" })).value.items;
  assert.deepEqual(chats, [{ id: chatId, title: "Shared Original Chat" }]);
  assert.equal((await send({ command: "chatMessages", id: randomUUID() })).status, 409);
  assert.equal(transcriptCalls, 1);
  assert.equal((await send({ command: "chatMessages", id: chatId })).value.messages[0].content, "Pinned Original reply");
  assert.equal(transcriptCalls, 2);
  allowed = false;
  const revoked = await send({ command: "detail", path: "Existing.md" });
  assert.equal(revoked.status, 503);
  assert.ok(!revoked.body.includes(root));
  allowed = true;
  const runBrowser = mode => new Promise((ok, reject) => {
    const child = spawn(process.env.PYTHON || "python3", ["-B", join(import.meta.dirname, "browser-original-notes.py")], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }, timeout: 30_000,
    });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { output += bytes; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? ok() : reject(new Error(output || `Browser exited ${code}`)));
    child.stdin.end(JSON.stringify({ origin, token, mode }));
  });
  await runBrowser("write");
  assert.equal(store.noteGet("UI Note").content, "Edited in the actual Original Webview");
  handler = readOnly;
  await runBrowser("read");
  // The same detached Chat without Notes consent must retain its Chat-only landing.
  handler = chatOnly;
  const chatSession = await request("/webview/session", { token, remember: false });
  const chatCookie = chatSession.headers["set-cookie"][0].split(";")[0];
  const landing = await request("/webview/", undefined, chatCookie);
  assert.equal(landing.status, 303);
  assert.equal(landing.headers.location, "/webview/chat");
  assert.equal((await request("/webview/message", { command: "list", q: "", caseSensitive: false }, chatCookie)).status, 409);
});
