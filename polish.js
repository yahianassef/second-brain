/* =========================================================
   POLISH — the small movements that make it feel built
   =========================================================
   Nothing here changes what the app does. It adds the motion an interface is
   expected to have, and takes the edges off the phone:

     • views cross-fade and lift in instead of appearing
     • cards, rows and tiles arrive in a quick stagger
     • a press on anything tappable gives way under the finger
     • a ripple from where you actually touched
     • bars and rings grow from nothing the first time they are drawn
     • the phone's tab bar slides a lit marker rather than jumping it
     • momentum scrolling, no tap-highlight, no accidental text selection
     • modals and sheets spring rather than snap

   All of it is CSS where it can be, obeys reduce-motion, and switches off with
   the Living background toggle so one switch calms the whole app.
   ========================================================= */
const Polish = {
  calm() {
    try {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (e) { /* older browser */ }
    return (DB.settings || {}).fxAmbient === false;
  },

  /** A ripple where the finger or cursor actually landed. */
  ripple(e) {
    if (this.calm()) return;
    const hit = e.target.closest('button, .card.tap, .nav-item, .more-tile, .gym-card, .item.tap, .side-btn, .seg button, .chip.tap');
    if (!hit || hit.disabled || hit.dataset.noRipple !== undefined) return;
    const box = hit.getBoundingClientRect();
    if (box.width > 900 || box.height > 600) return;         // not on huge panels
    const dot = document.createElement('span');
    dot.className = 'fx-ripple';
    const size = Math.max(box.width, box.height) * 1.2;
    dot.style.width = dot.style.height = size + 'px';
    dot.style.left = (e.clientX - box.left - size / 2) + 'px';
    dot.style.top = (e.clientY - box.top - size / 2) + 'px';
    const was = getComputedStyle(hit).position;
    if (was === 'static') hit.style.position = 'relative';
    hit.appendChild(dot);
    setTimeout(() => dot.remove(), 620);
  },

  /** Give each child a place in the queue so they can arrive in order. */
  stagger(root) {
    const host = root || document.getElementById('view');
    if (!host) return;
    let i = 0;
    host.querySelectorAll(':scope > .card, :scope > section > .card, :scope > .stats > .card, '
      + ':scope > .gym-grid > .gym-card, :scope > .more-grid > .more-tile, :scope > .stat-grid > .stat')
      .forEach(el => {
        el.style.setProperty('--fx-i', Math.min(i, 12));
        i++;
      });
  },

  /** Bars and rings draw themselves in, once, when a view is painted. */
  grow(root) {
    if (this.calm()) return;
    const host = root || document.getElementById('view');
    if (!host) return;
    host.querySelectorAll('.bar > i').forEach(bar => {
      const to = bar.style.width;
      if (!to || bar.dataset.grown) return;
      bar.dataset.grown = '1';
      bar.style.width = '0%';
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = to; }));
    });
    host.querySelectorAll('svg circle[stroke-dasharray]').forEach(ring => {
      if (ring.dataset.grown) return;
      ring.dataset.grown = '1';
      const dash = ring.getAttribute('stroke-dasharray');
      const off = ring.getAttribute('stroke-dashoffset');
      if (off === null) return;
      ring.setAttribute('stroke-dashoffset', dash.split(/[ ,]/)[0]);
      requestAnimationFrame(() => requestAnimationFrame(() => { ring.setAttribute('stroke-dashoffset', off); }));
    });
  },

  /** The phone's tab bar: slide the marker between tabs. */
  navMarker() {
    const nav = document.querySelector('.navbar');
    if (!nav) return;
    let bar = nav.querySelector('.fx-navbar-marker');
    if (!bar) {
      bar = document.createElement('i');
      bar.className = 'fx-navbar-marker';
      nav.appendChild(bar);
    }
    const on = nav.querySelector('button.on');
    if (!on) { bar.style.opacity = '0'; return; }
    const box = on.getBoundingClientRect(), host = nav.getBoundingClientRect();
    bar.style.opacity = '1';
    bar.style.width = Math.round(box.width * 0.42) + 'px';
    bar.style.transform = `translateX(${Math.round(box.left - host.left + box.width * 0.29)}px)`;
  },

  afterRender() {
    this.stagger();
    this.grow();
    this.navMarker();
    const view = document.getElementById('view');
    if (view && !this.calm()) {
      view.classList.remove('fx-in');
      void view.offsetWidth;
      view.classList.add('fx-in');
    }
  },

  init() {
    if (typeof DB === 'undefined' || typeof render !== 'function') return;
    this.styles();

    const paint = render;
    render = (...a) => {
      paint.apply(null, a);
      try { this.afterRender(); } catch (e) { /* never block a render */ }
    };

    document.addEventListener('pointerdown', e => this.ripple(e), { passive: true });
    window.addEventListener('resize', () => this.navMarker());
    setTimeout(() => this.afterRender(), 60);
  },

  styles() {
    const s = document.createElement('style');
    s.textContent = `
    /* ---- the phone, first: scrolling and touch feel ---- */
    html{-webkit-text-size-adjust:100%}
    body{-webkit-tap-highlight-color:transparent;overscroll-behavior-y:contain}
    .screen,.content,.modal,.g-side,.sheet{-webkit-overflow-scrolling:touch}
    button,.card.tap,.nav-item,.more-tile,.gym-card,.item.tap,.side-btn{
      -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
    input,textarea,select,.prose,.gym-block,[contenteditable]{-webkit-user-select:auto;user-select:auto}

    /* ---- a finger is wider than a cursor ---- */
    @media (hover:none){
      .link-btn,.g-chip,.g-crumb,.seg button,.chip.tap,.gym-tabs .btn,.gym-tools .btn{
        min-height:42px;display:inline-flex;align-items:center}
      .g-crumb{padding:6px 2px}
      .icon-btn{min-width:40px;min-height:40px}
      .navbar button{min-height:52px}
    }

    /* ---- a press gives way ---- */
    @media (hover:none){
      button:active,.card.tap:active,.more-tile:active,.gym-card:active,.item.tap:active{
        transform:scale(.975);transition:transform .07s ease-out}
    }
    .btn,.nav-item,.more-tile,.gym-card,.side-btn,.chip,.icon-btn{
      transition:transform .14s var(--ease),background-color .18s,border-color .18s,box-shadow .18s,color .18s}
    .btn:active,.icon-btn:active{transform:scale(.96)}

    /* ---- a ripple from where you touched ---- */
    .fx-ripple{position:absolute;border-radius:50%;pointer-events:none;z-index:0;
      background:radial-gradient(circle,rgba(var(--acc2-rgb),.30),rgba(var(--acc2-rgb),0) 70%);
      animation:fxRipple .6s var(--ease) forwards}
    @keyframes fxRipple{from{opacity:.9;transform:scale(.25)}to{opacity:0;transform:scale(1)}}

    /* ---- a view arrives rather than appears ---- */
    #view.fx-in > *{animation:fxRise .42s var(--ease) both;
      animation-delay:calc(var(--fx-i,0) * 38ms)}
    @keyframes fxRise{from{opacity:0;transform:translateY(10px) scale(.994)}to{opacity:1;transform:none}}

    /* ---- bars and rings draw in ---- */
    .bar > i{transition:width .7s var(--ease)}
    svg circle[stroke-dasharray]{transition:stroke-dashoffset .9s var(--ease)}

    /* ---- modals and sheets spring ---- */
    .overlay .modal{animation:fxModal .26s var(--ease) both}
    @keyframes fxModal{from{opacity:0;transform:translateY(14px) scale(.975)}to{opacity:1;transform:none}}
    .sheet{animation:fxSheet .3s var(--ease) both}
    @keyframes fxSheet{from{transform:translateY(100%)}to{transform:none}}

    /* ---- the phone's tab bar gets a marker that slides ---- */
    .navbar{position:fixed}
    .fx-navbar-marker{position:absolute;top:0;left:0;height:3px;border-radius:0 0 4px 4px;
      background:linear-gradient(90deg,var(--blue),var(--blue-2));box-shadow:0 0 12px var(--blue-glow);
      transition:transform .32s var(--ease),width .32s var(--ease),opacity .2s;pointer-events:none;opacity:0}
    .navbar button.on::before{display:none}

    /* ---- the brand mark breathes, very slightly ---- */
    .brand-mark,.cg-mark{animation:fxBreathe 6s ease-in-out infinite}
    @keyframes fxBreathe{0%,100%{box-shadow:0 8px 24px -8px var(--blue-glow)}
      50%{box-shadow:0 10px 30px -8px var(--blue-glow),0 0 0 3px rgba(var(--acc2-rgb),.10)}}

    /* ---- nothing moves when you have asked for that ---- */
    @media (prefers-reduced-motion:reduce){
      #view.fx-in > *,.overlay .modal,.sheet,.brand-mark,.cg-mark{animation:none!important}
      .fx-ripple{display:none}
      .fx-navbar-marker{transition:none}
    }`;
    document.head.appendChild(s);
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Polish.init());
else Polish.init();
