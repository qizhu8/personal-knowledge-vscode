(() => {
  const t = text => globalThis.PkmChatText?.(text) || text;
  window.PkmChatRole = chat => chat?.portal?.binding?.role || (chat?.workerManager || chat?.manager || chat?.messages?.some(message => message.delegations?.length)
    ? "manager" : chat?.workerParentChatId || chat?.workerState?.parentChatId || chat?.parentChatId ? "worker" : undefined);
  const wizardTemplates = new Map();
  const portalTemplates = new Map();
  // Controller: blue Portal ring on the left, side-profile wizard on the right facing it.
  // Controlled: wizard on the left with its back to the ring on the right. Closed: a dashed ring only.
  window.PkmChatPortalIcon = (connected, role, showWizard = true) => {
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
    return portalTemplates.get(key).cloneNode(true);
  };
  window.PkmChatWorkingIcon = role => {
    if (role === "controller" || role === "controlled") {
      const icon = window.PkmChatPortalIcon(true, role);
      icon.classList.add("chat-role-icon"); icon.dataset.chatRole = role;
      return icon;
    }
    if (!["manager", "worker"].includes(role)) return document.getElementById("working-cauldron-template").content.firstElementChild.cloneNode(true);
    if (!wizardTemplates.has(role)) {
      const icon = document.createElement("span"); icon.className = "chat-role-icon"; icon.dataset.chatRole = role;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false"); svg.classList.add("pixel-wizard");
      const palette = { outline: "#30273f", hat: "#9983ce", edge: "#c8b4ef", skin: "#f6ceaa", hair: "#795440",
        eye: "#3a3040", book: "#e4ce8c", paper: "#fff0c8", pot: "#435366", rim: "#d2dfeb", potion: "#54cc8a", wand: "#c89355" };
      const rect = (parent, x, y, width, height, color) => {
        const node = document.createElementNS(svg.namespaceURI, "rect");
        for (const [key, value] of Object.entries({ x, y, width, height, fill: palette[color] })) node.setAttribute(key, String(value));
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
    return wizardTemplates.get(role).cloneNode(true);
  };
  const terminalWizard = state => {
    const icon = document.createElement("span"); icon.className = `chat-role-icon chat-terminal-wizard ${state === "completed" ? "wizard-sleeping" : "wizard-sooty"}`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("pixel-wizard");
    const rect = (x, y, width, height, color, className) => {
      const node = document.createElementNS(svg.namespaceURI, "rect");
      for (const [key, value] of Object.entries({ x, y, width, height, fill:color })) node.setAttribute(key, String(value));
      if (className) node.setAttribute("class", className);
      svg.append(node);
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
        text.setAttribute("x", String(14 + index * 3)); text.setAttribute("y", String(11 - index * 3));
        text.setAttribute("class", "wizard-snore"); text.style.animationDelay = `${index * -.6}s`; text.textContent = letter; snores.append(text);
      }
      svg.append(snores);
    } else {
      svg.dataset.facing = "front";
      rect(9, 5, 2, 2, "#c8b4ef"); rect(7, 7, 6, 3, "#9983ce"); rect(5, 10, 11, 2, "#c8b4ef");
      rect(7, 12, 7, 6, "#39333d", "wizard-face"); rect(6, 12, 1, 5, "#795440");
      rect(8, 14, 2, 2, "#fff", "wizard-eye"); rect(11, 14, 2, 2, "#fff", "wizard-eye");
      rect(9, 17, 3, 1, "#bbb2bd"); rect(7, 19, 8, 3, "#9983ce");
    }
    icon.append(svg); return icon;
  };
  window.PkmChatStatusIndicator = (value, role) => {
    const labels = { running: 'Running', stopped: 'Stopped', failed: 'Failed', completed: 'Completed', 'awaiting-input': 'Waiting for Input', 'awaiting-result': 'Waiting for delegated result', 'new-result': 'Completed: unread result', paused: 'Paused', idle: 'Idle' };
    const state = value === 'awaiting-input' ? 'waiting-input' : value === 'awaiting-result' ? 'waiting-result' : value === 'new-result' ? 'completed' : value === 'paused' ? 'stopped' : ['running', 'stopped', 'failed', 'completed'].includes(value) ? value : 'idle';
    const node = ["completed", "failed"].includes(state) ? terminalWizard(state)
      : role || state === 'running' ? window.PkmChatWorkingIcon(role) : document.createElement('span');
    node.classList.add('chat-status-indicator'); node.removeAttribute('aria-hidden'); node.dataset.state = state;
    if (role) node.dataset.chatRole = role;
    if (role && state !== 'running') node.classList.add("chat-role-still");
    const label = `${role ? `${t(({ manager:"Manager", worker:"Worker", controller:"Controller", controlled:"Controlled" })[role] || role)} · ` : ""}${t(labels[value] || 'Idle')}`;
    node.setAttribute('title', label); node.setAttribute('role', 'img'); node.setAttribute('aria-label', label);
    if (node.namespaceURI === 'http://www.w3.org/2000/svg') { const title = document.createElementNS(node.namespaceURI, 'title'); title.textContent = label; node.append(title); }
    return node;
  };
  window.PkmChatLibrary = ({ post, showChat, save, saved }) => {
    const root = document.getElementById("chat-list");
    const collapsed = new Set(saved.collapsedChatGroups || []);
    const expandedWorkers = new Set(saved.expandedWorkerChats || []);
    const order = [...(saved.chatListOrder || [])];
    const rows = new Map();
    const sections = new Map();
    const active = chat => ["running", "awaiting-input", "awaiting-result"].includes(chat.status);
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
    document.getElementById("list-new").onclick = () => { showChat(); post("new"); };
    document.getElementById("group-new").onclick = () => post("groupCreate");
    return {
      collapsed,
      order,
      expandedWorkers,
      render(library) {
        if (!library) return;
        const scroll = root.scrollTop;
        const ids = new Set(library.chats.map(chat => chat.id));
        for (let index = order.length - 1; index >= 0; index--) if (!ids.has(order[index])) order.splice(index, 1);
        const known = new Set(order);
        const fresh = library.chats.filter(chat => !known.has(chat.id)).map(chat => chat.id);
        order.unshift(...fresh);
        const rank = new Map(order.map((id, index) => [id, index]));
        const byId = new Map(library.chats.map(chat => [chat.id, chat]));
        const parent = chat => {
          const candidate = byId.get(chat.workerParentChatId);
          if (!candidate || candidate.trashedAt || chat.trashedAt || candidate.workerTreeId !== chat.workerTreeId || candidate.id === chat.id) return undefined;
          const seen = new Set([chat.id]);
          let ancestor = candidate;
          while (ancestor) {
            if (seen.has(ancestor.id)) return undefined;
            seen.add(ancestor.id); ancestor = byId.get(ancestor.workerParentChatId);
          }
          return candidate;
        };
        const children = new Map();
        for (const chat of library.chats) {
          const manager = parent(chat);
          if (manager) { if (!children.has(manager.id)) children.set(manager.id, []); children.get(manager.id).push(chat); }
        }
        const isActive = chat => active(chat) || (children.get(chat.id) || []).some(isActive);
        const sorted = chats => [...chats].sort((left, right) => Number(isActive(right)) - Number(isActive(left)) || rank.get(left.id) - rank.get(right.id));
        const buildRow = chat => {
          const trash = !!chat.trashedAt;
          let cached = rows.get(chat.id);
          if (!cached) {
            const node = document.createElement("div"); node.className = "chat-list-node"; node.dataset.nodeChatId = chat.id;
            const row = document.createElement("div"); row.className = "chat-list-row";
            const open = document.createElement("button"); open.className = "chat-list-open"; open.dataset.chatId = chat.id;
            const name = document.createElement("strong");
            open.onclick = () => { showChat(); post("select", { id: chat.id }); };
            row.ondragstart = event => { event.dataTransfer.setData("application/x-pkm-chat-id", chat.id); event.dataTransfer.effectAllowed = "move"; };
            const menuActions = event => {
              const current = byId.get(chat.id);
              const actions = current.trashedAt ? [["Restore Chat", () => post("restoreChat", { id: chat.id })], ["Delete permanently", () => post("deleteChat", { id: chat.id })]]
                : [["Open Chat", () => open.click()], ["Rename chat", () => post("rename", { id: chat.id })], ...(!parent(current) ? [["Move to group...", () => post("moveChat", { id: chat.id })]] : []), ["Move to Trash", () => post("trashChat", { id: chat.id })]];
              actions.push(["Copy PKM URL", () => post("copyChatId", { id: chat.id })]); openMenu(event, actions);
            };
            const toggle = button("chevron-right", "Workers", () => {
              expandedWorkers.has(chat.id) ? expandedWorkers.delete(chat.id) : expandedWorkers.add(chat.id);
              cached.children.hidden = !expandedWorkers.has(chat.id);
              cached.toggle.setAttribute("aria-expanded", String(expandedWorkers.has(chat.id))); save();
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
          const role = chat.portal?.binding?.role || (children.has(chat.id) ? "manager" : window.PkmChatRole(chat));
          const key = `${chat.status}:${role}:${trash}:${document.documentElement.lang}`;
          if (cached.statusKey !== key) {
            const status = window.PkmChatStatusIndicator(chat.status, role);
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
              : [["Open Chat", () => cached.open.click()], ["Rename chat", () => post("rename", { id: chat.id })], ...(!parent(chat) ? [["Move to group...", () => post("moveChat", { id: chat.id })]] : []), ["Move to Trash", () => post("trashChat", { id: chat.id })]];
            actions.push(["Copy PKM URL", () => post("copyChatId", { id: chat.id })]); openMenu(event, actions);
          };
          const descendants = sorted(children.get(chat.id) || []);
          cached.toggle.hidden = !descendants.length;
          cached.toggle.title = `${t("Workers")}: ${descendants.length}`;
          cached.count.textContent = String(descendants.length);
          cached.toggle.setAttribute("aria-expanded", String(expandedWorkers.has(chat.id)));
          cached.children.hidden = !expandedWorkers.has(chat.id);
          reconcile(cached.children, descendants.map(buildRow));
          return cached.node;
        };
        const groups = [{ id: "ungroup", name: "Ungroup" }, ...library.groups, { id: "trash", name: "Trash" }];
        const renderedSections = [];
        for (const group of groups) {
          const trash = group.id === "trash";
          const chats = sorted(library.chats.filter(chat => trash ? chat.trashedAt : !chat.trashedAt && !parent(chat) && chat.groupId === group.id));
          let section = sections.get(group.id);
          if (!section) { section = document.createElement("details"); sections.set(group.id, section); }
          section.className = `chat-list-group${trash ? " chat-list-trash" : ""}`; section.dataset.groupId = group.id; section.open = !collapsed.has(group.id);
          const summary = document.createElement("summary");
          const icon = document.createElement("span"); icon.className = `codicon codicon-${trash ? "trash" : "folder"}`;
          const title = document.createElement("span"); title.className = "chat-list-group-name"; title.textContent = ["ungroup", "trash"].includes(group.id) ? t(group.name) : group.name;
          const count = document.createElement("span"); count.className = "chat-list-count"; count.textContent = String(chats.length);
          summary.append(icon, title, count);
          if (trash) {
            const empty = button("clear-all", "Delete All", () => post("emptyTrash"));
            empty.className = "chat-trash-delete-all"; empty.append(document.createTextNode(t("Delete All")));
            empty.disabled = !chats.length; summary.append(empty);
          } else if (group.id !== "ungroup") {
            const actions = [["Rename group", () => post("groupRename", { id: group.id })], ["Delete group", () => post("groupDelete", { id: group.id })]];
            summary.append(button("ellipsis", "Group actions", event => openMenu(event, actions)));
            summary.oncontextmenu = event => openMenu(event, actions);
          }
          const oldSummary = section.firstElementChild;
          if (oldSummary) oldSummary.replaceWith(summary); else section.append(summary);
          section.ontoggle = () => {
            if (!section.isConnected) return;
            section.open ? collapsed.delete(group.id) : collapsed.add(group.id); save();
          };
          section.ondragover = event => { if (Array.from(event.dataTransfer.types).includes("application/x-pkm-chat-id")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } };
          section.ondrop = event => {
            event.preventDefault(); const id = event.dataTransfer.getData("application/x-pkm-chat-id");
            if (library.chats.some(chat => chat.id === id && !chat.trashedAt && !parent(chat))) post(trash ? "trashChat" : "moveChat", { id, value: group.id });
          };
          reconcile(section, [summary, ...chats.map(buildRow)]); renderedSections.push(section);
        }
        reconcile(root, renderedSections);
        for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
        for (const id of sections.keys()) if (!groups.some(group => group.id === id)) sections.delete(id);
        root.scrollTop = scroll;
        if (fresh.length) save();
      },
    };
  };
})();