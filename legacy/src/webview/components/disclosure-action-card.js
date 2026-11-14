const template = document.createElement("template");

template.innerHTML = `
  <style>
    :host {
      --disclosure-card-background: transparent;
      --disclosure-card-background-active: var(--disclosure-card-background);
      --disclosure-card-border: currentColor;
      --disclosure-card-border-active: var(--disclosure-card-border);
      --disclosure-card-focus: var(--disclosure-card-border-active);
      --disclosure-card-muted: currentColor;
      --disclosure-card-radius: 4px;
      --disclosure-card-summary-min-height: 42px;
      --disclosure-card-padding: 6px 7px;
      --disclosure-card-action-gap: 4px;
      display: block;
      overflow: hidden;
      border: 1px solid var(--disclosure-card-border);
      border-radius: var(--disclosure-card-radius);
      background: var(--disclosure-card-background);
      transition: border-color .16s ease, background .16s ease, box-shadow .16s ease;
    }

    :host(:hover),
    :host(:focus-within),
    :host([expanded]),
    :host([selected]) {
      border-color: var(--disclosure-card-border-active);
      background: var(--disclosure-card-background-active);
    }

    :host(:focus) {
      outline: 1px solid var(--disclosure-card-focus);
      outline-offset: 1px;
    }

    :host([unavailable]) { opacity: .65; }

    .summary {
      display: flex;
      min-height: var(--disclosure-card-summary-min-height);
      align-items: center;
      gap: 7px;
      padding: var(--disclosure-card-padding);
    }

    .copy {
      display: flex;
      flex: 1;
      min-width: 0;
      flex-direction: column;
      gap: 2px;
    }

    .toggle {
      display: flex;
      flex: none;
      width: 20px;
      height: 20px;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--disclosure-card-muted);
      font: inherit;
      cursor: pointer;
    }

    .chevron {
      font-size: 12px;
      line-height: 1;
      transform: rotate(0);
      transition: transform .16s ease;
    }

    .actions {
      display: flex;
      visibility: hidden;
      max-height: 0;
      align-items: center;
      gap: var(--disclosure-card-action-gap);
      flex-wrap: wrap;
      overflow: hidden;
      padding: 0 7px;
      opacity: 0;
      transform: translateY(-4px);
      transition: max-height .2s ease, padding .2s ease, opacity .14s ease,
        transform .2s ease, visibility 0s linear .2s;
    }

    :host(:hover) .actions,
    :host(:focus-within) .actions,
    :host([expanded]) .actions {
      visibility: visible;
      max-height: 96px;
      padding: 0 7px 7px;
      opacity: 1;
      transform: translateY(0);
      transition-delay: 0s;
    }

    :host(:hover) .chevron,
    :host(:focus-within) .chevron,
    :host([expanded]) .chevron { transform: rotate(180deg); }

    slot[name="actions"] { display: contents; }
    ::slotted([slot="title"]), ::slotted([slot="description"]) {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @media (prefers-reduced-motion: reduce) {
      :host, .actions, .chevron { transition: none; }
    }
  </style>
  <div class="summary" part="summary">
    <slot name="primary-action"></slot>
    <slot name="leading"></slot>
    <span class="copy" part="copy">
      <slot name="title"></slot>
      <slot name="description"></slot>
    </span>
    <slot name="badge"></slot>
    <button class="toggle" part="toggle" type="button" aria-expanded="false" title="Show actions">
      <span class="chevron" aria-hidden="true">⌄</span>
    </button>
  </div>
  <div class="actions" part="actions" id="actions">
    <slot name="actions"></slot>
  </div>
`;

class UoneDisclosureCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).append(template.content.cloneNode(true));
    this.toggleButton = this.shadowRoot.querySelector(".toggle");
    this.toggleButton.setAttribute("aria-controls", "actions");
    this.toggleButton.addEventListener("click", event => {
      event.stopPropagation();
      this.expanded = !this.expanded;
    });
    this.toggleButton.addEventListener("keydown", event => event.stopPropagation());
    this.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.expanded) {
        this.expanded = false;
        this.toggleButton.focus();
      }
    });
  }

  static get observedAttributes() { return ["expanded", "action-label"]; }

  connectedCallback() { this.syncState(); }

  attributeChangedCallback() { this.syncState(); }

  get expanded() { return this.hasAttribute("expanded"); }

  set expanded(value) { this.toggleAttribute("expanded", Boolean(value)); }

  syncState() {
    if (!this.toggleButton) return;
    const expanded = this.expanded;
    const label = this.getAttribute("action-label") || "actions";
    this.toggleButton.setAttribute("aria-expanded", String(expanded));
    this.toggleButton.title = `${expanded ? "Hide" : "Show"} ${label}`;
    this.toggleButton.setAttribute("aria-label", this.toggleButton.title);
  }
}

if (!customElements.get("uone-disclosure-card")) {
  customElements.define("uone-disclosure-card", UoneDisclosureCard);
}
