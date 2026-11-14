"use strict";

process.once("message", () => {
  process.send({ type: "startup-error", message: "Synthetic rejected restart" });
  process.send({ type: "close-error" }, () => process.disconnect());
  // Keep the process alive after IPC disconnect to check that the parent retains it.
  setTimeout(() => { process.exitCode = 1; }, 200);
});
