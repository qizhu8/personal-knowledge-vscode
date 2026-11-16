import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { hash, packageRoot, readOriginalSource } from "../scripts/migration.mjs";

test("knowledge historical dataset uses its separate pinned archive, never changed current source bytes", async () => {
  const path = "src/knowledge/filestore.ts";
  const sha256 = "c5c3a9761562818529a00aedb96aef254bef34dc80a4ed31f31efd39bc7a97a5";
  assert.equal(hash(await readOriginalSource(path, {
    sha256, dataset: "knowledge-document-lifecycle-historical",
  })), sha256);
  await assert.rejects(readOriginalSource(path, { sha256 }),
    error => error.evidenceReason === "hash-changed");
  await assert.rejects(readOriginalSource(path, {
    sha256: "0".repeat(64), dataset: "knowledge-document-lifecycle-historical",
  }), error => error.evidenceReason === "generation-mismatch");
  await assert.rejects(readOriginalSource(path, {
    sha256, dataset: "compiler-candidate-432",
  }), error => error.evidenceReason === "generation-mismatch");
});

test("inline-note historical aliases require exact protected source pins and authenticate all archive members", async () => {
  const metadata = JSON.parse(await readFile(new URL("../migration/evidence/knowledge-authentication-originals.json", import.meta.url), "utf8"));
  for (const member of metadata.members) {
    const dataset = member.path === "scripts/capture-knowledge-mutations.mjs"
      ? "knowledge-mutations-producer-historical" : member.path === "tests/test-markdown-owned-assets.js"
      ? "knowledge-knowledge-mutations-historical" : member.path === "src/knowledge/markdown-assets.ts"
        ? "knowledge-document-lifecycle-historical" : "knowledge-inline-note-historical";
    assert.equal(hash(await readOriginalSource(member.path, {
      sha256: member.sha256, dataset,
    })), member.sha256);
  }
  await assert.rejects(readOriginalSource("src/domain/note-work-items.ts", {
    sha256: "64f39b26b1d115e92ed5fc1f31c81ef746baf325ea07689c2407449a66aab76e",
    dataset: "knowledge-inline-note-historical",
  }), error => error.evidenceReason === "generation-mismatch");
});

test("historical producer authentication rejects wrong bytes and wrong digest under the protected producer pin", async () => {
  const { script } = JSON.parse(await readFile(new URL("../migration/knowledge-mutations-provenance.json", import.meta.url), "utf8"));
  const metadata = JSON.parse(await readFile(new URL("../migration/evidence/knowledge-authentication-originals.json", import.meta.url), "utf8"));
  const wrongMember = metadata.members.find(member => member.path === "src/knowledge/filestore.ts");
  await assert.rejects(readOriginalSource(`${metadata.archive}!/${wrongMember.member}`, {
    root: packageRoot, sha256: script.sha256, archiveSha256: metadata.archiveSha256,
  }), error => error.evidenceReason === "hash-changed");
  await assert.rejects(readOriginalSource(script.path, {
    sha256: wrongMember.sha256, dataset: "knowledge-mutations-producer-historical",
  }), error => error.evidenceReason === "generation-mismatch");
});

test("shared capture pins bind normalized knowledge targets without treating current native files as originals", async () => {
  const metadata = JSON.parse(await readFile(new URL("../migration/knowledge-mutations-provenance.json", import.meta.url), "utf8"));
  const { path, sha256 } = metadata.capture;
  assert.equal(hash(await readOriginalSource(path, {
    kind: "captured", sha256, dataset: "knowledge-knowledge-mutations-historical",
  })), sha256);
  await assert.rejects(readOriginalSource(path, {
    kind: "captured", sha256: "0".repeat(64), dataset: "knowledge-knowledge-mutations-historical",
  }), error => error.evidenceReason === "generation-mismatch");
});
