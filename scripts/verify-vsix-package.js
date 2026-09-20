#!/usr/bin/env node
const assert = require("assert");
const { spawnSync } = require("child_process");

const [vsixPath, expectedVersion, expectedChannel] = process.argv.slice(2);
assert(vsixPath && expectedVersion && ["stable", "pre-release"].includes(expectedChannel),
  "usage: verify-vsix-package.js <vsix> <version> <stable|pre-release>");

function unzip(args) {
  const result = spawnSync("unzip", args, { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || `unzip ${args.join(" ")} failed`);
  return result.stdout;
}

const manifest = unzip(["-p", vsixPath, "extension.vsixmanifest"]);
const packageJson = JSON.parse(unzip(["-p", vsixPath, "extension/package.json"]));
const entries = unzip(["-Z1", vsixPath]).split(/\r?\n/).filter(Boolean);
const identityTag = manifest.match(/<Identity\b[^>]*\/>/)?.[0] || "";
const attributes = Object.fromEntries([...identityTag.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
const preRelease = /<Property\b(?=[^>]*\bId="Microsoft\.VisualStudio\.Code\.PreRelease")(?=[^>]*\bValue="true")[^>]*\/>/.test(manifest);

assert.strictEqual(attributes.Id, "personal-knowledge", "VSIX identity must target personal-knowledge");
assert.strictEqual(attributes.Publisher, "Uone", "VSIX identity must target publisher Uone");
assert.strictEqual(attributes.Version, expectedVersion, "VSIX manifest version must match the requested release");
assert.strictEqual(packageJson.version, expectedVersion, "embedded package.json version must match the requested release");
assert.strictEqual(preRelease, expectedChannel === "pre-release", "VSIX channel marker must match the requested release channel");

const forbidden = entries.filter(entry => /^(extension\/(tests|docs|\.vscode|coverage)\/|extension\/planning\.md$|extension\/scripts\/verify-vsix-package\.js$)/.test(entry));
assert.deepStrictEqual(forbidden, [], `VSIX contains forbidden development files: ${forbidden.join(", ")}`);

console.log(`VSIX package test: Uone.personal-knowledge ${expectedVersion} (${expectedChannel}) metadata and boundaries OK`);