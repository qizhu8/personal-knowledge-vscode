import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createLegacyApiChatLocalProvider } from "../dist/legacy-api-chat-local-provider.js";
const require = createRequire(import.meta.url);
const { image } = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
test("native loopback provider sends real PNG bytes and decodes fragmented UTF-8/CRLF SSE; incomplete results fail closed", async t => {
  let mode = "ok", calls = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer private-synthetic");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${image.dataBase64}`);
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "incomplete") { response.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'); return; }
      const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"真实 PNG response"},"finish_reason":null}]}\r\n\r\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
      for (let i = 0; i < bytes.length; i++) {
        response.write(bytes.subarray(i, i + 1));
        if (i % 5 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      response.end();
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const provider = createLegacyApiChatLocalProvider({ endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "private-synthetic", model: "private" });
  const messages = [{ role: "user", content: "Inspect this PNG.", images: [image] }];
  assert.equal(await provider(messages, new AbortController().signal), "真实 PNG response");
  mode = "incomplete";
  await assert.rejects(provider(messages, new AbortController().signal), /without a complete result/);
  assert.equal(calls, 2);
  assert.throws(() => createLegacyApiChatLocalProvider({ endpoint: "https://example.invalid/v1", apiKey: "unused", model: "private" }), /private loopback/);
});
