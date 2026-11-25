export interface SharedManagedBinding {
  origin: string;
  serviceId: string;
  token: string;
}
export async function sharedManagementBodySha256(serviceId: string, action: string,
  input: { generation?: unknown; receiptId?: unknown; acknowledge?: unknown } = {}): Promise<string> {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const actions = ["switch", "recover", "cleanup-runtime", "reset-index", "reconcile", "revoke-access", "human-review-enrollment"];
  const acknowledge = action === "reconcile" ? "reviewed-outcome-no-replay"
    : action === "revoke-access" ? "revoke-current-business-credential" : null;
  if (!uuid.test(serviceId) || !actions.includes(action)
    || (action === "switch" ? typeof input.generation !== "string" || !uuid.test(input.generation) : input.generation !== undefined)
    || (action === "reconcile" ? typeof input.receiptId !== "string" || !uuid.test(input.receiptId) : input.receiptId !== undefined)
    || input.acknowledge !== undefined && input.acknowledge !== acknowledge)
    throw new Error("Invalid semantic management operation.");
  const semantic = { schema: "pkm.shared-management-body/v1", serviceId, action,
    generation: input.generation ?? null, receiptId: input.receiptId ?? null, acknowledge };
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(semantic)));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

export function validateSharedManagedBinding(binding: SharedManagedBinding) {
  const url = new URL(binding.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.origin !== binding.origin || !/^[a-f0-9-]{36}$/.test(binding.serviceId)
    || binding.token.length < 32 || /[\r\n]/.test(binding.token))
    throw new Error("Invalid independently provisioned shared service binding.");
}

/** No retry, redirect following, inferred origin or authority escalation. */
export async function sharedManagedRequest(binding: SharedManagedBinding, path: string, input?: unknown) {
  validateSharedManagedBinding(binding);
  if (!/^\/(?:shared|manage)\/[a-z-]+$/.test(path)) throw new Error("Invalid shared service route.");
  const response = await fetch(`${binding.origin}${path}`, {
    method: input === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${binding.token}`, "X-PKM-Service-Id": binding.serviceId,
      ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const value = await response.json() as Record<string, any>;
  if (!response.ok || value.error) throw new Error(JSON.stringify(value));
  return value;
}
