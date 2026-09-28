#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const core = read("src/webview/panel/00-core.js");
const knowledge = read("src/webview/panel/20-knowledge.js");
const github = read("src/webview/panel/46-github-sync.js");
const mcp = read("src/webview/panel/50-mcp.js");
const skillRouter = read("src/webview/panel/51-skill-router.js");
const projects = read("src/webview/panel/15-projects.js");
const plain = value => JSON.parse(JSON.stringify(value));

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const freshnessStart = core.indexOf("const TAB_CACHE_FRESH_MS");
const freshnessEnd = core.indexOf("\nconst pendingActionButtons", freshnessStart);
const freshnessContext = {};
vm.createContext(freshnessContext);
vm.runInContext(`${core.slice(freshnessStart, freshnessEnd)};this.isFresh=tabCacheIsFresh;this.maxAge=TAB_CACHE_FRESH_MS`, freshnessContext);
assert.strictEqual(freshnessContext.maxAge, 120000);
assert.strictEqual(freshnessContext.isFresh(0, 120000), false);
assert.strictEqual(freshnessContext.isFresh(1, 120000), true);
assert.strictEqual(freshnessContext.isFresh(1, 120001), false);

function verifyCachedTab(source, functionName, cacheName, updatedAtName, renderName, loadingName, command) {
  const calls = [];
  const context = {
    [cacheName]: { cached: true },
    [updatedAtName]: 100,
    [renderName]: data => calls.push(["render", data]),
    [loadingName]: () => calls.push(["loading"]),
    tabCacheIsFresh: value => value === 100,
    ask: (...args) => calls.push(["ask", ...args]),
  };
  vm.createContext(context);
  vm.runInContext(`${functionSource(source, functionName)};this.show=${functionName}`, context);
  context.show();
  assert.deepStrictEqual(plain(calls), [["render", { cached: true }]], `${functionName} must reuse a fresh cache without requesting`);

  calls.length = 0;
  context[updatedAtName] = 50;
  context.show();
  assert.deepStrictEqual(plain(calls), [["render", { cached: true }], ["ask", command, {}, null, true]],
    `${functionName} must render stale cache before silent revalidation`);

  calls.length = 0;
  context[cacheName] = null;
  context[updatedAtName] = 0;
  context.show();
  assert.deepStrictEqual(plain(calls), [["loading"], ["ask", command, {}, null, false]],
    `${functionName} must show loading only when no cached data exists`);
}

verifyCachedTab(mcp, "showMcpTab", "mcpStatusCache", "mcpStatusUpdatedAt", "renderMcpPane", "renderMcpLoading", "checkMcp");
verifyCachedTab(skillRouter, "showSkillRouterTab", "skillRouterStatusCache", "skillRouterStatusUpdatedAt", "renderSkillRouterPane", "renderSkillRouterLoading", "skillRouterStatus");

const githubCalls = [];
const githubContext = {
  githubSyncUpdatedAt: 100,
  renderGitHubSyncPane: () => githubCalls.push(["render"]),
  renderGitHubSyncLoading: () => githubCalls.push(["loading"]),
  tabCacheIsFresh: value => value === 100,
  ask: (...args) => githubCalls.push(["ask", ...args]),
};
vm.createContext(githubContext);
vm.runInContext(`${functionSource(github, "showGitHubSyncTab")};this.show=showGitHubSyncTab`, githubContext);
githubContext.show();
assert.deepStrictEqual(plain(githubCalls), [["render"]]);
githubCalls.length = 0;
githubContext.githubSyncUpdatedAt = 50;
githubContext.show();
assert.deepStrictEqual(plain(githubCalls), [["render"], ["ask", "githubSyncState", {}, null, true]]);
githubCalls.length = 0;
githubContext.githubSyncUpdatedAt = 0;
githubContext.show();
assert.deepStrictEqual(plain(githubCalls), [["loading"], ["ask", "githubSyncState", {}, null, false]]);

assert.match(knowledge, /state\.tab === 'mcp'[\s\S]{0,220}showMcpTab\(\)/);
assert.match(knowledge, /state\.tab === 'skillRouter'[\s\S]{0,220}showSkillRouterTab\(\)/);
assert.match(knowledge, /state\.tab === 'githubSync'[\s\S]{0,220}showGitHubSyncTab\(\)/);
assert.doesNotMatch(knowledge, /state\.tab === 'mcp'[\s\S]{0,180}renderMcpLoading\(\)[\s\S]{0,80}ask\('checkMcp'/);
assert.match(core, /command === 'mcpStatus'[\s\S]{0,180}mcpOnStatus\(data\)/);
assert.match(core, /command === 'skillRouterStatus'[\s\S]{0,120}skillRouterOnStatus\(data\)/);
assert.match(mcp, /mcpPathSizeCache\.set\(String\(data\.key\), data\)/);
assert.match(mcp, /for \(const cached of mcpPathSizeCache\.values\(\)\) renderMcpPathSize\(cached\)/);
assert.match(mcp, /if \(data\?\.preview\) mcpGeneratedCache = data/);
assert.match(github, /title="Refresh GitHub Sync"[\s\S]{0,100}ask\('githubSyncState'/);
const recipeBranch = knowledge.slice(knowledge.indexOf("} else if (state.tab === 'recipes')"), knowledge.indexOf("} else if (state.tab === 'projects')"));
assert(recipeBranch.indexOf("renderGlobalRecipes();") < recipeBranch.indexOf("if (!projectSnapshot || projectSnapshotDirty) ask('projectState', {});"),
  "Recipe Library must render its snapshot before requesting only when missing or invalidated");
assert.match(projects, /function recipeRefresh\(\) \{\s*ask\('projectState'/, "Recipe Library must retain explicit Refresh");
assert.match(projects, /function projectOnResult\(data\) \{[\s\S]{0,300}projectSnapshotDirty = false/,
  "authoritative mutation snapshots must clear Recipe Library invalidation");
assert.match(projects, /function recipeSnapshotSignature\(snapshot\)[\s\S]*recipeStateChanged[\s\S]*if \(!recipeStateChanged\) return/,
  "unchanged Project snapshots must not rebuild the Recipe Library DOM");
assert.match(projects, /focusIndex[\s\S]*selectionStart[\s\S]*treeTop[\s\S]*setSelectionRange/,
  "real Recipe updates must restore id-less focus, caret selection, and CatTree scroll");

console.log("tab cache UI tests passed");
