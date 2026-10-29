import { AsyncLocalStorage } from "async_hooks";

export interface PanelTarget { webview: { postMessage(message: any): unknown }; }
export interface PanelSession<T extends PanelTarget> {
  panel?: T;
  snapshot: Record<string, any>;
  ready: boolean;
  markdownDraftOpen: boolean;
  lastHeartbeat: number;
  lastDiagnostic: string;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  pendingOpen?: { type: string; key: string; edit?: boolean; tab?: string };
  pendingTab?: string;
  pendingActions?: Record<string, any>;
  pendingProjectId?: string;
  pendingNativeSessionId?: string;
  pendingSubscriptionShare?: string;
  pendingServerSlug?: string;
  pendingEnvironmentId?: string;
  pendingMcpRegenerateHighlight: boolean;
  revisions: Map<string, string>;
  listRequests: Map<string, number>;
}

/** Only presentation state belongs here. Backend services and operation locks remain shared.
 * VS Code WebviewInput has Singleton capability, not native clone/split support:
 * src/vs/workbench/contrib/webviewPanel/browser/webviewEditorInput.ts.
 * Our editor/title/context contribution creates a new panel from an inert snapshot;
 * webview/context would only contribute to the HTML content menu, not the tab menu.
 */
export class PanelRegistry<T extends PanelTarget> {
  readonly instances = new Map<T, PanelSession<T>>();
  readonly requests = new AsyncLocalStorage<PanelSession<T>>();
  active?: T;
  readonly staging = this.createSession();

  private createSession(panel?: T, snapshot: unknown = {}): PanelSession<T> {
    return { panel, snapshot: clonePanelSnapshot(snapshot), ready: false, markdownDraftOpen: false,
      lastHeartbeat: Date.now(), lastDiagnostic: "", pendingMcpRegenerateHighlight: false, revisions: new Map(), listRequests: new Map() };
  }
  current(): PanelSession<T> { return this.requests.getStore() || (this.active && this.instances.get(this.active)) || this.staging; }
  add(panel: T, snapshot?: unknown): PanelSession<T> {
    const session = this.createSession(panel, snapshot);
    this.instances.set(panel, session);
    this.active = panel;
    return session;
  }
  focus(panel: T): void { if (this.instances.has(panel)) this.active = panel; }
  remove(panel: T): void {
    const session = this.instances.get(panel);
    if (session?.recoveryTimer) clearTimeout(session.recoveryTimer);
    this.instances.delete(panel);
    if (this.active === panel) this.active = [...this.instances.keys()].pop();
  }
  reply(session: PanelSession<T>, message: object): void {
    if (session.panel && this.instances.has(session.panel)) session.panel.webview.postMessage(message);
  }
  broadcast(message: object, except?: T): void {
    for (const panel of this.instances.keys()) if (panel !== except) panel.webview.postMessage(message);
  }
  duplicate(panel: T): Record<string, any> { return clonePanelSnapshot(this.instances.get(panel)?.snapshot); }
}

/** Snapshots are inert UI data: requests, timers and operations are never restored/replayed. */
export function clonePanelSnapshot(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}
