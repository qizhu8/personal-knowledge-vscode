import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initialize } from "../dist/storage.js";
import { serializeTodoBoard } from "../dist/domain/todo-board.js";
import { legacyManagedFixture, closeLegacyManagedFixture } from "./legacy-managed-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
for (const profile of ["compact", "legacy"]) test(`original Note item read/discovery transport (${profile})`,
  { timeout: 60_000 }, async t => {
    const parent = await mkdtemp(join(tmpdir(), "pkm-native-read-"));
    let client;
    t.after(async () => { try { await client?.close(); } finally { await rm(parent, { recursive: true, force: true }); } });
    const data = await initialize(join(parent, "workspace"));
    const managed = await legacyManagedFixture(parent);
    const item = { id: "task", title: "Verify", state: "Planning", goal: "Observe", scope: "API", acceptance: ["Checked"], evidence: [] };
    await writeFile(join(data, "notes", "Inline.md"),
      `---\ntitle: Inline\n---\n\`\`\`pkm-work-item\n${JSON.stringify(item)}\n\`\`\`\n`);
    await mkdir(join(data, "notes", "Board.assets"), { recursive: true });
    await writeFile(join(data, "notes", "Board.md"), "---\ntitle: Board\ndocumentKind: todo-board\n---\nManual content\n");
    await writeFile(join(data, "notes", "Board.assets", "pkm-todo-board.json"), serializeTodoBoard([item], {}));
    const original = (operation, path, extra = {}) => JSON.parse(execFileSync(process.execPath, [
      join(repository, "resources/knowledge_mutations.js"), repository, data,
    ], { input: JSON.stringify({ operation, area: "notes", path, ...extra }), encoding: "utf8" }));
    for (let restart = 0; restart < 2; restart++) {
      client = new Client({ name: "original-native-reads", version: "1.0.0" });
      await client.connect(new StdioClientTransport({ command: "python3",
        args: [join(root, "compat/legacy-compact-mcp.py"), "--data", data, "--node", process.execPath, "--managed-generation", managed],
        env: { ...process.env, PKM_CAPABILITY_PROFILE: profile, PYTHONDONTWRITEBYTECODE: "1" }, stderr: "pipe" }));
      const read = async (name, args, expected) => {
        const direct = await client.callTool({ name, arguments: args });
        assert.notEqual(direct.isError, true, JSON.stringify(direct));
        assert.deepEqual(direct.structuredContent, expected);
        const deferred = await client.callTool({ name: "capability_read", arguments: {
          operation: `mcp.tool.${name}`, version: 1, arguments: args,
        } });
        assert.deepEqual(deferred, direct);
      };
      for (const slug of ["Inline", "Board"])
        await read("note_work_items", { slug }, original("work-items-read", `${slug}.md`));
      await read("note_work_item_notes", {}, original("work-item-notes", "_discovery.md", { query: "", limit: 20 }));
      const spoof = await client.callTool({ name: "note_work_items", arguments: { slug: "Inline", actorId: "user:local" } });
      assert.equal(spoof.isError, true);
      const traversal = await client.callTool({ name: "note_work_items", arguments: { slug: "../outside" } });
      assert.equal(traversal.isError, true);
      await closeLegacyManagedFixture(client);
    }
  });
