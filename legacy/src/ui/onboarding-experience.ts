import { compareVersionOrder } from "../runtime/version-order";

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
    id: "pkm-chat",
    introducedIn: "3.2",
    highlightIcon: "comment-discussion",
    highlightTitleKey: "experience.featureChatTitle",
    highlightBodyKey: "experience.featureChatBody",
    steps: [
      { target: "#topbar strong", titleKey: "experience.tourWelcomeTitle", bodyKey: "experience.tourWelcomeBody" },
      { target: "#open-pkm-chat-button", titleKey: "experience.featureChatTitle", bodyKey: "experience.featureChatBody" },
    ],
  },
  {
    id: "retrieval-system",
    introducedIn: "3.2",
    highlightIcon: "search",
    highlightTitleKey: "experience.featureRetrievalTitle",
    highlightBodyKey: "experience.featureRetrievalBody",
    steps: [
      {
        target: "#searchbox", fallback: '.workspace-button[data-workspace="knowledge"]',
        titleKey: "experience.featureRetrievalTitle", bodyKey: "experience.featureRetrievalBody",
        workspace: "knowledge", tab: "skills",
      },
    ],
  },
  {
    id: "router",
    introducedIn: "3.2",
    highlightIcon: "git-compare",
    highlightTitleKey: "experience.featureRouterTitle",
    highlightBodyKey: "experience.featureRouterBody",
    steps: [
      {
        target: '.tab[data-tab="skillRouter"]', workspace: "settings", tab: "skillRouter",
        titleKey: "experience.featureRouterTitle", bodyKey: "experience.featureRouterBody",
      },
    ],
  },
  {
    id: "github-sync", introducedIn: "3.2", highlightIcon: "sync",
    highlightTitleKey: "experience.featureSyncTitle", highlightBodyKey: "experience.featureSyncBody",
    steps: [
      { target: '.tab[data-tab="githubSync"]', workspace: "settings", tab: "githubSync",
        titleKey: "experience.featureSyncTitle", bodyKey: "experience.featureSyncBody" },
    ],
  },
  {
    id: "portal", introducedIn: "3.2", highlightIcon: "remote",
    highlightTitleKey: "experience.featurePortalTitle", highlightBodyKey: "experience.featurePortalBody",
    steps: [
      { target: '.tab[data-tab="portalConnections"]', workspace: "projects", tab: "portalConnections",
        titleKey: "experience.featurePortalTitle", bodyKey: "experience.featurePortalBody" },
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
    if (Number(release.split(".")[0]) > Number(previousRelease.split(".")[0])) return true;
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
