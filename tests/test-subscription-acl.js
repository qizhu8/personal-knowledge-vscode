#!/usr/bin/env node
const assert = require("assert");
const { BrokerAcl } = require("../dist/subscription-acl");

async function allowed(policy, accountId, sourceIp, action = "request-sync") {
  const acl = await BrokerAcl.create({ shareId: "share-1", accountMode: "open", accountRules: [], networkMode: "block-list", ipRules: [], automaticBlocks: [], ...policy });
  return acl.enforce({ accountId, sourceIp, shareId: "share-1", action });
}

async function main() {
  assert(await allowed({}, "account-a", "10.0.0.1"), "open ACL must allow signed accounts");
  assert(!(await allowed({ accountMode: "block-list", accountRules: ["account-a"] }, "account-a", "10.0.0.1")), "account deny must override allow");
  assert(await allowed({ accountMode: "block-list", accountRules: ["account-a"] }, "account-b", "10.0.0.1"));
  assert(await allowed({ accountMode: "white-list", accountRules: ["account-a"] }, "account-a", "10.0.0.1"));
  assert(!(await allowed({ accountMode: "white-list", accountRules: ["account-a"] }, "account-b", "10.0.0.1")));
  assert(!(await allowed({ accountMode: "white-list", accountRules: [] }, "account-a", "10.0.0.1")), "empty account whitelist must deny all");
  assert(!(await allowed({ networkMode: "block-list", ipRules: ["10.*.*.*"] }, "account-a", "10.2.3.4")));
  assert(await allowed({ networkMode: "white-list", ipRules: ["10.2.0.0/16"] }, "account-a", "10.2.3.4"));
  assert(!(await allowed({ networkMode: "white-list", ipRules: ["10.2.0.0/16"] }, "account-a", "10.3.3.4")));
  assert(!(await allowed({ automaticBlocks: ["10.2.3.4"], networkMode: "white-list", ipRules: ["10.2.0.0/16"] }, "account-a", "10.2.3.4")), "automatic deny must override network whitelist");
  assert(!(await allowed({}, "account-a", "10.0.0.1", "unknown-action")), "unknown actions must default deny");
  assert(!(await (await BrokerAcl.create({ shareId: "share-1", accountMode: "open", accountRules: [], networkMode: "block-list", ipRules: [], automaticBlocks: [] })).enforce({ accountId: "account-a", sourceIp: "10.0.0.1", shareId: "other-share", action: "discover" })), "unknown resources must default deny");
  console.log("Subscription ACL test: Casbin deny-overrides, account/network lists, automatic blocks, and default deny OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
