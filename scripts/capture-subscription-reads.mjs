import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash, checkCaptureRecords } from "./migration.mjs";

const sourceRoot = resolve(packageRoot, "legacy");
const files = [];
async function capture(source, captured, transform = value => value) {
  const original = await readFile(resolve(sourceRoot, source), "utf8");
  const content = transform(original);
  await writeFile(resolve(packageRoot, captured), content);
  files.push({ source, captured, sourceSha256: hash(original), capturedSha256: hash(content) });
}
await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
await capture("src/subscriptions/subscription-acl.ts", "src/domain/subscription-reads-acl.ts", value =>
  value.replace('"./subscription-ip-policy"', '"./subscription-reads-ip-policy.js"'));
await capture("src/subscriptions/subscription-ip-policy.ts", "src/domain/subscription-reads-ip-policy.ts", value =>
  value.replace('import * as ipaddr from "ipaddr.js";', 'import ipaddr from "ipaddr.js";')
    .replace("address.match(range)", "(address as ipaddr.IPv4).match(range as [ipaddr.IPv4, number])"));
await capture("src/subscriptions/subscriptions.ts", "src/domain/subscription-reads-record.ts", value => {
  const parsed = ts.createSourceFile("subscriptions.ts", value, ts.ScriptTarget.Latest, true);
  const names = new Set(["SubscriptionPriority", "SubscriptionRecord", "subscriptionPriority"]);
  const selected = parsed.statements.filter(node => node.name && names.has(node.name.getText(parsed)));
  if (selected.length !== names.size) throw new Error("Subscription record capture boundaries changed.");
  return selected.map(node => {
    const text = node.getText(parsed);
    return text.startsWith("export ") ? text : `export ${text}`;
  }).join("\n\n") + "\n";
});
await capture("src/subscriptions/subscription-gateway-entry.ts", "src/domain/subscription-reads-policy.ts", value => {
  const parsed = ts.createSourceFile("subscription-gateway-entry.ts", value, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "aclAllowed");
  const policy = declaration?.body?.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(parsed) === "policy"));
  if (!policy) throw new Error("Original broker policy capture boundaries changed.");
  return `import type { BrokerAclPolicy } from "./subscription-reads-acl.js";

export function persistedBrokerAclPolicy(share: {
  summary: { shareId: string };
  accountMode?: BrokerAclPolicy["accountMode"];
  accountRules?: string[];
  accessMode?: BrokerAclPolicy["networkMode"];
  ipRules?: string[];
}, stats: { automaticBlocks: Record<string, Record<string, unknown>> }): BrokerAclPolicy {
  ${policy.getText(parsed)}
  return policy;
}
`;
});
await capture("tests/test-subscription-acl.js", "tests/subscription-reads-original.test.mjs", value =>
  value.replace('#!/usr/bin/env node\n', "")
    .replace('const assert = require("assert");', 'import assert from "node:assert/strict";')
    .replace('const { BrokerAcl } = require("../dist/subscriptions/subscription-acl");',
      'import { BrokerAcl } from "../dist/domain/subscription-reads-acl.js";'));
const provenance = {
  schema: "pkm.domain-capture/v1",
  transformation: "Original BrokerAcl and IP policy runtime bodies unchanged; local ESM import rewritten, CJS ipaddr namespace import changed to ESM default, and erased type assertion added for TypeScript 6 union-overload compatibility. AST-selected persisted record/priority declarations unchanged except export; gateway aclAllowed policy initializer captured unchanged inside typed pure function. Original ACL regression executable imports rewritten for isolated ESM.",
  files,
  requiredDependencies: { casbin: "5.51.1", "ipaddr.js": "2.5.0" },
  qualification: "Local persisted metadata projection and pure policy evaluation only. No gateway, MQTT, remote proof verification, owner bypass, authorization grant, credentials, materialization or fork adapter. Original state belongs to extension globalStorage, not Knowledge Root; only explicit isolated fixture copies are supported.",
};
await writeFile(resolve(packageRoot, "migration/subscription-reads-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
const issues = await checkCaptureRecords(files, sourceRoot, packageRoot);
if (issues.length) throw new Error(JSON.stringify(issues));
console.log(`Captured and checked ${files.length} original subscription read sources.`);
