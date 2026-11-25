import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");

async function fixture(t) {
  const parent = resolve("tests", `.original-mcp-profile-${randomUUID()}`);
  const storage = join(parent, "profile");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  await chmod(storage, 0o700);
  const bundle = join(parent, "binding.mjs");
  await build({
    stdin: { contents: `
      export {originalMcpProfileBinding} from "./src/original-mcp-profile-binding.ts";
      export {bindOriginalMcpEnrollment,originalMcpEnrollmentName,bindOriginalMcpNativeBootstrap,originalMcpNativeBootstrapName}
        from "./clients/vscode-host/original-mcp-enrollment.ts";
    `, resolveDir: resolve() },
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const api = await import(pathToFileURL(bundle).href);
  t.after(() => rm(parent, { recursive: true }));
  const profile = api.originalMcpProfileBinding(storage);
  const enrollment = { schema: "pkm.original-mcp-enrollment/v1",
    descriptorPath: join(parent, "descriptor.json"), descriptorSha256: "a".repeat(64), profileSha256: profile.sha256 };
  const file = join(storage, api.originalMcpEnrollmentName);
  return { parent, storage, api, profile, enrollment, file };
}

test("native profile enrollment is explicit, profile-bound and cannot hot-activate or change its launch pin", async t => {
  const f = await fixture(t);
  const absent = f.api.bindOriginalMcpEnrollment(f.storage);
  assert.equal(absent.current(), undefined);
  await writeFile(f.file, JSON.stringify(f.enrollment), { mode: 0o600 });
  assert.throws(() => absent.current(), /ENROLLMENT_UNAVAILABLE/);
  const active = f.api.bindOriginalMcpEnrollment(f.storage);
  assert.deepEqual(active.current(), f.enrollment);
  await writeFile(f.file, JSON.stringify({ ...f.enrollment, descriptorSha256: "b".repeat(64) }));
  assert.throws(() => active.current(), /ENROLLMENT_UNAVAILABLE/);
  assert.deepEqual(f.api.originalMcpProfileBinding(f.storage), f.profile, "Ordinary profile file changes do not replace profile identity.");
});

test("enrollment cannot rebind another profile, accept unsafe storage/files, aliases, or arbitrary fields", async t => {
  const f = await fixture(t);
  for (const value of [
    { ...f.enrollment, profileSha256: "0".repeat(64) },
    { ...f.enrollment, descriptorPath: "../untrusted.json" },
    { ...f.enrollment, token: "credentials-must-not-be-in-enrollment" },
  ]) {
    await writeFile(f.file, JSON.stringify(value), { mode: 0o600 });
    assert.throws(() => f.api.bindOriginalMcpEnrollment(f.storage), /ENROLLMENT_UNAVAILABLE/);
  }
  await writeFile(f.file, JSON.stringify(f.enrollment));
  await chmod(f.file, 0o644);
  assert.throws(() => f.api.bindOriginalMcpEnrollment(f.storage), /ENROLLMENT_UNAVAILABLE/);
  await chmod(f.file, 0o600);
  await chmod(f.storage, 0o755);
  assert.throws(() => f.api.bindOriginalMcpEnrollment(f.storage), /PROFILE_UNAVAILABLE/);
  await chmod(f.storage, 0o700);
  const alias = join(f.parent, "alias");
  await symlink(f.storage, alias);
  assert.throws(() => f.api.bindOriginalMcpEnrollment(alias), /PROFILE_UNAVAILABLE/);
  const moved = join(f.parent, "old-profile");
  await rename(f.storage, moved);
  await mkdir(f.storage, { mode: 0o700 });
  await writeFile(f.file, JSON.stringify(f.enrollment), { mode: 0o600 });
  assert.throws(() => f.api.bindOriginalMcpEnrollment(f.storage), /ENROLLMENT_UNAVAILABLE/);
});

test("native attachment bootstrap is frozen separately and can never enroll a business MCP endpoint", async t => {
  const f = await fixture(t);
  const file = join(f.storage, f.api.originalMcpNativeBootstrapName);
  const value = { ...f.enrollment, schema: "pkm.original-mcp-native-bootstrap/v1" };
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  assert.equal(f.api.bindOriginalMcpEnrollment(f.storage).current(), undefined);
  const active = f.api.bindOriginalMcpNativeBootstrap(f.storage);
  assert.deepEqual(active.current(), value);
  await writeFile(file, JSON.stringify({ ...value, descriptorSha256: "f".repeat(64) }));
  assert.throws(() => active.current(), /ENROLLMENT_UNAVAILABLE/);
  await writeFile(file, JSON.stringify(f.enrollment));
  assert.throws(() => f.api.bindOriginalMcpNativeBootstrap(f.storage), /ENROLLMENT_UNAVAILABLE/);
});

async function providerFixture(t) {
  const f = await fixture(t);
  const requiredIds = JSON.parse(await readFile(new URL("fixtures/original-public-mcp-discovery.json", import.meta.url), "utf8"))
    .describes.map(entry => entry.operation);
  const bundle = join(f.parent, "provider.mjs");
  await build({
    stdin: { contents: `
      export {registerIsolatedMcp} from "./clients/vscode-host/mcp-provider.ts";
      export {setDescriptorFixture} from "descriptor-fixture";
    `, resolveDir: resolve() },
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
    plugins: [{
      name: "readonly-descriptor-fixture",
      setup(plugin) {
        plugin.onResolve({ filter: /(?:original-mcp-broker-descriptor\.js|^descriptor-fixture)$/ },
          () => ({ path: "fixture", namespace: "descriptor-fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "descriptor-fixture" }, () => ({ contents: `
          let selected;
          export const setDescriptorFixture = value => { selected = value; };
          export async function verifyOriginalMcpBrokerDescriptor(path, pin, profile) {
            if (!selected || selected.refused || path !== selected.descriptorPath
              || pin !== selected.descriptorSha256 || profile !== selected.profileSha256)
              throw new Error("DESCRIPTOR_REFUSED");
            const ids = ${JSON.stringify(requiredIds)};
            return {nodePath:"/fixture/pinned-node",relayPath:"/fixture/pinned-relay.js",
              writable: selected.writable !== false,
              enabledOperationIds: selected.partial ? ids.slice(0,-1) : ids,
              disabledOperationIds: selected.partial ? [ids.at(-1)] : []};
          }
        ` }));
      },
    }],
  });
  const module = await import(pathToFileURL(bundle).href);
  let provider, legacyPresent = false, disposed = false;
  const native = {
    EventEmitter: class {
      listeners = new Set();
      event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
      fire() { for (const listener of this.listeners) listener(); }
      dispose() { this.listeners.clear(); }
    },
    Uri: { file: path => ({ scheme: "file", authority: "", path, query: "", fragment: "" }) },
    McpStdioServerDefinition: class {
      constructor(label, command, args, env) { Object.assign(this, { label, command, args, env }); }
    },
    lm: { registerMcpServerDefinitionProvider(_id, selected) {
      provider = selected;
      return { dispose() { disposed = true; } };
    } },
    extensions: { getExtension: id => legacyPresent && id === "Uone.personal-knowledge" ? {} : undefined },
  };
  module.setDescriptorFixture(f.enrollment);
  return { ...f, module, native, provider: () => provider,
    setLegacy: value => { legacyPresent = value; }, disposed: () => disposed };
}

test("native original-broker route passes only pinned relay arguments and rejects legacy/managed-root conflicts", async t => {
  const f = await providerFixture(t);
  let managed;
  const binding = f.module.registerIsolatedMcp(f.native, () => managed, () => f.enrollment);
  t.after(() => binding.dispose());
  const provider = f.provider();
  const [definition] = await provider.provideMcpServerDefinitions();
  assert.equal(definition.command, "/fixture/pinned-node");
  assert.match(definition.label, /original library/);
  assert.deepEqual(definition.args, ["/fixture/pinned-relay.js", "relay", "--descriptor",
    f.enrollment.descriptorPath, "--pin", f.enrollment.descriptorSha256]);
  assert.deepEqual(definition.env, { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(definition.version, f.enrollment.descriptorSha256);
  assert.equal(await provider.resolveMcpServerDefinition(definition), definition);
  f.setLegacy(true);
  await assert.rejects(provider.resolveMcpServerDefinition(definition), /LEGACY_EXTENSION_PRESENT/);
  await assert.rejects(provider.provideMcpServerDefinitions(), /LEGACY_EXTENSION_PRESENT/);
  f.setLegacy(false);
  managed = "/fixture/conflicting-managed-root";
  await assert.rejects(provider.provideMcpServerDefinitions(), /CONFIGURATION_CONFLICT/);
});

test("native broker definitions fail closed on changed descriptor, definition, or missing native inventory", async t => {
  const f = await providerFixture(t);
  const binding = f.module.registerIsolatedMcp(f.native, () => undefined, () => f.enrollment);
  t.after(() => binding.dispose());
  const provider = f.provider();
  const [definition] = await provider.provideMcpServerDefinitions();
  definition.args.push("--changed");
  await assert.rejects(provider.resolveMcpServerDefinition(definition), /stale or changed/);
  const [next] = await provider.provideMcpServerDefinitions();
  for (const change of [{ partial: true }, { writable: false }]) {
    f.module.setDescriptorFixture({ ...f.enrollment, ...change });
    await assert.rejects(provider.resolveMcpServerDefinition(next), /FULL_PARITY_REQUIRED/);
  }
  f.module.setDescriptorFixture({ ...f.enrollment, refused: true });
  await assert.rejects(provider.resolveMcpServerDefinition(next), /DESCRIPTOR_REFUSED/);
  delete f.native.extensions;
  await assert.rejects(provider.provideMcpServerDefinitions(), /NATIVE_INVENTORY_UNAVAILABLE/);
});
