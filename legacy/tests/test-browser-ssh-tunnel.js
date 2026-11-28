const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { browserSshTunnelCommand } = require("../dist/runtime/pkm-browser-ssh-tunnel");

test("generated tunnel command is accepted by OpenSSH with public-key-only authentication and strict host verification", () => {
  const command = browserSshTunnelCommand({ host: "user@pkm-server" }, "127.0.0.1", "https://127.0.0.1:8443");
  const args = command.split(" ").slice(1);
  const output = execFileSync("ssh", ["-F", "/dev/null", "-G", ...args], { encoding: "utf8" });
  assert.match(output, /^hostname pkm-server$/m);
  assert.match(output, /^user user$/m);
  assert.match(output, /^passwordauthentication no$/m);
  assert.match(output, /^kbdinteractiveauthentication no$/m);
  assert.match(output, /^preferredauthentications publickey$/m);
  assert.match(output, /^controlmaster false$/m);
  assert.doesNotMatch(output, /^controlpath (?!none$)/m);
  assert.match(output, /^stricthostkeychecking true$/m);
  assert.match(output, /^exitonforwardfailure yes$/m);
  assert.match(output, /^localforward \[127\.0\.0\.1\]:8443 \[127\.0\.0\.1\]:8443$/m);
});

test("tunnel guidance refuses shell/SSH argument injection and nonloopback browser or server endpoints", () => {
  for (const host of ["-bad", "user@-bad", "host name", "host;echo", "host$(id)", "host\n-oProxyCommand=bad", "ssh://host", "host:22"]) {
    assert.throws(() => browserSshTunnelCommand({ host }, "127.0.0.1", "https://localhost:8443"), /SSH hostname/);
  }
  for (const [address, origin] of [["0.0.0.0", "https://localhost:8443"], ["192.0.2.1", "https://localhost:8443"],
    ["127.0.0.1", "https://server.example:8443"], ["127.0.0.1", "http://localhost:8443"],
    ["127.0.0.1", "https://localhost:8443/path"]]) {
    assert.throws(() => browserSshTunnelCommand({ host: "pkm-server" }, address, origin), /requires server interface/);
  }
});
