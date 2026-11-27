import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { compatibilityMcpConfiguration } from "./compatibility-mcp.js";
import { acquireCompatibilityGatewayCustody } from "./compatibility-gateway-custody.js";
import { startOrJoinCompatibilityGateway } from "./compatibility-gateway-coordination.js";
import { originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import { pinOriginalMcpBrokerFile } from "./original-mcp-relay.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const filePin = z.strictObject({ path: z.string(), sha256: digest });
const schema = z.strictObject({
  schema: z.literal("pkm.compatibility-gateway-service/v1"),
  configuration: compatibilityMcpConfiguration,
  extensionPath: z.string(), payloadBuild: digest, nonce: digest,
  verifier: filePin, fence: filePin,
});
const [filename, expected] = process.argv.slice(2);
if (process.argv.length !== 4 || !filename || !expected || !process.send)
  throw new Error("Verified native service bootstrap and private admission channel required.");
const bytes = originalMcpPrivateBytes(filename, 2_000_000);
if (hash(bytes) !== expected) throw new Error("Compatibility service bootstrap changed.");
const boot = schema.parse(JSON.parse(bytes.toString()));
const require = createRequire(pathToFileURL(filename));
function pinned(pin: z.infer<typeof filePin>) {
  if (pinOriginalMcpBrokerFile(pin.path).sha256 !== pin.sha256) throw new Error("Compatibility service module changed.");
}
pinned(boot.verifier); pinned(boot.fence); pinned(boot.configuration.node);
const { verifyNextPayload } = require(boot.verifier.path);
const { acquireLinuxRootWriterFence, assertLinuxRootStillLegacyWritable } = require(boot.fence.path);
const assertBound = () => {
  if (hash(originalMcpPrivateBytes(filename, 2_000_000)) !== expected) throw new Error("Compatibility service bootstrap changed.");
  pinned(boot.verifier); pinned(boot.fence); pinned(boot.configuration.node); pinned(boot.configuration.legacy.launcher);
  const active = JSON.parse(originalMcpPrivateBytes(join(boot.configuration.managedRoot, "active-generation.json")).toString());
  if (active.schema !== "pkm.mcp.lifecycle/v1" || active.generation !== boot.configuration.gateway.generation)
    throw new Error("Compatibility service generation changed.");
};
const assertVerified = () => {
  assertBound();
  if (verifyNextPayload(boot.extensionPath).buildId !== boot.payloadBuild) throw new Error("Compatibility service payload changed.");
};
assertVerified();
const { createNativePublicFacade } = await import("./native-public-mcp.js");
let uncertainAdmission = false, prepared = false, committed = false;
const notify = (command: string, detail?: string) => process.send?.({ command, nonce: boot.nonce, ...(detail ? { detail } : {}) });
let manager: { close(): Promise<void>; failClosed(): Promise<void>; isIdle(): boolean } | undefined;
let closing: Promise<void> | undefined;
const stop = (failed = false) => {
  if (!failed && manager && !manager.isIdle()) return Promise.resolve();
  return closing ??= (async () => {
  if (manager) await (failed ? manager.failClosed() : manager.close());
  })();
};
process.on("message", input => {
  if (input && typeof input === "object" && "nonce" in input && input.nonce === boot.nonce
  && "command" in input) {
    if (input.command === "committed") committed = true;
    if (input.command === "abort" && prepared && !committed) void stop(true).catch(() => { process.exitCode = 1; });
  }
});
process.on("disconnect", () => {
  if (prepared && !committed) void stop(true).catch(() => { process.exitCode = 1; });
});
try {
  const custody = await acquireCompatibilityGatewayCustody(boot.configuration.knowledgeRoot, async root => {
    await new Promise<void>((resolve, reject) => {
      const disconnect = () => { uncertainAdmission = true; finish(new Error("Native admission channel was lost; recovery required.")); };
      const message = (input: unknown) => {
        if (!input || typeof input !== "object") return;
        const value = input as Record<string, unknown>;
        if (value.nonce !== boot.nonce) return;
        if (value.command === "drained") finish();
        if (value.command === "refused") finish(new Error("Native predecessor drain was refused."));
        if (value.command === "abort") { uncertainAdmission = true; finish(new Error("Native admission became uncertain.")); }
      };
      function finish(error?: Error) {
        process.off("disconnect", disconnect); process.off("message", message);
        error ? reject(error) : resolve();
      }
      process.once("disconnect", disconnect); process.on("message", message);
      notify("drain");
    });
    if (!process.connected) { uncertainAdmission = true; throw new Error("Native admission channel was lost."); }
    assertLinuxRootStillLegacyWritable(root);
    const preflight = acquireLinuxRootWriterFence(root, "exclusive", 1_000);
    try { preflight.assertHeld(); } finally { preflight.release(); }
    return acquireLinuxRootWriterFence(root, "shared", 1_000);
  }, () => uncertainAdmission);
  if (!process.connected) { await custody.release(false); throw new Error("Native admission channel was lost."); }
  const attribution = { schema: "pkm.mcp.attribution/v1", source: "standalone", scope: "unknown" };
  const started = await startOrJoinCompatibilityGateway(boot.configuration, {
    ...boot.configuration.gateway, managedRoot: boot.configuration.managedRoot,
    createFacade: createNativePublicFacade, assertVerified,
  }, {
    workbenchAttribution: attribution, chatAttribution: attribution,
    acquireLegacyFence() { throw new Error("Service custody is already held."); },
    assertAllowed: assertBound, async confirm() { return false; },
  }, { kind: "owner", custody, reservation: undefined,
    assertHeld: () => custody.assertHeld(), release: clean => custody.release(clean) }, "original", {
    headless: true, onIdle() {
      void stop().catch(error => { console.error(error.message); process.exitCode = 1; });
    },
    onFailure() { void stop(true).catch(error => { console.error(error.message); process.exitCode = 1; }); },
  });
  if (!("failClosed" in started)) throw new Error("Independent service did not acquire its own custody.");
  manager = started;
  process.on("SIGINT", () => { void stop(true).catch(() => { process.exitCode = 1; }); });
  process.on("SIGTERM", () => { void stop(true).catch(() => { process.exitCode = 1; }); });
  prepared = true;
  notify("ready");
} catch (error) {
  notify("failed", error instanceof Error ? error.message : String(error));
  if (!prepared) process.disconnect?.();
  throw error;
}
