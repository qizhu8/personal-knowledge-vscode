import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost, withOriginalMcpPublicRequest } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { canonicalJson } from "../dist/domain/project-recipes-workflow-contracts.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";

const usage = await import(process.env.PKM_RECIPE_USAGE_MODULE || "../dist/original-mcp-recipe-usage.js");
const hash = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const actor = { id: "mcp:external", canWrite: false };
const sourceLimits = { maxFiles: 10_000, maxFileBytes: 1_048_576, maxTotalBytes: 16_777_216 };
const original = resolve("legacy/resources/recipe_runtime.py");
const python = `
import ast,json,os,sys,uuid
from pathlib import Path
request=json.load(sys.stdin)
source=sys.argv[1]
names={'_atomic_write','_json','_load_run','_recipe_usage_groups','_run_retry_count','_run_failure_count'}
ns={'os':os,'uuid':uuid,'json':json,'Path':Path,'RUN_SCHEMA':'pkm.recipe.run/v1',
    'USAGE_SUMMARY_GROUP_LIMIT':100,'USAGE_SUMMARY_RUN_SCAN_LIMIT':5000}
for node in ast.parse(Path(source).read_text()).body:
 if isinstance(node,ast.FunctionDef) and node.name in names:
  exec(compile(ast.Module(body=[node],type_ignores=[]),source,'exec'),ns)
store=Path(request['root'])
if request.get('write'):
 for run in request['runs']:
  ns['_atomic_write'](store/'.pkm/state/recipe-runs'/(run['runId']+'.json'),run)
else:
 try:
  summaries,truncated,scanned=ns['_recipe_usage_groups'](store,request.get('recipe_id',''),request.get('limit',50))
  print(json.dumps({'schema':'pkm.recipe.api/v1','ok':True,'summaries':summaries,
   'runs_scanned':scanned,'scan_truncated':truncated,'accounting':'one-run-per-recipe-revision; child-runs-are-not-rolled-up'}))
 except Exception as error:
  print(json.dumps({'schema':'pkm.recipe.api/v1','ok':False,'error':{'code':'recipe-usage-summary-failed','message':str(error)}}))
`;
const oracle = request => JSON.parse(execFileSync("python3", ["-I", "-B", "-c", python, original],
  { input: JSON.stringify(request), encoding: "utf8" }));
async function fixture(t, count = 0) {
  assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Cold original writers must run in the existing private Linux test framework.");
  const base = resolve("tests", `.recipe-native-source-${randomUUID()}`), root = join(base, "root");
  mkdirSync(join(root, ".pkm/state/recipe-runs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "notes"), { mode: 0o700 });
  writeFileSync(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nOriginal Recipe source fixture.\n", { mode: 0o600 });
  writeFileSync(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const run = (index, fields = {}) => ({
    schema: "pkm.recipe.run/v1", runId: `recipe_run_${String(index).padStart(24, "0")}`, recipeId: "recipe_parent",
    recipeName: "Original 工作", recipeRevision: 2, status: "completed", nodes: {}, ...fields,
  });
  const runs = count ? Array.from({ length: count }, (_, index) => run(index)) : [
    run(0, { status: "failed", nodeAttemptCounts: { work: 3 }, nodes: { work: { state: "failed", attempt: 3 } },
      loops: { repeat: { history: [{ iteration: 1, nodes: { work: { state: "failed", attempt: 1 } } },
        { iteration: 3, nodes: { work: { state: "failed", attempt: 3 } } }] } },
      usage: { measuredTokens: { total_tokens: 125 }, estimatedTokens: 320, measuredReports: 1 } }),
    run(1, { status: "running", usage: { estimatedTokens: 170, unknownModelCalls: 1 } }),
    run(2, { recipeId: "recipe_child", recipeName: "Child only", recipeRevision: 1,
      parent: { runId: "recipe_run_000000000000000000000000" },
      usage: { measuredTokens: { total_tokens: 999 }, measuredReports: 1 } }),
    run(3, { recipeRevision: 1, recipeName: "Earlier revision" }),
    run(4, { recipeId: "recipe_😀", recipeRevision: 1, usage: { estimatedTokens: 1 } }),
    run(5, { recipeId: "recipe_Ａ", recipeRevision: 1 }),
    ...Array.from({ length: 8 }, (_, index) => run(index + 6, {
      recipeId: "recipe_rounding", recipeRevision: 1, usage: { measuredTokens: { total_tokens: index ? 0 : 1 } },
    })),
  ];
  execFileSync("python3", ["-I", "-B", "-c", python, original],
    { input: JSON.stringify({ root, write: true, runs }), env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const ignored = join(root, ".pkm/state/recipe-runs/recipe_run_corrupt.json");
  writeFileSync(ignored, "{bad", { mode: 0o600 });
  if (count) utimesSync(ignored, 1, 1);
  const before = new Map(runs.map(run => [run.runId, readFileSync(join(root, `.pkm/state/recipe-runs/${run.runId}.json`))]));
  const plan = await captureOriginalMcpCustody({ root, backup: join(base, "custody"), operatorId: "recipe-usage-fixture",
    profileSha256: hash("separate-native-fixture-profile"),
    limits: { maxEntries: 20_000, maxDepth: 16, maxBytes: 32_000_000, maxFileBytes: 1_048_576 } });
  const closes = [], lifetime = new AbortController();
  let opened, host, modelCalls = 0;
  const reopen = async () => {
    opened = await openOriginalMcpRoot(plan);
    const owner = opened.owner; closes.push(() => owner.close());
    host = await createOriginalMcpNativeHost(opened.storage, {
      profileSha256: plan.profileSha256, sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
      authorityId: "fixture-only-recipe-source-host", epoch: randomUUID(), signal: lifetime.signal,
      assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
      models: { configuration: { aiEndpoint: "https://not-called.invalid", aiModel: "not-used" }, registryAvailability: {},
        async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
        transport: { supports() { return false; }, async open() { modelCalls++; throw new Error("No Recipe read may invoke a provider."); } } },
    });
  };
  await reopen();
  t.after(async () => {
    for (const close of closes.reverse()) await close();
    for (const [id, bytes] of before) assert.deepEqual(readFileSync(join(root, `.pkm/state/recipe-runs/${id}.json`)), bytes);
    assert.equal(modelCalls, 0); rmSync(base, { recursive: true, force: true });
  });
  let decisions = 0;
  const policy = (authorize = undefined) => {
    const control = new AbortController();
    return { signal: control.signal, control, assertCurrent() { if (control.signal.aborted) throw new Error("source revoked"); },
      async authorize(request, signal) {
        decisions++;
        if (authorize) return authorize(request, signal);
        return { actorId: "mcp:external", decisionId: randomUUID(), requestSha256: hash(request), expiresAtMs: Date.now() + 120_000 };
      } };
  };
  const read = (args = {}, principal = actor, signal = undefined) => withOriginalMcpPublicRequest(opened.storage, host, {
    operation: "mcp.tool.recipe_usage_summary", version: 1, tool: "recipe_usage_summary", readOnly: true,
    arguments: args, argumentsDigest: hash(args),
  }, () => usage.readOriginalMcpRecipeUsage(opened.owner, host, principal, args, signal), signal);
  return { root, plan, policy, read, lifetime, reopen, decisions: () => decisions, ignored,
    get opened() { return opened; }, get host() { return host; } };
}

test("cold original writer usage matches real Python grouping/errors; sealed native source survives restart but consent does not", { timeout: 90_000 }, async t => {
  const f = await fixture(t), source = await usage.planOriginalMcpRecipeUsage(f.opened.owner, f.host, sourceLimits);
  await assert.rejects(f.read(), /separate Recipe source decision/);
  await assert.rejects(usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, structuredClone(source), f.policy()),
    /actual same-owner source planner/);
  const originalLimit = source.limits.maxFiles, originalPlanSha = source.planSha256;
  source.limits.maxFiles++;
  const { planSha256: _changed, ...changed } = source;
  source.planSha256 = hash(changed);
  await assert.rejects(usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source, f.policy()), /Planned source/);
  source.limits.maxFiles = originalLimit; source.planSha256 = originalPlanSha;
  const policy = f.policy();
  await usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source, policy);
  const backend = createNativePublicOwnerBackend(f.opened.owner, { actor, originalMcpHost: f.host });
  try {
    const response = await backend.invoke("original_mcp_public", { tool: "recipe_usage_summary", arguments: {} });
    assert.deepEqual(response.structuredContent, oracle({ root: f.root }));
  } finally { await backend.close(); }
  for (const args of [{}, { recipe_id: "recipe_parent" }, { recipe_id: "missing" }, { limit: 1 }, { limit: 0 },
    { limit: 101 }, { recipe_id: "x".repeat(257) }])
    assert.deepEqual(await f.read(args), oracle({ root: f.root, ...args }));
  await assert.rejects(f.read({}, { id: "other-actor", canWrite: false }), /actor-owned public read/);
  await assert.rejects(usage.readOriginalMcpRecipeUsage(f.opened.owner, f.host, actor, {}), /public read/);
  const db = f.opened.storage.connectNative();
  try { assert.throws(() => db.exec("UPDATE original_recipe_usage_rows SET record='null'"), /immutable/); }
  finally { db.close(); }
  await f.opened.owner.close(); await f.reopen();
  await assert.rejects(f.read(), /separate Recipe source decision/);
  await usage.activateOriginalMcpRecipeUsage(f.opened.owner, f.host, f.policy());
  assert.deepEqual(await f.read(), oracle({ root: f.root }));
  assert.equal(f.decisions(), 2);
  usage.revokeOriginalMcpRecipeUsage(f.opened.storage);
  await assert.rejects(f.read(), /separate Recipe source decision/);
});

test("independent source denial/cancellation/revocation and source drift never publish an authorized accounting read", { timeout: 90_000 }, async t => {
  const f = await fixture(t), source = await usage.planOriginalMcpRecipeUsage(f.opened.owner, f.host, sourceLimits);
  await assert.rejects(usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source, f.policy(async () => null)), /denied/);
  const cancel = new AbortController(), delayed = f.policy(async (_request, signal) => {
    cancel.abort();
    signal.throwIfAborted();
  });
  await assert.rejects(usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source, delayed, cancel.signal), /abort/i);
  let db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'original_recipe_usage_%'").get().count, 0); }
  finally { db.close(); }
  await assert.rejects(usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source,
    f.policy(async () => ({ actorId: "mcp:external", decisionId: randomUUID(), requestSha256: "0".repeat(64), expiresAtMs: Date.now() + 1000 }))),
  /exact request/);
  let checks = 0;
  const expireDuringPublication = f.policy();
  expireDuringPublication.assertCurrent = () => { if (++checks === 5) throw new Error("source decision revoked before COMMIT"); };
  await assert.rejects(usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source, expireDuringPublication), /before COMMIT/);
  db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'original_recipe_usage_%'").get().count, 0); }
  finally { db.close(); }
  const policy = f.policy();
  await usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source, policy);
  policy.control.abort();
  await assert.rejects(f.read(), /approval port|revoked/);
  await usage.activateOriginalMcpRecipeUsage(f.opened.owner, f.host, f.policy());
  const originalCorrupt = readFileSync(f.ignored);
  try {
    writeFileSync(f.ignored, '{"schema":"pkm.recipe.run/v1","recipeId":"not-approved"}');
    await assert.rejects(f.read(), /source identity changed|preserved bytes changed/);
  } finally { writeFileSync(f.ignored, originalCorrupt); }
  const added = join(f.root, ".pkm/state/recipe-runs/recipe_run_unapproved.json");
  try {
    writeFileSync(added, "{}");
    await assert.rejects(f.read(), /membership changed/);
  } finally { rmSync(added); }
  f.lifetime.abort();
  await assert.rejects(f.read(), /unavailable or changed/);
});

test("native accounting preserves the original newest-5000 scan boundary before filtering by identity", { timeout: 120_000 }, async t => {
  const f = await fixture(t, 5001);
  const source = await usage.planOriginalMcpRecipeUsage(f.opened.owner, f.host, sourceLimits);
  assert.equal(source.files.length, 5002); assert.equal(source.runsScanned, 5000);
  await usage.admitOriginalMcpRecipeUsage(f.opened.owner, f.host, source, f.policy());
  assert.deepEqual(await f.read({ recipe_id: "missing" }), oracle({ root: f.root, recipe_id: "missing" }));
  assert.deepEqual(await f.read(), oracle({ root: f.root }));
});
