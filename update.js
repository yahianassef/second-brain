/* =========================================================
   UPDATE — pull down the newest version of the app itself
   =========================================================
   Safari keeps a home-screen app's files for a long time, so a change that is
   already live can take days to show up on the phone, with no obvious way to
   force it. A plain reload is not enough: it re-runs the copy already in the
   cache. This refetches the page and every script it loads with the cache
   deliberately bypassed, so the reload afterwards picks up the new files.
   ========================================================= */
const UPDATE_FILES = ['theme.css', 'update.js', 'push.js', 'sw.js', 'motion.js', 'gym-data.js', 'gym.js', 'gym-make.js', 'graph.js', 'polish.js',
  'theme.js', 'assistant.js', 'cloud-config.js', 'cloud.js', 'cloud-ui.js'];

const AppUpdate = {
  busy: false,

  /** When the copy you are looking at was built. */
  current() {
    const d = new Date(document.lastModified);
    return isNaN(d) ? null : d;
  },

  /** When the server's copy was built — null if it cannot be determined. */
  async latest() {
    try {
      const res = await fetch(location.pathname + '?v=' + Date.now(), { method: 'HEAD', cache: 'no-store' });
      const lm = res.headers.get('Last-Modified');
      if (!lm) return null;
      const d = new Date(lm);
      return isNaN(d) ? null : d;
    } catch (e) {
      return null;
    }
  },

  /** A minute of slack, because the two clocks are never exactly the same. */
  async available() {
    const [here, there] = [this.current(), await this.latest()];
    if (!here || !there) return null;
    return there.getTime() - here.getTime() > 60000;
  },

  label() {
    const d = this.current();
    if (!d) return 'Version unknown';
    return 'This version: ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  },

  async refresh() {
    if (this.busy) return;
    this.busy = true;
    try { toast('Fetching the latest version…'); } catch (e) { /* no toast yet */ }

    // Anything a service worker or the Cache API is holding goes first.
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      // The notifications helper stays (it caches nothing); it is only told to update
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.update().catch(() => null)));
      }
    } catch (e) { /* neither is required for this to work */ }

    // Refetch the page and its scripts with the HTTP cache bypassed, which
    // replaces the stale entries rather than just reading around them.
    const here = location.pathname.replace(/[^/]*$/, '');
    const targets = [location.pathname].concat(UPDATE_FILES.map(f => here + f));
    await Promise.all(targets.map(u => fetch(u, { cache: 'reload' }).catch(() => null)));

    // A changing query string is the one thing Safari will not serve from cache.
    const url = location.pathname + '?u=' + Date.now() + location.hash;
    location.replace(url);
  }
};

/* The app's icon set has no refresh glyph yet. */
if (typeof ICONS !== 'undefined' && !ICONS.refresh) {
  ICONS.refresh = '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>';
}

/* Every time the app opens or is refreshed, ask the server — past every cache —
   whether it has a newer copy, and if so fetch it and reload straight away, so a
   refresh always shows the latest change. Each newer copy is reloaded for at most
   once: if the reload still comes back old (the host has not finished
   publishing), it says so with an Update button instead of looping. */
AppUpdate.autoUpdate = async function () {
  const there = await this.latest(), here = this.current();
  if (!there || !here || there.getTime() - here.getTime() <= 60000) return;
  const KEY = 'secondBrain.autoUpdated', mark = String(there.getTime());
  let tried = '';
  try { tried = sessionStorage.getItem(KEY) || ''; } catch (e) { /* private window */ }
  // Never pull the page out from under an open form; offer the update instead
  const busy = document.querySelector('.overlay, .sheet.open');
  if (tried !== mark && !busy) {
    try { sessionStorage.setItem(KEY, mark); } catch (e) { /* private window */ }
    return this.refresh();
  }
  const line = document.getElementById('verLine');
  if (line) line.textContent = 'A newer version is ready — tap to get it';
  try {
    toast('A newer version is available', { action: 'Update', onAction: () => this.refresh() });
  } catch (e) { /* no toast on this build */ }
};
AppUpdate.announce = AppUpdate.autoUpdate;

if (typeof window !== 'undefined') {
  // Straight away on open, and again whenever the app comes back to the front
  window.addEventListener('load', () => AppUpdate.autoUpdate());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') AppUpdate.autoUpdate(); });
}
