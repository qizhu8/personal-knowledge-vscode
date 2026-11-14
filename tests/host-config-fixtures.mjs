import { randomUUID } from "node:crypto";
import { buildHostConfigOptions } from "../dist/host-config.js";

export function hostConfigFixture(overrides = {}) {
  const config = {
    schema: "pkm.native-host-config/v1", provider: "openai-compatible",
    endpoint: "https://synthetic.invalid/v1", secretRef: "secret:synthetic/provider",
    model: "synthetic-model", contextWindow: 16384, maxOutputTokens: 4096,
    outputTokenParameter: "max_tokens", includeUsage: true,
    tools: ["knowledge.document.create"], ...overrides,
  };
  const requests = [], reviews = [], authorizations = [], resolutions = [];
  let factoryCalls = 0;
  const policy = { allowedProviders: ["openai-compatible"], allowedEndpoints: ["https://synthetic.invalid/v1"],
    allowedModels: ["synthetic-model"], allowedTools: ["knowledge.document.create"] };
  const dependencies = {
    policy,
    async resolveSecret(ref) { resolutions.push(ref); return "synthetic-host-credential"; },
    fetchFactory() {
      factoryCalls++;
      return async (url, init) => {
        requests.push({ url, init });
        const payload = JSON.parse(init.body);
        const toolResponse = payload.messages.at(-1).role === "tool";
        const delta = toolResponse ? { content: "Synthetic answer." } : {
          tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: {
            name: "knowledge_document_create", arguments: JSON.stringify({
              id: "host-config-document", title: "Host configured", content: "Synthetic content.",
            }),
          } }],
        };
        const stream = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolResponse ? "stop" : "tool_calls" }] })}\n\n`
          + "data: [DONE]\n\n";
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      };
    },
    async reviewer(request) {
      reviews.push(request);
      return { actorId: request.actorId, decisionId: randomUUID(), decision: "approve" };
    },
    async authorizeTool(binding) { authorizations.push(binding); return true; },
  };
  return { config, dependencies, requests, reviews, authorizations, resolutions,
    get factoryCalls() { return factoryCalls; },
    build() { return buildHostConfigOptions(JSON.stringify(config), dependencies); } };
}
