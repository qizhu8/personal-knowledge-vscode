import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export type KnowledgeGroupArea = "skills" | "notes" | "papers";

export interface KnowledgeVisualGroup {
  id: string;
  name: string;
  color: string;
  order: number;
}

export interface KnowledgeGroupSnapshot {
  groups: KnowledgeVisualGroup[];
  assignments: Record<string, string>;
  pinnedFolders: string[];
}

interface KnowledgeGroupState {
  schema: 1;
  areas: Partial<Record<KnowledgeGroupArea, KnowledgeGroupSnapshot>>;
}

const DEFAULT_GROUP_ID = "default";
const UNNAMED_GROUP_ID = "unnamed";
const DEFAULT_COLOR = "#4f6b8a";
const UNNAMED_COLOR = "#6b7280";
const MY_IDEAS_COLOR = "#d29922";
let storeRoot = "";

export function setKnowledgeGroupStoreRoot(root: string): void {
  storeRoot = path.resolve(root);
}

function statePath(): string {
  if (!storeRoot) throw new Error("Knowledge Root is not configured.");
  return path.join(storeRoot, ".pkm", "knowledge-groups.json");
}

function defaultArea(area: KnowledgeGroupArea): KnowledgeGroupSnapshot {
  const groups: KnowledgeVisualGroup[] = [
    { id: DEFAULT_GROUP_ID, name: "Default Group", color: DEFAULT_COLOR, order: area === "papers" ? 1 : 0 },
    { id: UNNAMED_GROUP_ID, name: "Unnamed Group", color: UNNAMED_COLOR, order: 1000 },
  ];
  if (area === "papers") groups.unshift({ id: "my-ideas", name: "My Ideas", color: MY_IDEAS_COLOR, order: 0 });
  return {
    groups,
    assignments: area === "papers" ? { MyIdeas: "my-ideas" } : {},
    pinnedFolders: area === "papers" ? ["MyIdeas"] : [],
  };
}

function normalizeColor(value: unknown, fallback = DEFAULT_COLOR): string {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

function normalizeName(value: unknown): string {
  const name = String(value || "").trim();
  if (!name || /[\0\r\n]/.test(name)) throw new Error("Group name is required.");
  return name;
}

function normalizeArea(area: KnowledgeGroupArea, value: any): KnowledgeGroupSnapshot {
  const defaults = defaultArea(area);
  const groups: KnowledgeVisualGroup[] = [];
  if (Array.isArray(value?.groups)) {
    value.groups.forEach((group: any, index: number) => {
      const id = String(group?.id || "").trim();
      const name = String(group?.name || "").trim();
      if (!/^[A-Za-z0-9._-]+$/.test(id) || !name) return;
      groups.push({ id, name, color: normalizeColor(group.color), order: Number.isFinite(group.order) ? Number(group.order) : index });
    });
  }
  for (const required of defaults.groups) {
    if (!groups.some(group => group.id === required.id)) groups.push(required);
  }
  const ids = new Set(groups.map(group => group.id));
  const assignments = Object.fromEntries(Object.entries({ ...defaults.assignments, ...(value?.assignments || {}) })
    .map(([folder, group]) => [String(folder).split("/")[0], String(group)])
    .filter(([folder, group]) => !!folder && ids.has(group)));
  const pinnedFolders = [...new Set<string>((Array.isArray(value?.pinnedFolders) ? value.pinnedFolders : defaults.pinnedFolders)
    .map((folder: unknown) => String(folder).split("/")[0]).filter((folder: string) => !!folder))];
  return { groups: groups.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name)), assignments, pinnedFolders };
}

function readState(): KnowledgeGroupState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (parsed?.schema !== 1 || !parsed.areas || typeof parsed.areas !== "object") throw new Error("unsupported format");
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { schema: 1, areas: {} };
    throw new Error(`Cannot read Knowledge Group metadata: ${error?.message || String(error)}`);
  }
}

function writeState(state: KnowledgeGroupState): void {
  const destination = statePath();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
}

function mutate(area: KnowledgeGroupArea, callback: (snapshot: KnowledgeGroupSnapshot) => void): KnowledgeGroupSnapshot {
  const state = readState();
  const snapshot = normalizeArea(area, state.areas[area]);
  callback(snapshot);
  state.areas[area] = normalizeArea(area, snapshot);
  writeState(state);
  return state.areas[area]!;
}

export function knowledgeGroupSnapshot(area: KnowledgeGroupArea, folders: string[]): KnowledgeGroupSnapshot {
  const snapshot = normalizeArea(area, readState().areas[area]);
  const topLevels = [...new Set(folders.map(folder => String(folder).split("/")[0]).filter(Boolean))];
  for (const folder of topLevels) {
    if (!snapshot.assignments[folder]) snapshot.assignments[folder] = DEFAULT_GROUP_ID;
  }
  for (const folder of Object.keys(snapshot.assignments)) {
    if (!topLevels.includes(folder)) delete snapshot.assignments[folder];
  }
  return snapshot;
}

export function knowledgeGroupCreate(area: KnowledgeGroupArea, name: string, color: string): KnowledgeGroupSnapshot {
  return mutate(area, snapshot => {
    const normalized = normalizeName(name);
    if (snapshot.groups.some(group => group.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error("A Group with this name already exists.");
    const order = Math.max(0, ...snapshot.groups.filter(group => group.id !== UNNAMED_GROUP_ID).map(group => group.order)) + 1;
    snapshot.groups.push({ id: randomUUID(), name: normalized, color: normalizeColor(color), order });
  });
}

export function knowledgeGroupRename(area: KnowledgeGroupArea, groupId: string, name: string): KnowledgeGroupSnapshot {
  return mutate(area, snapshot => {
    const group = snapshot.groups.find(candidate => candidate.id === groupId);
    if (!group) throw new Error("Group was not found.");
    if (group.id === UNNAMED_GROUP_ID) throw new Error("Unnamed Group cannot be renamed.");
    const normalized = normalizeName(name);
    if (snapshot.groups.some(candidate => candidate.id !== group.id && candidate.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error("A Group with this name already exists.");
    group.name = normalized;
  });
}

export function knowledgeGroupSetColor(area: KnowledgeGroupArea, groupId: string, color: string): KnowledgeGroupSnapshot {
  return mutate(area, snapshot => {
    const group = snapshot.groups.find(candidate => candidate.id === groupId);
    if (!group) throw new Error("Group was not found.");
    group.color = normalizeColor(color);
  });
}

export function knowledgeGroupAssign(area: KnowledgeGroupArea, folder: string, groupId: string): KnowledgeGroupSnapshot {
  return mutate(area, snapshot => {
    const topLevel = String(folder || "").split("/")[0];
    if (!topLevel) throw new Error("Choose a top-level folder.");
    if (!snapshot.groups.some(group => group.id === groupId)) throw new Error("Group was not found.");
    snapshot.assignments[topLevel] = groupId;
  });
}

export function knowledgeGroupDelete(area: KnowledgeGroupArea, groupId: string): KnowledgeGroupSnapshot {
  return mutate(area, snapshot => {
    if ([DEFAULT_GROUP_ID, UNNAMED_GROUP_ID, "my-ideas"].includes(groupId)) throw new Error("Built-in Groups cannot be deleted.");
    if (!snapshot.groups.some(group => group.id === groupId)) throw new Error("Group was not found.");
    snapshot.groups = snapshot.groups.filter(group => group.id !== groupId);
    for (const [folder, assigned] of Object.entries(snapshot.assignments)) {
      if (assigned === groupId) snapshot.assignments[folder] = UNNAMED_GROUP_ID;
    }
  });
}

export function knowledgeGroupFolderRenamed(area: KnowledgeGroupArea, oldPath: string, newPath: string): void {
  const oldParts = String(oldPath || "").split("/").filter(Boolean);
  const newTopLevel = String(newPath || "").split("/").filter(Boolean)[0];
  if (oldParts.length !== 1 || !newTopLevel || oldParts[0] === newTopLevel) return;
  mutate(area, snapshot => {
    const assignment = snapshot.assignments[oldParts[0]];
    delete snapshot.assignments[oldParts[0]];
    if (assignment && !snapshot.assignments[newTopLevel]) snapshot.assignments[newTopLevel] = assignment;
    snapshot.pinnedFolders = snapshot.pinnedFolders.map(folder => folder === oldParts[0] ? newTopLevel : folder);
  });
}
