import { constants, accessSync, lstatSync, readFileSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const pinSchema = z.strictObject({
  dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), mode: z.string().regex(/^\d+$/),
  size: z.string().regex(/^\d+$/), mtimeNs: z.string().regex(/^\d+$/), ctimeNs: z.string().regex(/^\d+$/),
});
export const hostPythonHandleSchema = z.strictObject({
  schema: z.literal("pkm.host-python-environment/v1"),
  workspaceId: z.uuid(), actorId: z.string().min(1).max(256).regex(/^[^\0\r\n]+$/),
  environmentId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  root: z.string().min(1), executable: z.string().min(1), target: z.string().min(1),
  rootPin: pinSchema, entryPin: pinSchema, targetPin: pinSchema,
});
export type HostPythonHandle = z.infer<typeof hostPythonHandleSchema>;
function pin(stat: BigIntStats) {
  return Object.fromEntries(["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .map(key => [key, String(stat[key as keyof BigIntStats])]));
}
export function verifyHostPythonHandle(value: unknown, workspaceId: string, actorId: string): HostPythonHandle {
  const handle = hostPythonHandleSchema.parse(value);
  if (handle.workspaceId !== workspaceId || handle.actorId !== actorId) throw new Error("Python workspace/actor binding rejected.");
  for (const item of [handle.root, handle.executable, handle.target]) {
    if (!isAbsolute(item) || resolve(item) !== item || item.includes("\0")) throw new Error("Python path is not canonical.");
  }
  if (realpathSync(handle.root) !== handle.root || !lstatSync(handle.root).isDirectory()
    || realpathSync(dirname(handle.executable)) !== dirname(handle.executable)
    || ![join(handle.root, "bin", "python"), join(handle.root, "Scripts", "python.exe")].includes(handle.executable)
    || realpathSync(handle.executable) !== handle.target || realpathSync(handle.target) !== handle.target
    || !statSync(handle.target).isFile()) throw new Error("Python interpreter/root mapping rejected.");
  const same = (stat: BigIntStats, value: z.infer<typeof pinSchema>) =>
    (Object.keys(value) as (keyof typeof value)[]).every(key => String(stat[key]) === value[key]);
  if (!same(lstatSync(handle.root, { bigint: true }), handle.rootPin)
    || !same(lstatSync(handle.executable, { bigint: true }), handle.entryPin)
    || !same(statSync(handle.target, { bigint: true }), handle.targetPin)) throw new Error("Python environment changed; select it again.");
  accessSync(handle.executable, constants.X_OK);
  return handle;
}
export const registeredPythonSelectionSchema = z.strictObject({
  handle: hostPythonHandleSchema,
  registry: z.strictObject({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/), identity: z.string().max(1024) }),
});
export function selectRegisteredHostPythonEnvironment(path: string, workspaceId: string, actorId: string, environmentId: string) {
  const stat = lstatSync(path, { bigint: true });
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !stat.isFile() || stat.nlink !== 1n
    || stat.size > 262144n || process.platform !== "win32" && (stat.uid !== BigInt(process.getuid!()) || stat.mode & 0o022n))
    throw new Error("Registered Python selection requires an exact owned bounded registry.");
  const bytes = readFileSync(path), identity = JSON.stringify(pin(stat));
  const entries = z.array(z.object({ id: z.string(), path: z.string(), python: z.string() }).passthrough()).max(128).parse(JSON.parse(bytes.toString("utf8")));
  const matches = entries.filter(item => item.id === environmentId);
  if (matches.length !== 1) throw new Error("Registered Python environment is absent or ambiguous.");
  const entry = matches[0]!, target = realpathSync(entry.python);
  const handle = verifyHostPythonHandle({
    schema: "pkm.host-python-environment/v1", workspaceId, actorId, environmentId,
    root: entry.path, executable: entry.python, target,
    rootPin: pin(lstatSync(entry.path, { bigint: true })), entryPin: pin(lstatSync(entry.python, { bigint: true })),
    targetPin: pin(statSync(target, { bigint: true })),
  }, workspaceId, actorId);
  if (identity !== JSON.stringify(pin(lstatSync(path, { bigint: true }))) || !readFileSync(path).equals(bytes))
    throw new Error("Registered Python source changed during selection.");
  return registeredPythonSelectionSchema.parse({ handle, registry: {
    path, identity, sha256: createHash("sha256").update(bytes).digest("hex"),
  } });
}
