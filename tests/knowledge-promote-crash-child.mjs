import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";
import { Storage } from "../dist/storage.js";
import { nativeActor, openNativeRuntime } from "./native-runtime-fixtures.mjs";

const [root, point, requestJson] = process.argv.slice(2);
const request = JSON.parse(requestJson);
const sourceContainer = join(root, request.area, request.path);
const storage = await Storage.open(root);
const configured = await openNativeRuntime(storage);
const originalExec = childProcess.execFileSync, originalRename = fs.renameSync;
const originalUnlink = fs.unlinkSync, originalRmdir = fs.rmdirSync;
let moves = 0;
const stop = () => process.kill(process.pid, "SIGKILL");
childProcess.execFileSync = function (command, args, options) {
  const childMove = args?.[2]?.startsWith(sourceContainer + sep);
  if (childMove && point === "rollback" && moves === 1) {
    const error = new Error("Synthetic second-child move failure");
    error.status = 79;
    throw error;
  }
  const result = originalExec.call(this, command, args, options);
  if (childMove) {
    moves++;
    if (point === "asset-pair" && moves === 1 || point === "multi-child" && moves === 3) stop();
  }
  return result;
};
fs.renameSync = function (source, destination) {
  if (String(source).includes(".pkm-write-")) {
    if (point === "markdown-staging" && String(destination).endsWith("Alpha.md")) stop();
    if (point === "pin-staging" && String(destination).endsWith(".pk-meta.json")) stop();
  }
  const result = originalRename.call(this, source, destination);
  if (point === "pin-published" && String(destination).endsWith(".pk-meta.json")) stop();
  return result;
};
fs.unlinkSync = function (path) {
  const result = originalUnlink.call(this, path);
  if (point === "marker-removed" && path === join(sourceContainer, ".gitkeep")) stop();
  return result;
};
fs.rmdirSync = function (path, options) {
  const result = originalRmdir.call(this, path, options);
  if (point === "container-removed" && path === sourceContainer) stop();
  return result;
};
syncBuiltinESMExports();
try {
  const result = await configured.core.dispatch("capability_call", {
    operation: "knowledge.folder.promote-delete", version: 1, arguments: request,
  }, nativeActor);
  if (point !== "rollback" || !result.error) throw new Error(`Expected injected interruption: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result));
} finally {
  await configured.runtime.close();
  await storage.close();
}
