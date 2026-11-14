import { runTests } from "@vscode/test-electron";

const env = process.env;
const vscode = env.PKM_VSCODE_EXECUTABLE
  || `${env.HOME}/.cache/pkm-vscode-test/vscode-linux-x64-1.143.0/code`;

await runTests({
  vscodeExecutablePath: vscode,
  extensionDevelopmentPath: env.PKM_LEGACY_PRIVATE_DRIVER,
  extensionTestsPath: new URL("./linux-legacy-private-host.cjs", import.meta.url).pathname,
  extensionTestsEnv: {
    PKM_LEGACY_PRIVATE_ROOT: env.PKM_LEGACY_PRIVATE_ROOT,
    PKM_LEGACY_PRIVATE_EXTENSION: env.PKM_LEGACY_PRIVATE_EXTENSION,
    PKM_LEGACY_PRIVATE_PROFILE: env.PKM_LEGACY_PRIVATE_PROFILE,
    PKM_LEGACY_PRIVATE_READY: env.PKM_LEGACY_PRIVATE_READY,
    PKM_LEGACY_PRIVATE_RELEASE: env.PKM_LEGACY_PRIVATE_RELEASE,
    ...(env.PKM_LEGACY_PRIVATE_GENERATE_MCP
      ? { PKM_LEGACY_PRIVATE_GENERATE_MCP: env.PKM_LEGACY_PRIVATE_GENERATE_MCP }
      : {}),
  },
  launchArgs: [
    env.PKM_LEGACY_PRIVATE_WORKSPACE,
    `--user-data-dir=${env.PKM_LEGACY_PRIVATE_PROFILE}`,
    `--extensions-dir=${env.PKM_LEGACY_PRIVATE_EXTENSIONS}`,
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-telemetry",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--password-store=basic",
    "--proxy-server=http://127.0.0.1:1",
    "--proxy-bypass-list=127.0.0.1",
  ],
});
