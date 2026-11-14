"use strict";
const assert = require("node:assert/strict");
const { writeFile, readFile, readdir, stat, realpath } = require("node:fs/promises");
const { join } = require("node:path");
const vscode = require("vscode");

async function run() {
  const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
  const progress = async value => writeFile(join(fixture.root, "progress.json"), JSON.stringify(value));
  const extension = vscode.extensions.getExtension("pkm-nonproduction.pkm-next-nonproduction-host");
  assert(extension, "Host VSIX must be installed");
  assert.equal(await realpath(extension.extensionPath), fixture.installed);
  assert(!vscode.extensions.getExtension("uone.personal-knowledge"), "Production extension must not be loaded");
  assert(!extension.extensionPath.includes("test-driver"));
  const sourceBytes = await readFile(fixture.note, "utf8");
  const sourceStat = await stat(fixture.note);
  const invoke = suffix => vscode.commands.executeCommand(`pkm.nextHost.${suffix}`);
  for (const name of ["importPreview", "importConfirm"])
    assert(extension.packageJSON.contributes.commands.some(item => item.command === `pkm.nextHost.${name}`));

  await progress({ stage: "cancel-source" });
  await invoke("importPreview");
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "preview-deny" });
  await invoke("importPreview");
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "deny-confirm" });
  await invoke("importConfirm");
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "preview-accept" });
  await invoke("importPreview");
  assert.deepEqual((await readdir(fixture.data)).sort(), ["source"]);
  await progress({ stage: "accept-confirm" });
  await invoke("importConfirm");
  assert.equal(await readFile(join(fixture.destination, "notes", "Example.md"), "utf8"), sourceBytes);
  assert.equal(await readFile(fixture.note, "utf8"), sourceBytes);
  assert.equal((await stat(fixture.note)).mtimeMs, sourceStat.mtimeMs);
  assert.equal(extension.isActive, true);
  // The actual output is read from the workbench by the outside Playwright driver.
  await progress({ stage: "published" });
  let copied;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { copied = JSON.parse(await readFile(join(fixture.root, "ui-copied.json"), "utf8")); break; }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(copied, "Real UI must select and copy Output");
  const output = await vscode.env.clipboard.readText();
  assert(output.includes("FIRST-RUN IMPORT PREVIEW"));
  assert(output.includes("pkm.legacy-import-receipt/v1"));
  assert(output.includes('"cutover": false'));
  assert(output.includes(JSON.stringify(fixture.source)));
  assert(output.includes(JSON.stringify(fixture.destination)));
  const digests = [...output.matchAll(/"planSha256":\s*"([a-f0-9]{64})"/g)];
  assert.equal(digests.at(-1)?.[1], copied.planSha256);
  const fingerprints = [...output.matchAll(/"fingerprint":\s*"([a-f0-9]{64})"/g)];
  assert(fingerprints.length >= 3);
  assert.equal(fingerprints.at(-1)[1], fingerprints.at(-2)[1]);
  await writeFile(join(fixture.root, "output-verified.json"), '{"passed":true}');
  for (let attempt = 0; attempt < 300; attempt++) {
    try { if (JSON.parse(await readFile(join(fixture.root, "ui-passed.json"), "utf8")).passed) return; }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("UI driver did not verify receipt");
}

exports.run = async () => {
  let timer;
  try {
    await Promise.race([run(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Installed-host dialog acceptance timed out")), 75000);
    })]);
  }
  catch (error) {
    const fixture = JSON.parse(process.env.PKM_HOST_INSTALLED_FIXTURE);
    await writeFile(join(fixture.root, "progress.json"), JSON.stringify({ stage: "failed", error: String(error) }));
    throw error;
  }
  finally { clearTimeout(timer); }
};
