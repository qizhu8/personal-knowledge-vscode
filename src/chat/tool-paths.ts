export function relativeToolPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\0:]/.test(value)) throw new Error("Use a workspace-relative path.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").some(part => !part || part.startsWith(".") || part === "node_modules")) throw new Error("Hidden, excluded or outside-workspace paths are not allowed.");
  if (/\.(pem|key)$/i.test(normalized) || /(^|\/)(credentials|id_rsa|id_ed25519)(\.|$)/i.test(normalized)) throw new Error("Attach sensitive files explicitly instead of using tools.");
  return normalized;
}
