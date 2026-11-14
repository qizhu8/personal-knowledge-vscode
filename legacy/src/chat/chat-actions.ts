import { ApiChatTool } from "./api-chat-client";
import { abortable } from "./api-chat-tools";
import { QuestionSchema, questionSchema, validateQuestionAnswer } from "./chat-questions";

type ActionResult = Record<string, unknown>;
export type ChatActionRequest = (method: string, params: Record<string, unknown>) => Promise<ActionResult>;

export function createChatActionTools(options: {
  enabled: readonly string[];
  request: ChatActionRequest;
  ask: (prompt: string, schema: QuestionSchema, signal: AbortSignal,
    verify?: (answer: Record<string, unknown>) => Promise<void>) => Promise<Record<string, unknown> | undefined>;
  approve: (detail: string, signal: AbortSignal) => Promise<boolean>;
  progress: (message: string, waiting: boolean) => void;
  assertActive: () => void;
  keyPrefix: string;
}): ApiChatTool[] {
  const request = async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
    options.assertActive();
    if (signal.aborted) throw new Error("Request cancelled.");
    return abortable(options.request(method, params), signal);
  };
  const tools: ApiChatTool[] = [{
    name: "find_actions",
    description: "Find local Action contracts, readiness and preinstalled templates. Does not install, qualify remote operations or transfer data. Pin content_hash from the result when running.",
    parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, required: ["query"], additionalProperties: false },
    execute: async (args, signal) => {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) throw new Error("Provide a bounded Action query.");
      const [result, templates] = await Promise.all([
        request("retrieve", { task: args.query, limit: 6 }, signal), request("templates", {}, signal),
      ]);
      return JSON.stringify({ ...result, templates: templates.templates });
    },
  }, {
    name: "run_action",
    description: "Run a pinned approved Action or attach to its original run_id. Durable waits and read-only polling run without model polling; user checkpoints appear inside Chat. Returns the original Run's final result. For Chatroom joins run core.chatroom-alias first; use the user answer, never invent an alias. Cancellation does not roll back remote effects.",
    parameters: { type: "object", properties: {
      action_id: { type: "string" }, inputs: { type: "object" }, content_hash: { type: "string" },
      idempotency_key: { type: "string", minLength: 1, maxLength: 100 }, run_id: { type: "string", pattern: "^action_run_[0-9a-f]{32}$" },
    }, additionalProperties: false },
    execute: async (args, signal) => {
      let run: ActionResult;
      if (args.run_id !== undefined) {
        if (typeof args.run_id !== "string" || !/^action_run_[0-9a-f]{32}$/.test(args.run_id) || Object.keys(args).length !== 1) throw new Error("Attach using only the original run_id.");
        if (!await options.approve(`Attach to existing Action Run ${args.run_id}. Checkpoints and results will return to this Chat; no replacement invocation is submitted.`, signal)) throw new Error("Action attachment declined.");
        run = await request("run", { run_id: args.run_id }, signal);
      } else {
        if (typeof args.action_id !== "string" || typeof args.content_hash !== "string"
          || typeof args.idempotency_key !== "string" || !args.idempotency_key || args.idempotency_key.length > 100
          || !args.inputs || typeof args.inputs !== "object" || Array.isArray(args.inputs) || JSON.stringify(args.inputs).length > 32000) throw new Error("Provide an Action ID, pinned content_hash, object inputs and invocation key.");
        const definition = await request("definition_get", { action_id: args.action_id }, signal);
        if (definition.content_hash !== args.content_hash) throw new Error("Action revision changed; discover its current contract first.");
        if (!await options.approve(`Run ${args.action_id}\nRevision: ${args.content_hash}\nEffects: ${JSON.stringify(definition.effects || definition.effect)}\nInputs: ${JSON.stringify(args.inputs)}`, signal)) throw new Error("Action execution declined.");
        options.assertActive();
        if (signal.aborted) throw new Error("Request cancelled before Action submission.");
        const key = options.keyPrefix + ":" + args.idempotency_key;
        try {
          run = await options.request("platform_call", { action_id: args.action_id, inputs: args.inputs,
            content_hash: args.content_hash, idempotency_key: key });
        } catch (error) {
          throw new Error(`Action submission for ${key} failed or has an unknown outcome: ${error instanceof Error ? error.message : String(error)}. Inspect that original launch key; do not submit a replacement.`);
        }
      }
      const runId = run.run_id;
      if (typeof runId !== "string" || !/^action_run_[0-9a-f]{32}$/.test(runId)) throw new Error("Action service returned no durable Run identity.");
      try {
        if (signal.aborted) throw new Error("Request cancelled after durable submission.");
        while (run.state === "running" || run.state === "waiting") {
          options.progress(`Action ${runId} · ${run.state}`, true);
          if (run.state === "waiting") {
            const result = await request("checkpoints", { run_id: runId }, signal);
            const checkpoints = result.checkpoints;
            if (!Array.isArray(checkpoints)) throw new Error("Invalid Action checkpoint response.");
            for (const checkpoint of checkpoints) {
              if (checkpoint.state !== "waiting" || checkpoint.owner === "scheduler") continue;
              const proposal = checkpoint.proposal;
              const schema = questionSchema(checkpoint.answer_schema);
              const answer = await options.ask(typeof proposal?.prompt === "string" ? proposal.prompt
                : `Review ${checkpoint.kind}: ${JSON.stringify(proposal).slice(0, 4000)}`, schema, signal, async answer => {
                  await request("check_checkpoint_answer", { run_id: checkpoint.run_id,
                    checkpoint_id: checkpoint.checkpoint_id, answer }, signal);
                });
              options.assertActive();
              if (!answer) {
                await request("cancel_run", { run_id: runId }, signal);
                return JSON.stringify({ run_id: runId, state: "cancel_requested", remote_rollback: false });
              }
              validateQuestionAnswer(schema, answer);
              await request("respond_checkpoint", { run_id: checkpoint.run_id, checkpoint_id: checkpoint.checkpoint_id,
                resume_token: checkpoint.resume_token, proposal_digest: checkpoint.proposal_digest, answer,
                event_key: "chat-answer:" + checkpoint.checkpoint_id }, signal);
            }
          }
          await abortable(new Promise<void>(resolve => setTimeout(resolve, 250)), signal);
          await request("safety_scan", {}, signal);
          run = await request("run", { run_id: runId }, signal);
        }
        options.progress(`Action ${runId} · ${String(run.state)}`, false);
        return JSON.stringify({ run_id: runId, state: run.state, ok: run.execution_ok ?? run.ok,
          output: run.output, error: run.error, diagnostics: run.diagnostics,
          userState: run.userState, nextOwner: run.nextOwner, remote_rollback: false });
      } catch (error) {
        if (signal.aborted) await options.request("cancel_run", { run_id: runId });
        throw new Error(`Action ${runId}: ${error instanceof Error ? error.message : String(error)}. Inspect this original Run; do not submit a replacement.`);
      } finally { options.progress(`Action ${runId}`, false); }
    },
  }];
  return tools.filter(tool => options.enabled.includes(tool.name));
}
