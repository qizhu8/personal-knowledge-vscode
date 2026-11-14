import { runTests } from "@vscode/test-electron";

const env = process.env;
await runTests({
  vscodeExecutablePath: env.PKM_PROFILE_CODE,
  extensionDevelopmentPath: env.PKM_PROFILE_DRIVER,
  extensionTestsPath: new URL(env.PKM_PROFILE_BOOTSTRAP ? "./linux-managed-profile-bootstrap.cjs" : "./linux-managed-profile-installed-host.cjs", import.meta.url).pathname,
  extensionTestsEnv: Object.fromEntries(Object.entries(env).filter(([key]) =>
    key.startsWith("PKM_PROFILE_") || key === "PKM_MANAGED_WRITER_SESSION")),
  launchArgs: [env.PKM_PROFILE_WORKSPACE, `--user-data-dir=${env.PKM_PROFILE_USER}`,
    `--extensions-dir=${env.PKM_PROFILE_EXTENSIONS}`, `--profile=${env.PKM_PROFILE_NAME}`,
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates",
    "--skip-welcome", "--skip-release-notes", "--password-store=basic",
    "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1"],
});
