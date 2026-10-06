import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../runtime/cross-process-lock";

export interface ChatFolder { id: string; name: string; }
export interface ChatPlacement { groupId: string; trashedAt?: string; }
interface LibraryState { version: 1; groups: ChatFolder[]; placements: Record<string, ChatPlacement>; }

export class ChatLibrary {
  constructor(private readonly directory: string) {}

  read(): LibraryState {
    const file = path.join(this.directory, "library.json");
    if (!fs.existsSync(file)) return { version: 1, groups: [], placements: {} };
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as LibraryState;
    if (state.version !== 1 || !Array.isArray(state.groups) || !state.placements || typeof state.placements !== "object" || Array.isArray(state.placements)
      || state.groups.some(group => !/^chat_group_[a-f0-9]{32}$/.test(group.id) || typeof group.name !== "string" || !group.name.trim() || group.name.length > 120)) throw new Error("Unsupported Chat library format.");
    const groupIds = new Set(state.groups.map(group => group.id));
    if (groupIds.size !== state.groups.length || Object.entries(state.placements).some(([id, placement]) => !/^[a-f0-9-]{36}$/.test(id) || !placement || typeof placement !== "object" || Array.isArray(placement) || placement.groupId !== "ungroup" && !groupIds.has(placement.groupId) || placement.trashedAt !== undefined && (typeof placement.trashedAt !== "string" || !Number.isFinite(Date.parse(placement.trashedAt))))) throw new Error("Unsupported Chat library placement format.");
    return state;
  }

  createGroup(name: string): string {
    const id = "chat_group_" + randomUUID().replace(/-/g, "");
    this.update(state => { state.groups.push({ id, name: this.name(name, state) }); });
    return id;
  }

  renameGroup(id: string, name: string): void {
    this.update(state => { this.group(state, id).name = this.name(name, state, id); });
  }

  deleteGroup(id: string): void {
    this.update(state => {
      this.group(state, id); state.groups = state.groups.filter(group => group.id !== id);
      for (const placement of Object.values(state.placements)) if (placement.groupId === id) placement.groupId = "ungroup";
    });
  }

  move(chatId: string, groupId: string): void {
    this.update(state => {
      if (groupId !== "ungroup") this.group(state, groupId);
      state.placements[this.chatId(chatId)] = { ...state.placements[chatId], groupId };
    });
  }

  trash(chatId: string): void {
    this.update(state => { state.placements[this.chatId(chatId)] = { groupId: state.placements[chatId]?.groupId || "ungroup", trashedAt: new Date().toISOString() }; });
  }

  restore(chatId: string): void {
    this.update(state => {
      const placement = state.placements[this.chatId(chatId)];
      if (!placement?.trashedAt) throw new Error("This Chat is not in Trash.");
      delete placement.trashedAt;
    });
  }

  forget(chatId: string): void { this.update(state => { delete state.placements[this.chatId(chatId)]; }); }

  private chatId(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid Chat identity.");
    return id;
  }

  private group(state: LibraryState, id: string): ChatFolder {
    const group = state.groups.find(item => item.id === id);
    if (!group) throw new Error("Choose an existing Chat group. Ungroup cannot be renamed or deleted.");
    return group;
  }

  private name(name: string, state: LibraryState, id?: string): string {
    name = name.trim();
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Enter a group name of 1-120 characters without control characters.");
    if (["ungroup", "trash"].includes(name.toLowerCase()) || state.groups.some(group => group.id !== id && group.name.toLowerCase() === name.toLowerCase())) throw new Error("A Chat group with that name already exists.");
    return name;
  }

  private update(change: (state: LibraryState) => void): void {
    withCrossProcessLockSync(path.join(this.directory, "library.lock"), "Chat library", () => {
      const state = this.read(); change(state);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.directory, `library.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, path.join(this.directory, "library.json"));
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    });
  }
}