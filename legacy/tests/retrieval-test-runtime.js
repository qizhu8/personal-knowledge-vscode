const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function retrievalTestPython(t) {
  if (process.env.PKM_RETRIEVAL_TEST_PYTHON) return path.resolve(process.env.PKM_RETRIEVAL_TEST_PYTHON);
  const runtime = fs.mkdtempSync(path.join(process.cwd(), ".retrieval-test-runtime-"));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  execFileSync(process.env.PYTHON || "python3", ["-m", "venv", "--system-site-packages", runtime]);
  const python = process.platform === "win32" ? path.join(runtime, "Scripts", "python.exe") : path.join(runtime, "bin", "python");
  execFileSync(python, ["-m", "pip", "install", "--no-index", "--no-deps", "--no-cache-dir",
    path.join(__dirname, "../resources/vendor/adaptive_skill_retrieval-0.3.0.dev2026100504-py3-none-any.whl")], { stdio: "ignore" });
  return python;
}

module.exports = { retrievalTestPython };
