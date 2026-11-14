export interface PortalRoute {
  contextId: string;
  machine?: string;
  connected: boolean;
  role?: string;
  capabilities: readonly string[];
}
export interface PortalRequirements { platform?: string; programs?: string[]; }

export function parsePortalRequirements(value: unknown): PortalRequirements {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provide explicit remote execution requirements.");
  const requirements = value as Record<string, unknown>;
  if (requirements.platform !== undefined && !["win32", "linux", "darwin"].includes(String(requirements.platform))
    || requirements.programs !== undefined && (!Array.isArray(requirements.programs) || requirements.programs.length > 8
      || requirements.programs.some(program => typeof program !== "string" || !/^[a-z0-9._-]{1,48}$/.test(program)))) {
    throw new Error("Invalid Portal platform or program requirements.");
  }
  if (!requirements.platform && !(Array.isArray(requirements.programs) && requirements.programs.length)) throw new Error("Specify a required platform or program.");
  return { ...(typeof requirements.platform === "string" ? { platform: requirements.platform } : {}),
    ...(Array.isArray(requirements.programs) ? { programs: requirements.programs.map(String) } : {}) };
}

export function selectPortalRoute(routes: readonly PortalRoute[], value: unknown): PortalRoute {
  const requirements = parsePortalRequirements(value);
  const matching = routes.filter(route => route.connected && route.role === "controller" && route.capabilities.includes("commands-v1")
    && (!requirements.platform || route.capabilities.includes(`platform:${requirements.platform}`))
    && (requirements.programs || []).every(program => route.capabilities.includes(`program:${program}`)));
  if (!matching.length) throw new Error("No connected Portal executing Host satisfies these capabilities. Connect/pair an appropriate Host and obtain execution-side authorization; no command or model was invoked.");
  if (matching.length !== 1) throw new Error("Multiple Portal Hosts satisfy these capabilities. Choose an explicit contextId; no command was sent.");
  return matching[0];
}
