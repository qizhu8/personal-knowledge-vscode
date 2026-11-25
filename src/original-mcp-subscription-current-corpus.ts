import { createDecipheriv, createHash, createHmac, scryptSync } from "node:crypto";
import { z } from "zod";
import { validateCurrentSubscriptionBrokerRecord } from "./legacy-subscription-membership-change.js";
import { validateNativeGitHubTarget } from "./native-subscription-github.js";
import type { CurrentSubscriptionManifest } from "./original-mcp-subscription-profile-contracts.js";

type File = { path: string; bytes: Uint8Array; size: number; sha256: string };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => { throw Object.assign(new Error("NATIVE_SUBSCRIPTION_CORPUS_INVALID"), { code: "NATIVE_SUBSCRIPTION_CORPUS_INVALID" }); };
const envelopeSchema = z.strictObject({ v: z.literal(1), alg: z.literal("A256GCM"),
  iv: z.string().max(64), ciphertext: z.string().max(3 * 1024 * 1024), tag: z.string().max(64) });
const relative = (...parts: unknown[]) => parts.flatMap(part => String(part || "").replace(/\\/g, "/").split("/"))
  .map(part => part.trim().replace(/[<>:"|?*\u0000-\u001f]/g, "-")).filter(part => part && part !== "." && part !== "..").join("/") || "untitled";

/** Match the original materializer's projection to the signed downloaded bundle, not merely to self-reported cache hashes. */
export function verifyOriginalCurrentSubscriptionCorpus(manifest: CurrentSubscriptionManifest, files: File[],
  protectedMaterial?: ReadonlyMap<string, string>): void {
  const byPath = new Map(files.map(file => [file.path, file]));
  const read = (path: string) => {
    const file = byPath.get(path);
    if (!file || file.bytes.length !== file.size || hash(file.bytes) !== file.sha256) return fail();
    return Buffer.from(file.bytes);
  };
  for (const member of manifest.state.subscriptions) {
    if (member.source?.type === "github") {
      const prefix = `cache/${member.nodeId}/${member.shareId}/content/`;
      validateNativeGitHubTarget({ state: manifest.state, directories: [], files }, {
        action: "github-refresh", publisherNodeId: member.nodeId, shareId: member.shareId, subscriptionId: member.id,
        repository: member.source.repository, branch: member.source.branch, commit: member.source.commit,
        credentialTargetId: member.source.credentialTargetId || member.source.targetId || null,
        files: files.filter(file => file.path.startsWith(prefix) && !file.path.endsWith(".pkm-source.json"))
          .map(file => ({ path: file.path.slice(prefix.length), sha256: file.sha256, size: file.size })),
      });
      continue;
    }
    validateCurrentSubscriptionBrokerRecord(member, files);
    const prefix = `cache/${member.nodeId}/${member.shareId}/`, plaintext = read(`${prefix}bundle.json`);
    if (member.secretProtected) {
      const encrypted = read(`${prefix}bundle.encrypted.json`);
      if (`sha256:${hash(encrypted)}` !== member.collectionHash) return fail();
      if (protectedMaterial) {
        const material = protectedMaterial.get(member.id);
        if (!material || material.length > 4096 || !member.secretSalt) return fail();
        const base = scryptSync(material, Buffer.from(member.secretSalt, "base64url"), 32);
        const key = createHmac("sha256", base).update("pkm-share-content:v1").digest();
        try {
          const envelope = envelopeSchema.parse(JSON.parse(encrypted.toString("utf8")));
          const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
          decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
          const decoded = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
          if (!decoded.equals(plaintext)) return fail();
        } finally { base.fill(0); key.fill(0); }
      }
    } else if (`sha256:${hash(plaintext)}` !== member.collectionHash) return fail();
    let bundle: Record<string, any>;
    try {
      bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return fail();
    } catch { return fail(); }
    const expected = new Map<string, string>();
    const item = (kind: string, path: string, content: string) => {
      const name = `${prefix}${relative("content", kind, path)}`;
      if (expected.has(name) || expected.size >= 128 || name.length > 2048 || Buffer.byteLength(content) > 2 * 1024 * 1024) return fail();
      expected.set(name, content);
    };
    for (const skill of bundle.skills || []) item("skills", `${skill.metadata?.category ? `${skill.metadata.category}/` : ""}${skill.name}.md`, String(skill.content || ""));
    for (const note of bundle.notes || []) item("notes", `${note.slug || note.title || "note"}.md`, String(note.content || ""));
    for (const paper of bundle.papers || []) item("papers", `${paper.slug || [paper.category, paper.title || "paper"].filter(Boolean).join("/")}.md`, String(paper.content || ""));
    for (const prompt of bundle.prompts || []) item("prompts", `${prompt.project}/${prompt.task}/${prompt.version}/${prompt.file}`, String(prompt.content || ""));
    for (const script of bundle.scripts || []) item("scripts", `${script.category === "(root)" ? "" : `${script.category}/`}${script.file}`, String(script.content || ""));
    for (const pkg of bundle.packages || []) for (const file of pkg.files || []) item("packages", `${pkg.name}/${file.path}`, String(file.content || ""));
    for (const server of bundle.servers || []) item("servers", `${server.slug}/server.link.json`, JSON.stringify({ name: server.name, category: server.category, tags: server.tags, url: server.url || "" }, null, 2));
    for (const recipe of bundle.recipes || []) item("recipes", `${recipe.category ? `${recipe.category}/` : ""}${recipe.recipeId}.json`, JSON.stringify(recipe, null, 2));
    for (const [path, content] of expected) {
      if (!read(path).equals(Buffer.from(content))) return fail();
      const provenance = JSON.parse(read(`${path}.pkm-source.json`).toString("utf8"));
      if (provenance.subscriptionId !== member.id || provenance.nodeId !== member.nodeId || provenance.shareId !== member.shareId
        || provenance.revision !== member.revision || provenance.contentHash !== `sha256:${hash(content)}`) return fail();
    }
    if (files.some(file => file.path.startsWith(`${prefix}content/`)
      && !expected.has(file.path) && !(file.path.endsWith(".pkm-source.json") && expected.has(file.path.slice(0, -16))))) return fail();
  }
}
