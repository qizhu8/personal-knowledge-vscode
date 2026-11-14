"use strict";
const fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const [bundle, configFile, phase] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (!config.root.includes(`${path.sep}.migration-test-work${path.sep}`)
  || !config.profileFile.startsWith(path.dirname(configFile) + path.sep))
  throw new Error("Crash worker is restricted to its own synthetic private fixture.");
const profile = {
  async get(key) { return JSON.parse(fs.readFileSync(config.profileFile, "utf8"))[key]; },
  async store(key, value) {
    const values = JSON.parse(fs.readFileSync(config.profileFile, "utf8")); values[key] = value;
    const fd = fs.openSync(config.profileFile, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(values)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
};
(async () => {
  const native = await import(pathToFileURL(bundle));
  const credentials = new (require(config.credentialsBundle).ChatRoomCredentialStore)(profile);
  const storage = await native.Storage.open(config.root, { deferRecovery: true });
  await native.admitPrivateRoom({ storage, sourceRoot: config.sourceRoot, roomId: config.roomId,
    profile, credentials, assertAuthority() {}, async authorize() { return true; },
    checkpoint(value) { if (value === phase) process.kill(process.pid, "SIGKILL"); } });
  throw new Error("Expected crash checkpoint was not reached.");
})().catch(error => { console.error(error); process.exitCode = 1; });
