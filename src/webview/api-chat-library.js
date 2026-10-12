(() => {
  const t = text => globalThis.PkmChatText?.(text) || text;
  window.PkmChatStatusIndicator = value => {
    const labels = { running: 'Running', stopped: 'Stopped', failed: 'Failed', completed: 'Completed', 'awaiting-input': 'Waiting for Input', 'awaiting-result': 'Waiting for delegated result', 'new-result': 'Completed: unread result', paused: 'Paused', idle: 'Idle' };
    const state = value === 'awaiting-input' ? 'waiting-input' : value === 'awaiting-result' ? 'waiting-result' : value === 'new-result' ? 'completed' : value === 'paused' ? 'stopped' : ['running', 'stopped', 'failed', 'completed'].includes(value) ? value : 'idle';
    const node = state === 'running' ? document.getElementById('working-cauldron-template').content.firstElementChild.cloneNode(true) : document.createElement('span');
    node.classList.add('chat-status-indicator'); node.removeAttribute('aria-hidden'); node.dataset.state = state;
    const label = t(labels[value] || 'Idle'); node.setAttribute('title', label); node.setAttribute('role', 'img'); node.setAttribute('aria-label', label);
    if (state === 'running') { const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = label; node.append(title); }
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
          const key = `${chat.status}:${trash}:${document.documentElement.lang}`;
          if (cached.statusKey !== key) {
            const status = window.PkmChatStatusIndicator(chat.status);
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