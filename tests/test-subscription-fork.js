#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { forkRootName, forkSubscriptionContent } = require("../dist/subscription-fork");
const storage = require("../dist/storage");

const store = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-subscription-fork-"));
try {
  const creativeRoot = forkRootName("CreativeGen", "alice", "host-a");
  assert.match(creativeRoot, /^_folk_CreativeGen - alice - host-a--[a-f0-9]{12}$/);
  assert.strictEqual(forkRootName("CreativeGen", "alice", "host-a"), creativeRoot, "folk identity must be stable");
  assert.notStrictEqual(forkRootName("CreativeGen", "bob", "host-b"), creativeRoot, "same-name Brokers from different publishers must not collide");

  const skillPath = forkSubscriptionContent(store, {
    type: "skills",
    brokerName: "CreativeGen",
    publisherUser: "alice",
    publisherHost: "host-a",
    remotePath: "Ads/Data Quality/assetquality-snorkel-weak-supervision.md",
    content: "# Weak supervision\n",
  });
  assert.strictEqual(skillPath, `skills/${creativeRoot}/Ads/Data Quality/assetquality-snorkel-weak-supervision.md`);
  assert.strictEqual(fs.readFileSync(path.join(store, skillPath), "utf8"), "# Weak supervision\n");
  assert.strictEqual(fs.existsSync(path.join(store, "skills", creativeRoot, ".gitkeep")), true, "folk root must persist until explicitly deleted");
  assert.throws(() => forkSubscriptionContent(store, {
    type: "skills", brokerName: "CreativeGen", publisherUser: "alice", publisherHost: "host-a", remotePath: "Ads/Data Quality/assetquality-snorkel-weak-supervision.md", content: "overwrite",
  }), /already exists/, "Fork must never overwrite an existing local copy");

  const collectionPath = forkSubscriptionContent(store, {
    type: "skills", brokerName: "CreativeGen", publisherUser: "alice", publisherHost: "host-a", remotePath: "",
    folder: { path: "", files: [
      { path: "Coding/Scope/scope-basics.md", content: "# Scope\n" },
      { path: "General/AML/aml-basics.md", content: "# AML\n" },
    ] },
  });
  assert.strictEqual(collectionPath, `skills/${creativeRoot}`);
  assert.strictEqual(fs.readFileSync(path.join(store, collectionPath, "Coding/Scope/scope-basics.md"), "utf8"), "# Scope\n");
  assert.strictEqual(fs.readFileSync(path.join(store, collectionPath, "General/AML/aml-basics.md"), "utf8"), "# AML\n");
  assert.strictEqual(fs.readFileSync(path.join(store, skillPath), "utf8"), "# Weak supervision\n", "whole-Broker Fork must preserve prior non-conflicting Forks");
  assert.throws(() => forkSubscriptionContent(store, {
    type: "skills", brokerName: "CreativeGen", publisherUser: "alice", publisherHost: "host-a", remotePath: "",
    folder: { path: "", files: [{ path: "Coding/Scope/scope-basics.md", content: "overwrite" }] },
  }), /already exists/, "whole-Broker Fork must reject conflicts without overwriting");

  const folderPath = forkSubscriptionContent(store, {
    type: "notes",
    brokerName: "ResearchHost",
    publisherUser: "researcher",
    publisherHost: "gpu-01",
    remotePath: "Research/MiniRAG",
    folder: { path: "Research/MiniRAG", files: [
      { path: "Index.md", content: "# MiniRAG\n" },
      { path: "Ideas/Next.md", content: "# Next\n" },
    ] },
  });
  const researchRoot = forkRootName("ResearchHost", "researcher", "gpu-01");
  assert.strictEqual(folderPath, `notes/${researchRoot}/Research/MiniRAG`);
  assert.strictEqual(fs.existsSync(path.join(store, "notes", researchRoot, ".gitkeep")), true);
  assert.strictEqual(fs.readFileSync(path.join(store, folderPath, "Index.md"), "utf8"), "# MiniRAG\n");
  assert.strictEqual(fs.readFileSync(path.join(store, folderPath, "Ideas/Next.md"), "utf8"), "# Next\n");
  assert.throws(() => forkSubscriptionContent(store, {
    type: "notes", brokerName: "ResearchHost", publisherUser: "researcher", publisherHost: "gpu-01", remotePath: "Research/MiniRAG",
    folder: { path: "Research/MiniRAG", files: [{ path: "Index.md", content: "overwrite" }] },
  }), /already exists/, "Folder Fork must never merge into or overwrite an existing local folder");

  const packageSource = {
    type: "packages",
    brokerName: "CreativeGen",
    publisherUser: "alice",
    publisherHost: "host-a",
    remotePath: "asset-tool",
    package: { name: "asset-tool", files: [
      { path: "README.md", content: "# Asset Tool\n" },
      { path: "src/check.py", content: "print('ok')\n" },
    ] },
  };
  const packagePath = forkSubscriptionContent(store, packageSource);
  assert.strictEqual(packagePath, "packages/asset-tool_CreativeGen");
  assert.strictEqual(fs.readFileSync(path.join(store, packagePath, "README.md"), "utf8"), "# Asset Tool\n");
  assert.strictEqual(fs.readFileSync(path.join(store, packagePath, "src", "check.py"), "utf8"), "print('ok')\n");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(store, packagePath, ".pkm-package.json"), "utf8")), {
    schema: 1, kind: "subscription-fork", originalName: "asset-tool", brokerName: "CreativeGen", publisherUser: "alice", publisherHost: "host-a",
  });
  assert.strictEqual(forkSubscriptionContent(store, packageSource), "packages/asset-tool_CreativeGen1");
  assert.strictEqual(forkSubscriptionContent(store, packageSource), "packages/asset-tool_CreativeGen2");
  storage.setStorePath(store);
  const forkedPackages = storage.packageList().filter(item => item.name.startsWith("asset-tool_CreativeGen"));
  assert.deepStrictEqual(forkedPackages.map(item => item.name).sort(), ["asset-tool_CreativeGen", "asset-tool_CreativeGen1", "asset-tool_CreativeGen2"]);
  assert.deepStrictEqual(forkedPackages[0].source, { kind: "subscription-fork", originalName: "asset-tool", brokerName: "CreativeGen", publisherUser: "alice", publisherHost: "host-a" });
  assert.strictEqual(fs.existsSync(path.join(store, "packages", creativeRoot)), false, "Package Fork must not create a nested folk folder");
  assert.throws(() => forkSubscriptionContent(store, {
    type: "packages", brokerName: "CreativeGen", publisherUser: "alice", publisherHost: "host-a", remotePath: "bad", package: { name: "bad", files: [{ path: "../escape", content: "bad" }] },
  }), /unsafe path/, "Package Fork must reject traversal before writing any file");
  assert.strictEqual(fs.existsSync(path.join(store, "packages", "bad_CreativeGen")), false);

  console.log("Subscription Fork test: Broker-rooted files and folders, complete packages, conflict rejection, and traversal safety OK");
} finally {
  fs.rmSync(store, { recursive: true, force: true });
}
