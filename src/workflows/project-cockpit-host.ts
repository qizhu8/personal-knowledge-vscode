import * as fs from "fs";
import * as path from "path";
import { projectCockpit, ProjectOverviewInput } from "./project-cockpit";
import { ProjectModelError, ProjectSourceLink } from "./project-model";
import { ProjectStore, ProjectStoreCommand } from "./project-store";

export interface ProjectCockpitHost {
  store: ProjectStore;
  root: string;
  command(operation: string, input: object): ProjectStoreCommand;
  snapshot(): Promise<any>;
  respond(message: object): void;
  action(method: string, params: Record<string, unknown>): Promise<any>;
  openSource(id: string): void;
}

/** The extension and browser acceptance use the same host boundary and real ProjectStore. */
export async function handleProjectCockpitRequest(host: ProjectCockpitHost, msg: Record<string, any>): Promise<boolean> {
  if (!["projectCreate", "projectOverview", "projectLink", "projectLifecycle", "projectOpenSource", "projectCheckpoint"].includes(msg.command)) return false;
  const { store } = host;
  const projectId = String(msg.projectId || "");
  const command = (operation: string, input: object) => ({
    ...host.command(operation, input),
    ...(Number.isInteger(msg.expectedStoreVersion) ? { expectedStoreVersion: msg.expectedStoreVersion } : {}),
  });
  let result;
  if (msg.command === "projectCreate") {
    const input = { name: String(msg.name || ""), overview: (msg.overview || {}) as ProjectOverviewInput, template: String(msg.template || "") };
    result = store.createProject(command("project-create", input), input.name, input.overview, input.template);
  } else if (msg.command === "projectOverview") {
    const input = { projectId, overview: (msg.overview || {}) as ProjectOverviewInput, reason: String(msg.reason || "") };
    result = store.updateProject(command("project-overview", input), projectId, input.overview, input.reason);
  } else if (msg.command === "projectLink") {
    const input = { projectId, kind: String(msg.kind || "") as ProjectSourceLink["kind"], id: String(msg.id || "") };
    result = store.linkProject(command("project-source-link", input), projectId, input.kind, input.id);
  } else if (msg.command === "projectLifecycle") {
    const action = String(msg.action || "");
    if (!["archive", "restore", "delete"].includes(action)) throw new Error("Invalid Project lifecycle operation.");
    const input = { projectId, action, confirmed: msg.confirmed === true };
    result = store.lifecycleProject(command(`project-${action}`, input), projectId, action as "archive" | "restore" | "delete", input.confirmed);
  } else {
    const project = store.list().projects.find(value => value.projectId === projectId);
    const runId = String(msg.id || "");
    if (!project || !projectCockpit(host.root, project).items.some(item => item.sourceId === runId)) throw new Error("Project source is not linked.");
    if (msg.command === "projectOpenSource") { host.openSource(runId); return true; }
    if (!/^action_run_[0-9a-f]{32}$/.test(runId) || project.archivedAt || project.deletedAt) throw new Error("Restore the Project and inspect an Action checkpoint first.");
    const envelope = await host.action("checkpoints", { run_id: runId });
    const checkpoint = envelope.checkpoints?.find((value: any) => value.run_id === runId && value.checkpoint_id === msg.checkpointId);
    if (!checkpoint || checkpoint.state !== "waiting" || checkpoint.proposal_digest !== msg.proposalDigest
      || checkpoint.trigger?.kind && checkpoint.trigger.kind !== "human") {
      throw new ProjectModelError("checkpoint-stale", "Checkpoint changed or is no longer waiting. Refresh and inspect the current proposal.");
    }
    if (msg.action === "answer") {
      if (typeof msg.answer !== "string" || msg.answer.length > 65536 || typeof msg.eventKey !== "string"
        || !/^[A-Za-z0-9_-]{1,200}$/.test(msg.eventKey)) throw new Error("Enter bounded answer JSON and a stable response identity.");
      let answer: unknown;
      try { answer = JSON.parse(msg.answer); } catch { throw new Error("Answer must be valid JSON."); }
      await host.action("respond_checkpoint", { run_id: runId, checkpoint_id: checkpoint.checkpoint_id, resume_token: checkpoint.resume_token,
        proposal_digest: checkpoint.proposal_digest, answer, event_key: msg.eventKey });
    } else if (msg.action === "cancel" && msg.confirmed === true) {
      await host.action("cancel_run", { run_id: runId });
    } else throw new Error("Confirm cancellation or submit an explicit answer.");
    host.respond({ command: "projectCheckpointResult", data: { action: msg.action, checkpointId: checkpoint.checkpoint_id } });
  }
  if (result) host.respond({ command: "projectResult", data: { action: msg.command, ...result } });
  host.respond({ command: "projectState", data: await host.snapshot() });
  return true;
}

export async function promoteChatProject(store: ProjectStore, source: { chatId: string; sessionId?: string; title?: string },
  name: () => Promise<string | undefined>, command: ProjectCockpitHost["command"]): Promise<string | undefined> {
  const existing = () => store.list().projects.find(project => project.links?.some(link => link.kind === "chat" && link.id === source.chatId));
  const linked = existing();
  if (linked) return linked.projectId;
  const selected = await name();
  if (!selected?.trim()) return undefined;
  const raced = existing();
  if (raced) return raced.projectId;
  const sources: { kind: ProjectSourceLink["kind"]; id: string }[] = [{ kind: "chat", id: source.chatId }];
  if (source.sessionId) sources.push({ kind: "agent-session", id: source.sessionId });
  return store.createProject(command("project-chat-promote", { name: selected, sources }), selected, {}, "", sources).entityId;
}

export async function actionRunProject(store: ProjectStore, root: string, runId: string,
  select: (options: { label: string; projectId: string }[]) => Promise<{ projectId: string } | undefined>,
  command: ProjectCockpitHost["command"]): Promise<string | undefined> {
  if (!/^action_run_[0-9a-f]{32}$/.test(runId)) throw new Error("Invalid Action Run.");
  const snapshot = store.list();
  const existing = snapshot.projects.find(value => !value.deletedAt && value.links?.some(link => link.kind === "action-run" && link.id === runId));
  if (existing) return existing.projectId;
  const file = path.join(root, ".pkm", "state", "actions", "runs", runId, "run.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid Action Run record.");
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  if (run.run_id !== runId) throw new Error("Action Run was not found.");
  const selected = await select([...snapshot.projects.filter(value => !value.archivedAt && !value.deletedAt).map(value => ({ label: value.name, projectId: value.projectId })),
    { label: "Create a Project for this Run", projectId: "" }]);
  if (!selected) return undefined;
  if (!selected.projectId) {
    const name = String(run.action_id || "Action Run");
    return store.createProject(command("project-create", { name, runId }), name, {}, "", { kind: "action-run", id: runId }).entityId;
  }
  return store.linkProject(command("project-source-link", { projectId: selected.projectId, runId }), selected.projectId, "action-run", runId).entityId;
}
