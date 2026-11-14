globalThis.pkmMermaidReady = (async () => {
  const blocks = [...document.querySelectorAll('.prose pre code.mermaid, .prose pre code.language-mermaid')];
  if (!blocks.length) return;
  const failed = (holder, error) => {
    holder.className = 'mermaid-diagram mermaid-error';
    holder.setAttribute('role', 'alert');
    holder.textContent = 'Mermaid rendering failed: ' + String(error?.message || error).slice(0, 1000);
    console.error(holder.textContent);
  };
  try {
    if (!globalThis.mermaid) throw new Error('The local Mermaid library did not load. The diagram source is shown below.');
    mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true, securityLevel: 'strict', theme: 'default', fontFamily: 'inherit' });
  } catch (error) {
    for (const code of blocks) {
      const holder = document.createElement('div');
      code.closest('pre').before(holder);
      failed(holder, error);
    }
    return;
  }
  for (const [index, code] of blocks.entries()) {
    const pre = code.closest('pre');
    const holder = document.createElement('div');
    holder.className = 'mermaid-diagram';
    holder.setAttribute('role', 'img');
    holder.setAttribute('aria-label', 'Mermaid diagram');
    holder.tabIndex = 0;
    pre.before(holder);
    try {
      const rendered = await mermaid.render('pkm-note-diagram-' + index, code.textContent, holder);
      holder.innerHTML = rendered.svg;
      const svg = holder.querySelector('svg');
      if (!svg) throw new Error('Mermaid did not produce an SVG diagram.');
      PkmMediaZoom.attach(holder, svg, svg.viewBox.baseVal.width || svg.width.baseVal.value, 'Diagram');
      rendered.bindFunctions?.(holder);
      pre.remove();
    } catch (error) {
      failed(holder, error);
    }
  }
})();
