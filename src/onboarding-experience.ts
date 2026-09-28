import { compareVersionOrder } from "./version-order";

export interface FeatureTourStep {
  target: string;
  fallback?: string;
  titleKey: string;
  bodyKey: string;
  actionKey?: string;
  activate?: boolean;
  workspace?: string;
  tab?: string;
}

export interface FeatureTourModule {
  id: string;
  introducedIn: string;
  highlightIcon: string;
  highlightTitleKey: string;
  highlightBodyKey: string;
  steps: FeatureTourStep[];
}

export const FEATURE_TOUR_MODULES: readonly FeatureTourModule[] = Object.freeze([
  {
    id: "core-navigation",
    introducedIn: "3.2",
    highlightIcon: "library",
    highlightTitleKey: "experience.whatsNewKnowledgeTitle",
    highlightBodyKey: "experience.whatsNewKnowledgeBody",
    steps: [
      { target: "#topbar strong", titleKey: "experience.tourWelcomeTitle", bodyKey: "experience.tourWelcomeBody" },
      { target: "#workspace-rail", titleKey: "experience.tourWorkspacesTitle", bodyKey: "experience.tourWorkspacesBody" },
      {
        target: '.workspace-button[data-workspace="knowledge"]',
        titleKey: "experience.tourKnowledgeTitle",
        bodyKey: "experience.tourKnowledgeBody",
        actionKey: "experience.openKnowledge",
        activate: true,
      },
      {
        target: "#btn-add-knowledge",
        fallback: "#more-btn",
        titleKey: "experience.tourCreateTitle",
        bodyKey: "experience.tourCreateBody",
        workspace: "knowledge",
      },
    ],
  },
  {
    id: "agent-workflows",
    introducedIn: "3.2",
    highlightIcon: "play-circle",
    highlightTitleKey: "experience.whatsNewWorkflowTitle",
    highlightBodyKey: "experience.whatsNewWorkflowBody",
    steps: [
      {
        target: '.workspace-button[data-workspace="automation"]',
        titleKey: "experience.tourAutomationTitle",
        bodyKey: "experience.tourAutomationBody",
        actionKey: "experience.openAutomation",
        activate: true,
      },
      {
        target: '.workspace-button[data-workspace="projects"]',
        titleKey: "experience.tourProjectsTitle",
        bodyKey: "experience.tourProjectsBody",
        actionKey: "experience.openProjects",
        activate: true,
      },
    ],
  },
  {
    id: "runtime-and-sharing",
    introducedIn: "3.2",
    highlightIcon: "shield",
    highlightTitleKey: "experience.whatsNewSafetyTitle",
    highlightBodyKey: "experience.whatsNewSafetyBody",
    steps: [
      {
        target: '.workspace-button[data-workspace="settings"]',
        titleKey: "experience.tourSettingsTitle",
        bodyKey: "experience.tourSettingsBody",
        actionKey: "experience.openSettings",
        activate: true,
      },
      {
        target: '.tab[data-tab="mcp"]',
        titleKey: "experience.tourMcpTitle",
        bodyKey: "experience.tourMcpBody",
        actionKey: "experience.openSetup",
        activate: true,
        workspace: "settings",
      },
      { target: "#start-tour-button", titleKey: "experience.tourDoneTitle", bodyKey: "experience.tourDoneBody", actionKey: "experience.finish" },
    ],
  },
]);

export interface InitialExperienceState {
  version: string;
  previousVersion?: string;
  onboardingPending: boolean;
  onboardingCompleted: boolean;
  seenModuleIds: readonly string[];
  modules?: readonly FeatureTourModule[];
}

export interface InitialExperience {
  kind: "tour";
  audience: "new" | "update";
  version: string;
  release: string;
  moduleIds: string[];
}

export function minorRelease(version: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(String(version || "").trim());
  return match ? `${Number(match[1])}.${Number(match[2])}` : undefined;
}

function releaseOrder(left: string, right: string): number | undefined {
  return compareVersionOrder(`${left}.0`, `${right}.0`);
}

export function decideInitialExperience(state: InitialExperienceState): InitialExperience | undefined {
  const version = String(state.version || "").trim();
  const release = minorRelease(version);
  if (!release) return undefined;
  const modules = state.modules || FEATURE_TOUR_MODULES;
  const seen = new Set(state.seenModuleIds || []);
  const available = modules.filter(module => {
    const order = releaseOrder(module.introducedIn, release);
    return order !== undefined && order <= 0;
  });
  const newUser = state.onboardingPending && !state.onboardingCompleted;
  const previousRelease = minorRelease(state.previousVersion || "");
  const selected = available.filter(module => {
    if (newUser) return true;
    if (seen.has(module.id)) return false;
    if (!previousRelease) return module.introducedIn === release;
    const afterPrevious = releaseOrder(module.introducedIn, previousRelease);
    const atCurrent = releaseOrder(module.introducedIn, release);
    return afterPrevious === 1 && atCurrent !== undefined && atCurrent <= 0;
  });
  if (!selected.length) return undefined;
  return {
    kind: "tour",
    audience: newUser ? "new" : "update",
    version,
    release,
    moduleIds: selected.map(module => module.id),
  };
}
