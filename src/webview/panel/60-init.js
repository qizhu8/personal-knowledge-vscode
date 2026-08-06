// ── Init ───────────────────────────────────────────────────────────────────
ask('ready', {});                              // tell the extension the webview is loaded
ask('list', { tab:'skills', filter:'all', q:'' });

// Safety: if no response after 8 s, DB is still initializing — retry automatically
setTimeout(() => {
  const banner = document.getElementById('loading-banner');
  if (banner && !banner.classList.contains('hidden')) {
    // Update the subtitle to tell user what's happening
    const sub = document.querySelector('.loading-sub');
    if (sub) sub.textContent = 'Database is initializing, retrying…';
    // Retry the list request after another 3 s
    setTimeout(() => ask('list', { tab:'skills', filter:'all', q:'' }), 3000);
  }
}, 8000);
