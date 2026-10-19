const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const moduleRoot = path.join(root, "modules", "pkm-memory-engine");
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const environment = {
  ...process.env,
  PYTHON: python,
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONPATH: [path.join(moduleRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

for (const [program, args] of [
  [python, ["-m", "unittest", "discover", "-s", path.join(moduleRoot, "tests"), "-v"]],
  [process.execPath, ["--test", path.join(root, "tests", "test-memory-engine-client.js"), path.join(root, "tests", "test-chat-memory-service.js")]],
]) {
  const result = spawnSync(program, args, { cwd: root, env: environment, stdio: "inherit", timeout: 120000 });
  if (result.error) {
    console.error(`Memory Engine validation failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
