"use strict";
const path = require("node:path");
function build(root, outfile) {
  require("esbuild").buildSync({
    entryPoints: [path.join(root, "compat", "legacy-chatroom-retained.ts")],
    bundle: true, platform: "node", format: "cjs", absWorkingDir: root,
    outfile, logLevel: "silent",
  });
}
exports.build = build;
if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  build(root, path.join(root, "dist", "legacy-chatroom-retained.cjs"));
}
