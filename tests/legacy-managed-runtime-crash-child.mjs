import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resumeLegacyRootAdoptionExperimental } from "../dist/legacy-root-adoption.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { LegacyManagedApiChatRuntime } from "../dist/legacy-api-chat-managed-runtime.js";
import { createLegacyManagedChatLocalModel } from "../dist/legacy-api-chat-managed-provider.js";

process.on("message", () => {});
try {
  const file = realpathSync(process.argv[2]), stat = lstatSync(file), project = resolve(new URL("../legacy", import.meta.url).pathname);
  if (!file.startsWith(join(project, ".migration-test-work") + "/") || !stat.isFile() || stat.nlink !== 1
    || stat.mode & 0o077 || stat.uid !== process.getuid() || stat.size > 16384) throw new Error("Private owned crash fixture required.");
  const config = JSON.parse(readFileSync(file));
  if (realpathSync(config.root) !== join(dirname(file), "knowledge")
    || readFileSync(join(dirname(file), "in-place-fixture-token"), "utf8") !== config.nonce
    || realpathSync(config.inputFile) !== join(dirname(file), "fresh-input.txt"))
    throw new Error("Crash helper must remain inside this exact synthetic fixture.");
  const require = createRequire(import.meta.url), options = require("../legacy/tests/next-trial-electron/in-place-options.cjs").options;
  const storage = (await resumeLegacyRootAdoptionExperimental(config.root, options({
    fixture: dirname(file), root: config.root, nonce: config.nonce, workspaceId: config.workspaceId,
  }))).storage;
  await createNativeRuntime({ storage, workspaceId: config.workspaceId });
  let runtime;
  const model = createLegacyManagedChatLocalModel({ endpoint: config.endpoint, model: "synthetic-native-managed",
    apiKey: "fresh-private-managed-token", tools: async (_actor, turnId) => {
      await runtime.scope(turnId);
      return [{ name: "read_file", description: "Read this exact freshly authorized synthetic file once.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }];
    },
  });
  runtime = new LegacyManagedApiChatRuntime({ storage, actorId: config.actorId, model,
    authorize: async binding => binding.root === config.root && binding.chatId === config.input.chatId
      && binding.sourceSessionId === config.sourceSessionId && (!binding.tool || binding.tool === "read_file"),
    tools: { available: true, async execute(request) {
      if (request.call.name !== "read_file" || request.call.arguments.path !== "fresh-input.txt")
        throw new Error("Crash fixture permits only its exact fresh read.");
      const current = lstatSync(config.inputFile);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid()
        || current.size > 65536) throw new Error("Unsafe crash fixture file.");
      const bytes = readFileSync(config.inputFile);
      process.send({ kind: "tool-effect", operationId: config.input.operationId,
        sha256: createHash("sha256").update(bytes).digest("hex") });
      return new Promise(() => {});
    } },
  });
  process.send({ kind: "ready", pid: process.pid, workspaceId: config.workspaceId });
  await runtime.start(config.input);
  await runtime.settled(config.input, config.input.operationId);
  throw new Error("The unacknowledged effect unexpectedly completed.");
} catch (error) {
  process.send?.({ kind: "failed", error: String(error?.message ?? error) });
  process.exitCode = 1;
  process.disconnect?.();
}
