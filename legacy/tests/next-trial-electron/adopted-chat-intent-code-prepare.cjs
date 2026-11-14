"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const project = process.cwd();
const stage = path.join(project, ".migration-test-work/adopted-chat-intent-check");
const fixture = path.join(project, ".migration-test-work", `chat-intent-code-${crypto.randomUUID()}`);
const bundle = path.join(fixture, "bundle"), extension = path.join(bundle, "extension");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.mkdirSync(path.join(fixture, "knowledge-root"), { recursive: true, mode: 0o700 });
fs.mkdirSync(extension, { recursive: true, mode: 0o700 });
fs.cpSync(path.join(stage, "dist"), path.join(extension, "dist"), { recursive: true });
const driverSource = path.join(project, "tests/next-trial-electron/adopted-chat-intent-code-driver.cjs");
fs.copyFileSync(driverSource, path.join(extension, "extension.cjs"));
const actor = path.join(fixture, "actor.py"), controller = path.join(fixture, "controller.cjs");
fs.copyFileSync(path.join(project, "tests/adopted_chat_intent_code_ui.py"), actor);
fs.copyFileSync(path.join(project, "tests/next-trial-electron/adopted-chat-intent-code-controller.cjs"), controller);
fs.writeFileSync(path.join(extension, "package.json"), JSON.stringify({
  name: "private-chat-intent-fixture", publisher: "fixture", version: "0.0.1",
  displayName: "Private Chat Intent Fixture", engines: { vscode: "^1.90.0" },
  capabilities: { untrustedWorkspaces: { supported: true } },
  main: "./extension.cjs", activationEvents: ["onStartupFinished"],
  contributes: { commands: [
    { command: "pkmIntentFixture.ask", title: "PKM Intent Fixture: Ask" },
    { command: "pkmIntentFixture.revoke", title: "PKM Intent Fixture: Revoke" },
  ] },
}, null, 2));
fs.writeFileSync(path.join(bundle, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="cjs" ContentType="application/javascript"/>
  <Default Extension="html" ContentType="text/html"/>
  <Default Extension="css" ContentType="text/css"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="ttf" ContentType="application/octet-stream"/>
  <Default Extension="woff" ContentType="application/octet-stream"/>
  <Default Extension="woff2" ContentType="application/octet-stream"/>
  <Default Extension="map" ContentType="application/json"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml"/>
</Types>`);
fs.writeFileSync(path.join(bundle, "extension.vsixmanifest"), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="private-chat-intent-fixture" Version="0.0.1" Publisher="fixture" />
    <DisplayName>Private Chat Intent Fixture</DisplayName>
    <Description xml:space="preserve">Private isolated user intent test.</Description>
    <Categories>Other</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>`);
const vsix = path.join(fixture, "private-chat-intent-fixture.vsix");
const zip = spawnSync("zip", ["-q", "-r", vsix, "."], { cwd: bundle, encoding: "utf8" });
if (zip.status !== 0 || zip.error) throw zip.error || new Error(zip.stderr);
const python = process.env.PKM_BROWSER_PYTHON;
if (!python || !path.isAbsolute(python)) throw new Error("Specify an existing absolute PKM_BROWSER_PYTHON.");
const editor = fs.realpathSync(path.join(os.homedir(), ".cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code"));
const xvfb = fs.realpathSync(path.join(os.homedir(), ".cache/pkm-vscode-test/tools/xvfb/usr/bin/Xvfb"));
for (const executable of [editor, xvfb, python]) fs.accessSync(executable, fs.constants.X_OK);
const contract = { fixture, vsix, vsixSha256: digest(vsix), actor, actorSha256: digest(actor), controller,
  controllerSha256: digest(controller), driverSha256: digest(driverSource),
  issuerSha256: digest(path.join(extension, "dist/chat/adopted-root-chat-authority.js")), python, editor, xvfb };
const contractFile = path.join(fixture, "contract.json");
fs.writeFileSync(contractFile, JSON.stringify(contract, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ contractFile, ...contract }, null, 2));
