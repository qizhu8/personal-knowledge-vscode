import { cachedVSCode, runElectronAcceptance } from "./electron-test.mjs";
import { isolatedEnvironment, startLiveRuntime } from "./live-runtime.mjs";

async function main() {
  const runtime = await startLiveRuntime();
  try {
    const vscodeExecutablePath = cachedVSCode();
    console.log("Actual next-server CLI ready in a fresh synthetic workspace (read-only, no provider configuration).");
    // Electron itself also gets a fresh home, not the operator's credentials.
    const environment = isolatedEnvironment(runtime.home);
    const previous = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, environment);
      await runElectronAcceptance({
        runner: "live-electron-test-runner.cjs",
        vscodeExecutablePath,
        workspace: runtime.workspace,
        environment: {
          ...environment,
          PKM_LIVE_ACCEPTANCE: JSON.stringify({
            origin: runtime.origin, token: runtime.token,
            workspaceId: runtime.workspaceId, actorId: runtime.actorId,
          }),
        },
      });
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  } finally {
    await runtime.close();
  }
}

main().catch(error => {
  console.error(`Live-runtime Electron acceptance failed: ${error.message}`);
  process.exitCode = 1;
});
