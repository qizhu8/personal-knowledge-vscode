"use strict";
const fs = require("node:fs");
const net = require("node:net");
const vscode = require("vscode");
const assert = require("node:assert/strict");

exports.activate = async context => {
  const marker = process.env.PKM_SYNC_NORMAL_MARKER;
  try {
    assert.equal(context.extension.id.toLowerCase(), "uone.personal-knowledge");
    const storage = fs.realpathSync(context.globalStorageUri.fsPath);
    assert.equal(storage, fs.realpathSync(process.env.PKM_SYNC_PROFILE_STORAGE));
    if (process.env.PKM_SYNC_NORMAL_ACTION === "store") {
      const key = "personalKnowledge.githubSync.vscode.fixture-target";
      await context.secrets.store(key, JSON.stringify({ accountLabel: "fixture", accessToken: "fixture-token" }));
      if (!await context.secrets.get(key)) throw new Error("Synthetic credential was not stored");
    } else if (process.env.PKM_SYNC_NORMAL_ACTION === "read") {
      const key = "personalKnowledge.githubSync.vscode.fixture-target";
      const value = await context.secrets.get(key);
      assert.equal(JSON.parse(value).accountLabel, "fixture");
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(process.env.PKM_SYNC_SECRET_SOCKET);
        socket.setTimeout(30000, () => socket.destroy(new Error("Secret bridge timed out")));
        socket.once("error", reject);
        socket.once("connect", () => socket.write(JSON.stringify({ nonce: process.env.PKM_SYNC_SECRET_NONCE, value }) + "\n"));
        socket.once("data", data => {
          if (data.toString() !== "ok\n") return socket.destroy(new Error("Secret bridge rejected"));
          socket.end(); resolve();
        });
      });
    } else throw new Error("Invalid private fixture action");
    fs.writeFileSync(marker, JSON.stringify({ passed: true, extensionId: context.extension.id.toLowerCase(), storage }),
      { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(marker, JSON.stringify({ passed: false, error: String(error?.message ?? error) }), { flag: "wx", mode: 0o600 });
  } finally {
    setTimeout(() => { void vscode.commands.executeCommand("workbench.action.quit"); }, 100);
  }
};
