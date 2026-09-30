const { GitHubSyncCoordinator } = require("../../dist/github-sync-coordinator.js");

const [stateDirectory, knowledgeRoot, extensionVersion] = process.argv.slice(2);
let release;
let hold = false;
const coordinator = new GitHubSyncCoordinator({
  stateDirectory,
  knowledgeRoot,
  extensionVersion,
  pollMs: 40,
  heartbeatMs: 40,
  leaseMs: 300,
  compatibilityBlock: error => error && error.block,
  execute: async (targetId, reason, fencingToken) => {
    process.send?.({ type: "execute", targetId, reason, fencingToken, pid: process.pid });
    if (hold) await new Promise(resolve => { release = resolve; });
  },
});

coordinator.configure([{
  id: "primary",
  enabled: true,
  intervalMinutes: 60,
  syncOnChange: true,
  lastSuccessAt: new Date().toISOString(),
}]);

process.on("message", message => {
  if (message.type === "request") {
    process.send?.({ type: "requested", accepted: coordinator.request("primary", message.reason), pid: process.pid });
  } else if (message.type === "requests") {
    process.send?.({
      type: "requested-batch",
      accepted: message.reasons.map(reason => coordinator.request("primary", reason)),
      pid: process.pid,
    });
  } else if (message.type === "hold") {
    hold = true;
  } else if (message.type === "configure") {
    coordinator.configure([{
      id: "primary",
      enabled: true,
      intervalMinutes: 60,
      syncOnChange: true,
      lastSuccessAt: new Date().toISOString(),
    }]);
    process.send?.({ type: "configured", pid: process.pid });
  } else if (message.type === "release") {
    hold = false;
    release?.();
    release = undefined;
  } else if (message.type === "dispose") {
    coordinator.dispose();
    process.exit(0);
  }
});

process.send?.({ type: "ready", pid: process.pid });
