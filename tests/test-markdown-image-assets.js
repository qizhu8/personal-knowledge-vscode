#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { referencedMarkdownAssets } = require("../dist/markdown-assets");
const { attachMarkdownAssetsToSyncBundle } = require("../dist/sync-server");
const { setStorePath } = require("../dist/filestore");
const { GITHUB_SYNC_CONTENT_TYPES, githubSyncMigrationCanonicalFiles } = require("../dist/github-sync");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-markdown-assets-"));
try {
  const notes = path.join(root, "notes");
  fs.mkdirSync(path.join(notes, "Team", "Design"), { recursive: true });
  fs.mkdirSync(path.join(notes, "Team", "_assets"), { recursive: true });
  fs.mkdirSync(path.join(notes, "_assets"), { recursive: true });
  fs.writeFileSync(path.join(notes, "Team", "_assets", "plot one.png"), Buffer.from("team-plot"));
  fs.writeFileSync(path.join(notes, "_assets", "root.png"), Buffer.from("root-plot"));
  fs.writeFileSync(path.join(root, "outside.png"), Buffer.from("outside"));
  const markdown = [
    "![parent](../_assets/plot%20one.png)",
    "![root](../../_assets/root.png?raw=1#figure)",
    "![missing](_assets/missing.png)",
    "![remote](https://example.com/image.png)",
    "![pkm](pkm://knowledge/knowledge_0123456789abcdef01234567)",
    "![escape](../../../outside.png)",
    "`![code](../_assets/plot%20one.png)`",
    "```md",
    "![fenced](../_assets/plot%20one.png)",
    "```",
  ].join("\n");
  const assets = referencedMarkdownAssets(root, "notes", "Team/Design/Doc.md", markdown);
  assert.deepStrictEqual(assets.map(asset => asset.path), ["_assets/root.png", "Team/_assets/plot one.png"]);
  assert(assets.every(asset => /^sha256:[a-f0-9]{64}$/.test(asset.digest)));

  setStorePath(root);
  const bundle = attachMarkdownAssetsToSyncBundle({
    notes: [{ slug: "Team/Design/Doc", category: "Team/Design", content: markdown }],
  });
  assert.deepStrictEqual(bundle.assets.map(asset => `${asset.type}/${asset.path}`), [
    "notes/_assets/root.png",
    "notes/Team/_assets/plot one.png",
  ]);
  assert.strictEqual(Buffer.from(bundle.assets[1].data, "base64").toString(), "team-plot");

  const panelSource = fs.readFileSync(path.join(__dirname, "..", "src", "webview", "panel", "00-core.js"), "utf8");
  const resolverSource = panelSource.match(/function resourceSegments[\s\S]*?(?=\/\/ Wiki links)/);
  assert(resolverSource, "Markdown resource resolver must remain independently testable");
  const context = {
    CONTENT_BASES: { notes: "vscode-webview://unit/notes", skills: "vscode-webview://unit/skills", papers: "vscode-webview://unit/papers" },
    renderNonce: 17,
  };
  vm.createContext(context);
  new vm.Script(`${resolverSource[0]}; this.fixAssets = fixAssets;`).runInContext(context);
  const rendered = context.fixAssets(
    '<img src="../_assets/plot%20one.png"><img src="https://example.com/x.png"><img src="pkm://knowledge/id"><a href="../_assets/plot%20one.png">plot</a>',
    "Team/Design",
    "notes",
  );
  assert.match(rendered, /vscode-webview:\/\/unit\/notes\/Team\/_assets\/plot%20one\.png\?_r=17/);
  assert.match(rendered, /src="https:\/\/example\.com\/x\.png"/);
  assert.match(rendered, /src="pkm:\/\/knowledge\/id"/);
  assert.match(rendered, /href="vscode-webview:\/\/unit\/notes\/Team\/_assets\/plot%20one\.png"/);
  assert.strictEqual(
    context.fixAssets('<img src="../../../outside.png">', "Team/Design", "notes"),
    '<img src="../../../outside.png">',
    "relative resources must not escape their approved content root",
  );

  const main = path.join(root, "notes", "Team", "Design", "Doc.md");
  fs.writeFileSync(main, markdown);
  const catalog = Object.fromEntries(GITHUB_SYNC_CONTENT_TYPES.map(type => [type, []]));
  catalog.notes.push({
    id: "Team/Design/Doc",
    label: "Doc",
    cat: "Team/Design",
    isPrivate: false,
    source: main,
    destination: "notes/Team/Design/Doc.md",
    dependencies: assets.map(asset => ({ source: asset.fullPath, destination: `notes/${asset.path}` })),
  });
  assert.deepStrictEqual(
    githubSyncMigrationCanonicalFiles(catalog).map(file => file.path),
    ["notes/Team/Design/Doc.md", "notes/_assets/root.png", "notes/Team/_assets/plot one.png"],
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Markdown image assets: relative resolution, bundle transport, and GitHub dependencies OK");
