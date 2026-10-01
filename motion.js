/* =========================================================
   MOTION — the app with a pulse
   =========================================================
   Three things, all optional and all built from the accent colour, so they
   follow whatever theme you picked:

     • a drifting field of linked nodes behind everything, which is the app's
       own mark — circles joined by lines — made ambient
     • numbers that count up to their new value instead of snapping to it
     • a small burst when you finish a task or tick a habit

   It stays out of the way: paused when the tab is hidden, capped at 30 frames
   a second, switched off entirely by the system's reduce-motion setting, and
   drawn on one canvas that never takes a click.
   ========================================================= */
const MOTION_FPS = 30;

const Motion = {
  canvas: null, ctx: null, nodes: [], sparks: [], raf: null, last: 0, dpr: 1,
  w: 0, h: 0, seen: new Map(), running: false,
  px: -999, py: -999, pointerSeen: 0,

  reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  },
  ambientOn() { return !this.reduced() && (DB.settings || {}).fxAmbient !== false; },
  celebrateOn() { return !this.reduced() && (DB.settings || {}).fxCelebrate !== false; },

  /* ---------------- the canvas everything is drawn on ---------------- */
  surface() {
    if (this.canvas) return this.canvas;
    const c = document.createElement('canvas');
    c.id = 'motionFx';
    document.body.insertBefore(c, document.body.firstChild);
    this.canvas = c;
    this.ctx = c.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    return c;
  },

  resize() {
    if (!this.canvas) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.seed();
  },

  /** Enough nodes to feel alive, few enough to stay cheap on a phone. */
  seed() {
    const target = Math.max(14, Math.min(44, Math.round(this.w * this.h / 32000)));
    const made = [];
    for (let i = 0; i < target; i++) {
      const old = this.nodes[i];
      made.push(old && old.x < this.w && old.y < this.h ? old : {
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        vx: (Math.random() - 0.5) * 0.14,
        vy: (Math.random() - 0.5) * 0.14,
        r: 1.1 + Math.random() * 1.7
      });
    }
    this.nodes = made;
  },

  /** The accent, read live, so changing the colour changes the field. */
  ink() {
    const cs = getComputedStyle(document.documentElement);
    const rgb = (cs.getPropertyValue('--acc2-rgb') || '0,168,255').trim();
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return { rgb, dot: light ? 0.38 : 0.55, line: light ? 0.16 : 0.22 };
  },

  frame(now) {
    this.raf = requestAnimationFrame(t => this.frame(t));
    if (now - this.last < 1000 / MOTION_FPS) return;
    this.last = now;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const ink = this.ink();

    if (this.ambientOn()) {
      const near = Math.min(170, Math.max(110, this.w / 7));
      this.nodes.forEach(n => {
        n.x += n.vx; n.y += n.vy;
        if (n.x < -20) n.x = this.w + 20; else if (n.x > this.w + 20) n.x = -20;
        if (n.y < -20) n.y = this.h + 20; else if (n.y > this.h + 20) n.y = -20;
      });
      // lines first, so the dots sit on top of them
      ctx.lineWidth = 1;
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + 1; j < this.nodes.length; j++) {
          const a = this.nodes[i], b = this.nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d > near) continue;
          ctx.strokeStyle = `rgba(${ink.rgb},${(1 - d / near) * ink.line})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      // whatever is near the pointer leans towards it and brightens
      const reach = 150;
      const fresh = now - this.pointerSeen < 2600;
      this.nodes.forEach(n => {
        let glow = 0;
        if (fresh) {
          const d = Math.hypot(n.x - this.px, n.y - this.py);
          if (d < reach) {
            glow = 1 - d / reach;
            ctx.strokeStyle = `rgba(${ink.rgb},${glow * (ink.line * 2.6)})`;
            ctx.beginPath();
            ctx.moveTo(n.x, n.y);
            ctx.lineTo(this.px, this.py);
            ctx.stroke();
          }
        }
        ctx.fillStyle = `rgba(${ink.rgb},${Math.min(0.9, ink.dot + glow * 0.45)})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + glow * 1.4, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // a burst fades and falls, then removes itself
    this.sparks = this.sparks.filter(s => s.life > 0);
    this.sparks.forEach(s => {
      s.life -= 1;
      s.x += s.vx; s.y += s.vy;
      s.vy += 0.16;                       // a little gravity reads as celebratory
      s.vx *= 0.98;
      const a = Math.max(0, s.life / s.max);
      ctx.fillStyle = `rgba(${s.rgb},${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * a + 0.6, 0, Math.PI * 2);
      ctx.fill();
    });

    // nothing moving and nothing to celebrate: stop burning frames
    if (!this.ambientOn() && !this.sparks.length) this.stop();
  },

  start() {
    if (this.running) return;
    if (!this.ambientOn() && !this.sparks.length) return;
    this.surface();
    this.running = true;
    this.raf = requestAnimationFrame(t => this.frame(t));
  },
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.ctx) this.ctx.clearRect(0, 0, this.w, this.h);
  },
  refresh() {
    document.body.classList.toggle('fx-ambient', this.ambientOn());
    if (this.ambientOn()) { this.start(); } else if (!this.sparks.length) { this.stop(); }
  },

  /* ---------------- a burst where you tapped ---------------- */
  burst(x, y, which) {
    if (!this.celebrateOn()) return;
    this.surface();
    const cs = getComputedStyle(document.documentElement);
    const rgb = which === 'habit'
      ? (cs.getPropertyValue('--green-rgb') || '34,197,94').trim()
      : (cs.getPropertyValue('--acc2-rgb') || '0,168,255').trim();
    for (let i = 0; i < 16; i++) {
      const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.4;
      const speed = 1.6 + Math.random() * 2.6;
      const life = 26 + Math.random() * 16;
      this.sparks.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 1.1,
        r: 1.4 + Math.random() * 1.8, life, max: life, rgb
      });
    }
    this.start();
  },

  /* ---------------- numbers that count up ---------------- */
  /** Splits "AED 1,819.00" into prefix, number and suffix so units survive. */
  parse(text) {
    const m = String(text).match(/^(\D*?)([\d][\d,\s]*(?:\.\d+)?)(.*)$/);
    if (!m) return null;
    // the digit group happily swallows a trailing space ("1 day"), which would
    // come back as "1day" — hand any of it back to the suffix
    const digits = m[2].replace(/\s+$/, '');
    const post = m[2].slice(digits.length) + m[3];
    const n = Number(digits.replace(/[,\s]/g, ''));
    if (!isFinite(n)) return null;
    return { pre: m[1], n, post, decimals: (digits.split('.')[1] || '').length, grouped: digits.includes(',') };
  },

  countUp() {
    if (this.reduced() || (DB.settings || {}).fxCount === false) return;
    document.querySelectorAll('.stat .value').forEach(el => {
      const label = (el.closest('.stat')?.querySelector('.label')?.textContent || '') + '|' + (UI.view || '');
      const parsed = this.parse(el.textContent.trim());
      if (!parsed) { this.seen.set(label, null); return; }
      const before = this.seen.get(label);
      this.seen.set(label, parsed.n);
      // only when it actually changed, and never on a jump so large it would blur
      if (before === undefined || before === null || before === parsed.n) return;
      if (Math.abs(parsed.n - before) > 1e7) return;

      const start = performance.now();
      const span = 520;
      const fmt = v => parsed.pre + (parsed.grouped
        ? v.toLocaleString(undefined, { minimumFractionDigits: parsed.decimals, maximumFractionDigits: parsed.decimals })
        : v.toFixed(parsed.decimals)) + parsed.post;
      const tick = now => {
        const t = Math.min(1, (now - start) / span);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = fmt(before + (parsed.n - before) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = fmt(parsed.n);
      };
      requestAnimationFrame(tick);
    });
  },

  /* ---------------- wiring ---------------- */
  init() {
    if (typeof DB === 'undefined') return;
    this.styles();

    // a completed task or habit gets a burst from wherever it was tapped
    document.addEventListener('click', e => {
      const hit = e.target.closest('[data-act="toggleTask"], [data-act="toggleHabit"]');
      if (!hit || hit.classList.contains('on')) return;     // only on the way to done
      const r = hit.getBoundingClientRect();
      this.burst(r.left + r.width / 2, r.top + r.height / 2,
        hit.dataset.act === 'toggleHabit' ? 'habit' : 'task');
    }, true);

    // after every repaint, let the figures catch up to their new values
    const paint = render;
    render = function (...a) { paint.apply(null, a); try { Motion.countUp(); } catch (e) { /* never block a render */ } };

    window.addEventListener('pointermove', e => {
      this.px = e.clientX; this.py = e.clientY; this.pointerSeen = performance.now();
      if (!this.running) this.refresh();
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop(); else this.refresh();
    });
    try {
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => this.refresh());
    } catch (e) { /* older Safari */ }

    this.refresh();
  },

  styles() {
    const s = document.createElement('style');
    s.textContent = `
    /* Above the page colour, below everything you read or tap. The desktop's
       main pane paints an opaque background over it, so that one layer is made
       transparent while its gradients stay. */
    #motionFx{position:fixed;inset:0;z-index:0;pointer-events:none}
    .app{position:relative;z-index:1}
    .main{background-color:transparent}
    .screen{position:relative;z-index:1}
    /* A slow wash of accent light across the top band, which is the one part
       of the page no card sits on. */
    /* The wash is clipped to its container: it drifts and scales, and either
       would otherwise push the page sideways. */
    body.fx-ambient .main{overflow:hidden}
    body.fx-ambient .screen{overflow-x:clip}
    body.fx-ambient .main::after,
    body.fx-ambient .screen::after{content:'';position:absolute;left:-12%;right:-12%;top:-18%;height:62%;
      pointer-events:none;z-index:0;
      background:radial-gradient(42% 60% at 22% 0%,rgba(var(--acc-rgb),.20),transparent 70%),
                 radial-gradient(38% 55% at 78% 8%,rgba(var(--acc2-rgb),.15),transparent 70%);
      animation:fxDrift 26s ease-in-out infinite alternate}
    body.fx-ambient .screen::after{top:0;height:46%}
    .content,.screen > *{position:relative;z-index:1}
    @keyframes fxDrift{
      0%{transform:translate3d(-3%,0,0) scale(1);opacity:.85}
      50%{transform:translate3d(4%,2%,0) scale(1.09);opacity:1}
      100%{transform:translate3d(-2%,-2%,0) scale(1.04);opacity:.9}}
    @media (prefers-reduced-motion:reduce){#motionFx{display:none}
      body.fx-ambient .main::after,body.fx-ambient .screen::after{animation:none}}`;
    document.head.appendChild(s);
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Motion.init());
else Motion.init();
