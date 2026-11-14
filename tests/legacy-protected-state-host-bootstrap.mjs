import * as fs from "node:fs/promises";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

process.once("message", async ({ statePath, state, entry }) => {
  const bytes = Buffer.from(state);
  const withSize = stat => {
    const result = Object.create(stat);
    Object.defineProperty(result, "size", { value: typeof stat.size === "bigint" ? BigInt(bytes.length) : bytes.length });
    return result;
  };
  const patched = { ...fs,
    async lstat(path, options) {
      const stat = await fs.lstat(path, options);
      return path === statePath ? withSize(stat) : stat;
    },
    async open(path, ...args) {
      if (path !== statePath) return fs.open(path, ...args);
      return { async stat(options) { return withSize(await fs.lstat(path, options)); },
        async readFile() { return Buffer.from(bytes); }, async close() {} };
    },
  };
  mock.module("node:fs/promises", { namedExports: patched, defaultExport: patched });
  try {
    await import(pathToFileURL(entry).href);
    process.send?.({ type: "ready" });
  } catch {
    bytes.fill(0);
    process.send?.({ type: "bootstrap-error" });
    process.disconnect?.();
  }
  process.once("disconnect", () => bytes.fill(0));
});
