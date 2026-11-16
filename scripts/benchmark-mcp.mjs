#!/usr/bin/env node
/**
 * Server-only release-VSIX comparison. See raw JSON methodology and CLI --help.
 * No production MCP, editor, default profile, provider, or kernel-cache changes.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { dirname, basename, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { performance } from "node:perf_hooks";

const script = fileURLToPath(import.meta.url);
const digest = value => createHash("sha256").update(value).digest("hex");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const clock = () => performance.now();
const stamp = () => new Date().toISOString();
let systemPageSize;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const logicalDigest = value => digest(JSON.stringify(canonical(value)));
export function quantile(values, q) {
  assert(values.length && values.every(Number.isFinite), "Nonempty finite samples required");
  assert(q > 0 && q <= 1);
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
}
export function aggregate(samples) {
  assert(samples.length && samples.every(s => !s.error && Number.isFinite(s.ms) && s.ms > 0),
    "Failed or missing measurements cannot be aggregated as fast responses");
  const values = samples.map(s => s.ms), median = quantile(values, 0.5);
  return { n: values.length, p50Ms: median, p95Ms: quantile(values, 0.95),
    minMs: Math.min(...values), maxMs: Math.max(...values),
    madMs: quantile(values.map(v => Math.abs(v - median)), 0.5) };
}
export function pairedSummary(runs, metric) {
  const pairs = new Map();
  for (const run of runs) {
    assert(["old", "new"].includes(run.variant));
    const pair = pairs.get(run.pairId) ?? {};
    assert(!pair[run.variant], "Duplicate pair member");
    pair[run.variant] = run;
    pairs.set(run.pairId, pair);
  }
  const values = [...pairs].map(([pairId, pair]) => {
    assert(pair.old && pair.new, "Incomplete pair");
    const old = metric(pair.old), next = metric(pair.new);
    assert(old > 0 && next > 0 && Number.isFinite(old) && Number.isFinite(next), "Invalid pair metric");
    return { pairId, order: pair.old.order === 0 ? "AB" : "BA", old, new: next,
      newOverOld: next / old, changePercent: 100 * (next / old - 1) };
  });
  const changes = values.map(v => v.changePercent), median = quantile(changes, 0.5);
  return { nPairs: values.length, pairs: values, medianChangePercent: median,
    minChangePercent: Math.min(...changes), maxChangePercent: Math.max(...changes),
    madChangePercentagePoints: quantile(changes.map(v => Math.abs(v - median)), 0.5) };
}
export function unwrap(response) {
  assert(!response.isError, `MCP error: ${JSON.stringify(response)}`);
  let value = response.structuredContent;
  if (value === undefined) {
    const text = response.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert(text, "Missing MCP result");
    value = JSON.parse(text);
  }
  // FastMCP wraps scalar/array return values in {result: ...}.
  if (value && !Array.isArray(value) && Object.keys(value).length === 1 && "result" in value) value = value.result;
  for (let n = 0; typeof value === "string" && n < 3; n++) value = JSON.parse(value);
  assert(value && typeof value === "object", "Non-object logical output");
  assert(value.ok !== false && !value.error, `Logical error: ${JSON.stringify(value)}`);
  return value;
}
export function equivalent(operation, value, fixture) {
  if (operation === "get_note") {
    assert.equal(value.slug, fixture.slug);
    assert.equal(value.title, fixture.title);
    assert.equal(value.content.trim(), fixture.body.trim());
    return { slug: value.slug, title: value.title, bodySha256: digest(value.content.trim()) };
  }
  if (operation === "list_notes" || operation.startsWith("search_")) {
    const rows = Array.isArray(value) ? value : value.items ?? value.notes ?? value.results;
    assert(Array.isArray(rows), `Unrecognized ${operation} result: ${JSON.stringify(value).slice(0, 1000)}`);
    const expected = operation === "list_notes" ? fixture.all : operation === "search_one" ? fixture.one : fixture.ten;
    const actual = rows.map(r => ({ slug: r.slug, title: r.title })).sort((a, b) => a.slug.localeCompare(b.slug));
    assert.deepEqual(actual, expected, `${operation}: missing, extra, or unequal rows`);
    if (operation === "list_notes") {
      assert.equal(value.total, fixture.all.length);
      assert.equal(value.next_offset, null);
      if (fixture.stableIdentities) {
        assert.equal(value.identity_complete, true);
        assert.equal(value.missing_identity_count, 0);
      }
    }
    return { count: actual.length, logicalSha256: digest(JSON.stringify(actual)) };
  }
  throw new Error(`Unknown equivalence operation ${operation}`);
}

function command(command_, args, options = {}) {
  const r = spawnSync(command_, args, { encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0)
    throw new Error(JSON.stringify({ command: command_, args, code: r.status, error: String(r.error ?? ""),
      stdout: r.stdout, stderr: r.stderr }));
  return r.stdout;
}
async function exists(path) {
  try { await fs.lstat(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}
async function write(path, value) {
  const pending = `${path}.pending`;
  await fs.writeFile(pending, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(pending, path);
}
async function inventory(root, dir = root) {
  const files = {};
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await inventory(root, path));
    else {
      assert(entry.isFile(), `No symlink/special file allowed: ${path}`);
      files[relative(root, path)] = digest(await fs.readFile(path));
    }
  }
  return files;
}
function environment(root) {
  const home = join(root, "home"), scratch = join(root, "scratch");
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: join(scratch, "runtime"),
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1",
    PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
    PKM_CAPABILITY_PROFILE: "compact", PKM_MCP_NODE: process.execPath,
    OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" };
}
async function extract(python, vsix, target) {
  command(python, ["-I", "-B", "-c", `
import zipfile,pathlib,sys,stat
root=pathlib.Path(sys.argv[2]);root.mkdir(mode=0o700)
with zipfile.ZipFile(sys.argv[1]) as z:
 for i in z.infolist():
  p=pathlib.PurePosixPath(i.filename)
  if p.is_absolute() or ".." in p.parts or stat.S_ISLNK(i.external_attr>>16):
   raise RuntimeError("Unsafe VSIX entry")
  q=root.joinpath(*p.parts)
  if i.is_dir():q.mkdir(parents=True,exist_ok=True)
  else:
   q.parent.mkdir(parents=True,exist_ok=True)
   with q.open("xb") as f:f.write(z.read(i))
`, vsix, target]);
}
async function provisionOld(options, extension, source, managed, python) {
  const interpreterDirectory = join(options.root, "old-python-runtime");
  if (!await exists(interpreterDirectory)) {
    await fs.mkdir(join(interpreterDirectory, "bin"), { recursive: true, mode: 0o700 });
    await fs.symlink(python, join(interpreterDirectory, "bin/python"));
  }
  const helper = join(options.root, "old-generator.cjs");
  if (!await exists(helper)) await fs.writeFile(helper, `
const Module=require("module"),path=require("path");
const [extension,source,managed,home,interpreterDirectory]=process.argv.slice(2);
const config={mcpServerPath:managed,mcpRuntimePath:interpreterDirectory,mcpEnabledFeatureDomains:["knowledge"]};
const vscode={workspace:{isTrusted:true,workspaceFolders:[],getConfiguration:()=>({get:(k,d)=>k in config?config[k]:d})},
 env:{appRoot:home,machineId:"synthetic-benchmark",sessionId:"synthetic-benchmark"},
 Uri:{file:p=>({fsPath:p,toString:()=>p})}};
const load=Module._load;
Module._load=function(name,...args){if(name==="vscode")return vscode;return load.call(this,name,...args)};
require(path.join(extension,"dist/knowledge/filestore.js")).setStorePath(source);
require(path.join(extension,"dist/mcp/mcp.js")).generateMcpServer({
 extensionPath:extension,globalStorageUri:{fsPath:home}
}).then(value=>{console.log(JSON.stringify(value));},e=>{console.error(e.stack);process.exitCode=1;});
`, { flag: "wx", mode: 0o600 });
  return JSON.parse(command(process.execPath, [helper, extension, source, managed, join(options.root, "home"), interpreterDirectory],
    { env: environment(options.root), cwd: options.root }));
}

async function proc(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const base = { pid, ppid: Number(fields[1]), startTicks: fields[19], state: fields[0],
      cpuTicks: Number(fields[11]) + Number(fields[12]), rssBytes: Number(fields[21]) * systemPageSize };
    try {
      const io = await fs.readFile(`/proc/${pid}/io`, "utf8");
      base.io = Object.fromEntries([...io.matchAll(/^(\w+): (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
    } catch {}
    try {
      const pss = /Pss:\s+(\d+) kB/.exec(await fs.readFile(`/proc/${pid}/smaps_rollup`, "utf8"));
      if (pss) base.pssBytes = Number(pss[1]) * 1024;
    } catch {}
    try { base.command = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean); } catch {}
    try { base.executable = await fs.readlink(`/proc/${pid}/exe`); } catch {}
    return base;
  } catch (e) { if (["ENOENT", "ESRCH"].includes(e.code)) return null; throw e; }
}
async function tree(pid, known) {
  const result = [], visited = new Set();
  async function visit(id, expected, parent) {
    if (visited.has(id)) return;
    visited.add(id);
    const p = await proc(id);
    if (!p || expected !== undefined && p.startTicks !== expected || parent !== undefined && p.ppid !== parent) return;
    result.push(p);
    known.set(p.pid, p.startTicks);
    try {
      for (const thread of await fs.readdir(`/proc/${id}/task`)) {
        try {
          const children = (await fs.readFile(`/proc/${id}/task/${thread}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
          for (const child of children) await visit(Number(child), undefined, id);
        } catch (e) { if (!["ENOENT", "ESRCH"].includes(e.code)) throw e; }
      }
    } catch (e) { if (!["ENOENT", "ESRCH"].includes(e.code)) throw e; }
  }
  await visit(pid, known.get(pid), known.has(pid) ? undefined : process.pid);
  // Retain already-seen descendants after reparenting, never recycled process IDs.
  for (const [id, generation] of known) await visit(id, generation);
  return { elapsedMs: clock(), processes: result,
    rssBytes: result.reduce((s, p) => s + p.rssBytes, 0),
    pssBytes: result.every(p => p.pssBytes !== undefined) ? result.reduce((s, p) => s + p.pssBytes, 0) : null };
}
export function resourceDelta(before, after, ticksPerSecond) {
  const lookup = new Map(before.processes.map(p => [`${p.pid}:${p.startTicks}`, p]));
  const io = {}, matched = [];
  let cpuMs = 0;
  for (const p of after.processes) {
    const b = lookup.get(`${p.pid}:${p.startTicks}`);
    if (!b) continue;
    matched.push(`${p.pid}:${p.startTicks}`);
    cpuMs += (p.cpuTicks - b.cpuTicks) * 1000 / ticksPerSecond;
    for (const [k, v] of Object.entries(p.io ?? {})) {
      if (b.io?.[k] !== undefined) io[k] = (io[k] ?? 0) + v - b.io[k];
    }
  }
  return { elapsedMs: after.elapsedMs - before.elapsedMs, cpuMs, io, matched,
    observationOnly: true, excludesExitedBeforeEndpoint: true };
}
async function stopOwned(client, transport, known) {
  try { await client?.close(); } catch {}
  for (let n = 0; n < 30; n++) {
    const alive = (await Promise.all([...known].map(async ([pid, start]) => {
      const p = await proc(pid); return p && p.startTicks === start && p.state !== "Z" ? p : null;
    }))).filter(Boolean);
    if (!alive.length) return;
    if (n === 15 || n === 25) for (const p of alive.reverse()) {
      try { process.kill(p.pid, n === 15 ? "SIGTERM" : "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    await sleep(100);
  }
  throw new Error(`Owned MCP processes did not exit: ${JSON.stringify([...known])}; transport ${transport?.pid}`);
}

async function runOne(options, context, cell, pair, order, variant) {
  const { Client, StdioClientTransport, ticksPerSecond } = context;
  const setup = cell[variant], known = new Map();
  const result = { cellId: cell.id, pairId: `${cell.id}-pair-${pair}`, pair, order, variant,
    startedAt: stamp(), loadBefore: os.loadavg(), operations: {}, processSamples: [], errors: [] };
  let client, transport, sampler, sampling = false;
  const runStarted = clock();
  let started = runStarted;
  try {
    result.registryBefore = await registrySnapshot(setup.managed);
    assert.equal(result.registryBefore.count, cell.stale, "Every run must start with exactly the configured stale history");
    transport = new StdioClientTransport({ command: options.python, args: setup.args, cwd: setup.managed,
      env: environment(options.root), stderr: "pipe" });
    result.command = [options.python, ...setup.args];
    let stderr = "";
    transport.stderr?.on("data", data => { stderr = (stderr + data.toString()).slice(-16384); });
    client = new Client({ name: "owned-release-performance-comparison", version: "1" });
    result.preflightSetupMs = clock() - runStarted;
    result.spawnPhaseStartedAt = stamp();
    started = clock();
    const connecting = client.connect(transport, { timeout: 120000 });
    const sample = async phase => {
      if (!transport.pid) return null;
      const value = await tree(transport.pid, known);
      value.phase = phase; value.elapsedMs -= started;
      result.processSamples.push(value);
      return value;
    };
    sampler = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      try { await sample("periodic"); } catch (e) { result.errors.push({ phase: "sampling", error: String(e) }); }
      finally { sampling = false; }
    }, 250);
    await connecting;
    const tools = await client.listTools();
    result.readyMs = clock() - started;
    result.transportPid = transport.pid;
    result.tools = tools;
    const call = async (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    const names = tools.tools.map(t => t.name);
    for (const name of ["capability_read", "capabilities_describe", "capabilities_list", "mcp_lifecycle_status"])
      assert(names.includes(name), `Unsupported common API: ${name}`);
    result.contracts = {};
    for (const operation of ["get_note", "list_notes", "search_notes"]) {
      const contract = unwrap(await call("capabilities_describe", { operation: `mcp.tool.${operation}` }));
      assert.equal(contract.id, `mcp.tool.${operation}`);
      assert.equal(contract.version, 1);
      assert.equal(contract.readOnly, true);
      result.contracts[operation] = contract;
    }
    const firstStarted = clock();
    const first = unwrap(await call("capability_read", { operation: "mcp.tool.get_note", version: 1,
      arguments: { slug: cell.fixture.slug } }));
    result.firstReadMs = clock() - firstStarted;
    result.spawnToFirstReadMs = clock() - started;
    result.firstReadValidation = equivalent("get_note", first, cell.fixture);
    result.firstReadLogicalSha256 = logicalDigest(first);
    result.firstReadResponse = first;
    result.lifecycle = unwrap(await call("mcp_lifecycle_status"));
    assert.equal(result.lifecycle.acceptingNewCalls, true);
    assert.equal(result.lifecycle.generation, setup.generation);
    const catalog = unwrap(await call("capabilities_list", { limit: 10 }));
    result.discoveryCatalog = catalog;
    const operations = [
      ["discovery", () => call("capabilities_describe", { operation: "mcp.tool.get_note" })],
      ["get_note", () => call("capability_read", { operation: "mcp.tool.get_note", version: 1, arguments: { slug: cell.fixture.slug } })],
      ["list_notes", () => call("capability_read", { operation: "mcp.tool.list_notes", version: 1, arguments: { limit: 0, offset: 0, recursive: true } })],
      ["search_one", () => call("capability_read", { operation: "mcp.tool.search_notes", version: 1,
        arguments: { query: "needleunique", limit: 20, detail: "legacy", route: "lexical" } })],
      ["search_ten", () => call("capability_read", { operation: "mcp.tool.search_notes", version: 1,
        arguments: { query: "needlegroup", limit: 20, detail: "legacy", route: "lexical" } })],
    ];
    await sample("ready-before-warmup");
    result.warmup = [];
    for (const [name, request] of operations) {
      for (let i = 0; i < options.warmup; i++) {
        const before = clock(), response = await request(), ms = clock() - before, value = unwrap(response);
        const validation = name === "discovery" ? validateDiscovery(value) : equivalent(name, value, cell.fixture);
        result.warmup.push({ operation: name, ms, responseBytes: Buffer.byteLength(JSON.stringify(response)), validation });
      }
    }
    const idleBefore = await sample("idle-start");
    await sleep(options.idleMs);
    const idleAfter = await sample("idle-end");
    result.idle = resourceDelta(idleBefore, idleAfter, ticksPerSecond);
    const requestBefore = await sample("timed-requests-start");
    // Interleave operations, rather than measuring all fast calls before all slow calls.
    for (const [name] of operations) result.operations[name] = { samples: [] };
    for (let i = 0; i < options.calls; i++) for (const [name, request] of operations) {
      const before = clock();
      try {
        const response = await request(), ms = clock() - before, value = unwrap(response);
        const validation = name === "discovery" ? validateDiscovery(value) : equivalent(name, value, cell.fixture);
        const op = result.operations[name];
        op.samples.push({ iteration: i, ms, responseBytes: Buffer.byteLength(JSON.stringify(response)),
          logicalBytes: Buffer.byteLength(JSON.stringify(value)), logicalSha256: logicalDigest(value), validation });
        if (i === 0) op.firstResponse = response;
      } catch (e) {
        result.operations[name].samples.push({ iteration: i, error: String(e) });
        throw e;
      }
    }
    const requestAfter = await sample("timed-requests-end");
    result.requestsResourceObservation = resourceDelta(requestBefore, requestAfter, ticksPerSecond);
    for (const op of Object.values(result.operations)) op.summary = aggregate(op.samples);
    result.resources = { sampledPeakTreeRssBytes: Math.max(...result.processSamples.map(p => p.rssBytes)),
      sampledPeakTreePssBytes: Math.max(...result.processSamples.map(p => p.pssBytes ?? 0)),
      idleStartTreeRssBytes: idleBefore.rssBytes, idleEndTreeRssBytes: idleAfter.rssBytes,
      idleEndTreePssBytes: idleAfter.pssBytes };
    result.stderr = stderr;
    result.passed = !result.errors.length;
    assert(result.passed, JSON.stringify(result.errors));
  } catch (e) {
    result.passed = false;
    result.errors.push({ phase: "run", error: String(e.stack ?? e) });
  } finally {
    clearInterval(sampler);
    while (sampling) await sleep(10);
    if (transport?.pid) {
      await tree(transport.pid, known).catch(() => {});
      if (!known.has(transport.pid)) {
        const p = await proc(transport.pid); if (p?.ppid === process.pid) known.set(p.pid, p.startTicks);
      }
    }
    await stopOwned(client, transport, known);
    result.ownedTreeExited = true;
    result.registryAfterExit = await registrySnapshot(setup.managed);
    if (variant === "new") assert.deepEqual(result.registryAfterExit, result.registryBefore,
      "NEW must not create/modify tracking records");
    // OLD deliberately persists its own stale instance on shutdown. Remove only that
    // owned run's record, outside timings, so the next run has identical history.
    if (variant === "old" && result.lifecycle?.instanceId) {
      const current = join(setup.managed, "instances", `${result.lifecycle.instanceId}.json`);
      await fs.rm(current, { force: true });
      if (!result.registryBefore.exists && !(await fs.readdir(join(setup.managed, "instances"))).length)
        await fs.rmdir(join(setup.managed, "instances"));
    }
    const reset = await registrySnapshot(setup.managed);
    assert.deepEqual(reset, result.registryBefore);
    result.registryResetForNextRun = reset;
    result.completedAt = stamp();
    result.totalMs = clock() - started;
    result.runIncludingPreflightMs = clock() - runStarted;
    result.loadAfter = os.loadavg();
  }
  async function registrySnapshot(managed) {
    const registry = join(managed, "instances");
    if (!await exists(registry)) return { exists: false, count: 0, files: {} };
    const files = await inventory(registry);
    return { exists: true, count: Object.keys(files).length, files };
  }
  return result;
}
function validateDiscovery(value) {
  assert.equal(value.id, "mcp.tool.get_note", JSON.stringify(value));
  assert.equal(value.version, 1);
  assert.equal(value.readOnly, true);
  return { operation: value.id, version: value.version };
}

async function prepare(options, report) {
  const before = clock();
  await extract(options.python, options.oldVsix, join(options.root, "old-package"));
  await extract(options.python, options.newVsix, join(options.root, "new-package"));
  report.provisioning.extractionMs = clock() - before;
  const oldExtension = join(options.root, "old-package/extension");
  const runtime = join(options.root, "new-package/extension/next-runtime/server");
  const factory = join(options.repository, "experimental/managed-migration.mjs");
  const accepted = JSON.parse(await fs.readFile(join(options.repository, "artifacts/pkm-v5-no-tracking-resource-audit.json")));
  const factorySha256 = digest(await fs.readFile(factory));
  assert.equal(factorySha256, accepted.factorySha256, "Factory must match accepted installed resource gate");
  const factoryDependencies = {};
  for (const name of ["managed-migration.mjs", "managed-launch-client.mjs", "managed-launcher.py", "python-bootstrap.py", "python-dependencies.py"])
    factoryDependencies[name] = digest(await fs.readFile(join(dirname(factory), name)));
  report.provisioning.factory = { path: factory, sha256: factorySha256, dependencies: factoryDependencies,
    source: "Existing accepted generation factory; not shipped inside NEW VSIX. Product runtime from immutable VSIX.",
    acceptedEvidenceSha256: digest(await fs.readFile(join(options.repository, "artifacts/pkm-v5-no-tracking-resource-audit.json"))) };
  const { stageIsolatedManagedGeneration, publishIsolatedManagedGeneration } = await import(pathToFileURL(factory));
  const { planLegacyImport, importLegacyWorkspace } = await import(pathToFileURL(join(runtime, "dist/legacy-import.js")));
  const cells = [];
  for (const size of options.sizes) {
    const source = join(options.root, `source-${size}`);
    await fs.mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
    await fs.chmod(source, 0o700);
    const all = [], files = {};
    for (let n = 0; n < size; n++) {
      const slug = `Bench-${String(n).padStart(5, "0")}`, title = slug;
      const body = `Canonical benchmark note ${String(n).padStart(5, "0")}.\n${n === 0 ? "needleunique" : "ordinarytoken"} ${n < 10 ? "needlegroup" : "ordinarygroup"}.\n${"Fixed synthetic read-only text. ".repeat(20)}\n`;
      const text = `---\ntitle: "${title}"\nknowledgeId: "knowledge_${n.toString(16).padStart(24, "0")}"\ndocumentId: "benchmark-note-${String(n).padStart(5, "0")}"\nrevision: 1\ntype: "general"\ntags: ["benchmark"]\ncreated: "2025-01-01T00:00:00.000Z"\n---\n${body}`;
      await fs.writeFile(join(source, "notes", `${slug}.md`), text, { flag: "wx", mode: 0o600 });
      await fs.utimes(join(source, "notes", `${slug}.md`), new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
      files[`notes/${slug}.md`] = digest(text);
      all.push({ slug, title });
    }
    const firstRaw = await fs.readFile(join(source, "notes/Bench-00000.md"), "utf8");
    const fixture = { slug: "Bench-00000", title: "Bench-00000", stableIdentities: true,
      body: firstRaw.split("---\n").slice(2).join("---\n"),
      all, one: all.slice(0, 1), ten: all.slice(0, 10), files, digest: digest(JSON.stringify(files)) };
    const data = join(options.root, `new-workspace-${size}`);
    const importStarted = clock();
    const plan = await planLegacyImport(source);
    assert(plan.ready, JSON.stringify(plan.blockers));
    const receipt = await importLegacyWorkspace(plan, data, { pythonExecutable: options.python });
    report.provisioning.datasets.push({ size, source, data, importMs: clock() - importStarted,
      planSha256: plan.planSha256, receipt, fixture });
    for (const stale of options.staleCounts) {
      const id = `notes-${size}-stale-${stale}`;
      const oldManaged = join(options.root, `${id}-old-managed`), newManaged = join(options.root, `${id}-new-managed`);
      const oldStarted = clock();
      const oldLaunch = await provisionOld(options, oldExtension, source, oldManaged, options.python);
      report.provisioning.oldGenerationAdapter = { path: join(options.root, "old-generator.cjs"),
        sha256: digest(await fs.readFile(join(options.root, "old-generator.cjs"))),
        purpose: "Prep-only minimal VSCode workspace/config/URI adapter around unmodified supported OLD generateMcpServer export. Not loaded in timed Python servers. No edited release source/templates." };
      const oldProvisionMs = clock() - oldStarted;
      const oldPointer = JSON.parse(await fs.readFile(join(oldManaged, "latest-generation.json")));
      const oldManifest = JSON.parse(await fs.readFile(join(oldManaged, "generations", oldPointer.generation, "manifest.json")));
      assert(oldManifest.runtimeMaintenance.startsWith(options.root + "/"), "No external runtime-maintenance path");
      const newStarted = clock();
      const manifest = await stageIsolatedManagedGeneration({ managedRoot: newManaged, data, repositoryRoot: runtime,
        python: options.python, node: process.execPath, allowWrites: false });
      await publishIsolatedManagedGeneration(newManaged, manifest.generation);
      const newProvisionMs = clock() - newStarted;
      for (const managed of [oldManaged, newManaged]) if (stale) {
        const registry = join(managed, "instances");
        await fs.mkdir(registry, { mode: 0o700 });
        for (let n = 0; n < stale; n++) await fs.writeFile(join(registry, `${n.toString(16).padStart(32, "0")}.json`),
          JSON.stringify({ schema: "pkm.mcp.lifecycle/v1", instanceId: n.toString(16).padStart(32, "0"),
            pid: 2000000000 + n, generation: managed === oldManaged ? oldManifest.generation : manifest.generation,
            phase: "accepting", timestamp: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" }),
          { flag: "wx", mode: 0o600 });
      }
      const cell = { id, size, stale, fixture,
        old: { managed: oldManaged, args: ["-B", oldLaunch.serverPath], generation: oldManifest.generation, manifest: oldManifest,
          provisionMs: oldProvisionMs },
        new: { managed: newManaged, args: ["-I", "-S", "-B", join(newManaged, "launch.py")],
          generation: manifest.generation, manifest, provisionMs: newProvisionMs } };
      cells.push(cell);
    }
  }
  report.provisioning.totalMs = clock() - before;
  return { cells, runtime };
}

async function main(args) {
  if (args.includes("--help")) {
    console.log("node scripts/benchmark-mcp.mjs --old-vsix PATH --new-vsix PATH --repository PATH --root NEW_OWNED_DIRECTORY --output PATH [--pairs 6 --calls 30 --warmup 3 --idle-ms 3000 --sizes 100,1000 --stale-counts 0,1390] [--probe]");
    return;
  }
  const flags = Object.fromEntries(args.reduce((acc, v, i) => {
    if (v.startsWith("--")) acc.push([v.slice(2), args[i + 1]?.startsWith("--") ? true : args[i + 1] ?? true]);
    return acc;
  }, []));
  const required = ["old-vsix", "new-vsix", "repository", "root", "output"];
  for (const k of required) assert(typeof flags[k] === "string", `--${k} required`);
  const options = { oldVsix: resolve(flags["old-vsix"]), newVsix: resolve(flags["new-vsix"]),
    repository: resolve(flags.repository), root: resolve(flags.root), output: resolve(flags.output),
    python: command("python3", ["-I", "-B", "-c", "import os,sys;print(os.path.realpath(sys.executable))"]).trim(),
    pairs: Number(flags.pairs ?? 6), calls: Number(flags.calls ?? 30), warmup: Number(flags.warmup ?? 3),
    idleMs: Number(flags["idle-ms"] ?? 3000), sizes: String(flags.sizes ?? "100,1000").split(",").map(Number),
    staleCounts: String(flags["stale-counts"] ?? "0,1390").split(",").map(Number), probe: !!flags.probe };
  assert(options.pairs >= 6 && options.calls >= 30 && options.warmup >= 3 && options.idleMs >= 3000,
    "At least 6 pairs, 30 calls, 3 warmups, 3 seconds idle required");
  assert(options.sizes.every(n => [100, 1000].includes(n)) && options.staleCounts.every(n => [0, 1390].includes(n)));
  assert(/^mcp-performance-[a-zA-Z0-9._-]+\.json$/.test(basename(options.output)), "Use a dedicated mcp-performance-*.json output");
  assert(!await exists(options.output), "Refuse to replace an existing evidence file");
  const hashes = { old: digest(await fs.readFile(options.oldVsix)), new: digest(await fs.readFile(options.newVsix)) };
  assert.equal(hashes.old, "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
  assert.equal(hashes.new, "c8486a6eac170d88b1dea0ac09433de1589424aca3bd5007f532780453a57df8");
  if (!flags.inside) {
    assert(!await exists(options.root), "Owned root must not exist; refuse adoption");
    await fs.mkdir(options.root, { mode: 0o700 });
    for (const name of ["home", "scratch/runtime"]) await fs.mkdir(join(options.root, name), { recursive: true, mode: 0o700 });
    await write(join(options.root, ".benchmark-owned.json"), { schema: "pkm.mcp-performance-owned/v1", nonce: randomUUID() });
    command("unshare", ["-Urn", "true"]);
    const absoluteArgs = args.map((value, i) => required.includes(args[i - 1]?.slice(2)) ? resolve(value) : value);
    const child = spawn("unshare", ["-Urn", process.execPath, script, ...absoluteArgs, "--inside"],
      { cwd: options.root, env: environment(options.root), stdio: "inherit" });
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
    assert.equal(code, 0, "Isolated benchmark failed; partial raw evidence retained, no latency claims");
    return;
  }
  assert.equal(JSON.parse(await fs.readFile(join(options.root, ".benchmark-owned.json"))).schema, "pkm.mcp-performance-owned/v1");
  const report = { schema: "pkm.real-vsix-mcp-performance/v1", startedAt: stamp(), passed: false,
    options, inputSha256Before: hashes, command: [process.execPath, script, ...args.filter(a => a !== "--inside")],
    harness: { path: script, sha256: digest(await fs.readFile(script)) },
    methodology: {
      scope: "Actual OLD managed release generation and NEW accepted managed Python launcher plus actual packaged Core child; server-only. No VSCode/Electron/UI overhead.",
      isolation: "unshare -Urn: private user/network namespaces, no network interfaces brought up. Owned synthetic HOME/XDG/root only. No hooks, strace or profiling.",
      setup: "Full VSIX extraction, genuine release generator, actual legacy import and accepted NEW immutable generation factory excluded from request timings and separately recorded.",
      pythonContext: "Same real Python executable and installed fastmcp dependency versions. OLD supported generator points at an owned synthetic runtime/bin/python symlink to that executable (maintenance path stays owned), then actual OLD managed server uses ambient site-packages. NEW actual -I -S launcher pins/copies the installed fastmcp dependency closure and verifies it at startup; its existing Core worker resolves the same PATH python3. This release architecture difference is retained, not bypassed.",
      cold: "Fresh process, warm shared OS page caches; client transport connect/spawn invocation through MCP initialize plus tools/list. Synthetic registry snapshots and transport/client object construction are preflightSetupMs, explicitly excluded. Three contract-discovery calls precede separately measured first logical read. Spawn-to-first-read includes that discovery gap.",
      warm: "Three successful warmups per operation before idle and timed calls. Thirty timed calls per op/run; interleaved ops. Gateway overhead included.",
      discovery: "Common logical capability discovery is capabilities_describe(mcp.tool.get_note,v1); catalogs differ, so tools/list bytes are not asserted equivalent.",
      discoveryQualification: "Described operation identity/version/input schema/read-only classification must match, but authorization/result text and catalog revision differ. Discovery timing is descriptive, not an equal-full-output speedup claim.",
      equivalence: "Every timed read: exact title/slug/body for get; entire matching row slug/title set for list (limit=0, total and terminal next_offset, all stable identities); exact one/ten expected search hits, legacy lexical route limit20. Additionally every old/new logical payload must have the identical full canonical JSON digest across the cell.",
      wireOutput: "Native release serialization retained, not padded or rewritten. OLD get_note duplicates content in text+structuredContent, NEW returns text only; decoded logical output must be identical. Search JSON whitespace differs; discovery authorization/result text and catalog revision intentionally differ. Record transport response bytes and logical bytes separately; no output-volume reduction presented as a like-for-like latency win.",
      quantiles: "Nearest rank: sorted[ceil(q*n)-1]. Run medians/p95 and paired new/old ratios retained. Six pairs are the independent repeats, not 180 pooled requests.",
      resources: "Uninstrumented server processes observed from /proc every 250ms. Full descendant tree identified by PID+startticks; RSS sum double-counts shared pages; PSS when readable. Sampled peaks are NOT kernel peaks. CPU/IO endpoint deltas exclude short-lived children absent at endpoints; no RUSAGE whole-tree claim.",
      limits: "Shared host, fixed run order alternating AB/BA, no cache dropping, n=6 pairs: descriptive dispersion only, no precise confidence intervals or broad product claim. No network/provider/write/UI/agent-conversation benchmarks.",
    },
    host: { platform: process.platform, arch: process.arch, kernel: os.release(), node: process.version,
      python: command(options.python, ["-I", "-B", "-c", "import sys,platform;print(sys.version);print(platform.platform())"]).trim(),
      pythonDistributions: JSON.parse(command(options.python, ["-I", "-B", "-c",
        "import importlib.metadata as m,json;print(json.dumps({d.metadata['Name']:d.version for d in m.distributions()}))"])),
      cpu: os.cpus(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), loadAtStart: os.loadavg(),
      clock: "Node performance.now(), monotonic milliseconds", ticksPerSecond: Number(command("getconf", ["CLK_TCK"]).trim()),
      pageSize: Number(command("getconf", ["PAGESIZE"]).trim()), networkNamespace: await fs.readlink("/proc/self/ns/net") },
    provisioning: { datasets: [] }, runs: [], summaries: [], failures: [] };
  systemPageSize = report.host.pageSize;
  try {
    const { cells, runtime } = await prepare(options, report);
    report.cells = cells.map(({ fixture, ...cell }) => ({ ...cell, fixtureDigest: fixture.digest }));
    await write(options.output, report);
    const sdk = suffix => import(pathToFileURL(join(runtime, `node_modules/@modelcontextprotocol/sdk/dist/esm/${suffix}.js`)));
    const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk("client/index"), sdk("client/stdio")]);
    const context = { Client, StdioClientTransport, ticksPerSecond: report.host.ticksPerSecond };
    for (const cell of cells) {
      for (let pair = 0; pair < (options.probe ? 1 : options.pairs); pair++) {
        const order = pair % 2 ? ["new", "old"] : ["old", "new"];
        for (let pos = 0; pos < order.length; pos++) {
          const run = await runOne(options, context, cell, pair, pos, order[pos]);
          report.runs.push(run);
          await write(options.output, report);
          console.log(JSON.stringify({ cell: cell.id, pair, variant: order[pos], passed: run.passed,
            readyMs: run.readyMs, errors: run.errors }));
          assert(run.passed, `Invalid measurement: ${cell.id}/${pair}/${order[pos]}`);
        }
      }
      const runs = report.runs.filter(r => r.cellId === cell.id);
      const equivalenceChecks = {};
      for (const operation of Object.keys(runs[0].operations)) {
        if (operation === "discovery") continue;
        const samples = runs.flatMap(r => r.operations[operation].samples);
        assert.equal(new Set(samples.map(s => s.logicalSha256)).size, 1, `${operation}: OLD/NEW full logical payload differs`);
        equivalenceChecks[operation] = { calls: samples.length, fullLogicalSha256: samples[0].logicalSha256,
          oldWireBytes: [...new Set(runs.filter(r => r.variant === "old").flatMap(r => r.operations[operation].samples.map(s => s.responseBytes)))],
          newWireBytes: [...new Set(runs.filter(r => r.variant === "new").flatMap(r => r.operations[operation].samples.map(s => s.responseBytes)))] };
      }
      for (const operation of ["get_note", "list_notes", "search_notes"])
        assert.equal(new Set(runs.map(r => logicalDigest(r.contracts[operation].inputSchema))).size, 1, "Common arguments differ");
      const metrics = {
        readyMs: r => r.readyMs, firstReadMs: r => r.firstReadMs,
        spawnToFirstReadMs: r => r.spawnToFirstReadMs,
        sampledPeakTreeRssBytes: r => r.resources.sampledPeakTreeRssBytes,
        sampledPeakTreePssBytes: r => r.resources.sampledPeakTreePssBytes,
      };
      for (const op of Object.keys(runs[0].operations)) {
        metrics[`${op}.p50Ms`] = r => r.operations[op].summary.p50Ms;
        metrics[`${op}.p95Ms`] = r => r.operations[op].summary.p95Ms;
      }
      report.summaries.push({ cellId: cell.id,
        equivalenceChecks,
        discoveryQualification: { coreContractMatches: true, fullOutputEquivalent: false, improvementClaimEligible: false,
          reason: "Release authorization/result descriptions and whole-catalog revision differ" },
        paired: Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, pairedSummary(runs, metric)])) });
      await write(options.output, report);
    }
    // Canonical input must still exactly match the content actually imported/read.
    for (const dataset of report.provisioning.datasets) {
      const all = await inventory(join(dataset.source, "notes"));
      assert.deepEqual(Object.fromEntries(Object.entries(all).map(([k, v]) => [`notes/${k}`, v])), dataset.fixture.files);
      const native = await inventory(join(dataset.data, "notes"));
      assert.deepEqual(native, all);
    }
    report.immutableGenerations = [];
    for (const cell of cells) for (const variant of ["old", "new"]) {
      const setup = cell[variant], root = join(setup.managed, "generations", setup.generation);
      const after = await inventory(root);
      delete after["manifest.json"];
      assert.deepEqual(after, setup.manifest.files, `Immutable generation changed: ${cell.id}/${variant}`);
      assert.deepEqual(JSON.parse(await fs.readFile(join(root, "manifest.json"))), setup.manifest);
      report.immutableGenerations.push({ cellId: cell.id, variant, generation: setup.generation,
        verifiedFiles: Object.keys(setup.manifest.files).length, beforeEqualsAfter: true });
    }
    const factoryAfter = {};
    for (const name of Object.keys(report.provisioning.factory.dependencies))
      factoryAfter[name] = digest(await fs.readFile(join(options.repository, "experimental", name)));
    assert.deepEqual(factoryAfter, report.provisioning.factory.dependencies);
    report.provisioning.factory.dependenciesAfter = factoryAfter;
    assert.equal(digest(await fs.readFile(script)), report.harness.sha256, "Harness changed during measurement");
    report.passed = !options.probe;
    report.probeOnly = options.probe;
  } catch (e) {
    report.failures.push(String(e.stack ?? e));
    process.exitCode = 1;
  } finally {
    report.inputSha256After = { old: digest(await fs.readFile(options.oldVsix)), new: digest(await fs.readFile(options.newVsix)) };
    assert.deepEqual(report.inputSha256Before, report.inputSha256After);
    report.completedAt = stamp();
    report.host.loadAtEnd = os.loadavg();
    report.rootRetainedForFailureInvestigation = true;
    if (!process.exitCode) {
      await fs.rm(options.root, { recursive: true, force: true });
      report.rootRetainedForFailureInvestigation = false;
      report.ownedRootRemoved = !await exists(options.root);
    }
    await write(options.output, report);
  }
}
if (resolve(process.argv[1] ?? "") === script) await main(process.argv.slice(2));
