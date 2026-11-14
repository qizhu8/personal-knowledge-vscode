import test from "node:test";
import assert from "node:assert/strict";
import { createHumanReviewComponent } from "../browser/human-review.mjs";
import { executionReview, memoryReview } from "./human-review-fixtures.mjs";

class Element {
  constructor(tag, document) { this.tag = tag; this.ownerDocument = document; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.textContent = ""; }
  set innerHTML(_) { throw new Error("Unsafe HTML is prohibited."); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  async click() { await this.listeners.get("click")?.(); }
}
function root() {
  const document = { createElement: tag => new Element(tag, document) };
  return new Element("root", document);
}
function entry(authority = "approval") {
  const request = authority === "approval" ? executionReview() : memoryReview("memory.record.revise");
  return { id: "00000000-0000-4000-8000-000000000001", authority, actorId: "alice", workspaceId: "synthetic-workspace",
    operationId: request.operationId, revision: 1, intentDigest: "c".repeat(64), expiresAt: 1_900_000_000_000,
    intent: { authority, request } };
}
function contents(element) { return [element.textContent, ...element.children.map(contents)].join("\n"); }

test("safe DOM renders exact command/args/source pins and sends only the viewed decision pin", async () => {
  for (const authority of ["approval", "memory"]) {
    const value = entry(authority), node = root(), decisions = [];
    let items = [value];
    const component = createHumanReviewComponent(node, { read: async () => ({ entries: items }), decide: async input => {
      decisions.push(input); items = []; return { status: "approved" };
    } });
    await component.refresh();
    const text = contents(node);
    assert.match(text, /Workspace synthetic-workspace \/ Actor alice/);
    assert.match(text, /Intent pin: c{64}/);
    assert.match(text, /Document impact:/);
    if (authority === "approval") { assert.match(text, /<img src=x onerror=evil\(\)>/); assert.match(text, /Context\/source pin: a{64}/); }
    else { assert.match(text, /Replacement sourced fact/); assert.match(text, /Revision: 8/); assert.match(text, /Document pin: b{64}/); }
    assert.equal(node.querySelectorAll("img").length, 0);
    await node.querySelectorAll("button").find(button => button.textContent === "Approve exact record").click();
    assert.deepEqual(decisions, [{ id: value.id, expectedRevision: 1, intentDigest: value.intentDigest, decision: "approve" }]);
    component.dispose(); assert.equal(node.children.length, 0);
  }
});

test("unavailable native human session leaves no approval buttons and never invents a bearer", async () => {
  const node = root();
  const component = createHumanReviewComponent(node, {
    read: async input => { assert.deepEqual(input, {}); throw new Error("private credential must not appear"); },
    decide: async () => { throw new Error("must not be called"); },
  });
  await component.refresh();
  assert.match(contents(node), /Machine credentials cannot review/);
  assert.ok(!contents(node).includes("private credential"));
  assert.equal(node.querySelectorAll("button").length, 1);
  component.dispose();
});

test("stale/detached button cannot issue another decision after refresh or disposal", async () => {
  const node = root(), value = entry();
  let decisions = 0;
  const component = createHumanReviewComponent(node, {
    read: async () => ({ entries: [value] }), decide: async () => { decisions++; return { status: "cancelled" }; },
  });
  await component.refresh();
  const old = node.querySelectorAll("button").find(button => button.textContent === "Approve exact record");
  await component.refresh(); await old.click(); assert.equal(decisions, 0);
  const latest = node.querySelectorAll("button").find(button => button.textContent === "Approve exact record");
  component.dispose(); await latest.click(); assert.equal(decisions, 0);
});
