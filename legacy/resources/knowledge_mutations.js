const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

try {
  const [extensionRoot, storeRoot] = process.argv.slice(2);
  if (!extensionRoot || !storeRoot) throw new Error("Extension path and Knowledge Root are required.");
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!["trash", "write-markdown", "work-items-read", "work-item-upsert", "work-item-command", "work-item-notes", "todo-board-create", "todo-api", "capability"].includes(request.operation) || !["skills", "notes", "papers", "prompts", "scripts"].includes(request.area)) {
    throw new Error("Unsupported knowledge mutation.");
  }
  const parts = String(request.path || "").split("/");
  if (parts.some(part => !part || [".", "..", ".trash", ".git"].includes(part) || part.includes("\\"))) {
    throw new Error("Unsafe knowledge path.");
  }
  const root = fs.realpathSync(storeRoot);
  const store = require(path.join(extensionRoot, "dist/knowledge/filestore"));
  store.setStorePath(root);
  const destination = path.join(root, request.area, ...parts);
  for (let current = destination; current !== root; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Symlink mutations are not allowed.");
  }
  if (request.operation === "capability") {
    if (request.area !== "notes") throw new Error("Capabilities require the configured knowledge context.");
    const leafArgs = request.args?.arguments;
    if (request.workerToken !== undefined && !leafArgs?.board_slug) throw new Error("Worker tokens require an exact Board.");
    const actorId = store.noteWorkItemExternalActor(leafArgs?.board_slug || "", request.workerToken);
    const { callCapabilityService } = require(path.join(extensionRoot, "dist/capabilities/service"));
    const memory = request.memoryConfig ? { options: request.memoryConfig, root } : undefined;
    callCapabilityService(request.api, request.args, actorId, memory).then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(`${error.code || "EXECUTION_FAILED"}: ${error.message}`); process.exitCode = 1; });
  } else if (request.operation === "todo-api") {
    if (request.area !== "notes") throw new Error("Todo API requires Notes.");
    const { callTodoApi } = require(path.join(extensionRoot, "dist/knowledge/todo-api"));
    if (request.workerToken !== undefined && !request.args?.board_slug) throw new Error("Worker tokens require an exact Board.");
    const actorId = store.noteWorkItemExternalActor(request.args?.board_slug || "", request.workerToken);
    console.log(JSON.stringify(callTodoApi(request.api, request.args, actorId)));
  } else if (request.operation === "todo-board-create") {
    if (request.area !== "notes" || !request.path.endsWith(".md")) throw new Error("Todo Boards belong in Notes.");
    const slug = request.path.slice(0, -3);
    console.log(JSON.stringify({ ok:true, slug, ...store.todoBoardCreate(slug, request.title, request.category || "") }));
  } else if (request.operation === "work-item-notes") {
    if (request.area !== "notes") throw new Error("Work Item discovery requires Notes.");
    console.log(JSON.stringify({ ok:true, ...store.noteWorkItemNotes(request.query ?? "", request.limit ?? 20) }));
  } else if (["work-items-read", "work-item-upsert", "work-item-command"].includes(request.operation)) {
    if (request.area !== "notes" || !request.path.endsWith(".md")) throw new Error("Work Items require a Markdown Note.");
    const slug = request.path.slice(0, -3);
    let result;
    if (request.operation === "work-items-read") result = store.noteWorkItemsRead(slug);
    else {
      const command = request.operation === "work-item-command" ? request.command
        : { action:store.noteWorkItemsRead(slug).items.some(item => item.id === request.item?.id) ? "edit" : "create", item:request.item };
      result = store.noteWorkItemExternalCommand(slug, request.expectedDigest, command, request.workerToken);
    }
    console.log(JSON.stringify({ ok:true, ...result }));
  } else if (request.operation === "write-markdown") {
    if (!["notes", "skills", "papers"].includes(request.area) || !/\.md$/i.test(request.path) || typeof request.content !== "string"
      || parts[0].toLowerCase() === "system") throw new Error("Invalid Markdown write.");
    if (request.previous && String(request.previous).split("/")[0].toLowerCase() === "system") throw new Error("System content is read-only for MCP writes.");
    store.writeKnowledgeMarkdown(request.area, request.path, request.previous || undefined, request.content);
    console.log(JSON.stringify({ ok: true }));
  } else if (!fs.existsSync(destination)) {
    if (request.expectedSha256) throw new Error("Knowledge changed after preview.");
    console.log(JSON.stringify({ ok: true, absent: true }));
  } else {
    if (request.expectedSha256 && crypto.createHash("sha256").update(fs.readFileSync(destination)).digest("hex") !== request.expectedSha256) {
      throw new Error("Knowledge changed after preview.");
    }
    const entry = store.knowledgePathMoveToTrash(request.area, request.path);
    if (!entry) throw new Error("Knowledge could not be moved to Trash.");
    console.log(JSON.stringify({ ok: true, trash: entry }));
  }
} catch (error) {
  console.error(error.stack || String(error));
  process.exitCode = 1;
}
