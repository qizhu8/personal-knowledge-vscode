globalThis.PkmMediaZoom = (() => {
  const printStyle = document.createElement('style');
  printStyle.textContent = `
    .media-zoom-viewport.media-can-pan{cursor:grab}
    .media-zoom-viewport.media-panning{cursor:grabbing;user-select:none}
    .media-zoom-fullscreen[open]{position:fixed;inset:0;box-sizing:border-box;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:16px;border:0;display:flex;flex-direction:column;background:var(--vscode-editor-background,#fff);color:var(--vscode-editor-foreground,#222)}
    .media-zoom-fullscreen::backdrop{background:rgba(0,0,0,.65)}
    .media-zoom-fullscreen>.media-zoom-viewport{flex:1;min-height:0;max-height:none!important}
    @media print{.media-zoom-controls{display:none!important}.media-zoom-viewport{max-height:none!important;overflow:visible!important}.media-zoom-viewport>svg,.media-zoom-viewport>img{max-width:100%!important;height:auto!important}.media-zoom-fullscreen[open]{position:static;width:auto;height:auto;display:block;padding:0}}
  `;
  document.head.append(printStyle);
  const active = new Map();
  new MutationObserver(() => {
    for (const [holder, dispose] of active) {
      if (!holder.isConnected) {
        active.delete(holder);
        dispose();
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  function attach(holder, media, naturalWidth, label) {
    if (!Number.isFinite(naturalWidth) || !(naturalWidth > 0)) throw new Error('Media has no usable width.');
    const kind = media instanceof SVGElement ? 'diagram' : 'image';
    const toolbar = document.createElement('div');
    toolbar.className = 'media-zoom-controls mermaid-zoom-controls';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', label + ' zoom');
    toolbar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;text-align:left';
    const viewport = document.createElement('div');
    viewport.className = 'media-zoom-viewport mermaid-viewport';
    viewport.style.cssText = 'overflow:auto;max-height:75vh;min-width:0';
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', label + '. Use zoom controls or +, -, 0 and F keys. Ctrl or Command plus wheel zooms; drag non-text areas to pan.');
    viewport.tabIndex = 0;
    holder.removeAttribute('role');
    holder.removeAttribute('aria-label');
    holder.removeAttribute('tabindex');
    holder.append(toolbar, viewport);
    viewport.append(media);
    const status = document.createElement('output');
    status.setAttribute('aria-live', 'polite');
    let scale = 1;
    let fitting = true;
    let fullscreen;
    let drag;
    let suppressClick = false;
    const updatePan = () => viewport.classList.toggle('media-can-pan',
      viewport.scrollWidth > viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight);
    const apply = () => {
      media.style.width = (naturalWidth * scale) + 'px';
      media.style.maxWidth = 'none';
      media.style.maxHeight = 'none';
      media.style.height = 'auto';
      media.style.display = 'block';
      status.textContent = Math.round(scale * 100) + '%';
      updatePan();
    };
    const fit = () => {
      fitting = true;
      scale = Math.min(1, Math.max(1, viewport.clientWidth) / naturalWidth);
      apply();
      viewport.scrollTo(0, 0);
    };
    const zoom = (value, point) => {
      const before = media.getBoundingClientRect();
      const previousScale = scale;
      const left = viewport.scrollLeft;
      const top = viewport.scrollTop;
      fitting = false;
      scale = Math.min(4, Math.max(0.01, value));
      apply();
      if (point) {
        viewport.scrollLeft = left + (point.x - before.left) * (scale / previousScale - 1);
        viewport.scrollTop = top + (point.y - before.top) * (scale / previousScale - 1);
      }
    };
    const button = (text, name, action) => {
      const control = document.createElement('button');
      control.type = 'button';
      control.textContent = text;
      control.title = name;
      control.setAttribute('aria-label', name);
      control.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      toolbar.append(control);
      return control;
    };
    button('-', 'Zoom out', () => zoom(scale / 1.25));
    button('+', 'Zoom in', () => zoom(scale * 1.25));
    button('Fit width', 'Fit ' + kind + ' to width', fit);
    button('100%', 'Original ' + kind + ' size', () => zoom(1));
    const restoreFullscreen = () => {
      if (!fullscreen) return;
      const { dialog, saved } = fullscreen;
      fullscreen = undefined;
      endDrag();
      holder.append(toolbar, viewport);
      dialog.remove();
      scale = saved.scale;
      fitting = saved.fitting;
      apply();
      viewport.scrollTo(saved.left, saved.top);
      fullscreenButton.textContent = 'Fullscreen';
      fullscreenButton.setAttribute('aria-label', 'View ' + kind + ' fullscreen');
      fullscreenButton.title = 'View ' + kind + ' fullscreen';
      fullscreenButton.setAttribute('aria-pressed', 'false');
      if (holder.isConnected) fullscreenButton.focus({ preventScroll: true });
    };
    const fullscreenButton = button('Fullscreen', 'View ' + kind + ' fullscreen', () => {
      if (fullscreen) {
        fullscreen.dialog.close();
        restoreFullscreen();
        return;
      }
      const dialog = document.createElement('dialog');
      dialog.className = 'media-zoom-fullscreen';
      dialog.setAttribute('aria-label', label + ' full-screen view');
      fullscreen = { dialog, saved: { scale, fitting, left: viewport.scrollLeft, top: viewport.scrollTop } };
      document.body.append(dialog);
      dialog.append(toolbar, viewport);
      dialog.addEventListener('close', () => { if (fullscreen?.dialog === dialog) restoreFullscreen(); }, { once: true });
      dialog.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
        const controls = [...dialog.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
          .filter(control => !control.disabled && control.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      fullscreenButton.textContent = 'Exit fullscreen';
      fullscreenButton.setAttribute('aria-label', 'Exit fullscreen');
      fullscreenButton.title = 'Exit fullscreen';
      fullscreenButton.setAttribute('aria-pressed', 'true');
      dialog.showModal();
      if (fitting) fit();
      viewport.focus({ preventScroll: true });
    });
    fullscreenButton.setAttribute('aria-pressed', 'false');
    toolbar.append(status);
    viewport.addEventListener('wheel', event => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || !Number.isFinite(event.deltaY) || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const delta = Math.min(500, Math.max(-500, event.deltaY * unit));
      zoom(scale * Math.exp(-delta * 0.002), { x: event.clientX, y: event.clientY });
    }, { passive: false });
    const endDrag = () => {
      if (!drag) return;
      const { id, moved } = drag;
      drag = undefined;
      suppressClick = moved;
      viewport.classList.remove('media-panning');
      if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    };
    viewport.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (event.button !== 0 || event.pointerType !== 'mouse' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || !viewport.classList.contains('media-can-pan')
        || event.target.closest('a,button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="button"],text,tspan,foreignObject')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      viewport.classList.add('media-panning');
      viewport.scrollLeft = drag.left - dx;
      viewport.scrollTop = drag.top - dy;
      event.preventDefault();
    });
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('lostpointercapture', endDrag);
    viewport.addEventListener('dragstart', event => { if (drag) event.preventDefault(); });
    viewport.addEventListener('click', event => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    viewport.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target !== viewport) return;
      const actions = new Map([
        ['+', () => zoom(scale * 1.25)], ['=', () => zoom(scale * 1.25)],
        ['-', () => zoom(scale / 1.25)], ['0', () => zoom(1)], ['f', fit], ['F', fit],
      ]);
      const action = actions.get(event.key);
      if (!action) return;
      event.preventDefault();
      action();
    });
    fit();
    const observer = new ResizeObserver(() => {
      if (fitting && holder.isConnected) fit();
      else updatePan();
    });
    observer.observe(viewport);
    active.set(holder, () => {
      observer.disconnect();
      endDrag();
      if (fullscreen) {
        fullscreen.dialog.close();
        restoreFullscreen();
      }
    });
  }

  function renderImages(root) {
    for (const image of root.querySelectorAll('img')) {
      if (image.closest('.media-zoom-viewport, .mermaid-diagram, .katex') || image.dataset.pkmZoom) continue;
      image.dataset.pkmZoom = 'pending';
      const ready = () => {
        if (!image.naturalWidth || !image.isConnected) return;
        const holder = document.createElement('span');
        holder.className = 'image-zoom';
        holder.style.cssText = 'display:block;min-width:0;max-width:100%;margin:1em 0';
        image.before(holder);
        attach(holder, image, image.naturalWidth, image.alt || 'Image');
        image.dataset.pkmZoom = 'ready';
      };
      if (image.complete && image.naturalWidth) ready();
      else image.addEventListener('load', ready, { once: true });
    }
  }
  return { attach, renderImages };
})();
