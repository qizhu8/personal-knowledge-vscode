const nativeInteractiveTags = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);

function hasInlineAction(element) {
  const handler = element.getAttribute("onclick") || "";
  const withoutEventMethods = handler.replace(/\bevent\.[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\);?/g, "");
  return /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(withoutEventMethods);
}

function enhanceClickableElement(element) {
  if (element.dataset.interactionEnhanced === "true"
    || nativeInteractiveTags.has(element.tagName)
    || !hasInlineAction(element)) return;
  element.dataset.interactionEnhanced = "true";
  if (!element.hasAttribute("role")) element.setAttribute("role", "button");
  if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
  if (element.hasAttribute("onkeydown")) return;
  element.addEventListener("keydown", event => {
    if (event.target !== element || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    element.click();
  });
}

function enhanceClickableElements(root = document) {
  if (root instanceof Element && root.hasAttribute("onclick")) enhanceClickableElement(root);
  root.querySelectorAll?.("[onclick]").forEach(enhanceClickableElement);
}

new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) enhanceClickableElements(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

enhanceClickableElements();
