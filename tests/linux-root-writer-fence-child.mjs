import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const [mode, root, readyPath, modulePath, timeout = "30000"] = process.argv.slice(2);
const cell = new Int32Array(new SharedArrayBuffer(4));

if (mode === "legacy") {
  const { withLegacyLinuxRootWriter } = require(modulePath);
  try {
    withLegacyLinuxRootWriter(root, () => {
      writeFileSync(readyPath, "entered");
      Atomics.wait(cell, 0, 0, Number(timeout));
    }, Number(timeout));
  } catch (error) {
    writeFileSync(readyPath, `blocked:${error.message}`);
    process.exitCode = 23;
  }
} else if (mode === "next") {
  try {
    const { Storage } = await import(resolve(modulePath));
    const storage = await Storage.open(root);
    writeFileSync(readyPath, "entered");
    Atomics.wait(cell, 0, 0, Number(timeout));
    await storage.close();
  } catch (error) {
    writeFileSync(readyPath, `error:${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 24;
  }
} else {
  process.exitCode = 2;
}
