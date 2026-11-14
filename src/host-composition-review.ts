import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import type { StandaloneHumanReview } from "./standalone-host.js";

export async function startTerminalReview(review: StandaloneHumanReview, evidence: object) {
  let capability = await review.openSession(evidence);
  const input = createInterface({ input: process.stdin, terminal: false });
  let chain = Promise.resolve();
  input.on("line", line => {
    chain = chain.then(async () => {
      try {
        const value = JSON.parse(line);
        if (value.action === "renew") {
          review.closeSession(capability); capability = await review.openSession(evidence);
          console.error(JSON.stringify({ humanReview: { renewed: true } }));
        } else if (value.action === "read") console.error(JSON.stringify({ humanReview: review.handlers.read(capability, {}) }));
        else if (value.action === "decide") console.error(JSON.stringify({ humanReview: review.handlers.decide(capability, value.input) }));
        else throw new Error();
      } catch { console.error(JSON.stringify({ humanReviewError: "Review unavailable or stale." })); }
    });
  });
  return () => { input.close(); review.closeSession(capability); };
}

export function createBrowserReview(review: StandaloneHumanReview, evidence: object) {
  let enrollment: string | undefined = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 120_000;
  const sessions = new Map<string, { capability: object; expiresAt: number }>();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Native review desk</title><link rel="stylesheet" href="/human-review.css"></head><body><form id="bind"><label>One-use native enrollment code <input id="code" type="password" autocomplete="off"></label><button>Bind human session</button></form><dialog id="review-modal" aria-label="Exact native human operation review"><main id="desk"></main></dialog><script type="module" src="/human-review-host.mjs"></script></body></html>`;
  const script = `import {createHumanReviewComponent} from '/human-review.mjs';
const send=async(path,input)=>{const r=await fetch('/human-review/'+path,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(input)});if(!r.ok)throw Error('Unavailable');return r.json()};
const desk=createHumanReviewComponent(document.getElementById('desk'),{read:i=>send('read',i),decide:i=>send('decide',i)});
document.getElementById('bind').addEventListener('submit',async e=>{e.preventDefault();const input=document.getElementById('code');try{await send('session',{code:input.value});input.value='';document.getElementById('bind').remove();document.getElementById('review-modal').showModal();await desk.refresh()}catch{input.value=''}});
`;
  const code = enrollment;
  async function handle(req: IncomingMessage, res: ServerResponse, body: () => Promise<unknown>): Promise<boolean> {
    if (!req.url?.startsWith("/human-review")) return false;
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && ["/human-review.mjs", "/human-review.css"].includes(req.url)) {
      res.writeHead(200, { "Content-Type": req.url.endsWith(".mjs") ? "text/javascript" : "text/css", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(await readFile(new URL(`../browser/${req.url.slice(1)}`, import.meta.url))); return true;
    }
    if (req.method === "GET" && ["/human-review", "/human-review-host.mjs"].includes(req.url)) {
      res.writeHead(200, { "Content-Type": req.url.endsWith(".mjs") ? "text/javascript" : "text/html", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Content-Type-Options": "nosniff" });
      res.end(req.url.endsWith(".mjs") ? script : html); return true;
    }
    if (req.method !== "POST" || req.headers.authorization !== undefined
      || req.headers.origin !== `http://${req.headers.host}`
      || req.headers["content-type"] !== "application/json") { reply(403, { error: "Native human session required." }); return true; }
    try {
      const input = await body();
      if (req.url === "/human-review/session") {
        const supplied = typeof input === "object" && input !== null && "code" in input && typeof input.code === "string" ? input.code : "";
        if (!enrollment || Date.now() >= expiresAt || supplied.length !== enrollment.length
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(enrollment))) throw new Error();
        enrollment = undefined;
        const capability = await review.openSession(evidence), id = randomBytes(32).toString("hex");
        sessions.set(id, { capability, expiresAt: Date.now() + 120_000 });
        res.setHeader("Set-Cookie", `pkm_human=${id}; HttpOnly; SameSite=Strict; Path=/human-review; Max-Age=120`);
        reply(200, { bound: true }); return true;
      }
      const id = /(?:^|; )pkm_human=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
      const session = id ? sessions.get(id) : undefined;
      if (!session || session.expiresAt <= Date.now()) throw new Error();
      if (req.url === "/human-review/read") reply(200, review.handlers.read(session.capability, input));
      else if (req.url === "/human-review/decide") reply(200, review.handlers.decide(session.capability, input));
      else reply(404, { error: "Not found." });
    } catch { reply(403, { error: "Native review unavailable or stale." }); }
    return true;
  }
  return { code, handle, close() { enrollment = undefined; for (const session of sessions.values()) review.closeSession(session.capability); sessions.clear(); } };
}
