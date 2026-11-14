import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export function isolatedEnvironment(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "127.0.0.1",
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  };
}

function launch(args, env) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: here, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32768); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32768); });
  const finished = new Promise(resolve => {
    child.once("error", error => resolve({ error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, finished, output: () => ({ stdout, stderr }) };
}

async function stop(process) {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill("SIGTERM");
  let timer;
  await Promise.race([
    process.finished,
    new Promise(resolve => { timer = setTimeout(() => {
      process.child.kill("SIGKILL");
      resolve();
    }, 10000); }),
  ]);
  clearTimeout(timer);
  await process.finished;
}

async function waitFor(process, ready, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = ready(process.output().stdout);
    if (result) return result;
    const outcome = await Promise.race([
      process.finished,
      new Promise(resolve => setTimeout(() => resolve(undefined), 50)),
    ]);
    if (outcome) {
      const finalResult = ready(process.output().stdout);
      if (finalResult && outcome.code === 0) return finalResult;
      throw new Error(`${label}: ${JSON.stringify(outcome)}\n${process.output().stderr}`);
    }
  }
  throw new Error(`${label}: timed out after 30s\n${process.output().stderr}`);
}

export async function startLiveRuntime() {
  const root = path.join(here, `.live-electron-state-${process.pid}-${randomBytes(6).toString("hex")}`);
  await mkdir(root, { mode: 0o700 });
  const home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const workspace = path.join(root, "workspace");
  const token = randomBytes(32).toString("hex");
  const env = { ...isolatedEnvironment(home), PKM_NEXT_TOKEN: token };
  let initializer, server;
  try {
    initializer = launch(["init", "--data", workspace], env);
    await waitFor(initializer, output => {
      try { return JSON.parse(output).initialized === workspace; } catch { return false; }
    }, "Actual next-server CLI initialization blocked");
    const initialized = await initializer.finished;
    if (initialized.code !== 0) throw new Error("Actual next-server CLI initialization failed");
    const identity = JSON.parse(await readFile(path.join(workspace, ".pkm-next-workspace"), "utf8"));
    if (identity.schema !== "pkm.next-workspace/v2" || !/^[a-f0-9-]{36}$/.test(identity.id))
      throw new Error("Invalid independently initialized workspace identity");
    server = launch(["http", "--data", workspace, "--port", "0", "--read-only"], env);
    const origin = await waitFor(server, output => {
      for (const line of output.split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.ready === true && value.transport === "http" && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.url))
            return value.url;
        } catch { /* CLI may emit non-readiness diagnostics. */ }
      }
    }, "Actual next-server CLI startup blocked");
    return {
      root, home, workspace, origin, token, workspaceId: identity.id, actorId: "local:reader",
      async close() {
        await stop(server);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) await stop(server);
    if (initializer) await stop(initializer);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
