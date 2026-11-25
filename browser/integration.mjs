// @ts-check
/**
 * Host integration checklist, not a server implementation. Static files must be exact allowlisted
 * same-origin resources, served before bearer authentication so the token-entry form can load.
 * API remains bearer authenticated; accept only the exact server Origin (never permissive CORS).
 * Inject native owner/provider adapters before advertising Manager/Chat operations.
 * The HTTP server serves these exact resources and accepts only its own browser Origin.
 * No SSE is declared by the current canonical protocol; ordered cursor polling is used.
 */
export const integration = Object.freeze({
  staticFiles: Object.freeze([
    "index.html", "bootstrap.mjs", "host-config.mjs", "protocol.mjs", "workspace.mjs", "workspace.css",
    "workflow-surfaces.mjs", "workflow-surfaces.css",
    "knowledge-lifecycle.mjs", "knowledge-lifecycle.css", "shared-management.mjs",
  ]),
  apiMethods: Object.freeze(["server_info", "capabilities_describe", "capability_read", "capability_call"]),
  apiPath: "/v1/",
  envelope: "pkm.next-result/v1",
  staticHeaders: Object.freeze({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
  }),
});
