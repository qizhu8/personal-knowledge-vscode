import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const built = await require("esbuild").build({
  stdin: { contents: `export { createOriginalMcpNativeRecipeProducer } from "./clients/vscode-host/original-mcp-native-recipe.ts";
    export { createOriginalMcpNativeRecipeEffectProducer } from "./clients/vscode-host/original-mcp-native-recipe-effect.ts";
    export { fixture as ui } from "vscode";
    export { fixture as identity } from "native-recipe-effect-signer";`, resolveDir: resolve(".") },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  plugins: [{ name: "explicit-native-recipe-display-fixture", setup(plugin) {
    plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "recipe-display" }));
    plugin.onLoad({ filter: /.*/, namespace: "recipe-display" }, () => ({ contents: `
      export const fixture = { messages: [], choice: undefined };
      export const workspace = { isTrusted: true, onDidChangeWorkspaceFolders: () => ({dispose(){}}) };
      export const commands = { registerCommand: () => ({dispose(){}}) };
      export const StatusBarAlignment = {Left:1};
      export const window = {
        async showWarningMessage(message, options, ...choices) {
          fixture.messages.push({message,options,choices});
          return fixture.choice ? fixture.choice(message,options,choices) : choices[0];
        },
        createStatusBarItem: () => ({dispose(){},show(){}}),
        showErrorMessage: async () => undefined,
        showOpenDialog: async () => undefined,
      };`, loader: "js" }));
    plugin.onResolve({ filter: /(?:original-mcp-native-identity\.js$|^native-recipe-effect-signer$)/ },
      () => ({ path: "signer", namespace: "recipe-signer" }));
    plugin.onLoad({ filter: /.*/, namespace: "recipe-signer" }, () => ({ contents: `
      export const fixture = { signer: undefined };
      export async function originalMcpNativeSigner() {
        if (!fixture.signer) throw Error("Explicit native display signer fixture is required.");
        return fixture.signer;
      }`, loader: "js" }));
  } }],
});
export function recipeNativeClientFixture(context, session, options) {
  // Only the VS Code display/signing adapter is synthetic; DTO validation, native producers,
  // authenticated socket, root/source custody and owned effects remain the production implementation.
  const memory = new Module(resolve("tests/.recipe-native-client-memory.cjs"));
  memory.filename = memory.id; memory.paths = Module._nodeModulePaths(resolve("."));
  memory._compile(built.outputFiles[0].text, memory.filename);
  const api = memory.exports;
  api.identity.signer = { activationId: session.activationId, identity: {
    sha256: session.identitySha256, profileSha256: session.binding.profileSha256 },
    payloadBuildId: session.binding.payloadBuildId, hostEntrySha256: session.binding.hostEntrySha256,
    signal: options.signal, assertCurrent: options.assertCurrent };
  const ready = (async () => {
    const source = await api.createOriginalMcpNativeRecipeProducer(context, { session, ...options });
    const effect = await api.createOriginalMcpNativeRecipeEffectProducer(context, {
      session, signal: options.signal, assertCurrent: options.assertCurrent, sourceAdmission: source.sourceAdmission,
    });
    return { source, effect };
  })().catch(error => { console.error("ACTUAL_RECIPE_NATIVE_CREATE", error.stack); throw error; });
  return { ready, ui: api.ui };
}
