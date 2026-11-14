const vscode = require("vscode");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

exports.activate = async context => {
  const fixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "driver-config.json"), "utf8"));
  const socket = net.createConnection(path.join(process.env.PKM_PRIVATE_SUBSCRIPTION_SOCKET_ROOT || fixture, "seed.sock"));
  let input = "";
  socket.once("connect", () => socket.write("ready\n"));
  socket.on("data", data => {
    input += data.toString("utf8");
    if (!input.endsWith("\n")) return;
    socket.pause();
    void (async () => {
      try {
        const message = JSON.parse(input);
        if (typeof message.secret !== "string" || !message.secret) throw new Error();
        for (const [index, shareId] of (config.shareIds || [config.shareId]).entries()) {
          const secret = index === 0 ? message.secret : message.secondSecret;
          if (typeof secret !== "string" || !secret) throw new Error();
          if (message.subscriberOnly !== true && (index === 0 || !config.secondNodeId || config.secondNodeId === config.subscriberNodeId))
            await context.secrets.store(`personalKnowledge.shareBroker.${shareId}.secret`, secret);
          if (typeof config.subscriberNodeId === "string")
            await context.secrets.store(`personalKnowledge.subscription.${index === 0 ? config.subscriberNodeId : config.secondNodeId || config.subscriberNodeId}.${shareId}.secret`, secret);
        }
        socket.end("ok\n");
      } catch { socket.end("failed\n"); }
      await vscode.commands.executeCommand("workbench.action.quit");
    })();
  });
  socket.once("error", () => { void vscode.commands.executeCommand("workbench.action.quit"); });
};
