import { deriveSystemId } from "./project-recipes-project-rules.js";

export interface ProjectSystemEntity {
  projectId: string;
  systemKind?: string;
}

export interface ThreadSystemEntity {
  threadId: string;
  projectId: string;
  systemKind?: string;
}

export interface ProjectSystemEntityGroup {
  project: ProjectSystemEntity;
  threads: ThreadSystemEntity[];
}

export function projectSystemEntityIssue(groups: ProjectSystemEntityGroup[], rootId?: string): string | undefined {
  if (!groups.length) return undefined;

  const projects = groups.map(group => group.project);
  const defaults = projects.filter(project => project.systemKind === "default-project");
  if (defaults.length !== 1) return "Canonical Project storage requires exactly one system Default Project.";

  const defaultProject = defaults[0]!;
  if (rootId !== undefined
    && defaultProject.projectId !== deriveSystemId(rootId, "pkm/default-project/v1")) {
    return "Default Project identity does not match the original root identity.";
  }

  for (const { project, threads } of groups) {
    const marked = threads.filter(thread => thread.systemKind === "general-thread");
    const expectedThreadId = deriveSystemId(project.projectId, "pkm/general-thread/v1");
    const derived = threads.filter(thread => thread.threadId === expectedThreadId);
    if (derived.length > 1) return `Project has duplicate derived General Threads: ${project.projectId}`;
    if (marked.length > 1) return `Project has duplicate system General Threads: ${project.projectId}`;
    if (marked.some(thread => thread.projectId !== project.projectId
      || thread.threadId !== expectedThreadId)
      || (marked.length === 1 && derived[0] !== marked[0])) {
      return `General Thread identity does not match its owning Project: ${project.projectId}`;
    }
    if (project.projectId === defaultProject.projectId && marked.length !== 1) {
      return "Canonical Default Project requires its derived system General Thread.";
    }
  }

  return undefined;
}
