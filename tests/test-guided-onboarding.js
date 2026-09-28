#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const { decideInitialExperience, FEATURE_TOUR_MODULES, minorRelease } = require(path.join(root, "dist", "onboarding-experience.js"));

assert.deepStrictEqual(
  decideInitialExperience({ version: "3.2.0", previousVersion: "3.1.11", onboardingPending: false, onboardingCompleted: true, seenModuleIds: [] }),
  { kind: "tour", audience: "update", version: "3.2.0", release: "3.2", moduleIds: FEATURE_TOUR_MODULES.map(module => module.id) },
  "a minor update must compose the feature modules introduced after the previous release",
);
assert.deepStrictEqual(
  decideInitialExperience({ version: "3.2.0", onboardingPending: true, onboardingCompleted: false, seenModuleIds: [] }),
  { kind: "tour", audience: "new", version: "3.2.0", release: "3.2", moduleIds: FEATURE_TOUR_MODULES.map(module => module.id) },
  "first configuration must compose every applicable feature module",
);
assert.strictEqual(
  decideInitialExperience({ version: "3.2.1", previousVersion: "3.2.0", onboardingPending: false, onboardingCompleted: true, seenModuleIds: [] }),
  undefined,
  "a patch update must not replay minor-release tours",
);
assert.strictEqual(
  decideInitialExperience({
    version: "3.2.0",
    previousVersion: "3.1.11",
    onboardingPending: false,
    onboardingCompleted: true,
    seenModuleIds: FEATURE_TOUR_MODULES.map(module => module.id),
  }),
  undefined,
  "completed feature modules must not be repeated",
);
const futureModules = [
  ...FEATURE_TOUR_MODULES,
  {
    id: "future-3-3",
    introducedIn: "3.3",
    highlightIcon: "sparkle",
    highlightTitleKey: "experience.whatsNewWorkflowTitle",
    highlightBodyKey: "experience.whatsNewWorkflowBody",
    steps: [],
  },
];
assert.deepStrictEqual(
  decideInitialExperience({
    version: "3.3.0",
    previousVersion: "3.2.9",
    onboardingPending: false,
    onboardingCompleted: true,
    seenModuleIds: FEATURE_TOUR_MODULES.map(module => module.id),
    modules: futureModules,
  })?.moduleIds,
  ["future-3-3"],
  "a minor update should select only modules introduced after the previous minor",
);
assert.deepStrictEqual(
  decideInitialExperience({
    version: "3.3.0",
    previousVersion: "3.1.9",
    onboardingPending: false,
    onboardingCompleted: true,
    seenModuleIds: [],
    modules: futureModules,
  })?.moduleIds,
  [...FEATURE_TOUR_MODULES.map(module => module.id), "future-3-3"],
  "skipping a minor release should compose every unseen module introduced since the previous minor",
);
assert.strictEqual(minorRelease("v3.2.19"), "3.2");
assert.strictEqual(minorRelease("invalid"), undefined);
assert.strictEqual(new Set(FEATURE_TOUR_MODULES.map(module => module.id)).size, FEATURE_TOUR_MODULES.length, "feature tour module IDs must be unique");
assert.ok(FEATURE_TOUR_MODULES.every(module => module.steps.length > 0), "every feature module must contain interactive steps");

const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
for (const marker of [
  "pkm.onboarding.pending.v2",
  "pkm.onboarding.completed.v2",
  "pkm.tours.lastSeenRelease.v1",
  "pkm.tours.seenModules.v1",
  'case "completeTourModules"',
]) assert.ok(extension.includes(marker), `extension is missing durable onboarding contract: ${marker}`);
assert.match(extension, /if \(firstConfiguration\)[\s\S]*ONBOARDING_PENDING_KEY/);

const html = fs.readFileSync(path.join(root, "src", "webview", "panel.html"), "utf8");
assert.match(html, /id="experience-layer"/);
assert.match(html, /id="coachmark" role="dialog" aria-modal="true"/);
assert.match(html, /id="whats-new-button"/);
assert.match(html, /id="start-tour-button"/);

const source = fs.readFileSync(path.join(root, "src", "webview", "panel", "05-onboarding.js"), "utf8");
for (const marker of [
  "coachmark-shade",
  "coachmark-target",
  "scrollIntoView",
  "positionCoachmark",
  "featureTourSteps",
  "completeTourModules",
  "maybeStartPendingExperience",
]) assert.ok(source.includes(marker), `guided onboarding is missing behavior: ${marker}`);
assert.doesNotMatch(source, /localStorage|sessionStorage/, "one-time state must remain extension-owned and durable");
assert.ok(FEATURE_TOUR_MODULES.reduce((count, module) => count + module.steps.length, 0) >= 9,
  "composable tour modules must point to real controls across the product");

const css = fs.readFileSync(path.join(root, "src", "webview", "panel.css"), "utf8");
assert.match(css, /\.coachmark-target/);
assert.match(css, /#coachmark\[data-placement="right"\]::before/);
assert.match(css, /prefers-reduced-motion:reduce/);

const english = JSON.parse(fs.readFileSync(path.join(root, "resources", "locales", "en.json"), "utf8")).strings;
const chinese = JSON.parse(fs.readFileSync(path.join(root, "resources", "locales", "zh-hans.json"), "utf8")).strings;
for (const key of ["experience.whatsNewTitle", "experience.tourWelcomeTitle", "experience.tourMcpBody", "experience.takeTour"]) {
  assert.ok(english[key], `English onboarding copy is missing: ${key}`);
  assert.ok(chinese[key] && chinese[key] !== english[key], `Chinese onboarding copy is missing: ${key}`);
}

console.log("guided onboarding tests passed");
