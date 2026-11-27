const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { randomUUID, randomBytes } = require("node:crypto");
const ts = require("typescript");

function fixture(t) {
  const home = path.join(__dirname, `.https-provision-${randomUUID()}`);
  const root = path.join(home, "knowledge");
  const serviceDirectory = path.join(home, "service");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const key = path.join(home, "key.pem"), cert = path.join(home, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert],
  { stdio: "ignore" });
  const stat = fs.lstatSync(root);
  const provision = { schema: "pkm.service-browser-transcript/v1", serviceIdentity: "service", root,
    rootDevice: stat.dev, rootInode: stat.ino, actorId: "browser", generation: randomUUID(),
    chatHostId: randomUUID(), namespace: "0123456789abcdef", chatId: randomUUID(), address: "127.0.0.1",
    port: 8443, httpsOrigin: "https://localhost:8443", cert: fs.readFileSync(cert, "utf8"),
    key: fs.readFileSync(key, "utf8"), token: randomBytes(32).toString("base64url") };
  const file = path.join(serviceDirectory, "browser-transcript-v1.json");
  const calls = [];
  let connectHook = () => {};
  let lifecycleLocked = false;
  const service = { pkmServiceIdentity: () => ({ identity: "service", knowledgeRoot: root, serviceDirectory }),
    async withPkmServiceLifecycleLock(_options, work) {
      lifecycleLocked = true;
      try { return await work(); } finally { lifecycleLocked = false; }
    },
    PkmServiceClient: { async connect() {
      assert.equal(lifecycleLocked, false, "Reconnect must run after releasing the singleton lifecycle lock");
      calls.push("connect");
      connectHook();
      return { async drain() {
        assert.equal(lifecycleLocked, true, "Drain and private publication must exclude singleton restarters");
        calls.push("drain");
      }, dispose() { calls.push("dispose"); } };
    } } };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname,
    "../src/runtime/pkm-browser-https-provision.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { exports: module.exports, module, process, URL, Buffer, require(name) {
    if (name === "./pkm-service") return service;
    if (name === "./pkm-service-browser-transcript") return { PKM_SERVICE_TRANSCRIPT_PROVISION: "browser-transcript-v1.json" };
    if (name === "./cross-process-lock") return require("../dist/runtime/cross-process-lock");
    if (name === "./pkm-browser-ssh-tunnel") return require("../dist/runtime/pkm-browser-ssh-tunnel");
    return require(name);
  } }, { filename: "pkm-browser-https-provision.js" });
  return { ...module.exports, provision, calls, file, setConnectHook: hook => { connectHook = hook; } };
}

test("native HTTPS setup drains before privately publishing and restarting; revoke removes the actual binding", async t => {
  const f = fixture(t);
  f.setConnectHook(() => {
    if (f.calls.length === 1) assert.equal(fs.existsSync(f.file), false);
    else {
      assert.equal(fs.lstatSync(f.file).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(f.file).nlink, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), f.provision);
    }
  });
  await f.provisionBrowserHttps({}, f.provision, () => {});
  assert.deepEqual(f.calls, ["connect", "drain", "dispose", "connect", "dispose"]);
  await assert.rejects(f.provisionBrowserHttps({}, f.provision, () => {}), /Revoke the existing/);
  await f.revokeBrowserHttps({});
  assert.equal(fs.existsSync(f.file), false);
});

test("setup validates TLS/root/interface before draining and rechecks native consent after draining", async t => {
  const f = fixture(t);
  for (const change of [{ httpsOrigin: "https://other.invalid:8443" }, { address: "0.0.0.0" },
    { port: 443 }, { rootInode: -1 }, { key: "not a private key" }]) {
    await assert.rejects(f.provisionBrowserHttps({}, { ...f.provision, ...change }, () => {}));
    assert.deepEqual(f.calls, []);
  }
  let checks = 0;
  await assert.rejects(f.provisionBrowserHttps({}, f.provision, () => {
    if (++checks === 2) throw Error("Native consent changed");
  }), /Native consent changed/);
  assert.deepEqual(f.calls, ["connect", "drain", "dispose"]);
  assert.equal(fs.existsSync(f.file), false);
});

test("SSH tunnel provisioning enforces loopback-only HTTPS before starting or draining a service", async t => {
  const f = fixture(t);
  for (const change of [{ address: "192.0.2.10" }, { httpsOrigin: "https://server.example:8443" },
    { sshTunnel: { host: "-oProxyCommand=bad" } }, { sshTunnel: { host: "server;bad" } }]) {
    await assert.rejects(f.provisionBrowserHttps({}, { ...f.provision, sshTunnel: { host: "pkm-server" }, ...change }, () => {}));
    assert.deepEqual(f.calls, []);
  }
  await f.provisionBrowserHttps({}, { ...f.provision, sshTunnel: { host: "user@pkm-server" } }, () => {});
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(saved.address, "127.0.0.1");
  assert.equal(saved.sshTunnel.host, "user@pkm-server");
  await f.revokeBrowserHttps({});
  assert.equal(fs.existsSync(f.file), false);
});

test("failed daemon startup revokes its newly published binding so setup can be retried", async t => {
  const f = fixture(t);
  f.setConnectHook(() => { if (f.calls.length > 1) throw Error("Listener port is busy"); });
  await assert.rejects(f.provisionBrowserHttps({}, f.provision, () => {}), /Listener port is busy/);
  assert.equal(fs.existsSync(f.file), false);
  f.setConnectHook(() => {});
  await f.provisionBrowserHttps({}, f.provision, () => {});
  assert.equal(fs.existsSync(f.file), true);
});

test("revocation during singleton startup cannot be reported as successful HTTPS setup", async t => {
  const f = fixture(t);
  f.setConnectHook(() => { if (f.calls.length > 1) fs.unlinkSync(f.file); });
  await assert.rejects(f.provisionBrowserHttps({}, f.provision, () => {}), { code: "ENOENT" });
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(f.calls[f.calls.length - 1], "dispose");
});
