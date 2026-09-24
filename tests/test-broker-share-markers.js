#!/usr/bin/env node
const assert = require("assert");
const { brokerShareMarkers } = require("../dist/broker-share-markers");

const items = [
  { name: "Direct", category: "Team/Current" },
  { name: "By Folder", category: "Team/Future" },
  { name: "Private Elsewhere", category: "Personal" },
];
const base = {
  visibility: "unlisted", revision: 1, revisionDate: "20260921", dailyRevision: 1, revisionLabel: "20260921.r1",
  selected: {}, folders: {}, accessMode: "block-list", ipRules: [], accountMode: "open", accountRules: [],
  protection: "open", controlPort: 19001, dataPort: 19002, contentHash: "", summary: {}, snapshotPath: "",
};
const active = { ...base, shareId: "active", name: "Active Broker", published: true, contentTypes: ["skills"], selected: { skills: ["Direct"] }, folders: { skills: ["Team/Future"] } };
const paused = { ...base, shareId: "paused", name: "Paused Broker", published: false, contentTypes: ["skills"], selected: { skills: ["Direct"] }, folders: {} };

const markers = brokerShareMarkers("skills", items, [active, paused]);
assert.deepStrictEqual(markers.items.Direct.brokers.map(item => [item.name, item.published]), [["Active Broker", true], ["Paused Broker", false]], "multi-Broker state must retain paused exposure warnings");
assert.deepStrictEqual(markers.items["By Folder"].brokers.map(item => item.name), ["Active Broker"], "folder selection must mark included content");
assert.deepStrictEqual(markers.folders.Team.brokers.map(item => item.name), ["Active Broker", "Paused Broker"], "parent folders must aggregate all shared descendants");
assert.deepStrictEqual(markers.folders["Team/Future"].brokers.map(item => item.name), ["Active Broker"], "selected folder must be marked directly");
assert.strictEqual(markers.items["Private Elsewhere"], undefined, "unselected content must stay unmarked");
assert.deepStrictEqual(brokerShareMarkers("skills", items, []).items, {}, "removing content from all Brokers must clear item markers");

const recipes = [{ recipeId: "recipe_release", name: "Release", category: "Operations/Release" }];
const recipeShare = { shareId: "share-recipes", name: "Recipe Broker", published: true,
  contentTypes: ["recipes"], selected: { recipes: ["recipe_release"] }, folders: {} };
const recipeMarkers = brokerShareMarkers("recipes", recipes, [recipeShare]);
assert.strictEqual(recipeMarkers.items.recipe_release.brokers[0].name, "Recipe Broker");
assert.strictEqual(recipeMarkers.folders["Operations/Release"].brokers[0].id, "share-recipes");

const notes = [
  { slug: "Project/Shared/Published Note", category: "Project/Shared" },
  { slug: "Project/Personal Knowledge Manager/Private Plan", category: "Project/Personal Knowledge Manager" },
];
const partialFolderShare = {
  ...base,
  shareId: "partial-folder",
  name: "Partial Folder Broker",
  published: true,
  contentTypes: ["notes"],
  selected: {},
  folders: { notes: ["Project/Shared"] },
};
const partialMarkers = brokerShareMarkers("notes", notes, [partialFolderShare]);
assert(partialMarkers.folders.Project, "an ancestor containing shared content must carry a caution marker");
assert(partialMarkers.folders["Project/Shared"], "the explicitly shared folder must be marked");
assert.strictEqual(partialMarkers.folders["Project/Personal Knowledge Manager"], undefined, "an unshared sibling folder must never inherit a marker");
assert.strictEqual(partialMarkers.items["Project/Personal Knowledge Manager/Private Plan"], undefined, "content in an unshared sibling folder must remain unmarked");

console.log("broker share marker test: multi-Broker, paused exposure, path-scoped folder inheritance, and clearing OK");