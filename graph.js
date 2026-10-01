/* =========================================================
   MAP — everything you keep, and what it is connected to
   =========================================================
   A force-directed view of your projects, tasks, notes, journal entries,
   courses, habits and goals. Three kinds of connection appear:

     • the ones already implied by your data — a task belongs to a project
     • the ones your writing implies — [[Double brackets]] in a note or journal
       entry, the way Obsidian does it, matched against everything by title
     • the ones you draw yourself — tap Link, then two things

   Links you draw are stored in DB.links and sync like any other collection, so
   the map is the same on your phone.
   ========================================================= */
const GRAPH_TYPES = {
  projects: { label: 'Projects', colour: '--violet', title: 'name' },
  tasks: { label: 'Tasks', colour: '--blue-2', title: 'title' },
  notes: { label: 'Notes', colour: '--amber', title: 'title' },
  journal: { label: 'Journal', colour: '--green', title: 'title' },
  courses: { label: 'Courses', colour: '--acc-t', title: 'name' },
  habits: { label: 'Habits', colour: '--green-t', title: 'name' },
  goals: { label: 'Goals', colour: '--red-t', title: 'name' }
};

const Graph = {
  nodes: [], edges: [], byKey: new Map(),
  canvas: null, ctx: null, raf: null, w: 0, h: 0, dpr: 1,
  view: { x: 0, y: 0, k: 1 },
  drag: null, hover: null, picked: null, linkFrom: null,
  alpha: 1, pointer: { x: 0, y: 0 }, ro: null, settled: false,
  level: { kind: 'hubs', type: '', focus: '' },        // where you have drilled to

  key: (type, id) => type + ':' + id,
  titleOf(type, item) { return String(item[(GRAPH_TYPES[type] || {}).title || 'title'] || item.name || item.title || 'Untitled'); },

  hidden() {
    const h = (DB.settings || {}).graphHidden;
    return Array.isArray(h) ? h : [];
  },

  /* ---------------- what is connected to what ---------------- */
  /** Every item of every visible type, with the edges between them. The levels
      above are drawn from this, so a connection means the same thing wherever
      you are. */
  buildAll() {
    const hidden = this.hidden();
    const keep = new Map();                        // key -> node
    const old = new Map(this.nodes.map(n => [n.key, n]));

    Object.keys(GRAPH_TYPES).forEach(type => {
      if (hidden.includes(type)) return;
      (DB[type] || []).forEach(item => {
        if (!item || !item.id) return;
        if (type === 'tasks' && item.status === 'Done' && (DB.settings || {}).graphDone === false) return;
        const key = this.key(type, item.id);
        const was = old.get(key);
        keep.set(key, {
          key, type, id: item.id, item,
          title: this.titleOf(type, item),
          x: was ? was.x : (Math.random() - 0.5) * 420,
          y: was ? was.y : (Math.random() - 0.5) * 420,
          vx: 0, vy: 0, deg: 0
        });
      });
    });

    const edges = [];
    const add = (aKey, bKey, kind) => {
      if (aKey === bKey || !keep.has(aKey) || !keep.has(bKey)) return;
      const id = aKey < bKey ? aKey + '|' + bKey : bKey + '|' + aKey;
      if (edges.some(e => e.id === id && e.kind === kind)) return;
      edges.push({ id, kind, a: keep.get(aKey), b: keep.get(bKey) });
    };

    // what your data already says
    (DB.tasks || []).forEach(t => t.projectId && add(this.key('tasks', t.id), this.key('projects', t.projectId), 'belongs'));
    (DB.goals || []).forEach(g => g.projectId && add(this.key('goals', g.id), this.key('projects', g.projectId), 'belongs'));

    // shared tags, which is how notes and journal entries find each other
    const byTag = new Map();
    keep.forEach(n => {
      const tags = Array.isArray(n.item.tags) ? n.item.tags : [];
      tags.forEach(raw => {
        const tag = String(raw).trim().toLowerCase();
        if (!tag) return;
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(n.key);
      });
    });
    byTag.forEach(list => {
      if (list.length > 12) return;                // a tag on everything says nothing
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i], list[j], 'tag');
    });

    // [[double brackets]] in anything you have written
    const byTitle = new Map();
    keep.forEach(n => {
      const t = n.title.trim().toLowerCase();
      if (t && !byTitle.has(t)) byTitle.set(t, n.key);
    });
    keep.forEach(n => {
      const text = [n.item.content, n.item.notes, n.item.description].filter(Boolean).join('\n');
      const found = text.match(/\[\[([^\]]{1,80})\]\]/g) || [];
      found.forEach(raw => {
        const want = raw.slice(2, -2).trim().toLowerCase();
        const hit = byTitle.get(want);
        if (hit) add(n.key, hit, 'wiki');
      });
    });

    // the ones you drew
    (DB.links || []).forEach(l => l && l.a && l.b && add(l.a, l.b, 'manual'));

    edges.forEach(e => { e.a.deg++; e.b.deg++; });
    return { nodes: [...keep.values()], edges, byKey: keep };
  },

  /** What to show, given how far you have drilled in. */
  build() {
    const all = this.buildAll();
    const lvl = this.level;

    if (lvl.kind === 'hubs') {
      // one dot per kind of thing, joined where their items are joined
      const old = new Map(this.nodes.map(n => [n.key, n]));
      const hubs = new Map();
      Object.keys(GRAPH_TYPES).forEach(type => {
        if (this.hidden().includes(type)) return;
        const count = all.nodes.filter(n => n.type === type).length;
        if (!count) return;
        const key = 'hub:' + type;
        const was = old.get(key);
        hubs.set(key, {
          key, type, hub: true, count,
          title: GRAPH_TYPES[type].label + ' · ' + count,
          x: was ? was.x : (Math.random() - 0.5) * 300,
          y: was ? was.y : (Math.random() - 0.5) * 300,
          vx: 0, vy: 0, deg: 0
        });
      });
      const seen = new Map();
      all.edges.forEach(e => {
        if (e.a.type === e.b.type) return;
        const a = 'hub:' + e.a.type, b = 'hub:' + e.b.type;
        if (!hubs.has(a) || !hubs.has(b)) return;
        const id = a < b ? a + '|' + b : b + '|' + a;
        const hit = seen.get(id);
        if (hit) { hit.weight++; return; }
        const edge = { id, kind: 'hub', weight: 1, a: hubs.get(a), b: hubs.get(b) };
        seen.set(id, edge);
      });
      const edges = [...seen.values()];
      edges.forEach(e => { e.a.deg += e.weight; e.b.deg += e.weight; });
      this.nodes = [...hubs.values()];
      this.edges = edges;
      this.byKey = hubs;
      this.alpha = 1;
      return;
    }

    if (lvl.kind === 'type') {
      // everything of one kind, plus whatever each one touches
      const wanted = new Set(all.nodes.filter(n => n.type === lvl.type).map(n => n.key));
      all.edges.forEach(e => {
        if (wanted.has(e.a.key)) wanted.add(e.b.key);
        else if (wanted.has(e.b.key)) wanted.add(e.a.key);
      });
      this.useSubset(all, wanted);
      return;
    }

    // one item and the things it touches, plus their links to each other
    const near = new Set([lvl.focus]);
    all.edges.forEach(e => {
      if (e.a.key === lvl.focus) near.add(e.b.key);
      if (e.b.key === lvl.focus) near.add(e.a.key);
    });
    this.useSubset(all, near);
  },

  useSubset(all, keys) {
    const keep = new Map();
    all.nodes.forEach(n => { if (keys.has(n.key)) { n.deg = 0; keep.set(n.key, n); } });
    const edges = all.edges.filter(e => keep.has(e.a.key) && keep.has(e.b.key));
    edges.forEach(e => { e.a.deg++; e.b.deg++; });
    this.nodes = [...keep.values()];
    this.edges = edges;
    this.byKey = keep;
    this.alpha = 1;
  },

  /** Drill in one step, or back out. */
  drill(node) {
    if (node.hub) { this.level = { kind: 'type', type: node.type, focus: '' }; }
    else { this.level = { kind: 'focus', type: node.type, focus: node.key }; }
    this.picked = node.hub ? null : node;
    this.settled = false;
    this.refit();
  },
  up() {
    const lvl = this.level;
    if (lvl.kind === 'focus') this.level = { kind: 'type', type: lvl.type, focus: '' };
    else if (lvl.kind === 'type') this.level = { kind: 'hubs', type: '', focus: '' };
    this.picked = null;
    this.linkFrom = null;
    this.settled = false;
    this.refit();
  },
  refit() {
    this.build();
    for (let i = 0; i < 160; i++) this.step();
    this.frameAll();
    this.alpha = 0.3;
    this.settled = true;
    this.paintBar();
    this.paintTrail();
    this.draw();
  },

  /* ---------------- layout ---------------- */
  step() {
    const nodes = this.nodes, n = nodes.length;
    if (!n) return;
    const repel = 5200, spring = 0.014, len = 86, centre = 0.012;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
        if (d2 > 240000) continue;                 // far enough apart to ignore
        const f = repel / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
    }
    this.edges.forEach(e => {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - len) * spring;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      e.a.vx += fx; e.a.vy += fy; e.b.vx -= fx; e.b.vy -= fy;
    });
    nodes.forEach(p => {
      p.vx -= p.x * centre; p.vy -= p.y * centre;
      if (this.drag === p) { p.vx = p.vy = 0; return; }
      p.vx *= 0.82; p.vy *= 0.82;
      p.x += Math.max(-18, Math.min(18, p.vx * this.alpha));
      p.y += Math.max(-18, Math.min(18, p.vy * this.alpha));
    });
    this.alpha = Math.max(0.02, this.alpha * 0.985);
  },

  /* ---------------- drawing ---------------- */
  colour(node, alpha) {
    const cs = getComputedStyle(document.documentElement);
    const hex = (cs.getPropertyValue(GRAPH_TYPES[node.type].colour) || '#0066FF').trim();
    if (alpha === undefined) return hex;
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  },
  radius(node) { return node.hub ? 13 + Math.min(16, Math.sqrt(node.count) * 2.4) : 5 + Math.min(10, node.deg * 1.5); },

  toScreen(p, sway) {
    const q = sway ? this.bob(p) : p;
    return { x: (q.x + this.view.x) * this.view.k + this.w / 2, y: (q.y + this.view.y) * this.view.k + this.h / 2 };
  },
  toWorld(x, y) { return { x: (x - this.w / 2) / this.view.k - this.view.x, y: (y - this.h / 2) / this.view.k - this.view.y }; },

  /** A gentle sway, so a settled map still looks alive. Drawing only — the
      layout underneath does not move, and it stops for reduce-motion. */
  bob(p) {
    if (this.still) return { x: p.x, y: p.y };
    const t = performance.now() / 1000;
    const seed = (p.key.charCodeAt(0) + p.key.length * 7) % 100;
    return { x: p.x + Math.sin(t * 0.5 + seed) * 2.1, y: p.y + Math.cos(t * 0.42 + seed * 1.3) * 2.1 };
  },

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const cs = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, this.w, this.h);

    const near = this.hover || this.picked;
    const linked = new Set();
    if (near) {
      linked.add(near.key);
      this.edges.forEach(e => {
        if (e.a.key === near.key) linked.add(e.b.key);
        if (e.b.key === near.key) linked.add(e.a.key);
      });
    }

    const lineRGB = (cs.getPropertyValue('--text2-rgb') || '163,173,191').trim();
    this.edges.forEach(e => {
      const a = this.toScreen(e.a, true), b = this.toScreen(e.b, true);
      const on = !near || (linked.has(e.a.key) && linked.has(e.b.key));
      ctx.strokeStyle = e.kind === 'manual'
        ? this.colour(e.a, on ? 0.75 : 0.12)
        : `rgba(${lineRGB},${on ? (e.kind === 'wiki' ? 0.5 : 0.26) : 0.07})`;
      ctx.lineWidth = (e.kind === 'manual' ? 1.8 : 1) * (on ? 1 : 0.8);
      if (e.kind === 'tag') ctx.setLineDash([3, 4]); else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    const label = (cs.getPropertyValue('--text') || '#E8ECF3').trim();
    const dim = (cs.getPropertyValue('--text-3') || '#6B7589').trim();
    this.nodes.forEach(p => {
      const s = this.toScreen(p, true);
      const r = this.radius(p) * Math.min(1.6, Math.max(0.7, this.view.k));
      const on = !near || linked.has(p.key);
      const isFocus = near && near.key === p.key;

      if (isFocus || this.linkFrom === p) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = this.colour(p, 0.18);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = this.colour(p, on ? 0.95 : 0.22);
      ctx.fill();
      if (this.linkFrom === p) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = this.colour(p, 1);
        ctx.stroke();
      }

      // labels only when there is room to read them
      if (this.view.k > 0.55 || isFocus || p.deg > 3) {
        ctx.font = `${isFocus ? 600 : 500} ${Math.max(10, 11.5 * Math.min(1.25, this.view.k))}px ${cs.getPropertyValue('--font') || 'sans-serif'}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = on ? label : dim;
        ctx.globalAlpha = on ? 1 : 0.45;
        const t = p.title.length > 26 ? p.title.slice(0, 24) + '…' : p.title;
        ctx.fillText(t, s.x, s.y + r + 13);
        ctx.globalAlpha = 1;
      }
    });

    if (this.linkFrom) {
      const a = this.toScreen(this.linkFrom);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = this.colour(this.linkFrom, 0.6);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(this.pointer.x, this.pointer.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  },

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    if (document.hidden) return;
    this.still = (DB.settings || {}).fxAmbient === false || (() => {
      try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    })();
    if (this.alpha > 0.03 || this.drag) this.step();
    if (this.alpha > 0.03 || this.drag || !this.still) this.draw();
  },

  /* ---------------- interaction ---------------- */
  at(x, y) {
    let best = null, bestD = 22;
    this.nodes.forEach(p => {
      const s = this.toScreen(p);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < Math.max(bestD, this.radius(p) + 8)) { if (!best || d < bestD) { best = p; bestD = d; } }
    });
    return best;
  },

  wire() {
    const c = this.canvas;
    let panning = null, moved = false;

    const pos = e => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', e => {
      const p = pos(e);
      this.pointer = p;
      moved = false;
      const hit = this.at(p.x, p.y);
      if (hit) { this.drag = hit; c.setPointerCapture(e.pointerId); }
      else panning = { x: p.x, y: p.y, vx: this.view.x, vy: this.view.y };
    });

    c.addEventListener('pointermove', e => {
      const p = pos(e);
      this.pointer = p;
      if (this.drag) {
        const w = this.toWorld(p.x, p.y);
        this.drag.x = w.x; this.drag.y = w.y;
        this.alpha = Math.max(this.alpha, 0.35);
        moved = true;
      } else if (panning) {
        this.view.x = panning.vx + (p.x - panning.x) / this.view.k;
        this.view.y = panning.vy + (p.y - panning.y) / this.view.k;
        moved = true;
        this.draw();
      } else {
        const was = this.hover;
        this.hover = this.at(p.x, p.y);
        c.style.cursor = this.hover ? 'pointer' : 'grab';
        if (was !== this.hover) this.draw();
      }
    });

    const release = e => {
      const p = pos(e);
      const hit = this.at(p.x, p.y);
      if (this.drag && !moved && hit) this.tap(hit);
      else if (!this.drag && !moved && !hit && this.linkFrom) { this.linkFrom = null; this.paintBar(); this.draw(); }
      this.drag = null; panning = null;
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', () => { this.drag = null; panning = null; });

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const p = pos(e);
      const before = this.toWorld(p.x, p.y);
      this.view.k = Math.max(0.25, Math.min(3, this.view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
      const after = this.toWorld(p.x, p.y);
      this.view.x += after.x - before.x;
      this.view.y += after.y - before.y;
      this.draw();
    }, { passive: false });

    // pinch, for the phone
    let pinch = null;
    c.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), k: this.view.k };
        this.drag = null;
      }
    }, { passive: true });
    c.addEventListener('touchmove', e => {
      if (pinch && e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.view.k = Math.max(0.25, Math.min(3, pinch.k * (d / pinch.d)));
        this.draw();
      }
    }, { passive: true });
    c.addEventListener('touchend', () => { pinch = null; }, { passive: true });
  },

  /** A tap either links two things, or opens what you tapped. */
  tap(node) {
    if (node.hub) { this.drill(node); return; }
    if (this.linkFrom && this.linkFrom !== node) {
      this.connect(this.linkFrom, node);
      this.linkFrom = null;
      this.paintBar();
      return;
    }
    if (this.linkFrom === node) { this.linkFrom = null; this.paintBar(); this.draw(); return; }
    // first tap selects, a second one drills into what it touches
    if (this.picked === node && this.level.focus !== node.key) { this.drill(node); return; }
    this.picked = this.picked === node ? null : node;
    this.paintBar();
    this.draw();
  },

  connect(a, b) {
    const pair = [a.key, b.key].sort();
    const already = (DB.links || []).find(l => l && [l.a, l.b].sort().join('|') === pair.join('|'));
    if (already) { toast('Those are already linked'); return; }
    DB.links = (DB.links || []).concat({
      id: uid(), a: a.key, b: b.key,
      created: today(), updated: today(), ts: Date.now()
    });
    saveDB();
    this.build();
    this.alpha = 0.6;
    this.draw();
    toast(`Linked ${a.title} and ${b.title}`, {
      action: 'Undo',
      onAction: () => {
        DB.links = (DB.links || []).filter(l => [l.a, l.b].sort().join('|') !== pair.join('|'));
        saveDB(); this.build(); this.draw(); this.paintBar();
      }
    });
  },

  unlink(aKey, bKey) {
    const pair = [aKey, bKey].sort().join('|');
    const before = (DB.links || []).length;
    DB.links = (DB.links || []).filter(l => [l.a, l.b].sort().join('|') !== pair);
    if (DB.links.length === before) { toast('That connection comes from your data, not a link you drew'); return; }
    saveDB();
    this.build();
    this.paintBar();
    this.draw();
    toast('Link removed');
  },

  paintTrail() {
    const el = document.getElementById('graphTrail');
    if (!el) return;
    const lvl = this.level;
    const focus = lvl.focus ? this.byKey.get(lvl.focus) : null;
    const crumbs = [`<button class="g-crumb" data-g="home">Everything</button>`];
    if (lvl.kind !== 'hubs') {
      crumbs.push(`<span>${icon('chevR', 13)}</span>`);
      crumbs.push(lvl.kind === 'type'
        ? `<b class="g-crumb on">${esc(GRAPH_TYPES[lvl.type].label)}</b>`
        : `<button class="g-crumb" data-g="type" data-key="${esc(lvl.type)}">${esc(GRAPH_TYPES[lvl.type].label)}</button>`);
    }
    if (lvl.kind === 'focus') {
      crumbs.push(`<span>${icon('chevR', 13)}</span>`);
      crumbs.push(`<b class="g-crumb on">${esc(focus ? focus.title : 'Selected')}</b>`);
    }
    el.innerHTML = crumbs.join('') + (lvl.kind === 'hubs'
      ? `<span class="g-hint">Tap a circle to open it</span>`
      : `<button class="btn btn-ghost sm g-up" data-g="up">${icon('chevL', 13)} Back</button>`);
  },

  /* ---------------- the panel beside the map ---------------- */
  paintBar() {
    const bar = document.getElementById('graphSide');
    if (!bar) return;
    const n = this.picked;
    if (!n) {
      const lvl = this.level;
      const where = lvl.kind === 'hubs'
        ? 'Each circle is one kind of thing, sized by how much of it you have. Tap one to open it.'
        : lvl.kind === 'type'
          ? `Every ${GRAPH_TYPES[lvl.type].label.toLowerCase().replace(/s$/, '')} you have, with whatever it touches. Tap one, then tap it again to drill into it.`
          : 'This is one thing and everything it connects to. Tap another to keep going.';
      bar.innerHTML = `<div class="g-empty">${icon('target', 20)}
        <b>${lvl.kind === 'hubs' ? 'Everything you keep' : 'Nothing selected'}</b>
        <span>${where}</span>
        <span>Drag to move, drag the background to pan, scroll or pinch to zoom.</span>
        <span class="g-legend">${Object.entries(GRAPH_TYPES).map(([k, v]) =>
          `<i style="background:var(${v.colour})"></i>${v.label}`).join('')}</span></div>`;
      return;
    }
    const mine = this.edges.filter(e => e.a.key === n.key || e.b.key === n.key);
    const kindLabel = { belongs: 'from your data', tag: 'shared tag', wiki: 'mentioned in writing', manual: 'linked by you' };
    bar.innerHTML = `
      <div class="g-head">
        <span class="g-dot" style="background:${this.colour(n)}"></span>
        <div><b>${esc(n.title)}</b><span>${GRAPH_TYPES[n.type].label.replace(/s$/, '')}</span></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary sm" data-g="drill">${icon('share', 14)} Drill in</button>
        <button class="btn btn-ghost sm" data-g="open">${icon('edit', 14)} Open</button>
        <button class="btn ${this.linkFrom === n ? 'btn-primary' : 'btn-ghost'} sm" data-g="link">${icon('link', 14)} ${this.linkFrom === n ? 'Pick the other one' : 'Link to…'}</button>
      </div>
      <div class="g-conns">
        <h4>${mine.length ? plural(mine.length, 'connection') : 'No connections yet'}</h4>
        ${mine.map(e => {
          const other = e.a.key === n.key ? e.b : e.a;
          return `<div class="g-conn" data-g="go" data-key="${esc(other.key)}">
            <span class="g-dot sm" style="background:${this.colour(other)}"></span>
            <div class="grow"><b>${esc(other.title)}</b><span>${kindLabel[e.kind]}</span></div>
            ${e.kind === 'manual' ? `<button class="icon-btn sm" data-g="cut" data-key="${esc(other.key)}" title="Remove this link">${icon('x', 14)}</button>` : ''}
          </div>`;
        }).join('')}
      </div>`;
  },

  /* ---------------- mounting into a view ---------------- */
  html() {
    const hidden = this.hidden();
    return `<div class="g-wrap">
      <div class="g-trail" id="graphTrail"></div>
      <div class="g-bar">
        ${Object.entries(GRAPH_TYPES).map(([k, v]) =>
          `<button class="g-chip${hidden.includes(k) ? ' off' : ''}" data-g="type" data-key="${k}">
            <i style="background:var(${v.colour})"></i>${v.label}</button>`).join('')}
        <span class="spacer"></span>
        <button class="btn btn-ghost sm" data-g="retidy">${icon('sparkle', 14)} Tidy up</button>
      </div>
      <div class="g-stage"><div class="g-canvas"><canvas id="graphCanvas"></canvas></div><div id="graphSide" class="g-side"></div></div>
    </div>`;
  },

  mount() {
    const c = document.getElementById('graphCanvas');
    if (!c) { this.unmount(); return; }
    this.canvas = c;
    this.ctx = c.getContext('2d');
    this.build();
    // the panel is filled first: on a phone it sits under the canvas, so until
    // it has its height the canvas measures far taller than it ends up
    this.paintBar();
    this.paintTrail();
    this.fit();
    // settle it before the first paint, so the map opens laid out instead of
    // exploding outwards while you watch
    if (!this.settled) {
      for (let i = 0; i < 160; i++) this.step();
      this.frameAll();
      this.settled = true;
      this.alpha = 0.25;
    }
    this.wire();            // a fresh canvas each render, so fresh listeners
    // and once more after layout has fully settled, in case anything moved
    requestAnimationFrame(() => this.fit());
    cancelAnimationFrame(this.raf);
    this.loop();

    const stage = c.parentElement;                 // .g-canvas
    if (this.ro) { try { this.ro.disconnect(); } catch (err) { /* ignore */ } }
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(() => this.fit());
      this.ro.observe(stage);
    }
    document.querySelector('.g-wrap').addEventListener('click', e => {
      const hit = e.target.closest('[data-g]');
      if (!hit) return;
      const what = hit.dataset.g;
      if (what === 'type') {
        const h = new Set(this.hidden());
        h.has(hit.dataset.key) ? h.delete(hit.dataset.key) : h.add(hit.dataset.key);
        DB.settings.graphHidden = [...h];
        DB.settings.ts = Date.now();
        saveDB();
        hit.classList.toggle('off');
        this.picked = null;
        this.build(); this.paintBar(); this.draw();
      } else if (what === 'retidy') {
        this.nodes.forEach(p => { p.x = (Math.random() - 0.5) * 420; p.y = (Math.random() - 0.5) * 420; });
        for (let i = 0; i < 160; i++) this.step();
        this.frameAll();
        this.alpha = 0.3;
        this.draw();
      } else if (what === 'open' && this.picked) {
        const n = this.picked;
        try { openForm(n.type, n.item); } catch (err) { toast('Could not open that'); }
      } else if (what === 'link' && this.picked) {
        this.linkFrom = this.linkFrom === this.picked ? null : this.picked;
        this.paintBar(); this.draw();
      } else if (what === 'home') {
        this.level = { kind: 'hubs', type: '', focus: '' };
        this.picked = null; this.linkFrom = null; this.refit();
      } else if (what === 'type') {
        this.level = { kind: 'type', type: hit.dataset.key, focus: '' };
        this.picked = null; this.linkFrom = null; this.refit();
      } else if (what === 'up') {
        this.up();
      } else if (what === 'drill' && this.picked) {
        this.drill(this.picked);
      } else if (what === 'go') {
        const n = this.byKey.get(hit.dataset.key);
        if (n) { this.drill(n); }
      } else if (what === 'cut' && this.picked) {
        e.stopPropagation();
        this.unlink(this.picked.key, hit.dataset.key);
      }
    });
  },

  centreOn(n) { this.view.x = -n.x; this.view.y = -n.y; },

  /** Zoom and pan so the whole map is on screen with a little air around it. */
  frameAll() {
    if (!this.nodes.length || !this.w) return;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    this.nodes.forEach(p => {
      x1 = Math.min(x1, p.x); x2 = Math.max(x2, p.x);
      y1 = Math.min(y1, p.y); y2 = Math.max(y2, p.y);
    });
    const pad = 90;                                  // room for the labels
    const w = Math.max(120, x2 - x1) + pad * 2;
    const h = Math.max(120, y2 - y1) + pad * 2;
    const side = document.getElementById('graphSide');
    const usable = this.w - (side && getComputedStyle(side).position === 'absolute' ? side.offsetWidth + 24 : 0);
    this.view.k = Math.max(0.3, Math.min(1.5, Math.min(usable / w, this.h / h)));
    this.view.x = -(x1 + x2) / 2 - (this.w - usable) / 2 / this.view.k;
    this.view.y = -(y1 + y2) / 2;
  },

  fit() {
    const c = this.canvas;
    if (!c) return;
    // measure the box the canvas actually fills, not whatever is around it
    const box = c.parentElement.getBoundingClientRect();
    const was = this.h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(200, Math.round(box.width));
    this.h = Math.max(200, Math.round(box.height));
    const grew = Math.abs(this.h - was) > 24;
    c.width = Math.round(this.w * this.dpr);
    c.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (grew && this.nodes.length) this.frameAll();   // keep everything in view
    this.draw();
  },

  unmount() {
    cancelAnimationFrame(this.raf);
    this.canvas = null; this.ctx = null;
  },

  /* ---------------- registering the view ---------------- */
  init() {
    if (typeof DB === 'undefined') return;
    this.styles();

    if (typeof VIEWS !== 'undefined' && typeof RENDER !== 'undefined') {
      // sits directly under Dashboard, in the same group
      const rebuilt = {};
      Object.entries(VIEWS).forEach(([k, v]) => {
        rebuilt[k] = v;
        if (k === 'dashboard') rebuilt.map = { title: 'Map', sub: 'How everything connects', icon: 'share', group: 'Overview' };
      });
      Object.keys(VIEWS).forEach(k => delete VIEWS[k]);
      Object.assign(VIEWS, rebuilt);
      RENDER.map = () => this.html();
      try { renderNav(); } catch (e) { /* not ready yet */ }
    } else if (typeof TITLES !== 'undefined' && typeof SCREENS !== 'undefined') {
      TITLES.map = 'Map';
      SCREENS.map = () => this.html();
      if (typeof SUBVIEWS !== 'undefined' && !SUBVIEWS.includes('map')) SUBVIEWS.push('map');
    }

    const paint = render;
    render = (...a) => {
      paint.apply(null, a);
      if (UI.view === 'map') setTimeout(() => this.mount(), 0); else this.unmount();
    };
    if (UI.view === 'map') setTimeout(() => this.mount(), 0);
  },

  styles() {
    if (typeof ICONS !== 'undefined') {
      if (!ICONS.share) ICONS.share = '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="6" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="m8.4 10.8 7.2-3.6M8.4 13.2l7.2 3.6"/>';
      if (!ICONS.link) ICONS.link = '<path d="M10 13.5a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M14 10.5a4 4 0 0 0-5.7-.4l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3"/>';
      if (!ICONS.edit) ICONS.edit = '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14.5 6.5 17.5 9.5"/>';
    }
    const s = document.createElement('style');
    s.textContent = `
    .g-wrap{display:flex;flex-direction:column;gap:10px;height:calc(100vh - 190px);min-height:420px}
    .g-trail{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:13px}
    .g-crumb{background:none;border:0;padding:0;font:inherit;font-size:13px;color:var(--blue-2);cursor:pointer}
    .g-crumb:hover{text-decoration:underline}
    .g-crumb.on{color:var(--text);font-weight:650}
    .g-trail span{display:inline-flex;color:var(--text-3)}
    .g-hint{font-size:12px;color:var(--text-3);margin-left:4px}
    .g-up{margin-left:auto}
    .g-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
    .g-bar .spacer{flex:1}
    .g-chip{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;cursor:pointer;
      background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font:inherit;font-size:12.5px;font-weight:600}
    .g-chip i{width:9px;height:9px;border-radius:50%}
    .g-chip.off{opacity:.42}
    .g-chip.off i{background:var(--text-3)!important}
    .g-stage{position:relative;flex:1;min-height:0;border:1px solid var(--border);border-radius:var(--radius);
      overflow:hidden;background:var(--surface);display:flex;flex-direction:column}
    .g-canvas{position:relative;flex:1;min-height:0}
    #graphCanvas{position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:none;cursor:grab}
    .g-side{position:absolute;right:10px;top:10px;bottom:10px;width:252px;overflow:auto;padding:14px;
      background:color-mix(in srgb,var(--surface-2) 88%,transparent);backdrop-filter:blur(10px);
      border:1px solid var(--border);border-radius:13px;font-size:13px}
    .g-empty{display:flex;flex-direction:column;gap:7px;color:var(--text-3);line-height:1.6}
    .g-empty b{color:var(--text);font-size:14px}
    .g-legend{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:10px;font-size:11.5px;align-items:center}
    .g-legend i{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:5px}
    .g-head{display:flex;gap:10px;align-items:center;margin-bottom:12px}
    .g-head b{display:block;font-size:14.5px;line-height:1.3}
    .g-head span{font-size:11.5px;color:var(--text-3)}
    .g-dot{width:13px;height:13px;border-radius:50%;flex-shrink:0}
    .g-dot.sm{width:9px;height:9px}
    .g-conns h4{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);margin:16px 0 8px}
    .g-conn{display:flex;align-items:center;gap:9px;padding:8px 6px;border-radius:9px;cursor:pointer}
    .g-conn:hover{background:var(--surface-3)}
    .g-conn b{display:block;font-size:12.5px;font-weight:600}
    .g-conn span{font-size:11px;color:var(--text-3)}
    .g-conn .icon-btn.sm{width:26px;height:26px}
    @media (max-width:900px){
      .g-wrap{height:calc(100vh - 215px)}
      .g-canvas{min-height:260px}
      .g-side{position:static;width:auto;max-height:36vh;backdrop-filter:none;border:0;
        border-top:1px solid var(--border);border-radius:0;background:var(--surface-2)}
    }`;
    document.head.appendChild(s);
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Graph.init());
else Graph.init();
