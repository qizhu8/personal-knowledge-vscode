"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const { pathToFileURL } = require("node:url");
exports.prepare = ({ extension, root, fixture }) => {
  const reflection = require("./legacy-reflection-gate-fixture.cjs").create({ extension, root, fixture });
  const ports = require("./legacy-ported-branch-fixture.cjs").create({ extension, root, fixture });
  const oracle = path.join(fixture, "reflection-gate-original-oracle");
  fs.mkdirSync(oracle, { mode: 0o700 });
  fs.cpSync(root, path.join(oracle, "knowledge"), { recursive: true, errorOnExist: true });
  for (const file of ["native-ui-fixture-token", "reflection-gate-source.json",
    "original-installed-knowledge-server.py", "ported-branch-source.json"])
    fs.copyFileSync(path.join(fixture, file), path.join(oracle, file));
  const run = script => {
    const result = spawnSync("python3", ["-B", path.join(__dirname, script), extension, oracle],
      { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const trace = run("legacy-reflection-gate-oracle.py"), rawPorts = run("legacy-ported-branch-oracle.py");
  assert.equal(trace.final.status, "completed");
  assert.equal(trace.release.start.ok, false);
  assert.equal(rawPorts.final.status, "completed");
  fs.writeFileSync(path.join(fixture, "reflection-gate-original-trace.json"),
    JSON.stringify({ reflection: trace, ports: rawPorts }), { flag: "wx", mode: 0o600 });
  return { recipeIds: [reflection.reflection.recipeId, reflection.gate.recipeId, ports.recipe.recipeId],
    oracleRoot: path.join(oracle, "knowledge"), oracleNeverAdopted: true,
    originalReleaseRefused: trace.release.start };
};
exports.policy = ({ fixture, binding, canonicalJson }) => {
  const reflection = JSON.parse(fs.readFileSync(path.join(fixture, "reflection-gate-source.json")));
  const ports = JSON.parse(fs.readFileSync(path.join(fixture, "ported-branch-source.json")));
  const recipes = [reflection.reflection, reflection.gate, ports.recipe];
  return { id: "installed-original-reflection-gates-raw-ports", humanGates: true, portedNoops: true, staticBranches: true,
    authorizationDigest: createHash("sha256").update(canonicalJson({ binding, recipes })).digest("hex"),
    authorizeDefinition: candidate => candidate.actorId === binding.actorId && candidate.source?.kind === "recipe"
      && recipes.some(recipe => recipe.recipeId === candidate.source.recipeId
        && recipe.executableDigest === candidate.executableDigest
        && canonicalJson(candidate.node) === canonicalJson(recipe.definition.spec.nodes.find(node => node.nodeId === candidate.node.nodeId))),
  };
};

exports.startSkills = async ({ fixture, extension, storage, core, actor }) => {
  const sdk = name => import(pathToFileURL(path.join(extension, "next-runtime/server/node_modules/@modelcontextprotocol/sdk/dist/esm", name)).href);
  const { Client } = await sdk("client/index.js"), { InMemoryTransport } = await sdk("inMemory.js");
  const { startLegacyNoteMcp } = await import(pathToFileURL(path.join(extension, "next-runtime/server/dist/legacy-note-mcp.js")).href);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startLegacyNoteMcp(storage, serverTransport, { core, actor });
  const client = new Client({ name: "installed-reflection-local-skills", version: "1" });
  await client.connect(clientTransport);
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/skills" || req.headers.origin !== undefined
      || req.socket.remoteAddress !== "127.0.0.1" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403); res.end(); return;
    }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; assert(size <= 65536); chunks.push(chunk);
      }
      const { tool, args } = JSON.parse(Buffer.concat(chunks).toString());
      assert(["skill_context", "skill_feedback"].includes(tool));
      const response = await client.callTool({ name: tool === "skill_context" ? "legacy_knowledge_read" : "legacy_skill_maintenance",
        arguments: { tool, arguments: args } });
      assert(!response.isError, JSON.stringify(response));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response.structuredContent.value));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: String(error) })); }
  });
  server.requestTimeout = 10000;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(fixture, "native-reflection-skills.json"),
    JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}/skills`, token }), { mode: 0o600 });
  return { async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await client.close(); await mcp.close();
  } };
};
