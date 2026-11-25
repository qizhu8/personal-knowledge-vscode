import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { compatibilityMcpFixture, compatibilityMcpValue } from "./compatibility-mcp-fixture.mjs";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

export const value = compatibilityMcpValue;
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const shape = result => Object.keys(result).sort();
const recordedValue = response => response.isError
  ? response.structuredContent ?? { errorText: response.content.filter(part => part.type === "text").map(part => part.text).join("") }
  : value(response);

export async function todoBasicFixture(t) {
  assert(process.env.PKM_TEST_WORKSPACE, "Run through the existing isolated test framework.");
  assert(process.env.PKM_TEST_PYTHON, "Use the exact business Python interpreter.");
  const extension = process.env.PKM_COMPATIBILITY_EXTENSION || resolve("../personal-knowledge-vscode");
  const require = createRequire(join(extension, "package.json"));
  let oracle, oracleRoot;
  const f = await compatibilityMcpFixture(t, { setup: async ({ base }) => {
    const directory = join(base, "todo-oracle");
    await mkdir(directory, { mode: 0o700 });
    oracle = pinnedOriginalKnowledgeWriterFixture({
      directory, legacyVsix: process.env.PKM_LEGACY_VSIX, python: process.env.PKM_TEST_PYTHON,
    });
    oracleRoot = join(directory, "library");
    await mkdir(join(oracleRoot, "notes", "Acceptance"), { recursive: true, mode: 0o700 });
  } });
  t.after(async () => {
    await assert.rejects(stat(f.base), { code: "ENOENT" });
    t.diagnostic("Todo owned fixture, copied oracle, generated runtime and retained mutation-lock helper were removed.");
  });
  const title = `TodoBasic${randomUUID().replaceAll("-", "")}`, slug = `Acceptance/${title}`;
  const notePath = join(f.root, "notes", `${slug}.md`);
  const boardPath = join(f.root, "notes", `${slug}.assets`, "pkm-todo-board.json");
  const trace = [];
  async function describe(client, leaf) {
    const id = `mcp.tool.${leaf}`;
    const response = await client.callTool({ name: "capabilities_describe", arguments: { operation: id } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const contract = value(response);
    assert.equal(contract.id, id);
    assert.equal(contract.version, 1);
    assert.equal(contract.transportName, leaf);
    return contract;
  }
  const contracts = new Map();
  async function discover(client, leaves) {
    for (const leaf of leaves) contracts.set(leaf, await describe(client, leaf));
    return contracts;
  }
  async function call(client, stage, leaf, args) {
    const contract = contracts.get(leaf);
    assert(contract, `Discover the actual original ${leaf} contract before invocation.`);
    const response = await client.callTool({
      name: contract.readOnly ? "capability_read" : "capability_call",
      arguments: { operation: contract.id, version: contract.version, arguments: args },
    });
    const result = recordedValue(response);
    trace.push({ stage, operation: contract.id, lane: contract.readOnly ? "capability_read" : "capability_call",
      argumentsSha256: hash(JSON.stringify(args)), isError: response.isError === true,
      fields: shape(result), ...(result.digest ? { digest: result.digest } : {}) });
    return response;
  }
  async function successful(client, stage, leaf, args) {
    const response = await call(client, stage, leaf, args);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const result = value(response);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, undefined, JSON.stringify(result));
    return result;
  }
  async function snapshot() {
    const note = await readFile(notePath), board = await readFile(boardPath);
    const noteStat = await stat(notePath), boardStat = await stat(boardPath);
    const oracleNote = join(oracleRoot, "notes", `${slug}.md`);
    const oracleBoard = join(oracleRoot, "notes", `${slug}.assets`, "pkm-todo-board.json");
    await writeFile(oracleNote, note, { mode: 0o600 });
    await mkdir(join(oracleRoot, "notes", `${slug}.assets`), { recursive: true, mode: 0o700 });
    await writeFile(oracleBoard, board, { mode: 0o600 });
    await utimes(oracleNote, noteStat.atime, noteStat.mtime);
    await utimes(oracleBoard, boardStat.atime, boardStat.mtime);
    const original = oracle.run(oracleRoot, `
      return { note: store.noteGet(input.slug), snapshot: store.noteWorkItemsRead(input.slug) };
    `, { slug });
    assert.equal(original.snapshot.digest, hash(board));
    assert.equal(original.note.boardDigest, hash(board));
    assert.deepEqual(original.snapshot.items, JSON.parse(board).items);
    return { note, board, original };
  }
  function assertMetadata(before, after) {
    const { boardDigest: beforeDigest, updated_at: beforeUpdated, ...beforeStable } = before.original.note;
    const { boardDigest: afterDigest, updated_at: afterUpdated, ...afterStable } = after.original.note;
    assert.deepEqual(afterStable, beforeStable);
    assert.equal(beforeDigest, hash(before.board));
    assert.equal(afterDigest, hash(after.board));
    assert(Date.parse(afterUpdated) >= Date.parse(beforeUpdated));
  }
  function currentRead(leaf, args) {
    const result = execFileSync(process.execPath, ["-e", `
      const net = require("node:net");
      net.connect = net.createConnection = () => { throw new Error("Todo oracle network access is forbidden."); };
      const path = require("node:path"), root = process.argv[2], extension = process.argv[1];
      const store = require(path.join(extension, "dist/knowledge/filestore.js"));
      const { todoApiDefinitions } = require(path.join(extension, "dist/knowledge/todo-api-contract.js"));
      const { callTodoApi } = require(path.join(extension, "dist/knowledge/todo-api.js"));
      const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (!todoApiDefinitions.find(api => api.name === input.leaf)?.readOnly) throw new Error("Read-only oracle only.");
      store.setStorePath(root);
      const actor = store.noteWorkItemExternalActor(input.args.board_slug || "");
      console.log(JSON.stringify(callTodoApi(input.leaf, input.args, actor)));
    `, extension, f.root], { cwd: f.base, input: JSON.stringify({ leaf, args }), encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: join(f.base, "home"), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result);
  }
  async function readParity(client, original, stage, leaf, args) {
    const actual = await call(client, stage, leaf, args);
    const direct = await call(original, `${stage}-original`, leaf, args);
    assert.deepEqual(actual, direct, `${leaf} must preserve every actual original MCP field.`);
    assert.notEqual(actual.isError, true, JSON.stringify(actual));
    const result = value(actual);
    assert.deepEqual(result, currentRead(leaf, args), `${leaf} must match the current actual original read-only API.`);
    return result;
  }
  async function holdMutation() {
    const { withCrossProcessLock } = require(join(extension, "dist/runtime/cross-process-lock.js"));
    await mkdir(join(f.root, ".pkm/state"), { recursive: true, mode: 0o700 });
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const lock = withCrossProcessLock(join(f.root, ".pkm/state/markdown-assets.lock"),
      "isolated-todo-basic-cancel", 5000, async () => { enter(); await gate; });
    const close = async () => { release(); await lock; };
    f.retainCleanup(close);
    await entered;
    return { close };
  }
  async function assertOriginalOwnership() {
    const entries = await readdir(f.root);
    for (const forbidden of ["core.sqlite", ".pkm-next-workspace", "boards"])
      assert(!entries.includes(forbidden), `Compatibility must not create ${forbidden}.`);
    assert.deepEqual(JSON.parse(await readFile(boardPath)).workers || {}, {}, "No worker grants are created.");
  }
  return { ...f, title, slug, notePath, boardPath, contracts, trace, discover, call, successful, snapshot,
    currentRead, readParity, holdMutation, assertOriginalOwnership, assertMetadata, oracle };
}
