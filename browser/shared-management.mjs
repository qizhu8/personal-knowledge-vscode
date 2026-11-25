// @ts-check
import { sharedManagedRequest, validateSharedManagedBinding, sharedManagementBodySha256 } from "./shared-managed-client.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const actions = ["switch", "reset-index", "cleanup-runtime", "recover", "reconcile", "revoke-access", "human-review-enrollment"];

/** Separate local management authority; never receives the business bearer or performs automatic actions. */
export function mountSharedManagement(root, { origin = globalThis.location.origin } = {}) {
  const document = root.ownerDocument, listeners = [];
  let binding, snapshot, approval, disposed = false, actionBusy = false, reading = false, enrollmentTimer;
  const observations = new Map();
  const node = (tag, text = "") => {
    const element = document.createElement(tag); element.textContent = text; return element;
  };
  const on = (element, event, handler) => {
    element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler));
  };
  const field = (label, type = "text") => {
    const wrapper = node("label"), input = node("input");
    input.type = type; input.setAttribute("aria-label", label);
    input.autocomplete = "off"; input.spellcheck = false;
    wrapper.className = "surface-field"; wrapper.append(node("span", label), input);
    return { wrapper, input };
  };
  const button = (label, handler) => {
    const element = node("button", label); element.type = "button";
    on(element, "click", () => { void run(handler); }); return element;
  };
  root.className = "panel shared-management";
  const details = node("details"), summary = node("summary", "Local service management (separate authority)");
  details.append(summary, node("p", "Exact same-origin loopback only. Provision the service UUID and separate management credential independently. Business access does not grant management or human approval."));
  const service = field("Management service UUID"), credential = field("Management credential", "password");
  const state = node("p", "Management disconnected · credentials are memory-only.");
  state.className = "surface-status"; state.setAttribute("role", "status");
  const error = node("p"); error.className = "error"; error.setAttribute("role", "alert"); error.hidden = true;
  const statusView = node("pre"), candidates = node("select");
  candidates.setAttribute("aria-label", "Verified staged generation");
  const action = node("select"); action.setAttribute("aria-label", "Management action");
  for (const value of actions) {
    const option = node("option", value); option.value = value; action.append(option);
  }
  const receipts = node("select"); receipts.setAttribute("aria-label", "Unknown manager receipt");
  const review = field("I reviewed native status and the exact target; failure is not rollback and nothing is replayed.", "checkbox");
  const pinsView = node("p"), historyView = node("pre"), observationsView = node("pre");
  observationsView.setAttribute("aria-label", "Durable management observations");
  const enrollment = field("One-use human enrollment code", "password"); enrollment.input.readOnly = true; enrollment.wrapper.hidden = true;
  const reviewLink = node("a", "Open independent native human review desk"); reviewLink.href = "/human-review"; reviewLink.hidden = true;
  const connect = button("Connect management", async () => {
    const secret = credential.input.value;
    disconnect();
    const candidate = { origin, serviceId: service.input.value, token: secret };
    credential.input.value = "";
    validateSharedManagedBinding(candidate);
    binding = candidate;
    try { await refresh(); } catch (failure) { binding = undefined; throw failure; }
  });
  const forget = button("Forget management credential", () => disconnect());
  const refreshButton = button("Refresh service status", refresh);
  const candidateButton = button("List verified staged candidates", async () => {
    const authority = binding;
    reading = true; update();
    try {
      const value = await request("/manage/candidates");
      if (binding !== authority || disposed) return;
      if (value.schema !== "pkm.shared-service-candidates/v1" || value.serviceId !== authority.serviceId
        || !Array.isArray(value.items) || value.items.length > 16) throw new Error("Invalid verified candidate response.");
      candidates.replaceChildren();
      for (const item of value.items) {
        if (!uuid(item.generation) || typeof item.compatible !== "boolean" ||
          !["standalone-core", "native-public-mcp"].includes(item.backendKind)) throw new Error("Invalid verified candidate.");
        const option = node("option", `${item.generation} · ${item.runtimeBuild} · ${item.compatible ? "compatible" : "incompatible"}`);
        option.value = item.generation; option.disabled = !item.compatible; candidates.append(option);
      }
      approval = undefined;
      state.textContent = `${value.items.length} verified staged candidate(s); ${value.rejectedCount} rejected. Staging is a separate explicit administrator operation.`;
    } finally { reading = false; }
  });
  const approve = button("Request exact management approval", async () => {
    if (readPins().length || !review.input.checked) throw new Error("Review native status and reconcile unresolved management operations first.");
    const target = selection(), operationId = crypto.randomUUID();
    actionBusy = true; update();
    try {
      const bodySha256 = await sharedManagementBodySha256(binding.serviceId, target.action, target);
      const value = await request("/manage/approve", { ...target, operationId, bodySha256 });
      if (!uuid(value.approvalId) || value.expiresInSeconds !== 60) throw new Error("Invalid management approval.");
      approval = { ...target, operationId, bodySha256, approvalId: value.approvalId, expires: Date.now() + 60_000 };
      state.textContent = "Exact approval ready for 60 seconds. No management action has been executed.";
    } finally { actionBusy = false; }
  });
  const execute = button("Execute approved management action", async () => {
    const exact = selection(), grant = approval;
    if (!grant || grant.expires <= Date.now() || !review.input.checked || readPins().length
      || JSON.stringify(exact) !== JSON.stringify(targetOf(grant))) throw new Error("Fresh exact management approval required.");
    const authority = binding;
    const pin = { schema: "pkm.management.pending/v1", serviceId: authority.serviceId,
      operationId: grant.operationId, bodySha256: grant.bodySha256, ...exact };
    const key = pinPrefix() + pin.operationId;
    const serialized = JSON.stringify(pin);
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw new Error("Management safety journal is unavailable; nothing dispatched.");
    approval = undefined; actionBusy = true; clearEnrollment(); update();
    state.textContent = `Executing approved ${exact.action}. Refresh service status observes native drain/background progress without replay.`;
    try {
      const { action: selectedAction, ...target } = exact;
      const value = await request(`/manage/${selectedAction}`, {
        ...target, approvalId: grant.approvalId, operationId: grant.operationId, bodySha256: grant.bodySha256,
        ...(selectedAction === "reconcile" ? { acknowledge: "reviewed-outcome-no-replay" } : {}),
        ...(selectedAction === "revoke-access" ? { acknowledge: "revoke-current-business-credential" } : {}),
      });
      if (binding !== authority || disposed) return;
      if (selectedAction === "human-review-enrollment") {
        if (value.schema !== "pkm.shared-human-enrollment/v1" || value.serviceId !== authority.serviceId
          || !/^[a-f0-9]{64}$/.test(value.code) || value.path !== "/human-review" || value.expiresInMs !== 120000)
          throw new Error("Invalid native human enrollment response.");
        enrollment.input.value = value.code; enrollment.wrapper.hidden = false; reviewLink.hidden = false;
        enrollmentTimer = setTimeout(clearEnrollment, value.expiresInMs);
      } else applyStatus(value);
      localStorage.removeItem(key);
      state.textContent = `Native ${selectedAction} completed. No automatic replay. Revocation affects all clients using the current business credential, not independent human authority.`;
    } catch (failure) {
      state.textContent = `Management ${exact.action} observation is unresolved. Do not retry or replace it. Explicitly check the exact durable management observation.`;
      throw failure;
    } finally { actionBusy = false; }
  });
  const checkObservations = button("Check durable management observations", async () => {
    const authority = binding;
    reading = true; approval = undefined; review.input.checked = false; update();
    try {
      for (const pin of readPins().slice(0, 8)) {
        const value = await request("/manage/operation-status", {
          operationId: pin.operationId, bodySha256: pin.bodySha256,
        });
        if (binding !== authority || disposed) return;
        if (value.schema !== "pkm.shared-management-outcome/v1" || value.serviceId !== pin.serviceId
          || value.operationId !== pin.operationId || value.bodySha256 !== pin.bodySha256
          || value.automaticReplay !== false || value.absenceIsNotNoncommit !== true
          || !["terminal", "pending", "unknown"].includes(value.status))
          throw new Error("Invalid native management observation; nothing reconciled.");
        if (value.status === "terminal" && (!value.record || value.record.id !== pin.operationId
          || value.record.bodySha256 !== pin.bodySha256 || value.record.action !== pin.action
          || !["completed", "failed"].includes(value.record.phase)
          || (pin.generation && value.record.to !== pin.generation)
          || (pin.receiptId && value.record.receiptId !== pin.receiptId)))
          throw new Error("Native management observation does not match the exact pinned action.");
        observations.set(pin.operationId, value);
      }
      observationsView.textContent = JSON.stringify([...observations.values()], null, 2);
      state.textContent = "Durable management observations checked without replay. Review the exact records, then explicitly acknowledge terminal matches. Missing/interrupted/unknown is not non-commitment.";
    } finally { reading = false; }
  });
  const reconcile = button("Acknowledge matching terminal management observation", () => {
    if (!review.input.checked) throw new Error("Review the matching native observation first. Failure does not mean rollback.");
    let count = 0;
    for (const pin of readPins()) {
      const observed = observations.get(pin.operationId);
      if (observed?.status === "terminal" && observed.bodySha256 === pin.bodySha256) {
        localStorage.removeItem(pinPrefix() + pin.operationId); observations.delete(pin.operationId); count++;
      }
    }
    state.textContent = `${count} matching terminal management observation(s) reviewed; no action replayed. A failed/interrupted operation is not a rollback. Native action-required and business uncertainty gates still apply.`;
  });
  const controls = node("div"); controls.className = "surface-tools";
  controls.append(connect, forget, refreshButton, candidateButton);
  const actionsView = node("div"); actionsView.className = "surface-tools";
  actionsView.append(action, candidates, receipts, approve, execute, checkObservations, reconcile);
  details.append(service.wrapper, credential.wrapper, controls, state, error, statusView, historyView,
    node("p", "Switch/reset/cleanup/recover drain the single native owner; they do not erase business uncertainty. Reconcile acknowledges a reviewed unknown manager receipt, never success or replay. Revoke stops new business dispatches globally. Human enrollment remains separate native authority."),
    review.wrapper, actionsView, pinsView, observationsView, enrollment.wrapper, reviewLink);
  root.replaceChildren(details);
  function targetOf(value) {
    return { action: value.action, ...(value.generation ? { generation: value.generation } : {}),
      ...(value.receiptId ? { receiptId: value.receiptId } : {}) };
  }
  function selection() {
    if (!actions.includes(action.value)) throw new Error("Unsupported management action.");
    if (action.value === "switch" && (!uuid(candidates.value) || candidates.selectedOptions[0]?.disabled))
      throw new Error("Select an explicitly verified compatible generation.");
    if (action.value === "reconcile" && !uuid(receipts.value)) throw new Error("Select an actual unknown native manager receipt.");
    return { action: action.value, ...(action.value === "switch" ? { generation: candidates.value } : {}),
      ...(action.value === "reconcile" ? { receiptId: receipts.value } : {}) };
  }
  function pinPrefix() { return `pkm.shared-management.pending.v1:${binding.serviceId}:`; }
  function readPins() {
    if (!binding) return [];
    if (localStorage.length > 4096) throw new Error("Management safety journal exceeds its bound.");
    const pins = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(pinPrefix())) continue;
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 1024 || pins.length >= 16) throw new Error("Invalid management safety journal.");
      const pin = JSON.parse(raw);
      if (pin.schema !== "pkm.management.pending/v1" || pin.serviceId !== binding.serviceId || !uuid(pin.operationId)
        || !/^[a-f0-9]{64}$/.test(pin.bodySha256) || key !== pinPrefix() + pin.operationId
        || !actions.includes(pin.action) || Object.keys(pin).some(name =>
          !["schema", "serviceId", "operationId", "bodySha256", "action", "generation", "receiptId"].includes(name))
        || (pin.action === "switch" ? !uuid(pin.generation) : pin.generation !== undefined)
        || (pin.action === "reconcile" ? !uuid(pin.receiptId) : pin.receiptId !== undefined))
        throw new Error("Invalid management safety journal; use the authenticated server operator, never clear/reset local state.");
      pins.push(pin);
    }
    return pins;
  }
  async function request(path, input) {
    if (!binding || disposed) throw new Error("Separate management authentication required.");
    return sharedManagedRequest(binding, path, input);
  }
  function applyStatus(value) {
    if (!binding || value.schema !== "pkm.shared-service-status/v1" || value.serviceId !== binding.serviceId
      || value.automaticReplay !== false) throw new Error("Management service identity/status mismatch.");
    snapshot = value;
    const { serviceId, workspaceId, actorId, backendKind, phase, generation, runtimeBuild, backendPid,
      clients, inFlight, backgroundChat, authentication, automaticReplay } = value;
    statusView.textContent = JSON.stringify({ serviceId, workspaceId, actorId, backendKind, phase, generation,
      runtimeBuild, backendPid, clients, inFlight, backgroundChat, authentication, automaticReplay }, null, 2);
    historyView.textContent = JSON.stringify(value.history?.slice(-8) ?? [], null, 2);
    receipts.replaceChildren();
    for (const item of (value.uncertain ?? []).slice(0, 32)) {
      if (!uuid(item.id)) continue;
      const option = node("option", `${item.id} · ${item.tool} · unknown`); option.value = item.id; receipts.append(option);
    }
  }
  async function refresh() {
    reading = true; update();
    try { applyStatus(await request("/manage/status")); state.textContent = `Observed native service phase: ${snapshot.phase}. No action replayed.`; }
    finally { reading = false; }
  }
  function clearEnrollment() {
    clearTimeout(enrollmentTimer); enrollment.input.value = ""; enrollment.wrapper.hidden = true; reviewLink.hidden = true;
  }
  function disconnect() {
    binding = snapshot = approval = undefined; credential.input.value = ""; clearEnrollment();
    observations.clear();
    statusView.textContent = historyView.textContent = pinsView.textContent = observationsView.textContent = "";
    candidates.replaceChildren(); receipts.replaceChildren();
    state.textContent = "Management disconnected · credentials and approval grants are memory-only.";
  }
  function update() {
    if (disposed) return;
    let pins = [], invalid = false;
    try { pins = readPins(); } catch (failure) { invalid = true; error.textContent = failure.message; error.hidden = false; }
    connect.disabled = actionBusy || reading; forget.disabled = actionBusy || reading;
    refreshButton.disabled = !binding || reading;
    candidateButton.disabled = !binding || actionBusy || reading;
    approve.disabled = !binding || actionBusy || reading || invalid || pins.length > 0 || !review.input.checked;
    execute.disabled = approve.disabled || !approval || approval.expires <= Date.now();
    checkObservations.disabled = !binding || actionBusy || reading || invalid || pins.length === 0;
    reconcile.disabled = !binding || actionBusy || reading || invalid || pins.length === 0 || !review.input.checked;
    action.disabled = actionBusy || reading; candidates.disabled = actionBusy || reading; receipts.disabled = actionBusy || reading;
    candidates.hidden = action.value !== "switch"; receipts.hidden = action.value !== "reconcile";
    pinsView.textContent = pins.length ? `Unresolved management operations: ${pins.map(pin => `${pin.operationId} · ${pin.action} · ${pin.bodySha256}`).join("; ")}. Reads only until matching native terminal observations are explicitly reviewed. No token, approval grant, enrollment code, or request body is persisted.` : "";
  }
  async function run(work) {
    if (disposed) return;
    error.hidden = true;
    try { await work(); }
    catch (failure) {
      if (disposed) return;
      let message = failure instanceof Error ? failure.message : "Management request failed.";
      try { message = JSON.parse(message).error ?? message; } catch {}
      error.textContent = String(message).slice(0, 512); error.hidden = false;
    } finally { update(); }
  }
  for (const element of [action, candidates, receipts, review.input])
    on(element, "change", () => {
      approval = undefined;
      if (element !== review.input) review.input.checked = false;
      clearEnrollment(); update();
    });
  update();
  return { dispose() {
    if (disposed) return;
    disconnect(); disposed = true; listeners.forEach(remove => remove()); root.replaceChildren();
  } };
}
