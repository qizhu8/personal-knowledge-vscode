import { createServer } from "node:http";
import { once } from "node:events";
import { OPERATIONS } from "../next-server/browser/protocol.mjs";

export class Element extends EventTarget {
  constructor(document, tag) {
    super();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.parentElement = null;
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this._text = "";
  }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("Unsafe HTML rendering is forbidden"); }
  get firstElementChild() { return this.children[0]; }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceWith(child) {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    this.parentElement = null;
    child.parentElement = parent;
    parent.children[index] = child;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    if (selector === "*") return all;
    if (selector === "button[data-capability]") return all.filter(child => child.tagName === "BUTTON" && child.dataset.capability);
    return all.filter(child => child.tagName.toLowerCase() === selector);
  }
}
export function fixtureDOM() {
  const document = { createElement: tag => new Element(document, tag), activeElement: null };
  const root = document.createElement("div");
  return { root, document };
}
export function find(root, predicate) {
  return root.querySelectorAll("*").find(predicate);
}
export function field(root, name) {
  return find(root, element => element.getAttribute("aria-label") === name);
}
export function action(root, label) {
  return find(root, element => element.tagName === "BUTTON" && element.textContent === label);
}
export function submit(input) {
  let form = input;
  while (form && form.tagName !== "FORM") form = form.parentElement;
  if (!form) throw new Error("Form not found");
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}
export function click(element) {
  let shell = element;
  while (shell.parentElement?.parentElement) shell = shell.parentElement;
  const event = new Event("click");
  Object.defineProperty(event, "target", { value: element });
  shell.dispatchEvent(event);
}
export async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

export const hostile = '<img src="https://evil.invalid/steal" onerror="alert(1)"> **literal** [link](javascript:alert(1))';
export function runRecord(version = 1) {
  return {
    schema: "pkm.manager.runtime/v1", runId: "run-1", projectId: "project-1", version,
    state: "active", phase: "workers", contract: { objective: "Deliver a tested native change" },
    updatedAt: 1700000000000, budget: { maxWorkers: 4, maxConcurrentWorkers: 2, maxTasks: 16, maxAttemptsPerTask: 2 },
    tasks: [{ definition: { taskId: "worker-1", title: "Native worker", dependsOn: [] }, state: "running", attempts: [] }],
    checks: [], feedback: [],
  };
}
export async function syntheticServer(options = {}) {
  const calls = [];
  const token = "a".repeat(32);
  const supported = options.supported ?? new Set(Object.values(OPERATIONS).map(value => value.operation).filter(operation => !operation.startsWith("manager.progress.")));
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "request", error: { code: "UNAUTHORIZED", effect: "not-committed" } }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    calls.push({ path: req.url, body: input });
    const method = req.url.slice(4);
    let result;
    let error;
    if (method === "server_info") result = { name: "pkm-next" };
    else if (method === "capabilities_describe") {
      const operation = Object.values(OPERATIONS).find(value => value.operation === input.operation);
      if (operation && supported.has(input.operation)) result = { ...operation, version: 1 };
      else error = { code: "NOT_FOUND", effect: "not-committed" };
    } else {
      result = await options.handle?.(input.operation, input.arguments, req, res);
      if (res.destroyed || res.writableEnded) return;
      if (result === undefined) {
        switch (input.operation) {
          case "knowledge.document.list": result = { items: [{ id: "doc-1", title: "Native Knowledge" }], nextOffset: null, workspaceRevision: "a".repeat(64) }; break;
          case "knowledge.document.get": result = { id: "doc-1", title: "Native Knowledge", content: hostile, revision: 1 }; break;
          case "chat.session.list": result = { items: [{ id: "chat-1", title: "First Chat", revision: 1 }], nextCursor: null }; break;
          case "chat.session.get": result = { id: "chat-1", title: "First Chat", revision: 1 }; break;
          case "chat.session.messages": result = { items: [{ role: "assistant", content: hostile, status: "complete" }], hasMore: false, nextCursor: "cursor-1" }; break;
          case "chat.session.create": result = { id: input.arguments.id, title: "New Chat", revision: 1 }; break;
          case "chat.turn.start": result = { id: input.arguments.id, status: "model", revision: 1, output: "" }; break;
          case "chat.turn.get": result = { id: input.arguments.id, status: "completed", revision: 2, output: "Native model output" }; break;
          case "chat.turn.events": result = { events: [{ sequence: 1, type: "completed", data: {} }], next: null }; break;
          case "chat.turn.cancel": result = { id: input.arguments.id, status: "cancelled", revision: 3, output: "" }; break;
          case "manager.runtime.get": result = runRecord(); break;
          case "manager.runtime.events": result = { items: input.arguments.afterSeq ? [] : [
            { seq: 1, type: "worker.delivery", time: 1700000000000, data: { taskId: "worker-1", attemptId: "attempt-1", artifact: hostile, pin: "b".repeat(64) } },
          ], nextSeq: 1 }; break;
          case "manager.runtime.feedback": result = { ...runRecord(2), feedback: [{ state: "queued" }] }; break;
          case "manager.runtime.cancel": result = { ...runRecord(3), state: "cancelled" }; break;
          default: error = { code: "NOT_AVAILABLE", effect: "not-committed" };
        }
      }
    }
    res.writeHead(error ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ schema: "pkm.next-result/v1", requestId: "synthetic-request", ...(error ? { error } : { result }) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { token, calls, origin: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
