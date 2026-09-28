const experience = {
  pending: null,
  kind: '',
  version: '',
  audience: '',
  moduleIds: [],
  automatic: false,
  steps: [],
  step: 0,
  target: null,
  targetClick: null,
  previousFocus: null,
};

let featureTourCatalog = { version: '', modules: [] };

function featureTourModules(moduleIds) {
  const wanted = new Set(moduleIds || []);
  return (featureTourCatalog.modules || []).filter(module => wanted.has(module.id));
}

function featureTourSteps(moduleIds) {
  return featureTourModules(moduleIds).flatMap(module =>
    (module.steps || []).map(step => ({ ...step, moduleId: module.id })));
}

function experienceLayer() { return document.getElementById('experience-layer'); }

function clearExperienceTarget() {
  if (experience.target && experience.targetClick) experience.target.removeEventListener('click', experience.targetClick);
  experience.target?.classList.remove('coachmark-target');
  experience.target = null;
  experience.targetClick = null;
}

function setShadeRect(element, left, top, width, height) {
  Object.assign(element.style, {
    left: `${Math.max(0, left)}px`,
    top: `${Math.max(0, top)}px`,
    width: `${Math.max(0, width)}px`,
    height: `${Math.max(0, height)}px`,
  });
}

function positionCoachmark() {
  const layer = experienceLayer();
  const card = document.getElementById('coachmark');
  if (!layer || layer.classList.contains('hidden') || !card) return;
  const shades = Object.fromEntries([...layer.querySelectorAll('.coachmark-shade')].map(item => [item.dataset.side, item]));
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const margin = 10;
  let rect = experience.target?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.left >= viewport.width || rect.bottom <= 0 || rect.top >= viewport.height) {
    Object.values(shades).forEach(shade => setShadeRect(shade, 0, 0, viewport.width, viewport.height));
    card.dataset.placement = 'center';
    card.style.left = `${Math.max(12, (viewport.width - card.offsetWidth) / 2)}px`;
    card.style.top = `${Math.max(12, (viewport.height - card.offsetHeight) / 2)}px`;
    return;
  }
  const cut = {
    left: Math.max(0, rect.left - 6),
    top: Math.max(0, rect.top - 6),
    right: Math.min(viewport.width, rect.right + 6),
    bottom: Math.min(viewport.height, rect.bottom + 6),
  };
  setShadeRect(shades.top, 0, 0, viewport.width, cut.top);
  setShadeRect(shades.bottom, 0, cut.bottom, viewport.width, viewport.height - cut.bottom);
  setShadeRect(shades.left, 0, cut.top, cut.left, cut.bottom - cut.top);
  setShadeRect(shades.right, cut.right, cut.top, viewport.width - cut.right, cut.bottom - cut.top);

  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const spaces = {
    right: viewport.width - cut.right,
    left: cut.left,
    bottom: viewport.height - cut.bottom,
    top: cut.top,
  };
  let placement = spaces.right >= cardWidth + 22 ? 'right'
    : spaces.left >= cardWidth + 22 ? 'left'
      : spaces.bottom >= cardHeight + 22 ? 'bottom'
        : spaces.top >= cardHeight + 22 ? 'top' : 'center';
  let left;
  let top;
  if (placement === 'right') {
    left = cut.right + 14;
    top = Math.min(viewport.height - cardHeight - margin, Math.max(margin, cut.top + (cut.bottom - cut.top - cardHeight) / 2));
  } else if (placement === 'left') {
    left = cut.left - cardWidth - 14;
    top = Math.min(viewport.height - cardHeight - margin, Math.max(margin, cut.top + (cut.bottom - cut.top - cardHeight) / 2));
  } else if (placement === 'bottom') {
    left = Math.min(viewport.width - cardWidth - margin, Math.max(margin, cut.left + (cut.right - cut.left - cardWidth) / 2));
    top = cut.bottom + 14;
  } else if (placement === 'top') {
    left = Math.min(viewport.width - cardWidth - margin, Math.max(margin, cut.left + (cut.right - cut.left - cardWidth) / 2));
    top = cut.top - cardHeight - 14;
  } else {
    left = Math.max(margin, (viewport.width - cardWidth) / 2);
    top = Math.max(margin, (viewport.height - cardHeight) / 2);
  }
  card.dataset.placement = placement;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function experienceFocusables() {
  return [...document.querySelectorAll('#coachmark button:not([disabled])')].filter(element => element.offsetParent !== null);
}

function finishExperience(completed = false) {
  clearExperienceTarget();
  const layer = experienceLayer();
  layer?.classList.add('hidden');
  layer?.setAttribute('aria-hidden', 'true');
  layer?.setAttribute('hidden', '');
  document.body.classList.remove('experience-open');
  window.removeEventListener('resize', positionCoachmark);
  window.removeEventListener('scroll', positionCoachmark, true);
  if (completed && experience.automatic && experience.moduleIds.length) {
    vscode.postMessage({
      command: 'completeTourModules',
      moduleIds: experience.moduleIds,
      audience: experience.audience,
    });
  }
  const focus = experience.previousFocus;
  experience.kind = '';
  experience.audience = '';
  experience.moduleIds = [];
  experience.automatic = false;
  experience.steps = [];
  experience.previousFocus = null;
  if (focus?.isConnected) focus.focus();
}

function completeTour() {
  finishExperience(true);
}

function renderTourStep(index) {
  clearExperienceTarget();
  experience.step = Math.max(0, Math.min(experience.steps.length - 1, index));
  const step = experience.steps[experience.step];
  if (step.workspace) document.querySelector(`.workspace-button[data-workspace="${step.workspace}"]`)?.click();
  if (step.tab) document.querySelector(`.tab[data-tab="${step.tab}"]`)?.click();
  let target = document.querySelector(step.target);
  const targetRect = target?.getBoundingClientRect();
  if ((!target || !target.offsetParent || targetRect.right <= 0 || targetRect.left >= window.innerWidth) && step.fallback) {
    target = document.querySelector(step.fallback);
  }
  experience.target = target;
  target?.classList.add('coachmark-target');
  if (step.activate && target) {
    experience.targetClick = () => setTimeout(() => renderTourStep(experience.step + 1), 80);
    target.addEventListener('click', experience.targetClick, { once: true });
  }
  document.getElementById('coachmark-eyebrow').textContent = t('experience.tourEyebrow');
  document.getElementById('coachmark-title').textContent = t(step.titleKey);
  document.getElementById('coachmark-body').textContent = t(step.bodyKey);
  document.getElementById('coachmark-highlights').replaceChildren();
  document.getElementById('coachmark-progress').textContent = t('experience.stepProgress', {
    current: experience.step + 1,
    total: experience.steps.length,
  });
  const back = document.getElementById('coachmark-back');
  const next = document.getElementById('coachmark-next');
  back.hidden = experience.step === 0;
  back.textContent = t('experience.back');
  next.textContent = t(step.actionKey || (experience.step === experience.steps.length - 1 ? 'experience.finish' : 'experience.next'));
  next.onclick = () => {
    if (experience.step === experience.steps.length - 1) {
      completeTour();
      return;
    }
    if (step.activate) target?.click();
    else renderTourStep(experience.step + 1);
  };
  back.onclick = () => renderTourStep(experience.step - 1);
  requestAnimationFrame(() => {
    experience.target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    requestAnimationFrame(positionCoachmark);
  });
}

function startOnboardingTour(options = {}) {
  finishExperience(false);
  experience.kind = 'onboarding';
  experience.audience = options.audience || 'manual';
  experience.moduleIds = [...(options.moduleIds || featureTourCatalog.modules.map(module => module.id))];
  experience.automatic = !!options.automatic;
  experience.steps = featureTourSteps(experience.moduleIds);
  if (!experience.steps.length) return;
  experience.previousFocus = document.activeElement;
  const layer = experienceLayer();
  layer.removeAttribute('hidden');
  layer.classList.remove('hidden');
  layer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('experience-open');
  document.getElementById('coachmark-close').title = t('experience.skipTour');
  document.getElementById('coachmark-close').setAttribute('aria-label', t('experience.skipTour'));
  window.addEventListener('resize', positionCoachmark);
  window.addEventListener('scroll', positionCoachmark, true);
  renderTourStep(0);
  document.getElementById('coachmark').focus();
}

function showWhatsNew(options = {}) {
  finishExperience(false);
  experience.kind = 'whatsNew';
  experience.version = options.version || featureTourCatalog.version || document.getElementById('pkm-version')?.textContent?.replace(/^v/, '') || '';
  experience.audience = options.audience || 'manual';
  experience.moduleIds = [...(options.moduleIds || featureTourCatalog.modules.map(module => module.id))];
  experience.automatic = !!options.automatic;
  experience.previousFocus = document.activeElement;
  const layer = experienceLayer();
  layer.removeAttribute('hidden');
  layer.classList.remove('hidden');
  layer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('experience-open');
  document.getElementById('coachmark-close').title = t('common.close');
  document.getElementById('coachmark-close').setAttribute('aria-label', t('common.close'));
  document.getElementById('coachmark-eyebrow').textContent = t('experience.whatsNewEyebrow');
  document.getElementById('coachmark-title').textContent = t('experience.whatsNewTitle', { version: experience.version });
  document.getElementById('coachmark-body').textContent = t('experience.whatsNewBody');
  const highlights = featureTourModules(experience.moduleIds);
  document.getElementById('coachmark-highlights').innerHTML = highlights.map(module =>
    `<article><span class="codicon codicon-${esc(module.highlightIcon)}" aria-hidden="true"></span><div><strong>${esc(t(module.highlightTitleKey))}</strong><p>${esc(t(module.highlightBodyKey))}</p></div></article>`
  ).join('');
  document.getElementById('coachmark-progress').textContent = '';
  document.getElementById('coachmark-back').hidden = true;
  const next = document.getElementById('coachmark-next');
  next.textContent = t('experience.takeTour');
  next.onclick = () => startOnboardingTour({
    moduleIds: experience.moduleIds,
    audience: experience.audience,
    automatic: experience.automatic,
  });
  experience.target = null;
  window.addEventListener('resize', positionCoachmark);
  requestAnimationFrame(positionCoachmark);
  document.getElementById('coachmark').focus();
}

function queueInitialExperience(data) {
  if (data?.kind !== 'tour' || !data?.version || !Array.isArray(data.moduleIds)) return;
  experience.pending = data;
  maybeStartPendingExperience();
}

function updateFeatureTourCatalog(data) {
  featureTourCatalog = {
    version: String(data?.version || ''),
    modules: Array.isArray(data?.modules) ? data.modules : [],
  };
  maybeStartPendingExperience();
}

function maybeStartPendingExperience() {
  if (!initialLoadComplete || !experience.pending || !featureTourCatalog.modules.length) return;
  const pending = experience.pending;
  experience.pending = null;
  if (pending.audience === 'new') {
    startOnboardingTour({ moduleIds: pending.moduleIds, audience: pending.audience, automatic: true });
  } else {
    showWhatsNew({ version: pending.version, moduleIds: pending.moduleIds, audience: pending.audience, automatic: true });
  }
}

document.getElementById('coachmark-close')?.addEventListener('click', () => {
  finishExperience(experience.automatic);
});
document.getElementById('whats-new-button')?.addEventListener('click', () => showWhatsNew());
document.getElementById('start-tour-button')?.addEventListener('click', () => startOnboardingTour());
document.addEventListener('keydown', event => {
  if (experienceLayer()?.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    finishExperience(experience.automatic);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = experienceFocusables();
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey
    ? focusable[(current <= 0 ? focusable.length : current) - 1]
    : focusable[(current + 1) % focusable.length];
  event.preventDefault();
  next.focus();
});
