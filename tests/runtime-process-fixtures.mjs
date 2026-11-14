import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RuntimeProcessService, RuntimeProcessStore } from "../dist/runtime-process.js";

// All children are exactly process.execPath and a synthetic local fixture. No OS inventory,
// shell, remote endpoint, ambient environment, detached process or legacy root is used.
export function runtimeFixture(options = {}) {
  const initialChildren = process.getActiveResourcesInfo().filter(name => name === "ProcessWrap").length;
  const directory = resolve("tests", `.runtime-process-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const script = resolve(directory, "synthetic.mjs");
  writeFileSync(script, `
import { writeFileSync } from "node:fs";
const [mode, parameter] = process.argv.slice(2);
if (mode === "io") {
  process.stdout.write(Buffer.from([0, 255, 195, 169, 10]));
  process.stderr.write(Buffer.from([254, 0, 65]));
} else if (mode === "bulk") {
  process.stdout.write(Buffer.alloc(Number(parameter), 97));
  process.stderr.write(Buffer.alloc(Number(parameter) + 7, 98));
} else if (mode === "ticks") {
  let n = 0;
  const timer = setInterval(() => {
    process.stdout.write("abc");
    process.stderr.write("de");
    if (++n === 20) clearInterval(timer);
  }, 8);
} else if (mode === "delay") {
  setTimeout(() => { process.stdout.write("done"); }, Number(parameter));
} else if (mode === "ignore") {
  process.on("SIGTERM", () => {});
  process.stdout.write("ready");
  setInterval(() => {}, 1000);
} else if (mode === "mark") {
  writeFileSync(parameter, "effect", { flag: "wx" });
} else if (mode === "exit") {
  process.exitCode = Number(parameter);
} else if (mode === "env") {
  process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));
}
`);
  let database = new DatabaseSync(resolve(directory, "fixture.sqlite"));
  const services = [];
  function service(overrides = {}) {
    const result = new RuntimeProcessService({
      repositoryFactory: (ownerId, events) => new RuntimeProcessStore(database, ownerId, events, overrides.previousOwnerId),
      adapters: [{
        id: "synthetic", executable: process.execPath, cwd: directory,
        arguments: input => [script, input.mode, String(input.parameter ?? "")],
      }],
      authorizeLaunch: async () => true,
      limits: { concurrency: 1, queue: 2, events: 8, deadlineMs: 2000, graceMs: 60, closeDrainMs: 200, ...options.limits },
      ...options,
      ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "previousOwnerId")),
    });
    services.push(result);
    return result;
  }
  return {
    directory, get database() { return database; }, service,
    reopenDatabase() {
      database.close();
      database = new DatabaseSync(resolve(directory, "fixture.sqlite"));
    },
    launch(runtime, mode = "io", parameter, extra = {}) {
      return runtime.launch({ actorId: "alice", operationId: randomUUID(), adapterId: "synthetic", input: { mode, ...(parameter === undefined ? {} : { parameter }) }, ...extra });
    },
    async cleanup() {
      const failures = [];
      for (const runtime of services) {
        try { await runtime.close({ drainMs: 0 }); } catch (error) {
          if (!["OWNERSHIP_LOST", "PERSISTENCE_UNAVAILABLE"].includes(error.code)) failures.push(error);
        }
      }
      await until(() => process.getActiveResourcesInfo().filter(name => name === "ProcessWrap").length <= initialChildren);
      database.close();
      rmSync(directory, { recursive: true, force: true });
      if (failures.length) throw new AggregateError(failures, "Runtime fixture cleanup failed.");
    },
  };
}
export async function until(fn, timeoutMs = 1500) {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= end) throw new Error("Bounded fixture condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
