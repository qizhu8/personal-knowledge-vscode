import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SelectedActionArtifact {
  path: string;
  selectedRoot: string;
  expectedSha256: string;
  size: number;
}
export interface SelectedActionDestination { path: string; selectedRoot: string }

function inspect(filename: string): SelectedActionArtifact {
  if (process.platform !== "linux" || !path.isAbsolute(filename) || path.resolve(filename) !== filename)
    throw new Error("Action artifact selection requires a canonical Linux path.");
  const selectedRoot = path.dirname(filename);
  if (fs.realpathSync(selectedRoot) !== selectedRoot) throw new Error("Action artifact parent must not contain links.");
  const parent = fs.openSync(selectedRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const anchored = path.join(`/proc/self/fd/${parent}`, path.basename(filename));
    const before = fs.lstatSync(anchored);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 32 * 1024 * 1024)
      throw new Error("Choose a regular, single-link Action artifact under 32 MiB.");
    const fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const pin = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      if (pin(fs.fstatSync(fd)) !== pin(before)) throw new Error("Action artifact changed before inspection.");
      const bytes = fs.readFileSync(fd);
      if (pin(fs.fstatSync(fd)) !== pin(before) || pin(fs.lstatSync(anchored)) !== pin(before)
        || pin(fs.lstatSync(filename)) !== pin(before) || bytes.length !== before.size)
        throw new Error("Action artifact changed during inspection.");
      return { path: filename, selectedRoot, expectedSha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
    } finally { fs.closeSync(fd); }
  } finally { fs.closeSync(parent); }
}

export function createActionArtifactPicker(ui: {
  select(): Promise<string | undefined>;
  confirm(source: Readonly<SelectedActionArtifact>): Promise<boolean>;
}) {
  return async (): Promise<SelectedActionArtifact | undefined> => {
    const filename = await ui.select();
    if (!filename) return undefined;
    const source = inspect(filename);
    if (!await ui.confirm(Object.freeze({ ...source }))) return undefined;
    const current = inspect(filename);
    if (JSON.stringify(current) !== JSON.stringify(source)) throw new Error("Action artifact changed after confirmation.");
    return current;
  };
}

export function createActionArtifactDestinationPicker(ui: {
  select(): Promise<string | undefined>;
  confirm(destination: Readonly<SelectedActionDestination>, artifact: Readonly<{ artifactId: string; digest: string; size: number }>): Promise<boolean>;
}) {
  return async (artifact: Readonly<{ artifactId: string; digest: string; size: number }>): Promise<SelectedActionDestination | undefined> => {
    const filename = await ui.select();
    if (!filename) return undefined;
    const inspect = () => {
      if (process.platform !== "linux" || !path.isAbsolute(filename) || path.resolve(filename) !== filename)
        throw new Error("Action artifact export requires a canonical Linux path.");
      const selectedRoot = path.dirname(filename);
      if (fs.realpathSync(selectedRoot) !== selectedRoot) throw new Error("Action artifact destination parent must not contain links.");
      const parent = fs.lstatSync(selectedRoot);
      if (!parent.isDirectory() || parent.isSymbolicLink() || fs.lstatSync(filename, { throwIfNoEntry: false }))
        throw new Error("Action artifact destination must not already exist.");
      return { destination: { path: filename, selectedRoot }, pin: `${parent.dev}:${parent.ino}` };
    };
    const before = inspect();
    if (!await ui.confirm(Object.freeze({ ...before.destination }), Object.freeze({ ...artifact }))) return undefined;
    const after = inspect();
    if (after.pin !== before.pin) throw new Error("Action artifact destination parent changed after confirmation.");
    return after.destination;
  };
}
