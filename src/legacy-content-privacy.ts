const privacyTypes = new Set([
  "skills", "notes", "papers", "prompts", "packages", "servers", "scripts", "recipes", "actions", "action-module-sets",
]);
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "PKM_STATE_UNSUPPORTED", path: ".pkm/content-privacy.json" });
}
export function validatePrivacyPolicy(bytes: Buffer): void {
  let state: unknown;
  try { state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("Original content privacy must remain valid UTF-8 JSON."); }
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !("schema" in state) || state.schema !== 1
    || !("private" in state) || !state.private || typeof state.private !== "object" || Array.isArray(state.private)) {
    fail("Only the original schema-1 content privacy policy is supported by this slice.");
  }
  if (Object.keys(state).some(key => key !== "schema" && key !== "private")) {
    fail("Original content privacy has unsupported schema-1 fields.");
  }
  for (const [type, values] of Object.entries(state.private)) {
    if (!privacyTypes.has(type) || !Array.isArray(values)
      || values.some(value => typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))) {
      fail("Original content privacy contains an unsupported type or non-array policy.");
    }
  }
}
