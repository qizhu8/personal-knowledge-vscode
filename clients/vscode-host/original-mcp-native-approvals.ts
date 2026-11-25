import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OriginalMcpNativeRequestFrame, OriginalMcpNativeRequestMethod } from "../../src/original-mcp-native-request.js";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";
import { originalMcpNativeCredentialAvailable } from "./original-mcp-native-credentials.js";
import { originalPublicMcpContracts } from "../../src/native-public-original-mcp-contracts.js";
import {
  privateResourcePublicationMethod, privateResourcePublicationDigest,
  parsePrivateResourcePublicationPayload,
} from "../../src/private-resource-publication-contracts.js";
import {
  originalNativeTrashMethod, parseOriginalNativeTrashPayload,
} from "../../src/original-native-trash-contracts.js";
import {
  originalMcpTodoGenesisMethod, parseOriginalMcpTodoGenesisPayload,
} from "../../src/original-mcp-todo-genesis-contracts.js";
import { originalPortalNativeMethod } from "../../src/original-mcp-portal-contracts.js";
import { createOriginalMcpNativePortalConsent } from "./original-mcp-native-portal.js";

export async function originalMcpNativeApprovals(context: vscode.ExtensionContext,
  claimInference?: (model: string, digest: string) => boolean) {
  const signer = await originalMcpNativeSigner(context);
  const portalConsent = createOriginalMcpNativePortalConsent({
    assertCurrent: () => signer.assertCurrent(), activationId: signer.activationId, context,
  });
  const contracts = z.object({ contracts: z.array(z.object({
    id: z.string(), version: z.number(), transportName: z.string(), readOnly: z.boolean(),
  })) }).parse(originalPublicMcpContracts()).contracts;
  const admissions = new Set<string>();
  const methods: readonly OriginalMcpNativeRequestMethod[] = Object.freeze([
    "admission.approve", "public.approve", "tool.approve", "tool.review", "credential.present",
    privateResourcePublicationMethod,
    originalNativeTrashMethod,
    originalMcpTodoGenesisMethod,
    originalPortalNativeMethod,
    ...(claimInference ? ["model.approve" as const] : []),
  ]);
  const key = (request: OriginalMcpNativeRequestFrame) => privateResourcePublicationDigest(request.payload.binding);
  function current(request: OriginalMcpNativeRequestFrame, signal: AbortSignal) {
    signer.assertCurrent();
    if (signal.aborted) throw new Error("NATIVE_REQUEST_CANCELLED");
    if (request.session.activationId !== signer.activationId || request.session.epoch !== signer.activationId
      || request.session.identitySha256 !== signer.identity.sha256
      || request.payload.binding.profileSha256 !== signer.identity.profileSha256)
      throw new Error("NATIVE_REQUEST_BINDING_MISMATCH");
  }
  async function approve(request: OriginalMcpNativeRequestFrame, signal: AbortSignal,
    title: string, detail: object) {
    current(request, signal);
    const answer = await vscode.window.showWarningMessage(title, {
      modal: true, detail: JSON.stringify(detail, null, 2),
    }, "Approve this request", "Deny");
    current(request, signal);
    return answer === "Approve this request";
  }
  return Object.freeze({
    methods,
    dispose() { portalConsent.dispose(); },
    async handle(request: OriginalMcpNativeRequestFrame, signal: AbortSignal): Promise<unknown> {
      current(request, signal);
      if (request.method === "admission.approve") {
        const approved = await approve(request, signal,
          "Allow this PKM v5 native session to read public content from the selected library?",
          { ...request.payload.binding,
            permission: "Public reads only. Writes, tools and native model requests require separate approval." });
        if (approved) {
          if (admissions.size >= 16 && !admissions.has(key(request)))
            throw new Error("NATIVE_REQUEST_BUSY");
          admissions.add(key(request));
        } else admissions.delete(key(request));
        return { decision: approved ? "approve" : "deny" };
      }
      if (!admissions.has(key(request))) throw new Error("NATIVE_DENIED");
      if (request.method === originalPortalNativeMethod) return portalConsent.handle(request, signal);
      if (request.method === originalMcpTodoGenesisMethod) {
        const payload = parseOriginalMcpTodoGenesisPayload(request.payload, request.session);
        const choices = {
          create: ["Create this exact Board once", "Create this exact public Todo Board and paired Note?"],
          recover: ["Recover this exact Board once", "Recover this exact public Todo Board creation?"],
          "activate-source": ["Activate this exact Board source", "Activate this exact public Todo Board source for this session?"],
        } as const;
        const [affirmative, title] = choices[payload.request.phase];
        const answer = await vscode.window.showWarningMessage(title, {
          modal: true, detail: JSON.stringify({
            ...payload.request, requestSha256: payload.requestSha256, defaultDecision: "deny",
            permission: "One exact empty public Board and its paired Note in the existing selected category. No folder creation, overwrite, conversion, worker enrollment, reviewer delegation, model or execution is authorized. Historical receipts do not grant current source access.",
          }, null, 2),
        }, "Deny", affirmative);
        current(request, signal);
        if (answer !== affirmative) return null;
        return {
          decision: "approve", actorId: "mcp:external", decisionId: randomUUID(),
          requestSha256: payload.requestSha256, operationId: payload.request.operationId,
          epoch: signer.activationId, expiresAtMs: Date.now() + 120000,
        };
      }
      if (request.method === originalNativeTrashMethod) {
        const payload = parseOriginalNativeTrashPayload(request.payload, request.session);
        const action = payload.request.subject.action;
        const choices = {
          list: ["Read these exact Trash entries once", "Read these exact public Note Trash entries?"],
          move: ["Move this exact Note to Trash once", "Move this exact public Note and paired assets to Trash?"],
          restore: ["Restore this exact Note once", "Restore this exact public Note and paired assets?"],
        } as const;
        const area = "area" in payload.request.subject ? payload.request.subject.area : "notes";
        const label = area === "skills" ? "Skill" : area === "scripts" ? "Script" : area === "prompts" ? "Prompt" : "Paper";
        const recovering = payload.request.phase === "recover";
        const [affirmative, title] = area === "notes" ? choices[action]
          : recovering
            ? [`Recover this exact ${label} ${action} once`,
              `Recover this exact public ${label} and paired assets ${action}?`]
            : action === "list"
              ? [`Read these exact ${label} Trash entries once`, `Read these exact public ${label} Trash entries?`]
              : action === "move"
                ? [`Move this exact ${label} to Trash once`, `Move this exact public ${label} and paired assets to Trash?`]
                : [`Restore this exact ${label} once`, `Restore this exact public ${label} and paired assets?`];
        const answer = await vscode.window.showWarningMessage(title, {
          modal: true, detail: JSON.stringify({
            ...payload.request, requestSha256: payload.requestSha256, defaultDecision: "deny",
            permission: area === "notes"
              ? "One exact public Note/paired-resource operation. Private folders, other Trash entries, permanent deletion and future access are not authorized. Recovery requires a fresh native decision; historical receipts are not permission."
              : `One exact public ${label}/paired-resource ${recovering ? "recovery" : "operation"}. Private folders, private owners and shared pairs, other Trash entries, permanent deletion, publication, execution and future access are not authorized. Recovery requires a fresh native decision; historical receipts are not permission.`,
          }, null, 2),
        }, "Deny", affirmative);
        current(request, signal);
        if (answer !== affirmative) return null;
        return {
          decision: "approve", actorId: "mcp:external", decisionId: randomUUID(),
          requestSha256: payload.requestSha256, operationId: payload.request.subject.operationId,
          epoch: signer.activationId, expiresAtMs: Date.now() + 120000,
        };
      }
      if (request.method === privateResourcePublicationMethod) {
        const payload = parsePrivateResourcePublicationPayload(request.payload, request.session);
        const answer = await vscode.window.showWarningMessage(
          "Publish this exact private resource into public document assets?",
          { modal: true, detail: JSON.stringify({
            ...payload.request, requestSha256: payload.requestSha256, defaultDecision: "deny",
            permission: "One private resource, one current operation. This publishes the exact bytes to the public paired target. The private source and folder remain unchanged. Model/Group/public-document approval grants no private publication or future access.",
          }, null, 2) }, "Deny", "Publish this exact resource once");
        current(request, signal);
        if (answer !== "Publish this exact resource once") return null;
        return {
          decision: "approve", actorId: "mcp:external", decisionId: randomUUID(),
          requestSha256: payload.requestSha256, operationId: payload.request.subject.operationId,
          epoch: signer.activationId, expiresAtMs: Date.now() + 120000,
        };
      }
      if (request.method === "model.approve") {
        const { provider, model, requestSha256 } = request.payload;
        if (provider !== "vscode" || !claimInference?.(model, requestSha256)) throw new Error("NATIVE_DENIED");
        const approved = await approve(request, signal, `Send this inference to native VS Code model ${model}?`,
          { root: request.payload.binding.root, model, requestSha256,
            disclosure: "The digest identifies the exact native inference; it is not the transcript." });
        return { decision: approved ? "approve" : "deny" };
      }
      if (request.method === "public.approve") {
        const operation = request.payload.request;
        const canonical = contracts.find(item => item.id === operation.operation);
        if (!canonical || canonical.transportName !== operation.tool || canonical.version !== operation.version
          || canonical.readOnly !== operation.readOnly)
          throw new Error("NATIVE_REQUEST_CLASSIFICATION_MISMATCH");
        const recipeInspection = operation.tool === "recipe_run_get";
        if (canonical.readOnly && !recipeInspection) return { decision: "approve" };
        const approved = await approve(request, signal, `Allow PKM v5 ${operation.tool} for this exact request?`,
          { root: request.payload.binding.root, workspaceId: request.payload.binding.workspaceId, ...operation,
            ...(recipeInspection ? {
              permission: "The original contract labels this getter read-only, but native Recipe inspection can synchronize durable execution state. Approve only this exact request; no model, process or external work is authorized.",
            } : {}),
          });
        return { decision: approved ? "approve" : "deny" };
      }
      if (request.method === "tool.approve") {
        const approved = await approve(request, signal, `Allow native PKM tool ${request.payload.request.operation}?`,
          { root: request.payload.binding.root, ...request.payload.request });
        return { decision: approved ? "approve" : "deny" };
      }
      if (request.method === "tool.review") {
        const review = request.payload.review;
        if (!["pending", "awaiting_approval"].includes(review.record.status))
          return { decision: "reject", decisionId: randomUUID(), actorId: "mcp:external" };
        const approved = await approve(request, signal, `Review native PKM execution ${review.record.tool}`,
          { root: request.payload.binding.root, ...review });
        return { decision: approved ? "approve" : "reject", decisionId: randomUUID(), actorId: "mcp:external" };
      }
      if (request.method === "credential.present") {
        const present = await originalMcpNativeCredentialAvailable(context, {
          profileSha256: request.payload.binding.profileSha256, secretId: request.payload.secretId,
        });
        current(request, signal);
        return { present };
      }
      throw new Error("MISSING_NATIVE_METHOD");
    },
  });
}
