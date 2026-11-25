import { readFile } from "node:fs/promises";
import { z } from "zod";

const manifestSchema = z.strictObject({
  staticFiles: z.tuple([
    z.literal("index.html"), z.literal("bootstrap.mjs"), z.literal("host-config.mjs"),
    z.literal("protocol.mjs"), z.literal("workspace.mjs"), z.literal("workspace.css"),
    z.literal("workflow-surfaces.mjs"), z.literal("workflow-surfaces.css"),
    z.literal("knowledge-lifecycle.mjs"), z.literal("knowledge-lifecycle.css"),
    z.literal("shared-management.mjs"),
  ]),
  apiMethods: z.tuple([
    z.literal("server_info"), z.literal("capabilities_describe"), z.literal("capability_read"), z.literal("capability_call"),
  ]),
  apiPath: z.literal("/v1/"),
  envelope: z.literal("pkm.next-result/v1"),
  staticHeaders: z.strictObject({
    "Cache-Control": z.literal("no-store"),
    "X-Content-Type-Options": z.literal("nosniff"),
    "Referrer-Policy": z.literal("no-referrer"),
    "Content-Security-Policy": z.literal("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'"),
  }),
});

export async function loadBrowserAssets() {
  const module = await import(new URL("../browser/integration.mjs", import.meta.url).href);
  const manifest = manifestSchema.parse(module.integration);
  const assets = new Map<string, Buffer>(await Promise.all(manifest.staticFiles.map(async name => [
    `/${name}`, await readFile(new URL(`../browser/${name}`, import.meta.url)),
  ] as const)));
  assets.set("/shared-managed-client.mjs", await readFile(new URL("./shared-managed-client.js", import.meta.url)));
  return { assets, headers: manifest.staticHeaders };
}
