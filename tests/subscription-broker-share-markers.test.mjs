import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerShareMarkers } from "../dist/domain/subscription-broker-share-markers.js";
const legacy = await import("../legacy/dist/subscriptions/broker-share-markers.js").then(m => m.brokerShareMarkers, () => null);

const share = (extra) => ({ shareId: "s", name: "S", published: true, contentTypes: ["skills"], selected: {}, folders: {}, ...extra });

test("markers retain paused brokers, folder inheritance, and clearing", () => {
  const items = [{ name: "Direct", category: "Team/Current" }, { name: "ByFolder", category: "Team/Future" }, { name: "Other", category: "Personal" }];
  const active = share({ shareId: "active", name: "Active", selected: { skills: ["Direct"] }, folders: { skills: ["Team/Future"] } });
  const paused = share({ shareId: "paused", name: "Paused", published: false, selected: { skills: ["Direct"] } });
  const m = brokerShareMarkers("skills", items, [paused, active]);
  assert.deepEqual(m.items.Direct.brokers.map(b => [b.name, b.published]), [["Active", true], ["Paused", false]]);
  assert.deepEqual(m.folders.Team.brokers.map(b => b.name), ["Active", "Paused"]);
  assert.equal(m.items.Other, undefined);
  assert.equal(m.folders["Team/Future"].brokers[0].id, "active");
  assert.deepEqual(brokerShareMarkers("skills", items, []), { items: {}, folders: {} });
});

test("sibling folders do not inherit; recipes and scripts identities", () => {
  const notes = [{ slug: "P/Shared/A", category: "P/Shared" }, { slug: "P/Private/B", category: "P/Private" }];
  const m = brokerShareMarkers("notes", notes, [share({ contentTypes: ["notes"], folders: { notes: ["P/Shared"] } })]);
  assert.ok(m.folders.P && m.folders["P/Shared"]);
  assert.equal(m.folders["P/Private"], undefined);
  const r = brokerShareMarkers("recipes", [{ recipeId: "r1", category: "Ops" }], [share({ contentTypes: ["recipes"], selected: { recipes: ["r1"] } })]);
  assert.ok(r.items.r1 && r.folders.Ops);
  const sc = brokerShareMarkers("scripts", [{ category: "(root)", file: "a.sh" }], [share({ contentTypes: ["scripts"], selected: { scripts: ["a.sh"] } })]);
  assert.ok(sc.items["a.sh"]);
});

test("native output matches the legacy implementation when its build exists", { skip: !legacy }, () => {
  const items = [{ name: "x", category: "A/B" }];
  const shares = [share({ folders: { skills: ["A"] } })];
  assert.deepEqual(brokerShareMarkers("skills", items, shares), legacy("skills", items, shares));
});
