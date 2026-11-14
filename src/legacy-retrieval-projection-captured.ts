// Generated original source normalizers; do not edit.
type Cite = { paper: string; note: string };
type SkillPriority = "normal" | "high" | "highest";
export function asArray(v: any): string[] {
  return Array.isArray(v) ? v : v ? [String(v)] : [];
}

export function skillPriority(value: unknown): SkillPriority {
  return value === "high" || value === "highest" ? value : "normal";
}

export function normalizeCites(v: any): Cite[] {
  if (!Array.isArray(v)) return [];
  const out: Cite[] = [];
  for (const e of v) {
    if (typeof e === "string") { if (e.trim()) out.push({ paper: e.trim(), note: "" }); }
    else if (e && typeof e === "object") {
      const paper = String(e.paper ?? e.key ?? e.target ?? "").trim();
      if (paper) out.push({ paper, note: String(e.note ?? e.comment ?? "") });
    }
  }
  return out;
}

export function toYear(v: any): number | null {
  if (typeof v === "number") return v;
  if (v == null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
