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
  { k: 'indigo', l: 'Indigo', c: '#4F46E5' },
  { k: 'violet', l: 'Violet', c: '#7C4DFF' },
  { k: 'magenta', l: 'Magenta', c: '#C026D3' },
  { k: 'rose', l: 'Rose', c: '#E11D62' },
  { k: 'crimson', l: 'Crimson', c: '#DC2626' },
  { k: 'amber', l: 'Amber', c: '#E08900' },
  { k: 'lime', l: 'Lime', c: '#65A30D' },
  { k: 'emerald', l: 'Emerald', c: '#0E9F6E' },
  { k: 'teal', l: 'Teal', c: '#0D94AE' },
  { k: 'sky', l: 'Sky', c: '#0284C7' },
  { k: 'slate', l: 'Slate', c: '#64748B' }
];

const BACKDROPS = [
  { k: 'plain', l: 'Plain', hint: 'just the theme colour' },
  { k: 'aurora', l: 'Aurora', hint: 'soft light from the corners' },
  { k: 'mesh', l: 'Mesh', hint: 'four colours, blurred' },
  { k: 'dusk', l: 'Dusk', hint: 'a diagonal wash' },
  { k: 'ember', l: 'Ember', hint: 'warm, low and slow' },
  { k: 'forest', l: 'Forest', hint: 'green and deep' },
  { k: 'grid', l: 'Grid', hint: 'faint ruled lines' },
  { k: 'dots', l: 'Dots', hint: 'a quiet dot field' }
];

const Theme = {
  mode: 'dark',          // 'dark' | 'light' | 'auto'
  accent: 'blue',
  backdrop: 'plain',
  solid: 92,             // how opaque the cards are over a backdrop
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
    root.dataset.backdrop = this.backdrop;
    root.style.setProperty('--pane-solid', (this.solid / 100).toFixed(2));
    root.style.setProperty('--pane-blur', (this.backdrop === 'plain' ? 0 : 10) + 'px');
    const bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.setAttribute('content', this.resolved() === 'light' ? '#F4F6FB' : '#07090D');
    const named = ACCENTS.find(a => a.k === this.accent);
    document.querySelectorAll('[data-theme-btn]').forEach(b => {
      const glyph = this.resolved() === 'light' ? this.sun() : this.moon();
      // the dot is the current accent, so the button says "colours" at a glance
      b.innerHTML = b.classList.contains('top-act')
        ? `${glyph}<i class="th-dot"></i>`
        : `${glyph}<span>Theme &amp; colour</span><i class="th-dot"></i>`;
      b.title = `${this.mode === 'auto' ? 'Automatic' : this.resolved() === 'light' ? 'Light' : 'Dark'}`
        + `, ${named ? named.l.toLowerCase() : this.accent} — tap to change`;
    });
  },

  load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(THEME_KEY) || '{}'); } catch (e) { saved = {}; }
    const fromDB = (typeof DB !== 'undefined' && DB && DB.settings) || {};
    // whatever the app has synced wins over this device's cache
    this.mode = fromDB.theme || saved.mode || 'dark';
    this.accent = fromDB.accent || saved.accent || 'blue';
    this.backdrop = fromDB.backdrop || saved.backdrop || 'plain';
    this.solid = Number(fromDB.paneSolid ?? saved.solid ?? 92);
    if (!['dark', 'light', 'auto'].includes(this.mode)) this.mode = 'dark';
    if (!ACCENTS.some(a => a.k === this.accent)) this.accent = 'blue';
    if (!BACKDROPS.some(b => b.k === this.backdrop)) this.backdrop = 'plain';
    if (!(this.solid >= 55 && this.solid <= 100)) this.solid = 92;
    this.remember();
    this.paint();
    this.watch();
  },

  remember() {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify({
        mode: this.mode, accent: this.accent, backdrop: this.backdrop, solid: this.solid
      }));
    }
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

  set(mode, accent, extra = {}) {
    if (mode) this.mode = mode;
    if (accent) this.accent = accent;
    if (extra.backdrop) this.backdrop = extra.backdrop;
    if (extra.solid !== undefined) this.solid = Number(extra.solid);
    this.remember();
    this.paint();
    if (typeof DB !== 'undefined' && DB && DB.settings) {
      DB.settings.theme = this.mode;
      DB.settings.accent = this.accent;
      DB.settings.backdrop = this.backdrop;
      DB.settings.paneSolid = this.solid;
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
        <div class="set-section"><h4>Background</h4>
          <p>Painted behind everything and tinted from your accent, so the two always agree.</p>
          <div class="th-backs">${BACKDROPS.map(b => `
            <button class="th-back${this.backdrop === b.k ? ' on' : ''}" data-back="${b.k}" title="${b.hint}">
              <i data-sample="${b.k}"></i><b>${b.l}</b><span>${b.hint}</span>
            </button>`).join('')}</div>
          <label class="th-range${this.backdrop === 'plain' ? ' off' : ''}">
            <span>Panels <b id="thSolidVal">${this.solid}%</b> solid</span>
            <input type="range" min="55" max="100" step="1" value="${this.solid}" data-solid>
            <span class="th-hint">Lower lets more of the background through the cards.</span>
          </label>
        </div>
        <div class="set-section"><h4>Motion</h4>
          <p>Drawn in your accent colour, paused when the app is in the background,
          and switched off entirely if your phone or laptop is set to reduce motion.</p>
          <label class="th-switch"><input type="checkbox" data-fx="fxAmbient"${(DB.settings || {}).fxAmbient !== false ? ' checked' : ''}>
            <span><b>Living background</b> — drifting, linked points behind the app</span></label>
          <label class="th-switch"><input type="checkbox" data-fx="fxCelebrate"${(DB.settings || {}).fxCelebrate !== false ? ' checked' : ''}>
            <span><b>Celebrate completions</b> — a burst when a task or habit is done</span></label>
          <label class="th-switch"><input type="checkbox" data-fx="fxCount"${(DB.settings || {}).fxCount !== false ? ' checked' : ''}>
            <span><b>Counting figures</b> — totals count up instead of jumping</span></label>
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
    m.querySelectorAll('[data-back]').forEach(b => b.onclick = () => {
      this.set(null, null, { backdrop: b.dataset.back });
      m.querySelectorAll('[data-back]').forEach(x => x.classList.toggle('on', x.dataset.back === this.backdrop));
      m.querySelector('.th-range')?.classList.toggle('off', this.backdrop === 'plain');
    });
    const slider = m.querySelector('[data-solid]');
    if (slider) slider.oninput = () => {
      this.set(null, null, { solid: slider.value });
      const out = m.querySelector('#thSolidVal');
      if (out) out.textContent = slider.value + '%';
    };
    m.querySelectorAll('[data-fx]').forEach(box => box.onchange = () => {
      DB.settings[box.dataset.fx] = box.checked;
      DB.settings.ts = Date.now();
      try { saveDB(); } catch (e) { /* storage blocked */ }
      try { Motion.refresh(); } catch (e) { /* motion.js not loaded */ }
      if (box.dataset.fx === 'fxCelebrate' && box.checked) {
        const r = box.getBoundingClientRect();
        try { Motion.burst(r.left + 10, r.top + 10, 'task'); } catch (e) { /* ignore */ }
      }
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
    btn.title = 'Theme and colours';
    const foot = document.querySelector('.sidebar-foot');
    if (foot) {
      btn.className = 'nav-item th-btn';
      foot.insertBefore(btn, foot.firstChild);
    } else {
      btn.className = 'top-act th-btn';
      btn.setAttribute('aria-label', 'Theme and colours');
      const anchor = document.getElementById('searchBtn') || document.getElementById('syncBtn');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
      else document.querySelector('header')?.appendChild(btn);
    }
    // One plain click, one obvious outcome: the panel with light, dark and the
    // colours. A hidden press-and-hold is not a button anyone finds.
    btn.addEventListener('click', () => this.panel());
  },

  styles() {
    const css = `
    .th-btn{position:relative}
    .th-btn svg{flex-shrink:0}
    .th-btn span{flex:1;text-align:left}
    .th-dot{width:11px;height:11px;border-radius:50%;flex-shrink:0;
      background:linear-gradient(135deg,var(--blue),var(--blue-2));
      box-shadow:0 0 0 1px var(--surface),0 2px 6px -2px var(--blue-glow)}
    .top-act .th-dot{position:absolute;right:5px;bottom:5px;width:8px;height:8px}
    .th-modes .btn{flex-direction:column;align-items:flex-start;gap:1px;padding:9px 13px}
    .th-hint{font-size:10.5px;opacity:.75;font-weight:500}
    .th-swatches{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:9px;margin-top:11px}
    .th-backs{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px;margin-top:11px}
    .th-back{display:flex;flex-direction:column;gap:5px;padding:9px;cursor:pointer;font:inherit;text-align:left;
      background:var(--surface-2);border:1px solid var(--border);border-radius:12px;color:var(--text-2)}
    .th-back i{height:40px;border-radius:8px;display:block;border:1px solid var(--border)}
    .th-back b{font-size:12.5px;color:var(--text)}
    .th-back span{font-size:10.5px;color:var(--text-3);line-height:1.4}
    .th-back.on{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}
    .th-back:hover{transform:translateY(-1px)}
    [data-sample="plain"]{background:var(--bg)}
    [data-sample="aurora"]{background:radial-gradient(60% 60% at 15% 0%,rgba(var(--acc-rgb),.5),transparent 70%),radial-gradient(55% 55% at 90% 15%,rgba(var(--acc2-rgb),.42),transparent 70%),var(--bg)}
    [data-sample="mesh"]{background:radial-gradient(40% 40% at 18% 20%,rgba(var(--acc-rgb),.5),transparent 65%),radial-gradient(36% 36% at 80% 28%,rgba(var(--violet-rgb),.44),transparent 65%),radial-gradient(38% 38% at 70% 84%,rgba(var(--acc2-rgb),.4),transparent 65%),var(--bg)}
    [data-sample="dusk"]{background:linear-gradient(160deg,rgba(var(--violet-rgb),.55),transparent 50%),linear-gradient(20deg,rgba(var(--acc-rgb),.5),transparent 55%),var(--bg)}
    [data-sample="ember"]{background:radial-gradient(60% 55% at 20% 5%,rgba(var(--amber-rgb),.5),transparent 70%),radial-gradient(55% 50% at 85% 95%,rgba(var(--red-rgb),.42),transparent 70%),var(--bg)}
    [data-sample="forest"]{background:radial-gradient(60% 55% at 80% 0%,rgba(var(--green-rgb),.5),transparent 70%),radial-gradient(50% 50% at 10% 90%,rgba(var(--acc2-rgb),.36),transparent 70%),var(--bg)}
    [data-sample="grid"]{background:linear-gradient(rgba(var(--acc-rgb),.28) 1px,transparent 1px),linear-gradient(90deg,rgba(var(--acc-rgb),.28) 1px,transparent 1px),var(--bg);background-size:11px 11px,11px 11px,auto}
    [data-sample="dots"]{background:radial-gradient(rgba(var(--acc2-rgb),.5) 1.2px,transparent 1.2px),var(--bg);background-size:9px 9px,auto}
    .th-range{display:flex;flex-direction:column;gap:6px;margin-top:14px;font-size:12.5px;color:var(--text-2)}
    .th-range.off{opacity:.45;pointer-events:none}
    .th-range b{color:var(--text)}
    .th-range .th-hint{font-size:11px;color:var(--text-3)}
    .th-swatch{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 6px;cursor:pointer;
      background:var(--surface-2);border:1px solid var(--border);border-radius:13px;color:var(--text-2);
      font:inherit;font-size:11.5px;transition:border-color .18s,transform .18s var(--ease)}
    .th-swatch:hover{transform:translateY(-2px);border-color:var(--border-2)}
    .th-swatch i{width:26px;height:26px;border-radius:50%;background:var(--sw);
      box-shadow:0 4px 12px -5px var(--sw),inset 0 0 0 1px rgba(255,255,255,.18)}
    .th-swatch.on{border-color:var(--sw);color:var(--text);box-shadow:0 0 0 1px var(--sw)}
    .th-switch{display:flex;gap:10px;align-items:flex-start;margin-top:9px;font-size:13px;
      line-height:1.6;color:var(--text-2);cursor:pointer}
    .th-switch input{width:17px;height:17px;flex-shrink:0;margin-top:2px;accent-color:var(--blue)}
    .th-switch b{color:var(--text);font-weight:600}
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
