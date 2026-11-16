import { initialize, Storage } from "./storage.js";
import { createNativeRuntime } from "./native-runtime.js";
import { startHttp } from "./http.js";
import { startMcp } from "./mcp.js";
import { resolve } from "node:path";
import { closeSync, writeSync } from "node:fs";
import { startStandaloneHost, readAuthorizedConfig, type StandaloneHost } from "./standalone-host.js";
import { managerTextConfigSchema } from "./host-composition-manager.js";
import { createBrowserReview, startTerminalReview } from "./host-composition-review.js";
import { assertWorkspaceBackupQuiescent } from "./workspace-backup.js";
import { z } from "zod";
import { parseArgs } from "node:util";
import { validateManagerPlan } from "./manager-plan.js";
import { codingWorkerPath } from "./domain/coding-worker-contracts.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { runLegacyImportCli, runLegacyRootInspectionCli } from "./legacy-import-cli.js";
import { runBundleImportCli } from "./bundle-import-cli.js";
import { startLegacyNoteMcp } from "./legacy-note-mcp.js";
import { legacyMcpNotePolicy } from "./legacy-mcp-note-policy.js";
import { createAdmittedLegacyKnowledgeSnapshotScheduler } from "./legacy-knowledge-snapshot-scheduler.js";
import { admitLegacyAssetClassification } from "./legacy-asset-classification.js";
import { createTrustedActionHostOptions } from "./trusted-action-host.js";
import { createVscodePluginRuntime } from "./vscode-plugin-host.js";

const codingPath = z.string().refine(codingWorkerPath);
const codingConfigSchema = z.strictObject({
  schema: z.literal("pkm.coding-host/v1"),
  files: z.array(z.strictObject({ path: codingPath, beforeHash: z.string().regex(/^[a-f0-9]{64}$/), writable: z.boolean() })).min(1).max(128),
  checks: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/), script: codingPath,
    args: z.array(z.string().max(256)).max(16), taskIds: z.array(z.string()), acceptanceIds: z.array(z.string()).min(1), e2e: z.boolean() })).min(1).max(32),
  plan: z.json(),
});

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const readyNonce = process.env.PKM_NEXT_OWNER_READY_NONCE;
  delete process.env.PKM_NEXT_OWNER_READY_NONCE;
  if (readyNonce !== undefined && (command !== "mcp" || !/^[a-f0-9]{64}$/.test(readyNonce)))
    throw new Error("Invalid private MCP owner readiness request.");
  if (command === "bundle-import") {
    await runBundleImportCli(args);
    return;
  }
  if (command === "inspect-legacy-root") {
    await runLegacyRootInspectionCli(args);
    return;
  }
  if (command === "import-plan" || command === "import" || command === "import-status" || command === "import-cleanup") {
    await runLegacyImportCli(command, args);
    return;
  }
  const { values, tokens } = parseArgs({
    args, strict: true, allowPositionals: false, tokens: true,
    options: {
      data: { type: "string" },
      port: { type: "string" },
      "read-only": { type: "boolean" },
      "experimental-legacy-note-mcp": { type: "boolean" },
      "experimental-legacy-mcp": { type: "boolean" },
      "allow-asset-classification": { type: "boolean" },
      "experimental-trusted-actions": { type: "boolean" },
      "experimental-trusted-plugins": { type: "boolean" },
      "experimental-managed-snapshot-scheduler": { type: "string" },
      config: { type: "string" },
      "human-review": { type: "string" },
      "manager-text-config": { type: "string" },
      destination: { type: "string" },
      "coding-config": { type: "string" },
      "authorized-disposable-coding-source": { type: "string" },
      "authorized-coding-stage-parent": { type: "string" },
      "allow-coding-check": { type: "string", multiple: true },
      "allow-provider": { type: "string", multiple: true },
      "allow-endpoint": { type: "string", multiple: true },
      "allow-model": { type: "string", multiple: true },
      "allow-tool": { type: "string", multiple: true },
      "allow-insecure-loopback": { type: "boolean" },
      "secret-ref": { type: "string", multiple: true },
    },
  });
  const repeatable = new Set(["allow-coding-check", "allow-provider", "allow-endpoint", "allow-model", "allow-tool", "secret-ref"]);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (token.value !== undefined && !token.value.trim()) throw new Error(`Missing value for --${token.name}.`);
    if (seen.has(token.name) && !repeatable.has(token.name)) throw new Error(`Duplicate option: --${token.name}.`);
    seen.add(token.name);
    if (command === "init" && token.name !== "data"
      || command === "backup" && !["data", "destination"].includes(token.name)
      || token.name === "port" && command !== "http")
      throw new Error(`Option --${token.name} is not supported by ${command}.`);
  }
  const directory = values.data, readOnly = values["read-only"] ?? false;
  const legacyNoteMcp = values["experimental-legacy-note-mcp"] ?? false, legacyMcp = values["experimental-legacy-mcp"] ?? false;
  const allowAssetClassification = values["allow-asset-classification"] ?? false;
  const trustedActions = values["experimental-trusted-actions"] ?? false, trustedPlugins = values["experimental-trusted-plugins"] ?? false;
  const configPath = values.config, humanMode = values["human-review"], insecure = values["allow-insecure-loopback"] ?? false;
  const managerTextPath = values["manager-text-config"], destination = values.destination;
  const codingConfigPath = values["coding-config"], codingSource = values["authorized-disposable-coding-source"];
  const codingStages = values["authorized-coding-stage-parent"], codingChecks = values["allow-coding-check"] ?? [];
  const snapshotSchedulerAdmission = values["experimental-managed-snapshot-scheduler"];
  const providers = (values["allow-provider"] ?? []).map(value => {
    if (value !== "openai-compatible" && value !== "azure-openai") throw new Error("Invalid provider policy.");
    return value;
  });
  const endpoints = values["allow-endpoint"] ?? [], models = values["allow-model"] ?? [], tools = values["allow-tool"] ?? [];
  let port = 0;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new Error("Invalid port.");
    port = Number(values.port);
  }
  if (snapshotSchedulerAdmission !== undefined && !/^[a-f0-9]{64}$/.test(snapshotSchedulerAdmission))
    throw new Error("An exact native snapshot scheduler enrollment digest is required.");
  const secrets = new Map<string, string>();
  for (const value of values["secret-ref"] ?? []) {
    const match = /^(secret:[A-Za-z0-9][A-Za-z0-9._/-]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (!match || secrets.has(match[1])) throw new Error("Invalid explicit secret reference.");
    secrets.set(match[1], match[2]);
  }
  if (!directory || !["init", "http", "mcp", "backup"].includes(command)) throw new Error("Usage: node dist/cli.js init|http|mcp|backup --data <isolated directory> [--port 0] [--read-only] [--allow-asset-classification] [--destination <NEW backup directory>]");
  if (legacyNoteMcp && (command !== "mcp" || !readOnly)) throw new Error("Experimental legacy Note MCP requires mcp --read-only and an isolated workspace.");
  if (legacyMcp && (command !== "mcp" || legacyNoteMcp))
    throw new Error("Experimental legacy MCP requires mcp and cannot combine compatibility modes.");
  if (allowAssetClassification && (!legacyMcp || readOnly))
    throw new Error("Asset classification requires writable experimental legacy MCP and its dedicated opt-in.");
  if (trustedActions && (!legacyMcp || readOnly || configPath))
    throw new Error("Trusted Actions require writable experimental legacy MCP and no model configuration.");
  if (trustedPlugins && (!["http", "mcp"].includes(command) || readOnly || configPath))
    throw new Error("Trusted Plugins require writable HTTP/MCP and no model configuration.");
  if (snapshotSchedulerAdmission && (!legacyMcp || readOnly))
    throw new Error("Native snapshot scheduler requires writable experimental managed MCP.");
  if (destination && command !== "backup" || command === "backup" && (!destination || configPath))
    throw new Error("Backup requires an explicit destination and no model configuration.");
  const experimentalSubscriptionProfile = process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_PROFILE;
  if (experimentalSubscriptionProfile && (process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST !== "1"
    || command !== "http" || readOnly || configPath || legacyMcp || legacyNoteMcp
    || !process.connected || typeof process.send !== "function"))
    throw new Error("Experimental Subscription profile requires writable HTTP and a trusted inherited host IPC.");
  if (process.env.PKM_EXPERIMENTAL_SUBSCRIPTION_HOST === "1" && !experimentalSubscriptionProfile)
    throw new Error("Experimental Subscription host requires an explicit profile.");
  if (command === "init") { console.log(JSON.stringify({ initialized: await initialize(directory) })); return; }
  if (command === "http" && (!process.env.PKM_NEXT_TOKEN || process.env.PKM_NEXT_TOKEN.length < 32)) throw new Error("Set PKM_NEXT_TOKEN to a random secret of at least 32 characters.");
  if (configPath) {
    if (command !== "http" || readOnly || !["terminal", "browser"].includes(humanMode ?? "")
      || !providers.length || !endpoints.length || !models.length || !tools.length || !secrets.size)
      throw new Error("Configured HTTP requires independent provider/endpoint/model/tool policy, explicit secret references and terminal|browser human review.");
    let coding: NativeRuntimeOptions["coding"];
    if (codingConfigPath || codingSource || codingStages || codingChecks.length) {
      if (!codingConfigPath || !codingSource || !codingStages || !codingChecks.length || managerTextPath)
        throw new Error("Coding requires pinned config, separately authorized disposable source/stage roots and explicit native checks.");
      const pinned = codingConfigSchema.parse(JSON.parse(await readAuthorizedConfig(resolve(codingConfigPath), resolve(codingConfigPath))));
      const planned = validateManagerPlan(pinned.plan);
      if (planned.status !== "ready" || pinned.checks.some(check => !codingChecks.includes(check.id))
        || codingChecks.some(id => !pinned.checks.some(check => check.id === id)))
        throw new Error("Coding plan or native check policy is invalid.");
      coding = {
        workspace: {
          owner: { actorId: "local:owner", nativeOwnerId: "standalone:disposable-coding" },
          authorizedDisposable: true, sourceRoot: resolve(codingSource), stageParent: resolve(codingStages),
          files: pinned.files, checks: pinned.checks,
          authorizeSource: files => files.length === pinned.files.length
            && files.every(file => pinned.files.some(allowed => allowed.path === file.path)),
          authorizeCheck: input => input.owner.actorId === "local:owner" && codingChecks.includes(input.commandId),
          redactOutput: output => ({ ok: !!output && typeof output === "object" && "ok" in output && output.ok === true }),
        },
        plan: async input => {
          const validated = validateManagerPlan({ ...pinned.plan as object, contract: input.contract, budget: input.budget });
          if (validated.status !== "ready" || JSON.stringify(input.contract) !== JSON.stringify(planned.plan.contract)
            || JSON.stringify(input.budget) !== JSON.stringify(planned.plan.budget)) throw new Error("Pinned coding completion contract does not match.");
          return validated;
        },
        authorizeTask: (owner, task, hash) => owner.actorId === "local:owner"
          && hash === planned.definitionHash && planned.plan.tasks.some(allowed => JSON.stringify(allowed) === JSON.stringify(task)),
      };
    }
    const evidence = Object.freeze({});
    let host: StandaloneHost;
    host = await startStandaloneHost({
      dataPath: directory, configPath: resolve(configPath),
      policy: { authorizedConfigPath: resolve(configPath), allowedProviders: providers, allowedEndpoints: endpoints,
        allowedModels: models, allowedTools: tools, allowInsecureLoopback: insecure },
      resolveSecret: async reference => { const variable = secrets.get(reference); return variable ? process.env[variable] : undefined; },
      authenticateHuman: value => value === evidence ? { workspaceId: host.workspaceId, actorId: "local:owner",
        readOnly: false, authorities: ["approval"] } : null,
      managerText: managerTextPath ? managerTextConfigSchema.parse(JSON.parse(await readAuthorizedConfig(resolve(managerTextPath), resolve(managerTextPath)))) : undefined,
      coding,
    });
    let stopReview: () => void = () => {};
    let transport: Awaited<ReturnType<typeof startHttp>>;
    try {
      const browser = humanMode === "browser" ? createBrowserReview(host.humanReview, evidence) : undefined;
      stopReview = browser ? () => browser.close() : await startTerminalReview(host.humanReview, evidence);
      transport = await startHttp(host.core, process.env.PKM_NEXT_TOKEN!, { id: "local:owner", canWrite: true }, port, browser);
      if (browser) console.error(JSON.stringify({ humanEnrollment: browser.code, expiresInMs: 120000, path: "/human-review" }));
      console.log(JSON.stringify({ ...host.readiness, transport: "http", url: transport.url, workspaceId: host.workspaceId }));
    } catch (error) { stopReview(); await host.close(); throw error; }
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true; stopReview();
      transport.server.closeIdleConnections();
      const drained = new Promise<void>((done, reject) => transport.server.close(error => error ? reject(error) : done()));
      try { await host.close(); await drained; } catch { console.error("Configured host shutdown failed."); process.exitCode = 1; }
    };
    process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
    return;
  }
  if (humanMode || managerTextPath || providers.length || endpoints.length || models.length || tools.length || secrets.size || insecure
    || codingConfigPath || codingSource || codingStages || codingChecks.length)
    throw new Error("Native host policy options require an explicit configuration.");
  if (command === "backup") {
    const target = resolve(destination!);
    const storage = await Storage.open(directory, { deferRecovery: true });
    try {
      const preflight = storage.connectNative();
      try { assertWorkspaceBackupQuiescent(preflight); } finally { preflight.close(); }
    } catch (error) { await storage.close(); throw error; }
    let native: Awaited<ReturnType<typeof createNativeRuntime>>;
    try { native = await createNativeRuntime({ storage, hostServices: {
      authorizeBackup: request => request.operation === "backup" && request.transport === "cli" && request.destination === target,
    } }); } catch (error) { await storage.close(); throw error; }
    try { console.log(JSON.stringify({ backup: await native.services.hostServices!.backup(target, "cli") })); }
    finally { await native.close(); await storage.close(); }
    return;
  }
  const storage = await Storage.open(directory, { deferRecovery: legacyMcp });
  const actor = { id: legacyMcp ? "mcp:external" : readOnly ? "local:reader" : "local:owner", canWrite: !readOnly };
  let native: Awaited<ReturnType<typeof createNativeRuntime>>;
  try { native = await createNativeRuntime({ storage,
    ...(experimentalSubscriptionProfile ? { experimentalSubscriptionHost: { profile: experimentalSubscriptionProfile } } : {}),
    ...(trustedPlugins ? { plugins: await createVscodePluginRuntime(storage, { actorId: actor.id }) } : {}),
    ...(trustedActions ? { hostServices: await createTrustedActionHostOptions(storage) } : {}),
    ...(legacyMcp ? { trash: { layoutVersion: "pkm.trash-lifecycle/v1" as const },
      legacyNoteWorkItems: await legacyMcpNotePolicy(storage, actor) } : {}) }); }
  catch (error) { await storage.close(); throw error; }
  const core = native.core;
  let scheduler: ReturnType<typeof createAdmittedLegacyKnowledgeSnapshotScheduler> | undefined;
  let stopTransport: () => Promise<void>;
  let transportStarted = false;
  let stopping = false;
  try {
    if (allowAssetClassification) {
      const workspaceRoot = storage.workspaceRoot(), workspaceId = await storage.workspaceId();
      const authorityId = "legacy-compact-mcp.asset-classification.v1";
      const allowedTools = ["asset_classify_preview", "asset_classify_apply", "asset_classify_rollback"] as const;
      await admitLegacyAssetClassification(storage, actor, {
        authorityId, allowedTools: [...allowedTools],
        authorize: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
          && binding.workspaceRoot === workspaceRoot && binding.authorityId === authorityId
          && binding.operation === "admit"
          && JSON.stringify([...binding.allowedTools].sort()) === JSON.stringify([...allowedTools].sort()),
      });
    }
    if (snapshotSchedulerAdmission) {
      scheduler = createAdmittedLegacyKnowledgeSnapshotScheduler(storage, actor, snapshotSchedulerAdmission);
      await scheduler.start();
    }
    if (command === "http") {
      const { server, url } = await startHttp(core, process.env.PKM_NEXT_TOKEN!, actor, port);
      stopTransport = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      transportStarted = true;
      console.log(JSON.stringify({ ready: true, transport: "http", url }));
    } else {
      const server = legacyMcp ? await startLegacyNoteMcp(storage, undefined, {
        core, actor, snapshotHost: scheduler?.host, assetClassificationEnabled: allowAssetClassification,
        actionHost: native.services.hostServices,
      })
        : legacyNoteMcp ? await startLegacyNoteMcp(storage) : await startMcp(core, actor);
      stopTransport = () => server.close();
      transportStarted = true;
      process.stdin.once("end", () => { void stop(); });
      if (readyNonce !== undefined) {
        const receipt = Buffer.from(`${readyNonce}\n`);
        if (writeSync(3, receipt) !== receipt.length) throw new Error("Incomplete private MCP owner readiness receipt.");
        closeSync(3);
      }
    }
  } catch (error) {
    stopping = true;
    try { if (transportStarted) await stopTransport!(); }
    finally { try { await scheduler?.close(); } finally { try { await native.close(); } finally { await storage.close(); } } }
    throw error;
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      try { await stopTransport(); } finally {
        try { await scheduler?.close(); } finally { try { await native.close(); } finally { await storage.close(); } }
      }
    }
    catch (error) { console.error(error); process.exitCode = 1; }
    finally {
      if (experimentalSubscriptionProfile && process.connected) process.disconnect?.();
    }
  }
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  if (experimentalSubscriptionProfile) {
    process.once("disconnect", () => { void stop(); });
    if (!process.connected) void stop();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
