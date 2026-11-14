import { rename, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const [rootArg, action, targetArg] = process.argv.slice(2);
const root = resolve(rootArg);
const target = resolve(root, targetArg);
const rel = relative(root, target);
if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target ||
  !["update", "rename", "delete", "asset"].includes(action)) {
  throw new Error("Invalid bounded legacy read race writer request.");
}

if (action === "update") {
  const before = await readFile(target, "utf8");
  if (!before.includes("revision: 1")) throw new Error("Unexpected document revision.");
  const after = before.replace("revision: 1", "revision: 2").replace("body-marker-02", "body-marker-02-updated");
  const staged = `${target}.pkm-write-batch13`;
  await writeFile(staged, after, { flag: "wx" });
  await rename(staged, target);
} else if (action === "rename") {
  await rename(target, join(dirname(target), "renamed-02.md"));
} else if (action === "delete") {
  await unlink(target);
} else {
  const before = await readFile(target);
  const staged = `${target}.pkm-write-batch13`;
  await writeFile(staged, Buffer.concat([before, Buffer.from("-external-update")]), { flag: "wx" });
  await rename(staged, target);
}
process.stdout.write(`external-${action}-complete\n`);
