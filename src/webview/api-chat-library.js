(() => {
  const t = text => globalThis.PkmChatText?.(text) || text;
  window.PkmChatClothingRole = chat => chat?.workerManager || chat?.manager || chat?.messages?.some(message => message.delegations?.length)
    ? "manager" : chat?.workerParentChatId || chat?.workerState?.parentChatId || chat?.parentChatId ? "worker"
      : undefined;
  window.PkmChatRole = chat => chat?.portal?.execution ? "controlled"
    : ["controller", "controlled"].includes(chat?.portal?.binding?.role) ? chat.portal.binding.role : window.PkmChatClothingRole(chat);
  window.PkmChatDisplayStatus = chat => chat?.portal?.execution
    ? chat.portal.execution.state === "awaiting-approval" ? "awaiting-input" : "running" : chat.status;
  const wizardTemplates = new Map();
  const portalTemplates = new Map();
  const applyClothingRole = (node, role) => {
    node.dataset.clothingRole = ["manager", "worker"].includes(role) ? role : "chat";
    return node;
  };
  // Controller: blue Portal ring on the left, side-profile wizard on the right facing it.
  // Controlled: wizard on the left with its back to the ring on the right. Closed: a dashed ring only.
  window.PkmChatPortalIcon = (connected, role, showWizard = true, clothingRole) => {
    const key = `${connected ? "open" : "closed"}:${showWizard ? role === "controlled" ? "controlled" : "controller" : "button"}`;
    if (!portalTemplates.has(key)) {
      const ns = "http://www.w3.org/2000/svg";
      const icon = document.createElement("span");
      icon.className = `portal-button-icon portal-scene ${connected ? "portal-open" : "portal-closed"}`;
      icon.dataset.connection = connected ? "connected" : "disconnected";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      svg.classList.add("portal-scene-svg");
      const controlled = role === "controlled";
      const ringX = !connected || !showWizard ? 12 : controlled ? 18.5 : 5.5;
      const shift = controlled ? 0 : 12;
      const ring = (className, rx, ry) => {
        const node = document.createElementNS(ns, "ellipse");
        for (const [name, value] of Object.entries({ class: className, cx: ringX, cy: 8, rx, ry })) node.setAttribute(name, String(value));
        svg.append(node);
      };
      ring("portal-ring-glow", 4.2, 7.2); ring("portal-ring", 4.2, 7.2); ring("portal-ring-inner", 2.4, 5.2);
      if (connected && showWizard) {
        const palette = { outline: "#30273f", hat: controlled ? "#5fae94" : "#9983ce", edge: controlled ? "#b5e4d2" : "#c8b4ef",
          skin: "#f6ceaa", hair: "#795440", eye: "#3a3040", wand: "#c89355", spark: "#bfe6ff" };
        const rect = (parent, x, y, width, height, color) => {
          const node = document.createElementNS(ns, "rect");
          for (const [name, value] of Object.entries({ x: x + shift, y, width, height, fill: palette[color] })) node.setAttribute(name, String(value));
          if (color === "hat") node.classList.add("wizard-clothing");
          if (color === "edge") node.classList.add("wizard-clothing-trim");
          parent.append(node);
        };
        const wizard = document.createElementNS(ns, "g"); wizard.setAttribute("class", "portal-side-wizard");
        wizard.dataset.facing = controlled ? "away-from-portal" : "toward-portal"; wizard.dataset.chatRole = controlled ? "controlled" : "controller";
        for (const [x, y, width, height, color] of [
          [8, 1, 2, 1, "edge"], [6, 2, 3, 1, "hat"], [5, 3, 4, 1, "hat"], [3, 4, 8, 1, "edge"],
          [4, 5, 4, 4, "skin"], [8, 5, 2, 3, "hair"], [3, 6, 1, 1, "skin"], [4, 6, 1, 1, "eye"], [4, 8, 2, 1, "hair"],
          [4, 9, 5, 2, "hat"], [3, 11, 7, 3, "hat"], [5, 10, 1, 3, "edge"], [3, 14, 2, 1, "outline"], [7, 14, 2, 1, "outline"],
        ]) rect(wizard, x, y, width, height, color);
        svg.append(wizard);
        for (let frame = 0; frame < 4; frame++) {
          const group = document.createElementNS(ns, "g"); group.classList.add("pixel-wizard-frame"); group.dataset.frame = String(frame);
          const up = frame === 1 || frame === 2;
          rect(group, 2, 9, 2, 1, "skin"); rect(group, 1, up ? 6 : 7, 1, 3, "wand");
          rect(group, 0, up ? 5 : 6, 1, 1, "spark");
          const [sx, sy] = [[22, 4], [20, 1], [15, 3], [16, 12]][frame];
          if (controlled) rect(group, sx, sy, 1, 1, "spark");
          else { rect(group, [10, 9, 8, 9][frame] - shift, [6, 5, 7, 8][frame], 1, 1, "spark"); rect(group, [6, 4, 5, 7][frame] - shift, [3, 10, 6, 12][frame], 1, 1, "spark"); }
          svg.append(group);
        }
      }
      icon.append(svg); portalTemplates.set(key, icon);
    }
    return applyClothingRole(portalTemplates.get(key).cloneNode(true), clothingRole);
  };
  window.PkmChatWorkingIcon = (role, clothingRole = role) => {
    if (role === "controller" || role === "controlled") {
      const icon = window.PkmChatPortalIcon(true, role, true, clothingRole);
      icon.classList.add("chat-role-icon"); icon.dataset.chatRole = role;
      return applyClothingRole(icon, clothingRole);
    }
    if (!["manager", "worker"].includes(role)) {
      const icon = window.PkmChatWorkingIcon("worker");
      delete icon.dataset.chatRole;
      return applyClothingRole(icon, clothingRole);
    }
    if (!wizardTemplates.has(role)) {
      const icon = document.createElement("span"); icon.className = "chat-role-icon"; icon.dataset.chatRole = role;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false"); svg.classList.add("pixel-wizard");
      const palette = { outline: "#30273f", hat: "#9983ce", edge: "#c8b4ef", skin: "#f6ceaa", hair: "#795440",
        eye: "#3a3040", book: "#e4ce8c", paper: "#fff0c8", pot: "#435366", rim: "#d2dfeb", potion: "#54cc8a", wand: "#c89355" };
      const rect = (parent, x, y, width, height, color) => {
        const node = document.createElementNS(svg.namespaceURI, "rect");
        for (const [key, value] of Object.entries({ x, y, width, height, fill: palette[color] })) node.setAttribute(key, String(value));
        if (color === "hat") node.classList.add("wizard-clothing");
        if (color === "edge") node.classList.add("wizard-clothing-trim");
        if (color === "eye") node.classList.add("wizard-working-eye");
        if (color === "skin" && width === 4 && height === 4) node.classList.add("wizard-face");
        if (color === "pot" || color === "potion") node.classList.add("wizard-cauldron");
        if (color === "wand") node.classList.add("wizard-stirrer");
        parent.append(node);
      };
      const worker = role === "worker"; const x = worker ? 1 : 4;
      for (const [dx, y, width, height, color] of [
        [1, 1, 2, 1, "edge"], [0, 2, 4, 1, "hat"], [-1, 3, 6, 1, "hat"], [-2, 4, 8, 1, "edge"],
        [0, 5, 4, 4, "skin"], [-1, 5, 1, 3, "hair"], [4, 5, 1, 2, "hair"], [1, 6, 1, 1, "eye"],
        [3, 6, 1, 1, "eye"], [2, 8, 1, 1, "hair"], [0, 9, 4, 4, "hat"], [-1, 11, 6, 3, "hat"],
        [0, 14, 2, 1, "outline"], [3, 14, 2, 1, "outline"], [1, 10, 1, 3, "edge"],
      ]) rect(svg, x + dx, y, width, height, color);
      svg.dataset.facing = "front";
      for (const [left, top, width, height, color] of worker ? [
        [7, 11, 8, 1, "rim"], [8, 12, 6, 1, "potion"], [8, 13, 6, 2, "pot"], [9, 15, 4, 1, "pot"],
        [6, 12, 1, 1, "rim"], [15, 12, 1, 1, "rim"],
      ] : [
        [1, 10, 3, 4, "book"], [4, 11, 1, 3, "outline"], [5, 10, 3, 4, "book"],
        [2, 11, 1, 2, "paper"], [6, 11, 1, 2, "paper"], [8, 10, 2, 1, "hat"],
      ]) rect(svg, left, top, width, height, color);
      for (let frame = 0; frame < 4; frame++) {
        const group = document.createElementNS(svg.namespaceURI, "g"); group.classList.add("pixel-wizard-frame"); group.dataset.frame = String(frame);
        if (worker) {
          const offset = [0, 1, 2, 1][frame];
          rect(group, 8 + offset, 8, 1, 5, "wand"); rect(group, 5, 9, 3 + offset, 1, "hat");
          rect(group, 7 + offset, 9, 1, 1, "skin"); rect(group, 10 + frame % 2, 12, 1, 1, "paper");
          if (frame === 1 || frame === 2) rect(group, 13, 9 - frame % 2, 1, 1, "potion");
        } else {
          const up = frame === 1 || frame === 2;
          rect(group, 10, up ? 8 : 9, 1, 2, "skin"); rect(group, 11, up ? 6 : 7, 1, 3, "wand");
          rect(group, 12, up ? 5 : 6, 1, 1, "book");
          if (frame === 2) { rect(group, 13, 4, 1, 1, "paper"); rect(group, 14, 5, 1, 1, "book"); }
        }
        svg.append(group);
      }
      icon.append(svg); wizardTemplates.set(role, icon);
    }
    return applyClothingRole(wizardTemplates.get(role).cloneNode(true), clothingRole);
  };
  const terminalWizard = state => {
    if (state === "paused" || state === "stopped") {
      const icon = window.PkmChatWorkingIcon("worker");
      icon.classList.add("chat-terminal-wizard", "wizard-held", "chat-role-still");
      delete icon.dataset.chatRole;
      for (const eye of icon.querySelectorAll(".wizard-working-eye")) eye.classList.add("wizard-eye");
      const svg = icon.querySelector("svg");
      const artwork = document.createElementNS(svg.namespaceURI, "g");
      artwork.setAttribute("transform", "scale(1.5)");
      artwork.append(...svg.children); svg.append(artwork);
      svg.setAttribute("viewBox", "0 0 24 24");
      return icon;
    }
    const icon = document.createElement("span"); icon.className = `chat-role-icon chat-terminal-wizard ${state === "completed" ? "wizard-sleeping" : state === "failed" ? "wizard-sooty" : "wizard-on-break"}`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("pixel-wizard");
    const rect = (x, y, width, height, color, className, parent = svg) => {
      const node = document.createElementNS(svg.namespaceURI, "rect");
      for (const [key, value] of Object.entries({ x, y, width, height, fill:color })) node.setAttribute(key, String(value));
      if (className) node.setAttribute("class", className);
      if (color === "#9983ce") node.classList.add("wizard-clothing");
      if (color === "#c8b4ef") node.classList.add("wizard-clothing-trim");
      parent.append(node);
    };
    if (state === "completed") {
      svg.dataset.facing = "side";
      rect(3, 16, 8, 3, "#9983ce"); rect(5, 18, 10, 1, "#c8b4ef");
      rect(7, 8, 2, 2, "#c8b4ef"); rect(5, 10, 5, 2, "#9983ce"); rect(4, 12, 9, 1, "#c8b4ef");
      rect(8, 13, 6, 4, "#f6ceaa", "wizard-face"); rect(7, 13, 2, 4, "#795440");
      rect(14, 15, 1, 1, "#f6ceaa"); rect(11, 15, 2, 1, "#493649");
      rect(2, 19, 18, 2, "#996d48", "wizard-desk"); rect(3, 21, 2, 3, "#795440"); rect(17, 21, 2, 3, "#795440");
      const snores = document.createElementNS(svg.namespaceURI, "g"); snores.classList.add("wizard-zzz");
      for (const [index, letter] of [..."zZZ"].entries()) {
        const text = document.createElementNS(svg.namespaceURI, "text");
        text.setAttribute("x", String(6 + index * 3)); text.setAttribute("y", String(11 - index * 3));
        text.setAttribute("class", "wizard-snore"); text.style.animationDelay = `${index * -.6}s`; text.textContent = letter; snores.append(text);
      }
      svg.append(snores);
    } else if (["paused", "stopped", "idle", "waiting-input", "waiting-result"].includes(state)) {
      svg.dataset.facing = "front";
      const resting = document.createElementNS(svg.namespaceURI, "g");
      resting.classList.add("wizard-break-breathe"); svg.append(resting);
      for (const [x, y, width, height, color, className] of [
        [8, 2, 2, 2, "#c8b4ef"], [6, 4, 6, 3, "#9983ce"], [4, 7, 12, 2, "#c8b4ef"],
        [7, 9, 7, 6, "#f6ceaa", "wizard-face"], [6, 9, 1, 5, "#795440"],
        [8, 11, 1, 1, "#493649", "wizard-eye"], [11, 11, 1, 1, "#493649", "wizard-eye"],
        [9, 14, 3, 1, "#795440"], [7, 16, 8, 5, "#9983ce"], [9, 17, 1, 3, "#c8b4ef"],
        [6, 21, 4, 1, "#30273f"], [12, 21, 4, 1, "#30273f"], [13, 16, 3, 2, "#f6ceaa"],
      ]) rect(x, y, width, height, color, className, resting);
      if (["idle", "waiting-input", "waiting-result"].includes(state)) {
        icon.classList.remove("wizard-on-break"); icon.classList.add(`wizard-${state}`);
        if (state === "waiting-input") {
          const hand = document.createElementNS(svg.namespaceURI, "g"); hand.classList.add("wizard-wave"); svg.append(hand);
          rect(15, 8, 2, 7, "#9983ce", undefined, hand); rect(15, 5, 2, 3, "#f6ceaa", undefined, hand);
          rect(17, 6, 1, 2, "#f6ceaa", undefined, hand);
        } else if (state === "waiting-result") {
          const glass = document.createElementNS(svg.namespaceURI, "g"); glass.classList.add("wizard-hourglass"); svg.append(glass);
          rect(16, 8, 6, 1, "#e4ce8c", "wizard-hourglass-cap", glass); rect(16, 17, 6, 1, "#e4ce8c", "wizard-hourglass-cap", glass);
          rect(17, 9, 1, 3, "#d2dfeb", undefined, glass); rect(20, 9, 1, 3, "#d2dfeb", undefined, glass);
          rect(18, 12, 2, 2, "#d2dfeb", undefined, glass); rect(17, 14, 1, 3, "#d2dfeb", undefined, glass);
          rect(20, 14, 1, 3, "#d2dfeb", undefined, glass);
          rect(18, 9, 2, 1, "#e4ce8c", "wizard-sand", glass);
        }
        icon.append(svg); return icon;
      }
      const cup = document.createElementNS(svg.namespaceURI, "g"); cup.classList.add("wizard-break-cup"); resting.append(cup);
      rect(15, 15, 5, 4, "#e4ce8c", undefined, cup); rect(16, 15, 3, 1, "#795440", undefined, cup);
      rect(20, 16, 2, 2, "#e4ce8c", undefined, cup); rect(14, 19, 7, 1, "#c8b4ef", undefined, cup);
      for (let index = 0; index < 2; index++) {
        const steam = document.createElementNS(svg.namespaceURI, "g");
        steam.classList.add("wizard-break-steam"); steam.style.animationDelay = `${index * -1.2}s`; svg.append(steam);
        rect(16 + index * 2, 11 - index, 1, 2, "#b8b0c9", undefined, steam);
      }
    } else {
      svg.dataset.facing = "front";
      const held = terminalWizard("stopped").querySelector("svg");
      held.querySelector(".wizard-face").setAttribute("fill", "#39333d");
      for (const eye of held.querySelectorAll(".wizard-eye")) eye.setAttribute("fill", "#fff");
      const aftermath = document.createElementNS(svg.namespaceURI, "g"); aftermath.classList.add("wizard-failure-aftermath");
      aftermath.append(...held.children); svg.append(aftermath);
      const stirring = document.createElementNS(svg.namespaceURI, "g"); stirring.classList.add("wizard-failure-stir");
      const worker = window.PkmChatWorkingIcon("worker").querySelector("svg");
      worker.setAttribute("width", "24"); worker.setAttribute("height", "24");
      worker.classList.remove("pixel-wizard"); stirring.append(worker); svg.prepend(stirring);
      const blast = document.createElementNS(svg.namespaceURI, "g"); blast.classList.add("wizard-failure-blast");
      for (const [x, y, width, height, color] of [
        [7, 5, 10, 15, "#ef9b45"], [3, 9, 18, 8, "#ef9b45"],
        [5, 7, 14, 12, "#f4c15d"], [8, 9, 9, 7, "#fff0c8"],
        [2, 4, 2, 2, "#e4ce8c"], [19, 3, 2, 3, "#e4ce8c"], [21, 19, 2, 2, "#ef9b45"],
      ]) rect(x, y, width, height, color, undefined, blast);
      svg.append(blast);
    }
    icon.append(svg); return icon;
  };
  window.PkmChatStatusLabel = (value, role) => {
    const labels = { running: 'Running', stopped: 'Stopped', failed: 'Failed', completed: 'Completed', 'awaiting-input': 'Waiting for Input', 'awaiting-result': 'Waiting for delegated result', 'new-result': 'Completed: unread result', paused: 'Paused', idle: 'Idle' };
    return `${role ? `${t(({ manager:"Manager", worker:"Worker", controller:"Controller", controlled:"Controlled" })[role] || role)} · ` : ""}${t(labels[value] || 'Idle')}`;
  };
  window.PkmChatStatusIndicator = (value, role, clothingRole = role) => {
    const state = value === 'awaiting-input' ? 'waiting-input' : value === 'awaiting-result' ? 'waiting-result' : value === 'new-result' ? 'completed' : ['running', 'stopped', 'paused', 'failed', 'completed'].includes(value) ? value : 'idle';
    const node = state === "running" ? window.PkmChatWorkingIcon(role, clothingRole) : terminalWizard(value === "new-result" ? "stopped" : state === "idle" ? "completed" : state);
    applyClothingRole(node, clothingRole);
    if (state === "idle") {
      node.classList.add("wizard-idle");
    }
    if (value === "new-result") node.dataset.unread = "true";
    if (state !== "running" && ["controller", "controlled"].includes(role)) {
      const svg = node.querySelector("svg");
      const artwork = document.createElementNS(svg.namespaceURI, "g");
      artwork.setAttribute("transform", role === "controller" ? "translate(8 0)" : "translate(0 0)");
      artwork.append(...svg.children); svg.append(artwork);
      svg.setAttribute("viewBox", "0 0 32 24");
      const portal = window.PkmChatPortalIcon(true, role, false).querySelector("svg");
      const ring = document.createElementNS(svg.namespaceURI, "g");
      ring.classList.add("portal-status-ring");
      ring.setAttribute("transform", `translate(${role === "controller" ? -8 : 16} 4)`);
      ring.append(...portal.children); svg.prepend(ring);
      node.classList.add("portal-status-scene");
    }
    node.classList.add('chat-status-indicator'); node.removeAttribute('aria-hidden'); node.dataset.state = state;
    if (role) node.dataset.chatRole = role;
    if (role && state !== 'running') node.classList.add("chat-role-still");
    const label = window.PkmChatStatusLabel(value, role);
    node.setAttribute('title', label); node.setAttribute('role', 'img'); node.setAttribute('aria-label', label);
    if (node.namespaceURI === 'http://www.w3.org/2000/svg') { const title = document.createElementNS(node.namespaceURI, 'title'); title.textContent = label; node.append(title); }
    return node;
  };
  window.PkmChatLibrary = ({ post, save, saved, configureCredits }) => {
    const root = document.getElementById("chat-list");
    const collapsed = new Set(saved.collapsedChatGroups || []);
    const expandedWorkers = new Set(saved.expandedWorkerChats || []);
    const order = [...(saved.chatListOrder || [])];
    const rows = new Map();
    const sections = new Map();
    let pickerGroups = [];
    let latestLibrary;
    let lastTraceSize;
    const active = chat => ["running", "awaiting-input", "awaiting-result"].includes(window.PkmChatDisplayStatus(chat));
    const reconcile = (parent, children) => {
      for (const [index, child] of children.entries()) if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
      while (parent.children.length > children.length) parent.lastElementChild.remove();
    };
    let menu;
    let menuOrigin;
    const closeMenu = () => { if (!menu) return; menu.remove(); menu = undefined; if (menuOrigin?.isConnected) menuOrigin.focus({ preventScroll: true }); };
    const button = (icon, label, action) => {
      const node = document.createElement("button"); node.type = "button"; node.title = t(label); node.setAttribute("aria-label", t(label));
      const glyph = document.createElement("span"); glyph.className = `codicon codicon-${icon}`; glyph.setAttribute("aria-hidden", "true");
      node.append(glyph); node.onclick = event => { event.stopPropagation(); action(event); }; return node;
    };
    const openMenu = (event, actions) => {
      event.preventDefault(); event.stopPropagation(); closeMenu();
      menuOrigin = document.activeElement;
      menu = document.createElement("div"); menu.className = "chat-list-menu"; menu.setAttribute("role", "menu");
      for (const [label, action] of actions) {
        const item = document.createElement("button"); item.textContent = t(label); item.setAttribute("role", "menuitem");
        item.onclick = () => { closeMenu(); action(); }; menu.append(item);
      }
      document.body.append(menu);
      menu.onkeydown = event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(menu.children); const current = items.indexOf(document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      };
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - bounds.width))}px`;
      menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - bounds.height))}px`;
      menu.firstElementChild?.focus();
    };
    document.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
    document.getElementById("list-new").onclick = () => post("new");
    document.getElementById("group-new").onclick = () => post("groupCreate");
    const controller = {
      collapsed,
      order,
      expandedWorkers,
      get pickerGroups() { return pickerGroups; },
      render(library) {
        if (!library) return;
        const renderStarted = performance.now();
        const trace = lastTraceSize !== library.chats.length;
        if (trace) post("chatListRender", { params: { phase: "started", chats: library.chats.length } });
        latestLibrary = library;
        const scroll = root.scrollTop;
        const ids = new Set(library.chats.map(chat => chat.id));
        for (let index = order.length - 1; index >= 0; index--) if (!ids.has(order[index])) order.splice(index, 1);
        const known = new Set(order);
        const fresh = library.chats.filter(chat => !known.has(chat.id)).map(chat => chat.id);
        order.unshift(...fresh);
        const rank = new Map(order.map((id, index) => [id, index]));
        const byId = new Map(library.chats.map(chat => [chat.id, chat]));
        const cyclicAncestry = new Map();
        for (const chat of library.chats) {
          if (cyclicAncestry.has(chat.id)) continue;
          const trail = [], seen = new Set();
          let ancestor = chat;
          while (ancestor && !cyclicAncestry.has(ancestor.id) && !seen.has(ancestor.id)) {
            trail.push(ancestor.id); seen.add(ancestor.id);
            ancestor = byId.get(ancestor.workerParentChatId);
          }
          const cyclic = !!ancestor && (seen.has(ancestor.id) || cyclicAncestry.get(ancestor.id));
          for (const id of trail) cyclicAncestry.set(id, cyclic);
        }
        const parents = new Map();
        for (const chat of library.chats) {
          const candidate = byId.get(chat.workerParentChatId);
          if (candidate && !candidate.trashedAt && !chat.trashedAt && candidate.workerTreeId === chat.workerTreeId
            && candidate.id !== chat.id && !cyclicAncestry.get(chat.id)) parents.set(chat.id, candidate);
        }
        const parent = chat => {
          return parents.get(chat.id);
        };
        const children = new Map();
        for (const chat of library.chats) {
          const manager = parent(chat);
          if (manager) { if (!children.has(manager.id)) children.set(manager.id, []); children.get(manager.id).push(chat); }
        }
        const subtreeActive = new Map(library.chats.map(chat => [chat.id, active(chat)]));
        const pendingChildren = new Map(library.chats.map(chat => [chat.id, children.get(chat.id)?.length || 0]));
        const leaves = library.chats.filter(chat => !pendingChildren.get(chat.id));
        for (let index = 0; index < leaves.length; index++) {
          const chat = leaves[index], manager = parent(chat);
          if (!manager) continue;
          if (subtreeActive.get(chat.id)) subtreeActive.set(manager.id, true);
          const remaining = pendingChildren.get(manager.id) - 1;
          pendingChildren.set(manager.id, remaining);
          if (!remaining) leaves.push(manager);
        }
        const sorted = chats => [...chats].sort((left, right) => Number(subtreeActive.get(right.id)) - Number(subtreeActive.get(left.id)) || rank.get(left.id) - rank.get(right.id));
        for (const [id, descendants] of children) children.set(id, sorted(descendants));
        const buildRow = chat => {
          const trash = !!chat.trashedAt;
          let cached = rows.get(chat.id);
          if (!cached) {
            const node = document.createElement("div"); node.className = "chat-list-node"; node.dataset.nodeChatId = chat.id;
            const row = document.createElement("div"); row.className = "chat-list-row";
            const open = document.createElement("button"); open.className = "chat-list-open"; open.dataset.chatId = chat.id;
            const name = document.createElement("strong");
            open.onclick = () => post("select", { id: chat.id });
            row.ondragstart = event => { event.dataTransfer.setData("application/x-pkm-chat-id", chat.id); event.dataTransfer.effectAllowed = "move"; };
            const menuActions = event => {
              const current = byId.get(chat.id);
              const actions = current.trashedAt ? [["Restore Chat", () => post("restoreChat", { id: chat.id })], ["Delete permanently", () => post("deleteChat", { id: chat.id })]]
                : [["Open Chat", () => open.click()], ["Rename chat", () => post("rename", { id: chat.id })], ...(configureCredits ? [["Credit limit", () => configureCredits({ chatId: chat.id })]] : []), ...(!parent(current) ? [["Move to group...", () => post("moveChat", { id: chat.id })]] : []), ["Move to Trash", () => post("trashChat", { id: chat.id })]];
              actions.push(["Copy PKM URL", () => post("copyChatId", { id: chat.id })]); openMenu(event, actions);
            };
            const toggle = button("chevron-right", "Workers", () => {
              expandedWorkers.has(chat.id) ? expandedWorkers.delete(chat.id) : expandedWorkers.add(chat.id);
              controller.render(latestLibrary); save();
            });
            toggle.className = "chat-list-workers-toggle"; toggle.setAttribute("aria-controls", `worker-children-${chat.id}`);
            const count = document.createElement("span"); toggle.append(count);
            const childList = document.createElement("div"); childList.className = "chat-list-children"; childList.id = `worker-children-${chat.id}`;
            const actionsButton = button("ellipsis", "Chat actions", event => cached.menuActions(event));
            row.oncontextmenu = event => cached.menuActions(event);
            row.append(open, toggle, actionsButton); node.append(row, childList);
            cached = { node, row, open, name, toggle, count, children: childList, menuActions }; rows.set(chat.id, cached);
          }
          const indicator = cached.open.querySelector(".chat-status-indicator");
          const clothingRole = window.PkmChatClothingRole(chat) || (children.has(chat.id) ? "manager" : undefined);
          const role = window.PkmChatRole(chat) || clothingRole;
          const displayStatus = window.PkmChatDisplayStatus(chat);
          const key = `${displayStatus}:${role}:${clothingRole}:${trash}:${document.documentElement.lang}`;
          if (cached.statusKey !== key) {
            const status = window.PkmChatStatusIndicator(displayStatus, role, clothingRole);
            if (trash) { status.title = t("In Trash"); status.setAttribute("aria-label", t("In Trash")); }
            if (indicator) indicator.replaceWith(status); else cached.open.prepend(status);
            cached.statusKey = key;
          }
          if (!cached.name.isConnected) cached.open.append(cached.name);
          cached.name.textContent = chat.title;
          cached.open.disabled = trash;
          cached.row.draggable = !trash && !parent(chat);
          cached.menuActions = event => {
            const actions = trash ? [["Restore Chat", () => post("restoreChat", { id: chat.id })], ["Delete permanently", () => post("deleteChat", { id: chat.id })]]
              : [["Open Chat", () => cached.open.click()], ["Rename chat", () => post("rename", { id: chat.id })], ...(configureCredits ? [["Credit limit", () => configureCredits({ chatId: chat.id })]] : []), ...(!parent(chat) ? [["Move to group...", () => post("moveChat", { id: chat.id })]] : []), ["Move to Trash", () => post("trashChat", { id: chat.id })]];
            actions.push(["Copy PKM URL", () => post("copyChatId", { id: chat.id })]); openMenu(event, actions);
          };
          const descendants = children.get(chat.id) || [];
          cached.toggle.hidden = !descendants.length;
          cached.toggle.title = `${t("Workers")}: ${descendants.length}`;
          cached.count.textContent = String(descendants.length);
          cached.toggle.setAttribute("aria-expanded", String(expandedWorkers.has(chat.id)));
          cached.children.hidden = !expandedWorkers.has(chat.id);
          return cached.node;
        };
        const buildVisibleRows = chats => {
          const pending = chats.map(chat => ({ chat, visited: false })).reverse();
          while (pending.length) {
            const item = pending.pop(), chat = item.chat;
            if (!item.visited) {
              buildRow(chat);
              pending.push({ chat, visited: true });
              if (expandedWorkers.has(chat.id)) {
                const descendants = children.get(chat.id) || [];
                for (let index = descendants.length - 1; index >= 0; index--) pending.push({ chat: descendants[index], visited: false });
              }
            } else {
              const descendants = expandedWorkers.has(chat.id) ? children.get(chat.id) || [] : [];
              reconcile(rows.get(chat.id).children, descendants.map(child => rows.get(child.id).node));
            }
          }
          return chats.map(chat => rows.get(chat.id).node);
        };
        const groups = [{ id: "ungroup", name: "Ungroup" }, ...library.groups, { id: "trash", name: "Trash" }];
        const renderedSections = [];
        pickerGroups = [];
        for (const group of groups) {
          const trash = group.id === "trash";
          const chats = sorted(library.chats.filter(chat => trash ? chat.trashedAt : !chat.trashedAt && !parent(chat) && chat.groupId === group.id));
          if (!trash && chats.length) {
            const entries = [];
            const pending = chats.map(chat => ({ chat, depth: 0, path: chat.title })).reverse();
            while (pending.length) {
              const item = pending.pop();
              entries.push(item);
              const descendants = children.get(item.chat.id) || [];
              for (let index = descendants.length - 1; index >= 0; index--) {
                const chat = descendants[index];
                pending.push({ chat, depth: item.depth + 1, path: `${item.path} / ${chat.title}` });
              }
            }
            pickerGroups.push({ name: group.id === "ungroup" ? t(group.name) : group.name, entries });
          }
          let section = sections.get(group.id);
          if (!section) { section = document.createElement("details"); sections.set(group.id, section); }
          section.className = `chat-list-group${trash ? " chat-list-trash" : ""}`; section.dataset.groupId = group.id; section.open = !collapsed.has(group.id);
          const summary = document.createElement("summary");
          const icon = document.createElement("span"); icon.className = `codicon codicon-${trash ? "trash" : "folder"}`;
          const title = document.createElement("span"); title.className = "chat-list-group-name"; title.textContent = ["ungroup", "trash"].includes(group.id) ? t(group.name) : group.name;
          const count = document.createElement("span"); count.className = "chat-list-count"; count.textContent = String(chats.length + (trash ? library.deletionCleanups?.length || 0 : 0));
          summary.append(icon, title, count);
          if (!trash) {
            const add = button("add", "New Chat", () => post("new", { groupId: group.id }));
            add.className = "chat-group-add";
            add.setAttribute("aria-label", `${t("New Chat")}: ${title.textContent}`);
            summary.append(add);
          }
          if (trash) {
            const empty = button("clear-all", "Delete All", () => post("emptyTrash"));
            empty.className = "chat-trash-delete-all"; empty.append(document.createTextNode(t("Delete All")));
            empty.disabled = !chats.length && !library.deletionCleanups?.length; summary.append(empty);
          } else {
            const actions = [...(configureCredits ? [["Credit limit", () => configureCredits({ groupId: group.id })]] : []), ["Copy Path", () => post("copyChatGroupPath", { id: group.id })],
              ...(group.id === "ungroup" ? [] : [["Rename group", () => post("groupRename", { id: group.id })], ["Delete group", () => post("groupDelete", { id: group.id })]])];
            summary.append(button("ellipsis", "Group actions", event => openMenu(event, actions)));
            summary.oncontextmenu = event => openMenu(event, actions);
          }
          const oldSummary = section.firstElementChild;
          if (oldSummary) oldSummary.replaceWith(summary); else section.append(summary);
          section.ontoggle = () => {
            if (!section.isConnected) return;
            const changed = collapsed.has(group.id) === section.open;
            section.open ? collapsed.delete(group.id) : collapsed.add(group.id);
            if (changed) controller.render(latestLibrary);
            save();
          };
          section.ondragover = event => { if (Array.from(event.dataTransfer.types).includes("application/x-pkm-chat-id")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } };
          section.ondrop = event => {
            event.preventDefault(); const id = event.dataTransfer.getData("application/x-pkm-chat-id");
            if (library.chats.some(chat => chat.id === id && !chat.trashedAt && !parent(chat))) post(trash ? "trashChat" : "moveChat", { id, value: group.id });
          };
          const cleanups = trash ? (library.deletionCleanups || []).map(item => {
            const row = document.createElement("div"); row.className = "chat-list-row"; row.dataset.deletionCleanup = item.id;
            const label = document.createElement("span");
            label.textContent = `${item.title} - ${t("Permanently deleted; cleanup pending. Cannot restore.")}`;
            const retry = document.createElement("button"); retry.type = "button";
            retry.textContent = t("Retry deletion cleanup"); retry.onclick = () => post("deleteChat", { id: item.id });
            row.append(label, retry);
            return row;
          }) : [];
          reconcile(section, [summary, ...(section.open ? buildVisibleRows(chats) : []), ...(section.open ? cleanups : [])]); renderedSections.push(section);
        }
        reconcile(root, renderedSections);
        for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
        for (const id of sections.keys()) if (!groups.some(group => group.id === id)) sections.delete(id);
        root.scrollTop = scroll;
        const elapsedMs = Math.round(performance.now() - renderStarted);
        if (trace || elapsedMs >= 100) post("chatListRender", { params: { phase: "completed", chats: library.chats.length, elapsedMs } });
        lastTraceSize = library.chats.length;
        if (fresh.length) save();
      },
    };
    return controller;
  };
})();