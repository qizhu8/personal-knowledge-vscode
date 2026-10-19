const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

try {
  const [extensionRoot, storeRoot] = process.argv.slice(2);
  if (!extensionRoot || !storeRoot) throw new Error("Extension path and Knowledge Root are required.");
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  if (request.operation !== "trash" || !["skills", "notes", "papers", "prompts", "scripts"].includes(request.area)) {
    throw new Error("Unsupported knowledge mutation.");
  }
  const parts = String(request.path || "").split("/");
  if (parts.some(part => !part || [".", "..", ".trash", ".git"].includes(part) || part.includes("\\"))) {
    throw new Error("Unsafe knowledge path.");
  }
  const root = fs.realpathSync(storeRoot);
  const destination = path.join(root, request.area, ...parts);
  for (let current = destination; current !== root; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink mutations are not allowed.");
  }
  if (!fs.existsSync(destination)) {
    if (request.expectedSha256) throw new Error("Knowledge changed after preview.");
    console.log(JSON.stringify({ ok: true, absent: true }));
  } else {
    if (request.expectedSha256 && crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex") !== request.expectedSha256) {
      throw new Error("Knowledge changed after preview.");
    }
    const store = require(path.join(extensionRoot, "dist/knowledge/filestore"));
    store.setStorePath(root);
    const entry = store.knowledgePathMoveToTrash(request.area, request.path);
    if (!entry) throw new Error("Knowledge could not be moved to Trash.");
    console.log(JSON.stringify({ ok: true, trash: entry }));
  }
} catch (error) {
  console.error(error.stack || String(error));
  process.exitCode = 1;
}
