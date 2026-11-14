const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { stopFixturePkmService, stopFixtureServices } = require("../scripts/stop-fixture-services");
const api = require("../dist/runtime/pkm-service");

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-cleanup-"));
  const home = path.join(fixtureRoot, "home"), knowledge = path.join(fixtureRoot, "knowledge");
  const storage = path.join(fixtureRoot, "storage"), extensionRoot = path.resolve(__dirname, "..");
  for (const directory of [home, knowledge, storage]) fs.mkdirSync(directory);
  const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
  let client, metadata, server, completed = false;
  try {
    process.env.HOME = process.env.USERPROFILE = home;
    const options = {
      knowledgeRoot: knowledge, globalStoragePath: storage,
      extensionVersion: require("../package.json").version,
      serviceEntryPath: path.join(extensionRoot, "dist/runtime/pkm-service-entry.js"),
      execute: async () => { throw new Error("Unexpected Sync execution."); },
    };
    const identity = api.pkmServiceIdentity(options);
    client = await api.PkmServiceClient.connect(options);
    metadata = JSON.parse(fs.readFileSync(path.join(identity.serviceDirectory, "endpoint.json"), "utf8"));
    client.dispose();
    process.kill(metadata.pid, 0);
    await assert.rejects(stopFixturePkmService({
      fixtureRoot: home, extensionRoot, storage, knowledge, home,
    }), /within the fixture root/);
    process.kill(metadata.pid, 0);
    await stopFixturePkmService({ fixtureRoot, extensionRoot, storage, knowledge, home });
    const deadline = Date.now() + 10_000;
    while (true) {
      try { process.kill(metadata.pid, 0); }
      catch (error) { if (error.code === "ESRCH") break; throw error; }
      if (Date.now() >= deadline) throw new Error("Drained fixture service process is still alive.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await stopFixturePkmService({ fixtureRoot, extensionRoot, storage, knowledge, home });
    assert.equal(process.env.HOME, home);
    assert.equal(process.env.USERPROFILE, home);
    const workerDir = path.join(storage, "retrieval", "fixture");
    fs.mkdirSync(workerDir, { recursive: true });
    const endpointPath = path.join(workerDir, "worker.json");
    let statusPid = process.pid + 1, shutdowns = 0;
    server = http.createServer((request, response) => {
      assert.equal(request.headers["x-pkm-retrieval-token"], "fixture-token");
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/status") response.end(JSON.stringify({ pid: statusPid }));
      else if (request.url === "/shutdown" && request.method === "POST") {
        shutdowns++;
        fs.unlinkSync(endpointPath);
        response.end("{}");
      } else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    fs.writeFileSync(endpointPath, JSON.stringify({ port: server.address().port, pid: process.pid, token: "fixture-token" }));
    await assert.rejects(stopFixtureServices({ fixtureRoot, extensionRoot, storage, knowledge, home }), /authenticated worker/);
    assert.equal(shutdowns, 0, "Mismatched worker PID must not receive shutdown.");
    assert(fs.existsSync(endpointPath), "Failed cleanup preserves evidence.");
    statusPid = process.pid;
    await stopFixtureServices({ fixtureRoot, extensionRoot, storage, knowledge, home });
    assert.equal(shutdowns, 1);
    assert.equal(fs.existsSync(endpointPath), false);
    completed = true;
    console.log("Fixture cleanup: detached survival reproduced; drain, process exit, scope guard, repeat cleanup and authenticated retrieval shutdown passed.");
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    client?.dispose();
    if (!completed && metadata) {
      try { process.kill(metadata.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
