(() => {
  const t = text => globalThis.PkmChatText?.(text) || text;
  window.PkmChatStatusIndicator = value => {
    const labels = { running: 'Running', stopped: 'Stopped', failed: 'Failed', 'awaiting-input': 'Waiting for Input', 'new-result': 'Idle: new result', paused: 'Idle: paused', idle: 'Idle' };
    const state = value === 'awaiting-input' ? 'waiting-input' : ['running', 'stopped', 'failed'].includes(value) ? value : 'idle';
    const node = document.createElement('span'); node.className = 'chat-status-indicator'; node.dataset.state = state;
    node.title = t(labels[value] || 'Idle'); node.setAttribute('role', 'img'); node.setAttribute('aria-label', node.title);
    return node;
  };
  window.PkmChatLibrary = ({ post, showChat, save, saved }) => {
    const root = document.getElementById("chat-list");
    const collapsed = new Set(saved.collapsedChatGroups || []);
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
      render(library) {
        if (!library) return;
        const focus = document.activeElement?.dataset?.chatId;
        const scroll = root.scrollTop;
        root.replaceChildren();
        const groups = [{ id: "ungroup", name: "Ungroup" }, ...library.groups, { id: "trash", name: "Trash" }];
        for (const group of groups) {
          const trash = group.id === "trash";
          const chats = library.chats.filter(chat => trash ? chat.trashedAt : !chat.trashedAt && chat.groupId === group.id);
          const section = document.createElement("details"); section.className = `chat-list-group${trash ? " chat-list-trash" : ""}`; section.dataset.groupId = group.id; section.open = !collapsed.has(group.id);
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
          section.append(summary);
          section.ontoggle = () => {
            if (!section.isConnected) return;
            section.open ? collapsed.delete(group.id) : collapsed.add(group.id); save();
          };
          section.ondragover = event => { if (Array.from(event.dataTransfer.types).includes("application/x-pkm-chat-id")) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } };
          section.ondrop = event => {
            event.preventDefault(); const id = event.dataTransfer.getData("application/x-pkm-chat-id");
            if (library.chats.some(chat => chat.id === id && !chat.trashedAt)) post(trash ? "trashChat" : "moveChat", { id, value: group.id });
          };
          for (const chat of chats) {
            const row = document.createElement("div"); row.className = "chat-list-row";
            const open = document.createElement("button"); open.className = "chat-list-open"; open.dataset.chatId = chat.id;
            const name = document.createElement("strong"); name.textContent = chat.title;
            const status = window.PkmChatStatusIndicator(chat.status);
            if (trash) { status.title = t('In Trash'); status.setAttribute('aria-label', t('In Trash')); }
            open.append(status, name); open.disabled = trash;
            open.onclick = () => { showChat(); post("select", { id: chat.id }); };
            row.draggable = !trash;
            row.ondragstart = event => { event.dataTransfer.setData("application/x-pkm-chat-id", chat.id); event.dataTransfer.effectAllowed = "move"; };
            const actions = trash ? [["Restore Chat", () => post("restoreChat", { id: chat.id })], ["Delete permanently", () => post("deleteChat", { id: chat.id })]]
              : [["Open Chat", () => open.click()], ["Move to group...", () => post("moveChat", { id: chat.id })], ["Move to Trash", () => post("trashChat", { id: chat.id })]];
            row.oncontextmenu = event => openMenu(event, actions);
            row.append(open, button("ellipsis", "Chat actions", event => openMenu(event, actions))); section.append(row);
          }
          root.append(section);
        }
        root.scrollTop = scroll;
        if (focus) Array.from(root.querySelectorAll("[data-chat-id]")).find(node => node.dataset.chatId === focus)?.focus({ preventScroll: true });
      },
    };
  };
})();