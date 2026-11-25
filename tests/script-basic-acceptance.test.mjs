import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { scriptBasicFixture, resultValue, sha256 } from "./script-basic-fixture.mjs";
import { originalScriptWorkerFixture } from "./script-original-worker-fixture.mjs";

const invoke = (client, operation, args) => client.callTool({
  name: "capability_read", arguments: { operation: `mcp.tool.${operation}`, version: 1, arguments: args },
});
async function successful(response) {
  const result = await response;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return resultValue(result);
}
const keys = value => Object.keys(value).sort();

test("Script readonly original IDs and actual original/v5 MCP offline retrieval refusal match exactly without a false positive", { timeout: 120000 }, async t => {
  const f = await scriptBasicFixture(t), { client: original } = await f.connect(true), { client } = await f.connect();
  const version = await successful(client.callTool({ name: "check_version", arguments: {} }));
  assert.equal(version.backend.operations, 151);
  const tools = (await client.listTools()).tools;
  for (const [name, alias] of [["get_script", "script_read"], ["search_scripts", "script_search"]]) {
    const contract = await successful(client.callTool({ name: "capabilities_describe",
      arguments: { operation: `mcp.tool.${name}` } }));
    assert.equal(contract.id, `mcp.tool.${name}`);
    assert.equal(contract.readOnly, true);
    assert.equal(tools.find(tool => tool.name === alias).annotations.readOnlyHint, true);
  }
  assert(!tools.some(tool => ["script_write", "script_modify", "script_execute"].includes(tool.name)));
  for (const query of ["scriptbasicfilenamesentinel", "scriptbasicbodysentinelold", "scriptbasicprivatesentinel", "scriptbasicabsentmarker"]) {
    const args = { query, route: "lexical", detail: "legacy", limit: 5 };
    const actual = await invoke(client, "search_scripts", args);
    assert.deepEqual(actual, await invoke(original, "search_scripts", args));
    assert.deepEqual(resultValue(actual), { ok: false, error: "Subscriber retrieval worker unavailable" });
    assert.deepEqual(actual, await client.callTool({ name: "script_search", arguments: args }));
  }
  const snapshot = await f.snapshot(1), id = snapshot.documents[0].source_id;
  const actual = await invoke(client, "get_script", { id });
  assert.deepEqual(actual, await invoke(original, "get_script", { id }));
  assert.deepEqual(actual, await client.callTool({ name: "script_read", arguments: { id } }));
  assert.equal(resultValue(actual).ok, false, JSON.stringify(actual));
  assert(!JSON.stringify(actual).includes(f.first));
  t.diagnostic(`Negative MCP evidence only: original/v5 get_script=${JSON.stringify(resultValue(actual))}; search_scripts requires the original attached retrieval worker. No normal MCP search/get positive is claimed.`);
  await f.close(original); await f.close(client);
  assert(!(await readdir(f.root)).includes("core.sqlite"), "Compatibility must preserve original storage ownership.");
});

test("Script pinned original reader and Source Python lexical search/get preserve canonical ID, exact bytes, hash, provenance and refresh with stale-generation refusal and private corpus exclusion", { timeout: 120000 }, async t => {
  const f = await scriptBasicFixture(t), snapshot = await f.snapshot(1);
  const privateFile = join(f.root, "scripts", f.privatePath), privateBefore = f.privateInitial;
  const args = { query: "scriptbasicbodysentinelold", route: "lexical", detail: "standard", limit: 5 };
  const searched = await f.lexical(snapshot, "search_scripts", args);
  assert.equal(searched.ok, true, JSON.stringify(searched));
  assert.equal(searched.search_mode, "lexical");
  assert.equal(searched.semantic_status, "off");
  assert.equal(searched.model_invoked, false);
  assert.equal(searched.hits.length, 1, "Empty search is not a successful basic sequence.");
  const hit = searched.hits[0], source = snapshot.documents[0], id = hit.source_id;
  assert(hit.path_evidence.some(value => value.matched_field === "body" && value.match === "exact"),
    "The positive marker must match exact Script body evidence, not fuzzy/zero-score fallback.");
  assert.deepEqual(keys(searched), [
    "adaptive", "content_type_routing", "corpus_revision", "counts", "diagnostics", "exact_terms", "groups", "hits",
    "incomplete", "learning_error", "lexical_anchors", "limit_reached", "model_invoked", "ok", "query_intent",
    "ready_generation", "request_id", "requested_content_types", "result_count", "retrieval_id", "route", "schema",
    "search_mode", "semantic_reason", "semantic_status", "skill_serving", "solution", "stale", "truncated",
  ]);
  assert.deepEqual(keys(hit), ["content_hash", "content_type", "description", "path_evidence", "provenance", "rank",
    "read_only", "score", "score_components", "score_semantics", "skill_id", "source_id", "source_label",
    "source_revision", "source_uri", "sources", "title"]);
  assert.equal(id, source.source_id);
  assert.equal(hit.source_revision, source.source_revision);
  assert.equal(hit.content_type, "script");
  assert.equal(hit.source_uri, source.source_uri);
  assert.equal(hit.read_only, source.read_only);
  assert.deepEqual(hit.provenance, { provider: source.provenance.provider }, "Original standard search compacts provenance; get preserves the complete source provenance.");
  const script = await f.lexical(snapshot, "get_script", { id });
  assert.equal(script.ok, true, JSON.stringify(script));
  assert.equal(script.content, f.first);
  assert.deepEqual(keys(script), ["content", "content_hash", "content_type", "corpus_revision", "description", "metadata",
    "ok", "provenance", "read_only", "ready_generation", "schema", "source_id", "source_revision", "source_uri",
    "stale", "title"]);
  assert.equal(script.schema, "pkm.knowledge.read/v1");
  assert(script.source_revision.startsWith(`sha256:${sha256(script.content)}:`));
  assert.equal(script.source_id, id);
  assert.equal(script.source_revision, source.source_revision);
  assert.equal(script.content_hash, hit.content_hash);
  assert.equal(script.content_type, "script");
  assert.equal(script.source_uri, source.source_uri);
  assert.deepEqual(script.provenance, source.provenance);
  assert.equal(script.read_only, source.read_only);
  assert.equal(script.ready_generation, 1);
  assert.equal(script.corpus_revision, snapshot.corpus_revision);
  assert.equal(sha256(script.content), sha256(await readFile(join(f.root, "scripts", f.path))));
  const reader = await f.originalReader();
  assert.equal(reader.row.content, script.content);
  t.diagnostic(`Exact search result fields=${JSON.stringify(keys(searched))}; hit fields=${JSON.stringify(keys(hit))}; get fields=${JSON.stringify(keys(script))}; original Script metadata=${JSON.stringify(reader)}`);
  await f.editExpected(f.first, f.fresh);
  await assert.rejects(f.editExpected(f.first, f.first), /exact expected bytes/);
  const freshSnapshot = await f.snapshot(2);
  const freshSearch = await f.lexical(freshSnapshot, "search_scripts", { ...args, query: "scriptbasicbodysentinelfresh" });
  assert.equal(freshSearch.ok, true, JSON.stringify(freshSearch));
  assert.equal(freshSearch.hits.length, 1);
  assert(freshSearch.hits[0].path_evidence.some(value => value.matched_field === "body" && value.match === "exact"));
  assert.equal(freshSearch.hits[0].source_id, id);
  const fresh = await f.lexical(freshSnapshot, "get_script", { id: freshSearch.hits[0].source_id });
  assert.equal(fresh.content, f.fresh);
  assert.equal(fresh.source_revision, freshSnapshot.documents[0].source_revision);
  assert.equal(fresh.content_hash, freshSearch.hits[0].content_hash);
  assert.notEqual(fresh.source_revision, script.source_revision);
  assert.notEqual(fresh.content_hash, script.content_hash);
  assert.notEqual(fresh.corpus_revision, script.corpus_revision);
  assert.equal(fresh.ready_generation, 2);
  assert.equal(sha256(fresh.content), sha256(await readFile(join(f.root, "scripts", f.path))));
  const oldMarker = await f.lexical(freshSnapshot, "search_scripts", args);
  assert.equal(oldMarker.ok, true);
  for (const hit of oldMarker.hits) {
    assert.equal(hit.source_revision, fresh.source_revision, "Original fuzzy lexical hits must reference the current revision, never the indexed old bytes.");
    assert.equal(hit.content_hash, fresh.content_hash);
    assert(!hit.path_evidence.some(value => value.match === "exact"));
  }
  const stale = await f.lexical(freshSnapshot, "search_knowledge", {
    query: "scriptbasicbodysentinelfresh", route: "lexical", generation_mode: "exact", generation: 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "generation-not-ready");
  const privateSearch = await f.lexical(freshSnapshot, "search_scripts", { ...args, query: "scriptbasicprivatesentinel" });
  assert.equal(privateSearch.ok, true);
  const privateId = `pkm://script/script_${sha256(f.privatePath).slice(0, 24)}`;
  assert(privateSearch.hits.every(hit => hit.source_id !== privateId));
  const denied = await f.lexical(freshSnapshot, "get_script", { id: privateId });
  assert.deepEqual(denied, { ok: false, code: "not-found", error: "Knowledge source not found" });
  assert(!JSON.stringify([searched, script, freshSearch, fresh, stale, privateSearch, denied]).includes(f.secret));
  const privateAfter = await lstat(privateFile, { bigint: true });
  for (const field of ["dev", "ino", "size", "atimeNs", "mtimeNs", "ctimeNs", "mode"]) assert.equal(privateAfter[field], privateBefore[field]);
  t.diagnostic(`Original VSIX ${f.oracle.originalPackageSha256}; positive lexical evidence is the actual Source Python adapter and independently pinned original public-only snapshot/reader. Private corpus exclusion is not a native Root source-policy admission. Old-marker fuzzy hits=${oldMarker.hits.length}, all current revision; no empty-search false positive. No Script is executed or Script write/update API asserted. Native Root/Host and installed MCP qualification remain separate gaps.`);
});

test("Script actual original worker startup binds the complete disposable public corpus to original and v5 MCP search/get, refresh, stale-generation refusal and drained exit", { timeout: 150000 }, async t => {
    const f = await scriptBasicFixture(t, { includePrivate: false }), worker = await originalScriptWorkerFixture(t, f);
    let original, client;
    try {
      const first = await worker.sync();
      assert.equal(first.ready.ready, true);
      assert.equal(first.ready.ready_generation, 1);
      assert.equal(first.ready.corpus_revision, first.snapshot.corpus_revision);
      assert.equal(first.ready.semantic_status, "off");
      assert.equal(first.ready.engine_version, worker.evidence.engineVersion);
      assert.equal(first.ready.configuration_hash, worker.evidence.configurationHash);
      assert.equal(first.ready.runtime.python, process.env.PKM_TEST_PYTHON);
      assert.equal(first.ready.runtime.worker_build, worker.manager.runtimeFiles().build);
      assert.equal(worker.manager.modelRuntime().configured, false, "Lexical startup must not install, select or silently invoke a model.");
      ({ client: original } = await f.connect(true)); ({ client } = await f.connect());
      const version = await successful(client.callTool({ name: "check_version", arguments: {} }));
      assert.equal(version.backend.storageMigrated, false);
      const args = { query: "scriptbasicbodysentinelold", route: "lexical", detail: "standard", limit: 5 };
      const searched = await invoke(client, "search_scripts", args);
      assert.deepEqual(searched, await invoke(original, "search_scripts", args), "Every original/A MCP Script field must match against the actual serving worker.");
      const found = await successful(searched);
      assert.equal(found.ok, true, JSON.stringify(found));
      assert.equal(found.hits.length, 1);
      assert.equal(found.model_invoked, false);
      assert.equal(found.semantic_status, "off");
      const hit = found.hits[0], source = first.indexed.find(document => document.content_type === "script");
      assert(hit.path_evidence.some(value => value.matched_field === "body" && value.match === "exact"));
      assert.equal(hit.source_id, source.source_id);
      assert.equal(hit.source_revision, source.source_revision);
      assert.deepEqual(hit.provenance, { provider: "pkm" });
      const read = await invoke(client, "get_script", { id: hit.source_id });
      assert.deepEqual(read, await invoke(original, "get_script", { id: hit.source_id }));
      assert.deepEqual(read, await client.callTool({ name: "script_read", arguments: { id: hit.source_id } }));
      const script = await successful(read);
      assert.equal(script.ok, true);
      assert.equal(script.content, f.first);
      assert.equal(script.content_hash, hit.content_hash);
      assert.equal(script.source_revision, source.source_revision);
      assert.equal(script.source_id, hit.source_id);
      assert.equal(script.content_type, "script");
      assert.equal(script.source_uri, source.source_uri);
      assert.equal(script.title, source.title);
      assert.equal(script.description, source.description);
      assert.deepEqual(script.metadata, source.metadata);
      assert.equal(script.corpus_revision, first.snapshot.corpus_revision);
      assert.equal(script.read_only, false, "Original local source mutability does not invent a Script write API.");
      assert.deepEqual(script.provenance, source.provenance);
      assert.equal(sha256(script.content), sha256(await readFile(join(f.root, "scripts", f.path))));
      assert.equal(script.ready_generation, 1);
      const pid = first.endpoint.pid;
      await f.editExpected(f.first, f.fresh);
      const refreshed = await worker.sync();
      assert.equal(refreshed.mode.mode, "delta");
      assert.equal(refreshed.endpoint.pid, pid);
      assert.equal(refreshed.ready.ready_generation, 2);
      const freshArgs = { ...args, query: "scriptbasicbodysentinelfresh" };
      const freshReply = await invoke(client, "search_scripts", freshArgs);
      assert.deepEqual(freshReply, await invoke(original, "search_scripts", freshArgs));
      assert.deepEqual(freshReply, await client.callTool({ name: "script_search", arguments: freshArgs }));
      const freshSearch = await successful(freshReply);
      assert.equal(freshSearch.ok, true);
      assert.equal(freshSearch.hits.length, 1);
      assert(freshSearch.hits[0].path_evidence.some(value => value.matched_field === "body" && value.match === "exact"));
      const freshRead = await invoke(client, "get_script", { id: freshSearch.hits[0].source_id });
      assert.deepEqual(freshRead, await invoke(original, "get_script", { id: freshSearch.hits[0].source_id }));
      const fresh = await successful(freshRead);
      assert.equal(fresh.content, f.fresh);
      assert.equal(fresh.source_id, hit.source_id);
      assert.equal(fresh.content_hash, freshSearch.hits[0].content_hash);
      assert.equal(fresh.source_revision, refreshed.indexed.find(document => document.content_type === "script").source_revision);
      assert.notEqual(fresh.content_hash, script.content_hash);
      assert.notEqual(fresh.source_revision, script.source_revision);
      assert.equal(fresh.ready_generation, 2);
      assert.notEqual(fresh.corpus_revision, script.corpus_revision);
      assert.equal(fresh.corpus_revision, refreshed.snapshot.corpus_revision);
      assert.equal(sha256(fresh.content), sha256(await readFile(join(f.root, "scripts", f.path))));
      const oldMarker = await successful(invoke(client, "search_scripts", args));
      assert.equal(oldMarker.ok, true);
      for (const current of oldMarker.hits) {
        assert.equal(current.source_revision, fresh.source_revision);
        assert.equal(current.content_hash, fresh.content_hash);
        assert(!current.path_evidence.some(value => value.match === "exact"));
      }
      const staleArgs = { query: freshArgs.query, route: "lexical", generation_mode: "exact", generation: 1 };
      const stale = await invoke(client, "search_knowledge", staleArgs);
      assert.deepEqual(stale, await invoke(original, "search_knowledge", staleArgs));
      assert.equal(resultValue(stale).ok, false);
      assert.equal(resultValue(stale).code, "generation-not-ready");
      await f.close(client); client = undefined;
      await f.close(original); original = undefined;
      assert.equal(worker.manager.processAlive(pid), true, "MCP drain and shared retrieval-worker shutdown are separate real lifecycles.");
      await worker.close();
      assert.equal(worker.manager.processAlive(pid), false);
      assert(!(await readdir(f.root)).includes("core.sqlite"));
      t.diagnostic(`Positive original/A MCP startup: original RetrievalWorkerManager.sync -> ensureLocked -> genuine worker-created descriptor, runtime stage, Exact/BM25 lexical ready generations 1/2; same PID ${pid} exited after real /shutdown. No pointer/model/source grant fabricated; complete owned public fixture only, not native Root/Host/private-source qualification.`);
    } finally {
      try {
        if (client) await f.close(client);
        if (original) await f.close(original);
      } finally { await worker.close(); }
    }
});

test("owned original Script worker exits before shared fixture removal after an interrupted test flow", { timeout: 120000 }, async t => {
  const f = await scriptBasicFixture(t, { includePrivate: false });
  const worker = await originalScriptWorkerFixture(t, f);
  const started = await worker.sync();
  assert(worker.manager.processAlive(started.endpoint.pid));
  f.retainCleanup(async () => {
    assert((await lstat(f.base)).isDirectory(), "Fixture files must remain until worker shutdown is confirmed.");
    assert.equal(worker.manager.processAlive(started.endpoint.pid), false);
  });
  t.after(async () => {
    assert.equal(worker.manager.processAlive(started.endpoint.pid), false);
    await assert.rejects(lstat(f.base), { code: "ENOENT" });
  });
  const abort = new AbortController();
  abort.abort(new Error("Interrupted owned fixture flow."));
  assert.throws(() => abort.signal.throwIfAborted(), /Interrupted owned fixture flow/);
});
