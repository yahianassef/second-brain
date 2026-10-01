/* =========================================================
   THEME — light, dark, or whatever the device is doing, and an accent colour
   =========================================================
   The colours themselves live in theme.css. This only decides which of them
   apply, remembers the choice, and puts a control in the app.

   The choice rides in DB.settings, so it follows you to your phone like
   everything else, and is mirrored into localStorage because the early snippet
   in each build's <head> has to set the theme before anything paints — reading
   it from the synced data would be too late and you would see a flash of dark.
   ========================================================= */
const THEME_KEY = 'secondBrain.theme';
const ACCENTS = [
  { k: 'blue', l: 'Blue', c: '#0066FF' },
  { k: 'violet', l: 'Violet', c: '#7C4DFF' },
  { k: 'emerald', l: 'Emerald', c: '#0E9F6E' },
  { k: 'amber', l: 'Amber', c: '#E08900' },
  { k: 'rose', l: 'Rose', c: '#E11D62' },
  { k: 'teal', l: 'Teal', c: '#0D94AE' }
];

const Theme = {
  mode: 'dark',          // 'dark' | 'light' | 'auto'
  accent: 'blue',
  media: null,

  prefersLight() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return false; }
  },
  resolved() { return this.mode === 'auto' ? (this.prefersLight() ? 'light' : 'dark') : this.mode; },

  /** The attributes the stylesheet keys off. */
  paint() {
    const root = document.documentElement;
    root.dataset.theme = this.resolved();
    root.dataset.accent = this.accent;
    const bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.setAttribute('content', this.resolved() === 'light' ? '#F4F6FB' : '#07090D');
    document.querySelectorAll('[data-theme-btn]').forEach(b => {
      b.innerHTML = this.resolved() === 'light' ? this.sun() : this.moon();
      b.title = `Theme: ${this.mode === 'auto' ? 'follows your device' : this.mode}`;
    });
  },

  load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(THEME_KEY) || '{}'); } catch (e) { saved = {}; }
    const fromDB = (typeof DB !== 'undefined' && DB && DB.settings) || {};
    // whatever the app has synced wins over this device's cache
    this.mode = fromDB.theme || saved.mode || 'dark';
    this.accent = fromDB.accent || saved.accent || 'blue';
    if (!['dark', 'light', 'auto'].includes(this.mode)) this.mode = 'dark';
    if (!ACCENTS.some(a => a.k === this.accent)) this.accent = 'blue';
    this.remember();
    this.paint();
    this.watch();
  },

  remember() {
    try { localStorage.setItem(THEME_KEY, JSON.stringify({ mode: this.mode, accent: this.accent })); }
    catch (e) { /* private window — the theme just will not survive a reload */ }
  },

  /** In 'auto', follow the device if it switches at sunset. */
  watch() {
    if (this.media) return;
    try {
      this.media = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => { if (this.mode === 'auto') this.paint(); };
      if (this.media.addEventListener) this.media.addEventListener('change', onChange);
      else this.media.addListener(onChange);
    } catch (e) { /* no matchMedia, no auto */ }
  },

  set(mode, accent) {
    if (mode) this.mode = mode;
    if (accent) this.accent = accent;
    this.remember();
    this.paint();
    if (typeof DB !== 'undefined' && DB && DB.settings) {
      DB.settings.theme = this.mode;
      DB.settings.accent = this.accent;
      DB.settings.ts = Date.now();
      try { saveDB(); } catch (e) { /* storage blocked */ }
    }
  },

  /** Tap the button to flip; the panel has the full choice. */
  flip() {
    this.set(this.resolved() === 'light' ? 'dark' : 'light');
    toast(this.resolved() === 'light' ? 'Light theme' : 'Dark theme');
  },

  panel() {
    const seg = (v, label, hint) => `
      <button class="btn ${this.mode === v ? 'btn-primary' : 'btn-ghost'}" data-mode="${v}">
        ${label}${hint ? `<span class="th-hint">${hint}</span>` : ''}
      </button>`;
    const swatch = a => `
      <button class="th-swatch${this.accent === a.k ? ' on' : ''}" data-accent="${a.k}"
        title="${a.l}" aria-label="${a.l}" style="--sw:${a.c}"><i></i><span>${a.l}</span></button>`;
    const m = openModal(`
      <div class="modal-head">
        <div><div class="eyebrow">Appearance</div><h3>Theme</h3></div>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="set-section"><h4>Light or dark</h4>
          <div class="btn-row th-modes">
            ${seg('light', 'Light')}
            ${seg('dark', 'Dark')}
            ${seg('auto', 'Automatic', 'follows your device')}
          </div>
        </div>
        <div class="set-section"><h4>Accent colour</h4>
          <p>Used for buttons, highlights, charts and the progress rings.</p>
          <div class="th-swatches">${ACCENTS.map(swatch).join('')}</div>
        </div>
        <p class="hint">Your choice is saved with your data, so your other devices pick it up on the next sync.</p>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" data-close>Done</button></div>`, false, 'small');

    m.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
      this.set(b.dataset.mode);
      m.querySelectorAll('[data-mode]').forEach(x => {
        x.className = 'btn ' + (x.dataset.mode === this.mode ? 'btn-primary' : 'btn-ghost');
      });
    });
    m.querySelectorAll('[data-accent]').forEach(b => b.onclick = () => {
      this.set(null, b.dataset.accent);
      m.querySelectorAll('[data-accent]').forEach(x => x.classList.toggle('on', x.dataset.accent === this.accent));
    });
  },

  /* ---------------- chrome ---------------- */
  sun() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
      stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/>
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/></svg>`;
  },
  moon() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 13.4A8.2 8.2 0 0 1 10.6 4a8.4 8.4 0 1 0 9.4 9.4z"/></svg>`;
  },

  button() {
    const btn = document.createElement('button');
    btn.id = 'themeBtn';
    btn.setAttribute('data-theme-btn', '');
    const foot = document.querySelector('.sidebar-foot');
    if (foot) {
      btn.className = 'nav-item th-btn';
      btn.innerHTML = this.moon();
      const label = document.createElement('span');
      label.textContent = 'Theme';
      btn.appendChild(label);
      foot.insertBefore(btn, foot.firstChild);
      // a plain click flips; press and hold, or right-click, opens the choices
      let held = null;
      btn.addEventListener('click', e => { if (e.shiftKey) this.panel(); else this.flip(); });
      btn.addEventListener('contextmenu', e => { e.preventDefault(); this.panel(); });
      btn.addEventListener('pointerdown', () => { held = setTimeout(() => { held = null; this.panel(); }, 550); });
      ['pointerup', 'pointerleave'].forEach(ev => btn.addEventListener(ev, () => clearTimeout(held)));
    } else {
      btn.className = 'top-act th-btn';
      btn.setAttribute('aria-label', 'Theme');
      btn.innerHTML = this.moon();
      const anchor = document.getElementById('searchBtn') || document.getElementById('syncBtn');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
      else document.querySelector('header')?.appendChild(btn);
      btn.addEventListener('click', () => this.flip());
      btn.addEventListener('contextmenu', e => { e.preventDefault(); this.panel(); });
      let held = null;
      btn.addEventListener('pointerdown', () => { held = setTimeout(() => { held = null; this.panel(); }, 550); });
      ['pointerup', 'pointerleave'].forEach(ev => btn.addEventListener(ev, () => clearTimeout(held)));
    }
  },

  styles() {
    const css = `
    .th-btn svg{flex-shrink:0}
    .th-modes .btn{flex-direction:column;align-items:flex-start;gap:1px;padding:9px 13px}
    .th-hint{font-size:10.5px;opacity:.75;font-weight:500}
    .th-swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:9px;margin-top:11px}
    .th-swatch{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 6px;cursor:pointer;
      background:var(--surface-2);border:1px solid var(--border);border-radius:13px;color:var(--text-2);
      font:inherit;font-size:11.5px;transition:border-color .18s,transform .18s var(--ease)}
    .th-swatch:hover{transform:translateY(-2px);border-color:var(--border-2)}
    .th-swatch i{width:26px;height:26px;border-radius:50%;background:var(--sw);
      box-shadow:0 4px 12px -5px var(--sw),inset 0 0 0 1px rgba(255,255,255,.18)}
    .th-swatch.on{border-color:var(--sw);color:var(--text);box-shadow:0 0 0 1px var(--sw)}
    .th-swatch.on i{box-shadow:0 4px 14px -4px var(--sw),inset 0 0 0 2px var(--surface-2),0 0 0 2px var(--sw)}`;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  },

  init() {
    this.styles();
    this.button();
    this.load();
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Theme.init());
else Theme.init();
