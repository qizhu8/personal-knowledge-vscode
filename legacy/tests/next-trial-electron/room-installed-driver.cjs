"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const vscode = require("vscode");

exports.activate = async function activate(context) {
  const root = process.env.PKM_ROOM_INSTALLED_FIXTURE;
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
  if (!root || fs.realpathSync(root) !== root || !root.includes(`${path.sep}.migration-test-work${path.sep}`)
    || !fs.realpathSync(context.globalStorageUri.fsPath).startsWith(path.join(root, "host-user") + path.sep))
    throw new Error("Installed Room driver requires the private Host profile.");
  const config = JSON.parse(fs.readFileSync(path.join(root, "driver-config.json"), "utf8"));
  const events = path.join(root, "host-events.jsonl"), command = path.join(root, "host-command.json");
  const emit = (event, extra = {}) => fs.appendFileSync(events, JSON.stringify({ event, ...extra }) + "\n", { mode: 0o600 });
  let sequence = fs.existsSync(command) ? JSON.parse(fs.readFileSync(command, "utf8")).sequence : 0, attempt = 0;
  let selectedRoom = 0, switching = 0, creating = false;
  const copied = new Set([0]);
  const next = async () => {
    for (;;) {
      if (fs.existsSync(command)) {
        const value = JSON.parse(fs.readFileSync(command, "utf8"));
        if (value.sequence > sequence) { sequence = value.sequence; return value.action; }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const extension = vscode.extensions.getExtension("Uone.personal-knowledge");
  if (!extension || !fs.realpathSync(extension.extensionPath).startsWith(path.join(root, "host-extensions") + path.sep))
    throw new Error("The actual installed Host extension was not found in the private profile.");
  await extension.activate();
  emit("product-activated", { version: extension.packageJSON.version, path: extension.extensionPath, extensionHostPid: process.pid });
  const productWindow = createRequire(path.join(extension.extensionPath, "dist/extension.js"))("vscode").window;
  const productCommands = createRequire(path.join(extension.extensionPath, "dist/extension.js"))("vscode").commands;
  const originalExecute = productCommands.executeCommand;
  let resolveFormEntry;
  const formEntryDone = new Promise(resolve => { resolveFormEntry = resolve; });
  if (config.formEntry) productCommands.executeCommand = async (...args) => {
    try { return await originalExecute.apply(productCommands, args); }
    finally { if (args[0] === "personalKnowledge.nextTrialStart") resolveFormEntry(); }
  };
  if (config.formEntry && productCommands.executeCommand === originalExecute)
    throw new Error("Cannot observe the actual Chatroom form command.");
  const original = {};
  const replace = (key, value) => {
    original[key] = productWindow[key]; productWindow[key] = value;
    if (productWindow[key] !== value) throw new Error(`Cannot instrument installed product ${key}.`);
  };
  replace("showOpenDialog", async options => {
    const value = options.canSelectFolders
      ? options.openLabel?.startsWith("Select an empty trial directory") ? config.trial : config.source
      : config.node;
    return [vscode.Uri.file(value)];
  });
  replace("showInputBox", async options => {
    if (config.formEntry) return original.showInputBox(options);
    if (options.prompt?.startsWith("Room UUID")) return config.roomIds?.[selectedRoom] ?? config.roomId;
    if (options.prompt?.startsWith("Loopback port")) return String(config.port);
    if (options.prompt === "Name of the new isolated Room") return "Fixture New Room";
    if (options.prompt === "Your display name in the new Room") return "Fixture New Host";
    if (options.prompt?.startsWith("Room secret (leave blank")) return "synthetic-new-secret";
    if (options.prompt === "Address @all or a participant") return "@all Native-created Room message";
    throw new Error(`Unexpected Room input: ${options.prompt}`);
  });
  replace("showWarningMessage", async (message, ...args) => {
    if (config.formEntry && (message.startsWith("Create a disposable PKM Next trial") || message.startsWith("Copy and host this Room"))) {
      emit(message.startsWith("Create a disposable") ? "form-trial-confirm" : "form-host-confirm");
      return original.showWarningMessage(message, ...args);
    }
    if (message === "Restore this historical participant identity?") {
      emit("approval-dialog");
      return original.showWarningMessage(message, ...args);
    }
    if (message.startsWith("Reopen the saved isolated Room")) {
      emit("recovery-dialog");
      return original.showWarningMessage(message, ...args);
    }
    if (message.startsWith("Create a disposable PKM Next trial")) return "Create Trial";
    if (message.startsWith("Copy and host this Room")) return "Host Isolated Room";
    throw new Error(`Unexpected warning: ${message}`);
  });
  replace("showInformationMessage", async (message, ...args) => {
    if (typeof message === "string" && message.includes("requests identity recovery")) emit("participant-pending");
    void original.showInformationMessage(message, ...args);
  });
  replace("showQuickPick", async (items, options) => {
    if (items.includes("Host an isolated legacy Room")) return "Host an isolated legacy Room";
    if (options?.placeHolder?.startsWith("Choose an inactive independently pinned Room")) {
      if (creating) { creating = false; return items.find(item => item.action === "Create a new isolated Room"); }
      return items.find(item => item.roomId === config.roomIds?.[selectedRoom])
        ?? (selectedRoom === 2 ? items.find(item => item.roomId && !config.roomIds?.slice(0, 2).includes(item.roomId)) : items[0]);
    }
    if (items.includes("Copy and host a private Room")) {
      if (creating) { creating = false; return "Create a new isolated Room"; }
      if (attempt === 0 && (selectedRoom === 0 || !copied.has(selectedRoom))) {
        copied.add(selectedRoom); return "Copy and host a private Room";
      }
      return "Rehost a Room already copied into this trial";
    }
    if (items.includes("Approve legacy participant identity recovery")) return config.recoveryMode === "proof-required"
      ? "Require participant credential to restore an identity" : "Approve legacy participant identity recovery";
    if (items.includes("Review participant approvals")) {
      emit("host-menu-ready", { room: options?.placeHolder });
      const action = await next();
      if (action === "review") return "Review participant approvals";
      if (action === "stop") return "Stop Host";
      if (action === "add") { selectedRoom = 1; return "Host another Room"; }
      if (action === "new") { creating = true; selectedRoom = 2; return "Host another Room"; }
      if (action === "add-native") { creating = false; selectedRoom = 2; return "Host another Room"; }
      if (action === "send-new") return "Send message";
      if (action === "close-one") return "Close this Room";
      if (action === "switch0" || action === "switch1" || action === "switch2") {
        switching = selectedRoom = Number(action.slice(-1)); return "Switch Room";
      }
      throw new Error(`Unexpected Host menu action: ${action}`);
    }
    if (options?.placeHolder?.startsWith("Choose one independently pinned Room")) {
      const roomId = config.resumeRoomId ?? config.roomId;
      const selection = items.find(item => item.description === roomId);
      if (!selection) throw new Error(`Saved Room ${roomId} is not available for explicit recovery.`);
      return selection;
    }
    if (options?.placeHolder === "Select an active Room") {
      const selection = items.find(item => switching === 2 ? item.label === "Fixture New Room" : item.description === config.roomIds?.[switching]);
      if (!selection) throw new Error(`Expected active Room ${switching} is not hosted.`);
      return selection;
    }
    throw new Error("Unexpected installed Room selection.");
  });
  replace("showErrorMessage", async (message, ...args) => {
    emit(typeof message === "string" && message.startsWith("PKM Next trial") ? "error" : "background-error", { message });
    void original.showErrorMessage(message, ...args);
  });
  try {
    if (config.formEntry) {
      emit("form-driver-ready");
      await formEntryDone;
      await originalExecute.call(productCommands, "personalKnowledge.nextTrialClose");
      emit("driver-finished");
      return;
    }
    await vscode.commands.executeCommand("personalKnowledge.nextTrialStart");
    emit("host-stopped");
    attempt++;
    while (true) {
      const action = await next();
      if (action === "close") break;
      if (action !== "rehost") throw new Error(`Unexpected Host lifecycle action: ${action}`);
      await vscode.commands.executeCommand("personalKnowledge.nextTrialDocuments");
      emit("host-stopped");
      attempt++;
    }
    await vscode.commands.executeCommand("personalKnowledge.nextTrialClose");
    emit("driver-finished");
  } catch (error) {
    emit("driver-failed", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (config.formEntry) productCommands.executeCommand = originalExecute;
    for (const [key, value] of Object.entries(original)) productWindow[key] = value;
  }
};
