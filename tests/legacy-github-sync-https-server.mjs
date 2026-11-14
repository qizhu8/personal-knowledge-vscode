import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { basename, join, resolve } from "node:path";

const fixture = process.env.PKM_PRIVATE_SYNC_UI_FIXTURE;
if (process.env.PKM_TEST_ISOLATED_NETWORK !== "1" || !fixture || resolve(fixture) !== fixture
  || !/^pkm-native-sync-ui-[a-f0-9-]{36}$/.test(basename(fixture))) throw new Error("Private HTTPS fixture denied.");
const authorization = `Basic ${Buffer.from("fixture:synthetic-https-token").toString("base64")}`;
const server = createServer({ key: readFileSync(join(fixture, "tls-key.pem")), cert: readFileSync(join(fixture, "tls-cert.pem")) }, (req, res) => {
  const url = new URL(req.url, "https://github.com");
  if (!url.pathname.startsWith("/fixture/fixture.git/")) { res.writeHead(404).end(); return; }
  if (req.headers.authorization !== authorization) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic"' }); res.end(); return;
  }
  if (existsSync(join(fixture, "git-redirect"))) {
    res.writeHead(302, { Location: "https://evil.invalid/fixture.git" }).end(); return;
  }
  const body = [];
  req.on("data", chunk => body.push(chunk));
  req.on("end", () => {
    const input = Buffer.concat(body);
    const receive = req.method === "POST" && url.pathname.endsWith("/git-receive-pack");
    if (receive) {
      appendFileSync(join(fixture, "git-pushes"), "push\n", { mode: 0o600 });
      if (existsSync(join(fixture, "git-race"))) {
        const gitDir = join(fixture, "remote.git");
        const ref = spawnSync("git", ["--git-dir", gitDir, "rev-parse", "refs/heads/race"], { encoding: "utf8" });
        if (ref.status !== 0 || !/^[a-f0-9]{40}\n$/.test(ref.stdout)
          || spawnSync("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", ref.stdout.trim()]).status !== 0) {
          res.writeHead(500).end(); return;
        }
      }
    }
    const child = spawn("git", ["http-backend"], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: fixture,
      GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname.replace("/fixture/fixture.git/", "/remote.git/"),
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers["content-type"] || "",
      CONTENT_LENGTH: String(input.length), HTTP_CONTENT_ENCODING: req.headers["content-encoding"] || "",
      REMOTE_USER: "fixture" }, stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    child.on("close", () => {
      if (receive && existsSync(join(fixture, "git-drop"))) {
        rmSync(join(fixture, "git-drop")); res.destroy(); return;
      }
      const output = Buffer.concat(chunks), index = output.indexOf("\r\n\r\n");
      if (index < 0) { res.writeHead(500).end(); return; }
      let status = 200;
      for (const line of output.subarray(0, index).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.slice(0, 3));
        else res.setHeader(name, value);
      }
      res.writeHead(status); res.end(output.subarray(index + 4));
    });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
});
server.listen(443, "127.0.0.1", () => process.stdout.write("READY\n"));
process.once("SIGTERM", () => server.close());
