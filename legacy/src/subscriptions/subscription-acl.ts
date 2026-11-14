import { Enforcer, newEnforcer, newModelFromString } from "casbin";
import { ipMatchesBlockRule, normalizeClientIp } from "./subscription-ip-policy";

export type BrokerAction = "discover" | "read-metadata" | "request-sync" | "download" | "mqtt-subscribe";
export interface BrokerAclPolicy {
  shareId: string;
  accountMode: "open" | "block-list" | "white-list";
  accountRules: string[];
  networkMode: "block-list" | "white-list";
  ipRules: string[];
  automaticBlocks: string[];
}
export interface BrokerAclRequest {
  accountId?: string;
  sourceIp: string;
  shareId: string;
  action: BrokerAction | string;
}

const MODEL = `
[request_definition]
r = sub, obj, act, ip

[policy_definition]
p = sub, obj, act, ip, eft

[policy_effect]
e = some(where (p_eft == allow)) && !some(where (p_eft == deny))

[matchers]
m = (p.sub == "*" || r.sub == p.sub) && r.obj == p.obj && (p.act == "*" || r.act == p.act) && ipRule(r.ip, p.ip)
`;

const ACTIONS: BrokerAction[] = ["discover", "read-metadata", "request-sync", "download", "mqtt-subscribe"];

export class BrokerAcl {
  private constructor(private readonly enforcer: Enforcer, readonly policy: BrokerAclPolicy) {}

  static async create(policy: BrokerAclPolicy): Promise<BrokerAcl> {
    const enforcer = await newEnforcer(newModelFromString(MODEL));
    await enforcer.addFunction("ipRule", (source: unknown, rule: unknown) => rule === "*" || ipMatchesBlockRule(String(source || ""), String(rule || "")));
    const accounts = policy.accountMode === "white-list" ? policy.accountRules : ["*"];
    const networks = policy.networkMode === "white-list" ? policy.ipRules : ["*"];
    for (const account of accounts) {
      for (const network of networks) {
        for (const action of ACTIONS) await enforcer.addPolicy(account, policy.shareId, action, network, "allow");
      }
    }
    if (policy.accountMode === "block-list") {
      for (const account of policy.accountRules) await enforcer.addPolicy(account, policy.shareId, "*", "*", "deny");
    }
    if (policy.networkMode === "block-list") {
      for (const network of policy.ipRules) await enforcer.addPolicy("*", policy.shareId, "*", network, "deny");
    }
    for (const network of policy.automaticBlocks) await enforcer.addPolicy("*", policy.shareId, "*", network, "deny");
    return new BrokerAcl(enforcer, policy);
  }

  async enforce(request: BrokerAclRequest): Promise<boolean> {
    return this.enforcer.enforce(request.accountId || "anonymous", request.shareId, request.action, normalizeClientIp(request.sourceIp));
  }
}
