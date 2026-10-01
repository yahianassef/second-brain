/* =========================================================
   THE GYM — a library you can drill into, inside Exercising
   =========================================================
   Exercising gains two tabs beside your log: Library and Programmes.

   Library: every exercise, filtered by equipment, muscle, level or pattern.
   Open one and you get the coaching — how to do it, what to watch, what people
   get wrong — plus the chain it belongs to, so you can drill from an easier
   version up to a harder one and back.

   Programmes: six plans, each drilling programme → day → exercise.

   Logging a set writes an ordinary workout into your data, so the Exercising
   figures, the dashboard and the sync all see it without knowing about any of
   this.
   ========================================================= */
const GYM_LEVELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

const Gym = {
  bySlug: new Map(),

  ready() {
    if (this.bySlug.size) return true;
    if (typeof GYM_EXERCISES === 'undefined') return false;
    GYM_EXERCISES.forEach(e => this.bySlug.set(e.slug, e));
    return true;
  },

  /* ---------------- what is on screen ---------------- */
  state() {
    UI.gym = UI.gym || { kit: '', muscle: '', level: '', q: '', open: '', programme: '', day: 0 };
    return UI.gym;
  },

  filtered() {
    const s = this.state();
    const q = s.q.trim().toLowerCase();
    return GYM_EXERCISES.filter(e => {
      if (s.kit && e.kit !== s.kit) return false;
      if (s.level && e.level !== s.level) return false;
      if (s.muscle && !e.primary.includes(s.muscle) && !e.secondary.includes(s.muscle)) return false;
      if (q && !(e.name.toLowerCase().includes(q)
        || e.summary.toLowerCase().includes(q)
        || e.primary.join(' ').toLowerCase().includes(q)
        || e.pattern.toLowerCase().includes(q))) return false;
      return true;
    });
  },

  kits() { return [...new Set(GYM_EXERCISES.map(e => e.kit))].sort(); },
  muscles() { return [...new Set(GYM_EXERCISES.flatMap(e => e.primary))].sort(); },

  /* ---------------- the library ---------------- */
  html() {
    if (!this.ready()) return `<div class="card">${emptyState('dumbbell', 'Library not loaded', 'Refresh the app and try again.')}</div>`;
    const s = this.state();
    if (s.open) return this.detail(s.open);

    const list = this.filtered();
    const pick = (key, label, options) => `
      <select class="select sm" data-gym="filter" data-key="${key}">
        <option value="">${label}</option>
        ${options.map(o => `<option value="${esc(o.v || o)}"${s[key] === (o.v || o) ? ' selected' : ''}>${esc(o.l || o)}</option>`).join('')}
      </select>`;

    return `
    <div class="gym-tools">
      <input class="input sm gym-search" data-gym="search" placeholder="Search 208 exercises…" value="${esc(s.q)}" autocomplete="off">
      ${pick('kit', 'Any equipment', this.kits())}
      ${pick('muscle', 'Any muscle', this.muscles())}
      ${pick('level', 'Any level', Object.entries(GYM_LEVELS).map(([v, l]) => ({ v, l })))}
      ${s.kit || s.muscle || s.level || s.q ? `<button class="btn btn-ghost sm" data-gym="clear">${icon('x', 14)} Clear</button>` : ''}
      <span class="spacer"></span>
      <span class="hint">${plural(list.length, 'exercise')}</span>
    </div>
    ${list.length ? `<div class="gym-grid">${list.map(e => this.card(e)).join('')}</div>`
      : `<div class="card">${emptyState('search', 'Nothing matches', 'Try fewer filters.')}</div>`}`;
  },

  card(e) {
    return `<button class="gym-card" data-gym="open" data-slug="${e.slug}">
      <div class="gym-card-top">
        <span class="chip ${e.level === 'advanced' ? 'red' : e.level === 'intermediate' ? 'amber' : 'green'}">${GYM_LEVELS[e.level]}</span>
        <span class="chip">${esc(e.kit)}</span>
        ${e.compound ? '<span class="chip blue">Compound</span>' : ''}
      </div>
      <b>${esc(e.name)}</b>
      <p>${esc(e.summary)}</p>
      <span class="gym-muscles">${e.primary.map(m => esc(m)).join(' · ')}</span>
    </button>`;
  },

  detail(slug) {
    const e = this.bySlug.get(slug);
    if (!e) return `<div class="card">${emptyState('search', 'Not found', 'That exercise is no longer in the library.')}</div>`;
    const chain = [e.easier && this.bySlug.get(e.easier), e, e.harder && this.bySlug.get(e.harder)].filter(Boolean);
    const related = GYM_EXERCISES.filter(x => x.slug !== e.slug && x.pattern === e.pattern
      && x.primary.some(m => e.primary.includes(m))).slice(0, 6);
    const lines = (title, items, cls = '') => items && items.length
      ? `<div class="gym-block"><h4>${title}</h4><ul class="${cls}">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '';

    return `
    <div class="gym-tools">
      <button class="btn btn-ghost sm" data-gym="back">${icon('chevL', 14)} All exercises</button>
      <span class="spacer"></span>
      <button class="btn btn-primary sm" data-gym="log" data-slug="${e.slug}">${icon('plus', 14)} Log this</button>
    </div>
    <div class="gym-detail">
      <div class="card">
        <div class="gym-card-top">
          <span class="chip ${e.level === 'advanced' ? 'red' : e.level === 'intermediate' ? 'amber' : 'green'}">${GYM_LEVELS[e.level]}</span>
          <span class="chip">${esc(e.kit)}</span>
          <span class="chip violet">${esc(e.pattern)}</span>
          ${e.single ? '<span class="chip">One side at a time</span>' : ''}
        </div>
        <h3 class="gym-title">${esc(e.name)}</h3>
        <p class="gym-summary">${esc(e.summary)}</p>
        <div class="gym-muscle-row">
          <div><span class="hint">Works</span><b>${e.primary.map(esc).join(', ') || '—'}</b></div>
          ${e.secondary.length ? `<div><span class="hint">Also</span><b>${e.secondary.map(esc).join(', ')}</b></div>` : ''}
        </div>
        ${e.video ? `<a class="btn btn-ghost sm" href="${esc(e.video)}" target="_blank" rel="noopener">${icon('ext', 14)} Watch the form</a>` : ''}
      </div>
      <div class="card">
        ${lines('How to do it', e.steps, 'gym-steps')}
        ${lines('Form tips', e.tips)}
        ${lines('Common mistakes', e.mistakes, 'gym-bad')}
      </div>
      ${chain.length > 1 ? `<div class="card">
        ${cardHead('trend', 'Work up through it')}
        <div class="gym-chain">${chain.map(c => `
          <button class="gym-step${c.slug === e.slug ? ' on' : ''}" data-gym="open" data-slug="${c.slug}">
            <span>${c.slug === e.easier ? 'Easier' : c.slug === e.harder ? 'Harder' : 'You are here'}</span>
            <b>${esc(c.name)}</b>
          </button>`).join('')}</div>
      </div>` : ''}
      ${related.length ? `<div class="card">
        ${cardHead('layers', 'Trains the same thing')}
        <div class="gym-related">${related.map(r => `
          <button class="gym-rel" data-gym="open" data-slug="${r.slug}">
            <b>${esc(r.name)}</b><span>${esc(r.kit)}</span>
          </button>`).join('')}</div>
      </div>` : ''}
    </div>`;
  },

  /* ---------------- programmes ---------------- */
  programmes() {
    if (!this.ready()) return '';
    const s = this.state();
    if (!s.programme) {
      return `<div class="gym-grid">${GYM_PROGRAMS.map(p => `
        <button class="gym-card" data-gym="prog" data-slug="${p.slug}">
          <div class="gym-card-top">
            <span class="chip ${p.level === 'advanced' ? 'red' : p.level === 'intermediate' ? 'amber' : 'green'}">${GYM_LEVELS[p.level] || p.level}</span>
            <span class="chip">${p.weeks} weeks</span>
            <span class="chip blue">${p.perWeek}×/week</span>
          </div>
          <b>${esc(p.name)}</b>
          <p>${esc(p.focus)}</p>
          <span class="gym-muscles">${esc(p.subtitle)}</span>
        </button>`).join('')}</div>`;
    }

    const p = GYM_PROGRAMS.find(x => x.slug === s.programme);
    if (!p) { s.programme = ''; return this.programmes(); }
    const day = p.days[Math.min(s.day, p.days.length - 1)] || p.days[0];
    return `
    <div class="gym-tools">
      <button class="btn btn-ghost sm" data-gym="progBack">${icon('chevL', 14)} All programmes</button>
      <span class="spacer"></span>
    </div>
    <div class="card">
      <h3 class="gym-title">${esc(p.name)}</h3>
      <p class="gym-summary">${esc(p.about)}</p>
      ${p.progression.length ? `<div class="gym-block"><h4>Week by week</h4><ul>${p.progression.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    </div>
    <div class="gym-tools">${p.days.map((d, i) => `
      <button class="btn ${d === day ? 'btn-primary' : 'btn-ghost'} sm" data-gym="day" data-i="${i}">${esc(d.name)}</button>`).join('')}</div>
    <div class="card">
      ${cardHead('dumbbell', esc(day.name), `<span class="hint">${esc(day.focus)}</span>`)}
      <div class="list">${day.slots.map(slot => {
        const e = this.bySlug.get(slot.slug);
        return `<div class="item gym-slot" data-gym="open" data-slug="${slot.slug}">
          <div class="grow">
            <div class="t">${esc(e ? e.name : slot.slug)}</div>
            <div class="s">${slot.sets}×${esc(String(slot.reps))} · ${slot.rest}s rest${slot.note ? ' · ' + esc(slot.note) : ''}</div>
          </div>
          ${icon('chevR', 16)}
        </div>`;
      }).join('')}</div>
    </div>`;
  },

  /* ---------------- logging ---------------- */
  log(slug) {
    const e = this.bySlug.get(slug);
    if (!e) return;
    const m = openModal(`
      <div class="modal-head">
        <div><div class="eyebrow">Log a workout</div><h3>${esc(e.name)}</h3></div>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <form class="modal-body" novalidate>
        <div class="form-grid">
          <div class="field" data-k="date"><label for="gymDate">Date</label><input class="input" type="date" id="gymDate" value="${today()}"></div>
          <div class="field" data-k="minutes"><label for="gymMin">Minutes</label><input class="input" type="number" id="gymMin" min="0" step="1" value="45"></div>
          <div class="field" data-k="sets"><label for="gymSets">Sets</label><input class="input" type="number" id="gymSets" min="0" step="1" value="3"></div>
          <div class="field" data-k="reps"><label for="gymReps">Reps</label><input class="input" id="gymReps" value="10"></div>
          <div class="field" data-k="weight"><label for="gymWeight">Weight</label><input class="input" id="gymWeight" placeholder="e.g. 20 kg"></div>
        </div>
        <p class="hint" style="margin-top:12px">Saved as a workout, so it counts towards your week like anything else you log.</p>
      </form>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" data-save>${icon('check', 15)} Save workout</button>
      </div>`);

    $('[data-save]', m).onclick = () => {
      const v = id => ($('#' + id, m) || {}).value || '';
      const sets = num(v('gymSets')), reps = v('gymReps'), weight = v('gymWeight');
      DB.workouts.unshift({
        id: uid(), created: today(), updated: today(), ts: Date.now(),
        date: v('gymDate') || today(),
        type: e.pattern === 'Conditioning' ? 'Cardio' : 'Strength',
        name: e.name,
        minutes: num(v('gymMin')),
        notes: [sets && reps ? `${sets}×${reps}` : '', weight, e.kit].filter(Boolean).join(' · ')
      });
      saveDB();
      closeModal();
      render();
      toast(`${e.name} logged`);
    };
  },

  /* ---------------- wiring into the Exercising view ---------------- */
  tabs() {
    const s = this.state();
    const tab = UI.exTab || 'log';
    const b = (k, label) => `<button class="btn ${tab === k ? 'btn-primary' : 'btn-ghost'} sm" data-gym="tab" data-key="${k}">${label}</button>`;
    return `<div class="gym-tabs">${b('log', 'My log')}${b('library', 'Library')}${b('programmes', 'Programmes')}</div>`;
  },

  click(e) {
    const hit = e.target.closest('[data-gym]');
    if (!hit) return;
    const s = this.state();
    const what = hit.dataset.gym;
    if (what === 'tab') { UI.exTab = hit.dataset.key; s.open = ''; render(); }
    else if (what === 'open') { s.open = hit.dataset.slug; UI.exTab = 'library'; render(); window.scrollTo?.({ top: 0 }); const c = document.getElementById('content'); if (c) c.scrollTop = 0; }
    else if (what === 'back') { s.open = ''; render(); }
    else if (what === 'clear') { s.kit = s.muscle = s.level = ''; s.q = ''; render(); }
    else if (what === 'prog') { s.programme = hit.dataset.slug; s.day = 0; render(); }
    else if (what === 'progBack') { s.programme = ''; render(); }
    else if (what === 'day') { s.day = Number(hit.dataset.i) || 0; render(); }
    else if (what === 'log') { this.log(hit.dataset.slug); }
  },

  init() {
    if (typeof DB === 'undefined' || typeof render !== 'function') return;
    this.styles();

    const host = typeof RENDER !== 'undefined' ? RENDER : (typeof SCREENS !== 'undefined' ? SCREENS : null);
    if (!host) return;
    const key = host.exercise ? 'exercise' : null;
    if (!key) return;
    const mine = host[key];
    host[key] = () => {
      const tab = UI.exTab || 'log';
      return this.tabs() + (tab === 'library' ? this.html() : tab === 'programmes' ? this.programmes() : mine());
    };

    document.addEventListener('click', e => this.click(e));
    document.addEventListener('input', e => {
      const hit = e.target.closest('[data-gym="search"]');
      if (hit) {
        this.state().q = hit.value;
        const at = hit.selectionStart;
        render();
        const again = document.querySelector('[data-gym="search"]');
        if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (err) { /* ignore */ } }
      }
    });
    document.addEventListener('change', e => {
      const hit = e.target.closest('[data-gym="filter"]');
      if (hit) { this.state()[hit.dataset.key] = hit.value; render(); }
    });
  },

  styles() {
    const s = document.createElement('style');
    s.textContent = `
    .gym-tabs{display:flex;gap:7px;margin-bottom:14px;flex-wrap:wrap}
    .gym-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
    .gym-tools .spacer{flex:1}
    .gym-search{min-width:190px;flex:1;max-width:320px}
    .gym-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:12px}
    .gym-card{text-align:left;display:flex;flex-direction:column;gap:7px;padding:15px;cursor:pointer;font:inherit;
      background:linear-gradient(180deg,var(--surface),var(--card-2));border:1px solid var(--border);
      border-radius:var(--radius);color:var(--text);transition:border-color .18s,transform .18s var(--ease)}
    .gym-card:hover{border-color:var(--blue-2);transform:translateY(-2px)}
    .gym-card b{font-size:15px;letter-spacing:-.01em}
    .gym-card p{font-size:12.5px;color:var(--text-2);line-height:1.55;margin:0}
    .gym-card-top{display:flex;gap:6px;flex-wrap:wrap}
    .gym-muscles{font-size:11.5px;color:var(--text-3);margin-top:auto}
    .gym-detail{display:flex;flex-direction:column;gap:12px}
    .gym-title{font-size:21px;letter-spacing:-.02em;margin:10px 0 6px}
    .gym-summary{color:var(--text-2);font-size:14px;line-height:1.6;margin:0 0 12px}
    .gym-muscle-row{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:12px}
    .gym-muscle-row span{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em}
    .gym-muscle-row b{font-size:13.5px}
    .gym-block{margin-bottom:18px}
    .gym-block:last-child{margin-bottom:0}
    .gym-block h4{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);margin:0 0 9px}
    .gym-block ul{margin:0;padding-left:18px;color:var(--text-2);font-size:13.5px;line-height:1.7}
    .gym-block li{margin-bottom:5px}
    .gym-block ul.gym-steps{counter-reset:step;list-style:none;padding-left:0}
    .gym-block ul.gym-steps li{counter-increment:step;position:relative;padding-left:30px;margin-bottom:9px}
    .gym-block ul.gym-steps li::before{content:counter(step);position:absolute;left:0;top:1px;width:21px;height:21px;
      border-radius:7px;background:var(--blue-soft);color:var(--blue-2);font-size:11.5px;font-weight:700;
      display:grid;place-items:center}
    .gym-block ul.gym-bad li::marker{color:var(--red-t)}
    .gym-chain{display:flex;gap:10px;flex-wrap:wrap}
    .gym-step{flex:1;min-width:150px;text-align:left;padding:12px 14px;border-radius:12px;cursor:pointer;font:inherit;
      background:var(--surface-2);border:1px solid var(--border);color:var(--text)}
    .gym-step span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);margin-bottom:4px}
    .gym-step.on{border-color:var(--blue);background:var(--blue-soft)}
    .gym-step:hover{border-color:var(--blue-2)}
    .gym-related{display:flex;gap:8px;flex-wrap:wrap}
    .gym-rel{text-align:left;padding:9px 12px;border-radius:10px;cursor:pointer;font:inherit;
      background:var(--surface-2);border:1px solid var(--border);color:var(--text)}
    .gym-rel:hover{border-color:var(--blue-2)}
    .gym-rel b{display:block;font-size:12.5px}
    .gym-rel span{font-size:11px;color:var(--text-3)}
    .gym-slot{cursor:pointer}
    .gym-slot:hover{background:var(--surface-2)}
    @media (max-width:620px){
      .gym-grid{grid-template-columns:1fr}
      .gym-search{max-width:none;width:100%}
      .gym-tools .select{flex:1;min-width:110px}
    }`;
    document.head.appendChild(s);
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Gym.init());
else Gym.init();
