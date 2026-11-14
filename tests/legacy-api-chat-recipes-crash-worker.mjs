import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { open } from "./legacy-api-chat-recipes-fixtures.mjs";

const prepared = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const env = await open(prepared, { onHeld: value => process.send({ type: "actual-effect-held", ...value }) });
const state = await env.authority.state(env.binding);
const created = await env.authority.create(env.binding, {
  namespace: env.binding.namespace, chatId: env.binding.chatId, operationId: randomUUID(),
  expectedDigest: state.digest, recipeId: prepared.evidence.recipeId, inputs: { mode: "crash" },
});
process.send({ type: "created", runId: created.runId });
