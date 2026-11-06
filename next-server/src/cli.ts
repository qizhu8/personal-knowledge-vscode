import { Core } from "./core.js";
import { initialize, Storage } from "./storage.js";
import { startHttp } from "./http.js";
import { startMcp } from "./mcp.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let directory: string | undefined, readOnly = false, port = 0;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--data") directory = args[++index];
    else if (args[index] === "--port") {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value) || Number(value) > 65535) throw new Error("Invalid port.");
      port = Number(value);
    } else if (args[index] === "--read-only") readOnly = true;
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  if (!directory || !["init", "http", "mcp"].includes(command)) throw new Error("Usage: node dist/cli.js init|http|mcp --data <NEW isolated directory> [--port 0] [--read-only]");
  if (command === "init") { console.log(JSON.stringify({ initialized: await initialize(directory) })); return; }
  if (command === "http" && (!process.env.PKM_NEXT_TOKEN || process.env.PKM_NEXT_TOKEN.length < 32)) throw new Error("Set PKM_NEXT_TOKEN to a random secret of at least 32 characters.");
  const storage = await Storage.open(directory);
  const core = new Core(storage);
  const actor = { id: readOnly ? "local:reader" : "local:owner", canWrite: !readOnly };
  let stopTransport: () => Promise<void>;
  try {
    if (command === "http") {
      const { server, url } = await startHttp(core, process.env.PKM_NEXT_TOKEN!, actor, port);
      stopTransport = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      console.log(JSON.stringify({ ready: true, transport: "http", url }));
    } else {
      const server = await startMcp(core, actor);
      stopTransport = () => server.close();
      process.stdin.once("end", () => { void stop(); });
    }
  } catch (error) { await storage.close(); throw error; }
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try { await stopTransport(); await storage.close(); }
    catch (error) { console.error(error); process.exitCode = 1; await storage.close(); }
  }
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
