type Route = "/manage/status" | "/manage/candidates" | "/manage/approve" | "/manage/switch" | "/manage/operation-status";

/** Host-only capability tied to the existing pkm entry. Keep object identity stable until that binding changes. */
export interface VerifiedMcpSwitchBinding {
  readonly serviceId: string;
  request(route: Route, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface SwitchHost {
  getBinding(): VerifiedMcpSwitchBinding | undefined;
  confirm(review: { serviceId: string; activeGeneration: string; targetGeneration: string }): Promise<boolean>;
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function parseStatus(binding: VerifiedMcpSwitchBinding, raw: Record<string, unknown>) {
  const { phase, generation, runtimeBuild, backendPid, inFlight, uncertain, backgroundChat } = raw;
  if (raw.schema !== "pkm.shared-service-status/v1" || raw.serviceId !== binding.serviceId
    || raw.automaticReplay !== false || typeof phase !== "string"
    || !["starting", "accepting", "draining", "action-required", "closed"].includes(phase)
    || !count(inFlight) || !Array.isArray(uncertain)
    || backgroundChat !== undefined && (!object(backgroundChat) || !count(backgroundChat.active) || !count(backgroundChat.uncertain)))
    throw new Error("Unverified manager status.");
  return {
    phase, generation: uuid(generation) ? generation : null, runtimeBuild: digest(runtimeBuild) ? runtimeBuild : null,
    backendPid: count(backendPid) && backendPid > 0 ? backendPid : null, inFlight, uncertain: uncertain.length,
    backgroundActive: (backgroundChat?.active as number | undefined) ?? 0,
    backgroundUncertain: (backgroundChat?.uncertain as number | undefined) ?? 0,
  };
}

type Status = ReturnType<typeof parseStatus>;
type Candidate = { generation: string; runtimeBuild: string; compatible: boolean };
type Operation = { binding: VerifiedMcpSwitchBinding; operationId: string; bodySha256: string; generation: string };
const blocker = (status: Status) => status.uncertain || status.backgroundUncertain ? "uncertainWork"
  : status.backgroundActive ? "backgroundWork"
    : status.phase !== "accepting" || !status.generation || !status.runtimeBuild || !status.backendPid ? "notAccepting" : "";

export function createMcpBackendSwitch(host: SwitchHost) {
  let busy = false;
  let unresolved: Operation | undefined;
  const sameBinding = (binding: VerifiedMcpSwitchBinding) => {
    try { return host.getBinding() === binding; } catch { return false; }
  };
  const status = async (binding: VerifiedMcpSwitchBinding) => parseStatus(binding, await binding.request("/manage/status"));
  const snapshot = async (binding: VerifiedMcpSwitchBinding) => {
    const active = await status(binding);
    try {
      const raw = await binding.request("/manage/candidates");
      if (raw.schema !== "pkm.shared-service-candidates/v1" || raw.serviceId !== binding.serviceId
        || raw.activeGeneration !== active.generation || !Array.isArray(raw.items) || raw.items.length > 16
        || !count(raw.rejectedCount)) throw new Error("Unverified candidate inventory.");
      const candidates: Candidate[] = raw.items.map(item => {
        if (!object(item) || !uuid(item.generation) || !digest(item.runtimeBuild) || typeof item.compatible !== "boolean")
          throw new Error("Unverified candidate.");
        return { generation: item.generation, runtimeBuild: item.runtimeBuild, compatible: item.compatible };
      });
      if (new Set(candidates.map(item => item.generation)).size !== candidates.length)
        throw new Error("Ambiguous candidate inventory.");
      return { active, candidates, rejected: raw.rejectedCount, error: "" };
    } catch { return { active, candidates: [], rejected: 0, error: "candidatesUnavailable" }; }
  };

  async function outcome(operation: Operation) {
    const { binding, operationId, bodySha256, generation } = operation;
    try {
      const raw = await binding.request("/manage/operation-status", { operationId, bodySha256 });
      if (raw.schema === "pkm.shared-management-outcome/v1" && raw.serviceId === binding.serviceId
        && raw.operationId === operationId && raw.bodySha256 === bodySha256 && raw.status === "terminal"
        && raw.automaticReplay === false && raw.absenceIsNotNoncommit === true && object(raw.record)
        && raw.record.id === operationId && raw.record.bodySha256 === bodySha256 && raw.record.action === "switch"
        && raw.record.to === generation && (raw.record.phase === "completed" || raw.record.phase === "failed"))
        return raw.record.phase;
    } catch { /* Missing evidence does not establish a non-commit. */ }
    return "unknownOutcome";
  }

  return {
    async handleMessage(message: unknown, respond: (message: object) => void): Promise<boolean> {
      if (!object(message) || message.command !== "mcpBackendSwitchRead" && message.command !== "mcpBackendSwitchApply") return false;
      if (!count(message.requestId)) return true;
      const send = (data: object, progress = false) => respond({
        command: "mcpBackendSwitchResult", data: { requestId: message.requestId, progress, ...data },
      });
      const read = message.command === "mcpBackendSwitchRead";
      if (busy) { send({ error: "busy" }); return true; }
      busy = true;
      try {
        const binding = host.getBinding();
        if (!binding || !uuid(binding.serviceId)) { send({ error: "unbound" }); return true; }
        if (unresolved) {
          if (unresolved.binding !== binding) { send({ error: "unknownOutcome" }); return true; }
          const result = await outcome(unresolved);
          if (result !== "unknownOutcome") unresolved = undefined;
          if (!read) { send({ error: result === "unknownOutcome" ? result : "refreshRequired" }); return true; }
          const view = await snapshot(binding);
          send(sameBinding(binding) ? { ...view, serviceId: binding.serviceId, outcome: result } : { error: "bindingChanged" });
          return true;
        }
        const view = await snapshot(binding);
        const { active, candidates } = view;
        const sendView = (data: object = {}) => send(sameBinding(binding)
          ? { ...view, serviceId: binding.serviceId, ...data } : { error: "bindingChanged" });
        if (read || view.error || !sameBinding(binding)) { sendView(); return true; }
        const target = candidates.find(item => item.compatible && item.generation === message.generation
          && item.runtimeBuild === message.runtimeBuild && item.generation !== active.generation);
        if (!target || binding.serviceId !== message.serviceId
          || active.generation !== message.activeGeneration || active.backendPid !== message.activePid) {
          sendView({ error: "selectionChanged" }); return true;
        }
        if (blocker(active)) { sendView({ error: blocker(active) }); return true; }
        if (!await host.confirm({ serviceId: binding.serviceId, activeGeneration: active.generation!, targetGeneration: target.generation })) {
          sendView({ outcome: "cancelled" }); return true;
        }
        if (!sameBinding(binding)) { sendView(); return true; }
        const approval = await binding.request("/manage/approve", { action: "switch", generation: target.generation });
        if (!uuid(approval.approvalId) || !uuid(approval.operationId) || !digest(approval.bodySha256))
          throw new Error("Unverified switch approval.");
        // Check after obtaining the revision-bound approval. A later manager transition invalidates it.
        const latest = await status(binding);
        if (!sameBinding(binding) || latest.generation !== active.generation || latest.backendPid !== active.backendPid
          || latest.runtimeBuild !== active.runtimeBuild || blocker(latest)) {
          send(sameBinding(binding) ? { active: latest, serviceId: binding.serviceId, error: blocker(latest) || "selectionChanged" }
            : { error: "bindingChanged" });
          return true;
        }
        const { operationId, bodySha256, approvalId } = approval;
        const operation = { binding, operationId, bodySha256, generation: target.generation };
        unresolved = operation;
        let finished = false;
        let timer: ReturnType<typeof setTimeout>;
        const observe = async () => {
          try {
            const active = await status(binding);
            if (!finished && sameBinding(binding)) send({ active, serviceId: binding.serviceId }, true);
          } catch { /* Progress reads are not mutation retries. */ }
          if (!finished && sameBinding(binding)) timer = setTimeout(() => void observe(), 500);
        };
        timer = setTimeout(() => void observe(), 250);
        let result;
        try {
          const reply = await binding.request("/manage/switch", { generation: target.generation, approvalId, operationId, bodySha256 });
          const observed = parseStatus(binding, reply);
          if (reply.operationId !== operationId || reply.bodySha256 !== bodySha256
            || observed.generation !== target.generation || observed.phase !== "accepting")
            throw new Error("Unverified switch result.");
          result = "completed";
        } catch (error) {
          // sharedManagedRequest wraps an authenticated HTTP error as JSON. Transport failures are not refusals.
          let refusal = false;
          if (error instanceof Error) {
            try {
              const reply: unknown = JSON.parse(error.message);
              refusal = object(reply) && typeof reply.error === "string" && reply.effect === "not-committed"
                && reply.operationId === undefined && reply.bodySha256 === undefined;
            } catch { /* Treat unverified effects as unknown. */ }
          }
          result = refusal ? "refused" : await outcome(operation);
        }
        finally { finished = true; clearTimeout(timer); }
        if (result !== "unknownOutcome") unresolved = undefined;
        if (!sameBinding(binding)) { send({ error: "bindingChanged", outcome: result }); return true; }
        try {
          const current = await snapshot(binding);
          send(sameBinding(binding) ? { ...current, serviceId: binding.serviceId, outcome: result }
            : { error: "bindingChanged", outcome: result });
        }
        catch { send({ error: "statusUnavailable", outcome: result }); }
      } catch {
        send({ error: "statusUnavailable", ...(unresolved ? { outcome: "unknownOutcome" } : {}) });
      } finally { busy = false; }
      return true;
    },
  };
}
