const pkmTableSortState = new Map();

function nextTableSortDirection(direction) {
  return direction === "ascending" ? "descending" : direction === "descending" ? "none" : "ascending";
}

function tableSortValue(cell) {
  const explicit = cell?.dataset?.sortValue;
  const text = String(explicit ?? cell?.textContent ?? "").trim();
  if (!text) return { rank: 3, value: "" };
  const numeric = Number(text.replaceAll(",", "").replace(/[%A-Za-z]+$/, ""));
  if (Number.isFinite(numeric)) return { rank: 0, value: numeric };
  const timestamp = Date.parse(text);
  if (/[0-9]/.test(text) && Number.isFinite(timestamp)) return { rank: 1, value: timestamp };
  return { rank: 2, value: text.toLocaleLowerCase() };
}

function compareTableValues(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.value < right.value) return -1;
  if (left.value > right.value) return 1;
  return 0;
}

function tableSortKey(table, headers) {
  if (table.dataset.sortKey) return table.dataset.sortKey;
  const classes = [...table.classList].filter(name => !["pk-table", "pkg-table"].includes(name)).join(".");
  return classes || headers.map(header => header.textContent.trim()).join("|");
}

function tableHeaderSortable(header) {
  if (header.dataset.sortable === "false" || Number(header.colSpan || 1) > 1) return false;
  const label = header.textContent.trim().toLocaleLowerCase();
  return !!label && !["action", "actions"].includes(label);
}

function applyTableSort(table, column, direction) {
  const body = table.tBodies[0];
  if (!body) return;
  const rows = [...body.rows];
  rows.forEach((row, index) => {
    if (row.dataset.canonicalOrder === undefined) row.dataset.canonicalOrder = String(index);
  });
  const ordered = direction === "none"
    ? rows.sort((left, right) => Number(left.dataset.canonicalOrder) - Number(right.dataset.canonicalOrder))
    : rows.sort((left, right) => {
      const compared = compareTableValues(tableSortValue(left.cells[column]), tableSortValue(right.cells[column]));
      return (direction === "descending" ? -compared : compared)
        || Number(left.dataset.canonicalOrder) - Number(right.dataset.canonicalOrder);
    });
  ordered.forEach(row => body.appendChild(row));
}

function enhanceSortableTable(table) {
  if (table.dataset.sortEnhanced === "true" || table.classList.contains("cmp-table")) return;
  const headers = [...(table.tHead?.rows[0]?.cells || [])];
  if (!headers.length || !table.tBodies.length) return;
  table.dataset.sortEnhanced = "true";
  const key = tableSortKey(table, headers);
  headers.forEach((header, column) => {
    if (!tableHeaderSortable(header)) {
      header.dataset.sortable = "false";
      return;
    }
    header.dataset.sortable = "true";
    header.tabIndex = 0;
    header.setAttribute("aria-sort", "none");
    const activate = () => {
      const current = pkmTableSortState.get(key);
      const direction = nextTableSortDirection(current?.column === column ? current.direction : "none");
      pkmTableSortState.set(key, { column, direction });
      headers.forEach(candidate => candidate.setAttribute("aria-sort", candidate === header ? direction : "none"));
      applyTableSort(table, column, direction);
    };
    header.addEventListener("click", activate);
    header.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  });
  const active = pkmTableSortState.get(key);
  if (active && headers[active.column]?.dataset.sortable === "true") {
    headers[active.column].setAttribute("aria-sort", active.direction);
    applyTableSort(table, active.column, active.direction);
  }
}

function enhanceSortableTables(root = document) {
  if (root instanceof HTMLTableElement) enhanceSortableTable(root);
  root.querySelectorAll?.("table").forEach(enhanceSortableTable);
}

new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) enhanceSortableTables(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

enhanceSortableTables();
