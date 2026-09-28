const assert = require("assert");
const packageJson = require("../package.json");
const { manifestJson, parseManagedManifest } = require("../dist/github-sync");

const current = JSON.parse(manifestJson([]));
assert.strictEqual(current.schema, 3);
assert.strictEqual(current.minimumExtensionVersion, packageJson.version);
assert.deepStrictEqual(parseManagedManifest(JSON.stringify(current)).files, []);

const legacy = { ...current };
delete legacy.minimumExtensionVersion;
assert.deepStrictEqual(parseManagedManifest(JSON.stringify(legacy)).files, [],
  "existing manifests without a version requirement must remain readable");

const future = { ...current, minimumExtensionVersion: "999.0.0" };
assert.throws(
  () => parseManagedManifest(JSON.stringify(future)),
  /requires Personal Knowledge Manager 999\.0\.0 or newer[\s\S]*Upgrade the extension[\s\S]*no local content was changed/,
);

const invalid = { ...current, minimumExtensionVersion: "not-semver" };
assert.throws(() => parseManagedManifest(JSON.stringify(invalid)), /invalid minimum extension version/);

console.log("GitHub Sync extension compatibility tests passed.");
