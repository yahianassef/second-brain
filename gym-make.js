/* =========================================================
   GENERATED WORKOUTS — ask for a session, get one you can edit
   =========================================================
   "bodyweight only", "quick workout at home", "bands, upper body, 20 minutes".

   Two ways it answers. If your Apps Script has a Gemini key it sends the whole
   catalogue and your sentence, and the model picks from that list — it can only
   ever return exercises the library already holds. If there is no key, or the
   call fails, the same request is built here instead: the words are read for
   equipment, length, level and body part, then one exercise is taken per
   movement pattern so the session is balanced rather than four kinds of press.

   Either way the result is yours to change: edit sets, reps and rest, swap an
   exercise, drag the order, add or drop anything, rename it, log it when it is
   done. Saved plans live in DB.routines and sync like everything else.
   ========================================================= */
// Matched by shape, not by exact text: the library writes "Core · rotation"
// with a middle dot, and an exact string put the core patterns out of reach.
const MAKE_PATTERNS = [
  [/^mobility/i, 'warm-up'],
  [/^squat/i, 'legs'],
  [/^hinge/i, 'legs'],
  [/^horizontal push/i, 'push'],
  [/^horizontal pull/i, 'pull'],
  [/^vertical push/i, 'push'],
  [/^vertical pull/i, 'pull'],
  [/^lunge/i, 'legs'],
  [/^core[ ·.:-].*anti-extension/i, 'core'],
  [/^core[ ·.:-].*rotation/i, 'core'],
  [/^core/i, 'core'],
  [/^calves/i, 'legs'],
  [/^conditioning/i, 'finisher']
];

const GymMake = {
  busy: false, last: null,

  state() {
    UI.make = UI.make || { request: '', open: '', error: '', reply: '' };
    return UI.make;
  },

  /** Gym builds its slug index lazily, so ask before every lookup. */
  look(slug) {
    if (typeof Gym !== 'undefined') Gym.ready();
    return (typeof Gym !== 'undefined' && Gym.bySlug.get(slug)) || null;
  },

  /* ---------------- reading the request ---------------- */
  /** Equipment named in the sentence, as the library labels it. */
  kitFrom(text) {
    const t = ' ' + text.toLowerCase() + ' ';
    const map = [
      [/body ?weight|no (kit|equipment|gear)|nothing|at home with nothing|calisthenic/, 'Bodyweight'],
      [/dumbbell|db\b/, 'Dumbbells'],
      [/barbell|bb\b|rack/, 'Barbells'],
      [/kettlebell|kb\b/, 'Kettlebells'],
      [/band|resistance band/, 'Resistance Bands'],
      [/machine|gym floor/, 'Machines'],
      [/cable|pulley/, 'Cables'],
      [/medicine ball|med ball|slam ball/, 'Medicine Ball'],
      [/stability ball|swiss ball/, 'Stability Ball']
    ];
    const found = map.filter(([re]) => re.test(t)).map(([, label]) => label);
    // "only" with nothing named still reads as bodyweight at home
    if (!found.length && /\bhome\b/.test(t) && !/gym/.test(t)) found.push('Bodyweight');
    return found;
  },

  minutesFrom(text) {
    const m = text.match(/(\d{1,3})\s*(?:min|minute|m\b)/i);
    if (m) return Math.max(5, Math.min(120, Number(m[1])));
    if (/\bquick|short|express|rushed|busy\b/i.test(text)) return 20;
    if (/\blong|full|thorough|complete\b/i.test(text)) return 60;
    return 40;
  },

  levelFrom(text) {
    if (/beginner|new|starting|easy|gentle|rusty|comeback/i.test(text)) return 'beginner';
    if (/advanced|hard|brutal|tough|experienced/i.test(text)) return 'advanced';
    return '';
  },

  /** Which movement groups the request is about, in the names the patterns use. */
  focusFrom(text) {
    const t = text.toLowerCase();
    const groups = new Set();
    if (/upper|chest|back|shoulder|arm|bicep|tricep|lat/.test(t)) { groups.add('push'); groups.add('pull'); }
    if (/push|press/.test(t)) groups.add('push');
    if (/pull|row|chin|pull-?up/.test(t)) groups.add('pull');
    if (/lower|leg|glute|quad|hamstring|squat|calf|calves/.test(t)) groups.add('legs');
    if (/core|abs|stomach|midsection|plank/.test(t)) groups.add('core');
    if (/cardio|conditioning|sweat|fat|hiit|heart|finisher/.test(t)) groups.add('finisher');
    return [...groups];
  },

  /* ---------------- building one here, without the model ---------------- */
  locally(request) {
    const kit = this.kitFrom(request);
    const minutes = this.minutesFrom(request);
    const level = this.levelFrom(request);
    const focus = this.focusFrom(request);
    const pool = GYM_EXERCISES.filter(e => (!kit.length || kit.includes(e.kit))
      && (!level || e.level === level || (level === 'beginner' && e.level === 'beginner')));
    const source = pool.length >= 6 ? pool : GYM_EXERCISES.filter(e => !kit.length || kit.includes(e.kit));
    if (!source.length) return null;

    const want = minutes <= 20 ? 4 : minutes <= 35 ? 6 : minutes <= 50 ? 7 : 9;
    const wanted = MAKE_PATTERNS.filter(([, group]) => {
      if (group === 'warm-up') return minutes > 20 && !focus.length;
      if (!focus.length) return group !== 'finisher' || minutes > 30;
      return focus.includes(group);
    });

    const picked = [];
    const used = new Set();
    const groupOf = (pattern) => (MAKE_PATTERNS.find(([re]) => re.test(pattern || '')) || [, 'other'])[1];
    const take = (re) => {
      const hit = source.find(e => re.test(e.pattern || '') && !used.has(e.slug));
      if (hit) { used.add(hit.slug); picked.push(hit); }
      return !!hit;
    };
    wanted.forEach(([re]) => { if (picked.length < want) take(re); });

    // top up, but stay inside what was asked for: a core finisher should not
    // fill its spare slots with squats
    const fits = e => !focus.length || focus.includes(groupOf(e.pattern));
    [source.filter(e => !used.has(e.slug) && fits(e)),
     source.filter(e => !used.has(e.slug))].forEach(bucket => {
      bucket.sort((a, b) => (b.compound ? 1 : 0) - (a.compound ? 1 : 0))
        .forEach(e => { if (picked.length < want) { used.add(e.slug); picked.push(e); } });
    });

    const blocks = picked.map(e => {
      const warm = /^mobility/i.test(e.pattern || '');
      const cond = /^conditioning/i.test(e.pattern || '');
      return {
        slug: e.slug,
        sets: warm ? 2 : cond ? 3 : e.compound ? 4 : 3,
        reps: warm ? '10' : cond ? '40s' : e.compound ? '6-8' : '10-12',
        rest: warm ? 20 : cond ? 45 : e.compound ? 120 : 60,
        note: ''
      };
    });

    const label = kit.length ? kit.join(' and ') : 'whatever is to hand';
    return {
      title: (() => {
        if (!focus.length) return minutes <= 20 ? 'Quick session' : 'Full session';
        const has = g => focus.includes(g);
        if (has('push') && has('pull') && !has('legs')) return 'Upper body';
        if (has('legs') && focus.length === 1) return 'Leg day';
        if (has('core') && focus.length === 1) return 'Core session';
        if (has('finisher') && focus.length === 1) return 'Conditioning';
        return 'Session';
      })(),
      focus: `${minutes} minutes with ${label}.`,
      minutes,
      blocks,
      reply: `Built from the library: ${blocks.length} exercises, about ${minutes} minutes.`,
      source: 'local'
    };
  },

  /** One line per exercise, which is all the model needs to choose well. */
  catalogue() {
    return GYM_EXERCISES.map(e =>
      `${e.slug} | ${e.name} | ${e.kit} | ${e.level} | ${e.pattern} | ${e.primary.join(', ')}`).join('\n');
  },

  async generate() {
    const s = this.state();
    const request = s.request.trim();
    if (!request) { toast('Say what you want first'); return; }
    if (this.busy) return;
    this.busy = true;
    s.error = '';
    render();

    let plan = null;
    const canAsk = typeof Sheets !== 'undefined' && Sheets.connected();
    if (canAsk) {
      try {
        const out = await Sheets.call('workout', { request, catalogue: this.catalogue() });
        plan = out.result;
        if (plan) plan.source = 'ai';
      } catch (err) {
        s.error = err.message || 'Could not reach the assistant';
      }
    }
    if (!plan) plan = this.locally(request);

    this.busy = false;
    if (!plan) {
      s.error = s.error || 'Nothing in the library matches that.';
      render();
      return;
    }
    this.save(plan, request);
  },

  save(plan, request) {
    const routine = {
      id: uid(), created: today(), updated: today(), ts: Date.now(),
      title: plan.title || 'Workout',
      focus: plan.focus || '',
      minutes: num(plan.minutes) || 0,
      request: request || '',
      source: plan.source || 'local',
      blocks: (plan.blocks || []).map(b => ({ ...b }))
    };
    DB.routines.unshift(routine);
    saveDB();
    const s = this.state();
    s.request = '';
    s.reply = plan.reply || '';
    s.open = routine.id;
    UI.exTab = 'made';
    render();
    toast(`${routine.title} saved${plan.source === 'local' ? ' — built from the library' : ''}`);
  },

  find(id) { return (DB.routines || []).find(r => r.id === id); },

  /* ---------------- changing one ---------------- */
  edit(id, index, field, value) {
    const r = this.find(id);
    if (!r || !r.blocks[index]) return;
    r.blocks[index][field] = field === 'sets' || field === 'rest' ? Math.max(0, num(value)) : value;
    r.updated = today(); r.ts = Date.now();
    saveDB();
  },
  move(id, index, by) {
    const r = this.find(id);
    if (!r) return;
    const to = index + by;
    if (to < 0 || to >= r.blocks.length) return;
    const [b] = r.blocks.splice(index, 1);
    r.blocks.splice(to, 0, b);
    r.updated = today(); r.ts = Date.now();
    saveDB(); render();
  },
  drop(id, index) {
    const r = this.find(id);
    if (!r) return;
    const [gone] = r.blocks.splice(index, 1);
    r.updated = today(); r.ts = Date.now();
    saveDB(); render();
    toast('Removed', { action: 'Undo', onAction: () => { r.blocks.splice(index, 0, gone); saveDB(); render(); } });
  },
  add(id, slug) {
    const r = this.find(id);
    const e = this.look(slug);
    if (!r || !e) return;
    r.blocks.push({ slug, sets: e.compound ? 4 : 3, reps: e.compound ? '6-8' : '10-12', rest: e.compound ? 120 : 60, note: '' });
    r.updated = today(); r.ts = Date.now();
    saveDB(); render();
    toast(`${e.name} added`);
  },
  rename(id) {
    const r = this.find(id);
    if (!r) return;
    const name = (prompt('Name this workout', r.title) || '').trim();
    if (!name) return;
    r.title = name.slice(0, 60); r.updated = today(); r.ts = Date.now();
    saveDB(); render();
  },
  remove(id) {
    const r = this.find(id);
    if (!r) return;
    confirmDialog('Delete this workout?', `“${esc(r.title)}” will be removed. Anything you have already logged stays.`,
      'Delete', () => {
        DB.routines = DB.routines.filter(x => x.id !== id);
        DB.trash = (DB.trash || []).concat({ id, ts: Date.now() });
        saveDB();
        this.state().open = '';
        render();
        toast('Deleted');
      });
  },

  /** Log every exercise in it as workouts, in one go. */
  logAll(id) {
    const r = this.find(id);
    if (!r || !r.blocks.length) return;
    const per = Math.max(5, Math.round((num(r.minutes) || 40) / r.blocks.length));
    r.blocks.forEach(b => {
      const e = this.look(b.slug);
      if (!e) return;
      DB.workouts.unshift({
        id: uid(), created: today(), updated: today(), ts: Date.now(),
        date: today(),
        type: e.pattern === 'Conditioning' ? 'Cardio' : 'Strength',
        name: e.name, minutes: per,
        notes: [`${b.sets}×${b.reps}`, e.kit, r.title].filter(Boolean).join(' · ')
      });
    });
    saveDB(); render();
    toast(`${plural(r.blocks.length, 'exercise')} logged from ${r.title}`);
  },

  /* ---------------- what you see ---------------- */
  html() {
    if (typeof Gym !== 'undefined') Gym.ready();
    const s = this.state();
    if (s.open) return this.detail(s.open);
    const list = [...(DB.routines || [])].sort((a, b) => num(b.ts) - num(a.ts));
    const canAsk = typeof Sheets !== 'undefined' && Sheets.connected();

    return `
    <div class="card mk-ask">
      ${cardHead('sparkle', 'Ask for a workout')}
      <div class="mk-row">
        <input class="input" data-mk="request" value="${esc(s.request)}" autocomplete="off"
          placeholder="bodyweight only, 20 minutes at home">
        <button class="btn btn-primary" data-mk="go"${this.busy ? ' disabled' : ''}>
          ${this.busy ? 'Building…' : `${icon('sparkle', 15)} Build it`}</button>
      </div>
      <div class="mk-eg">
        ${['bodyweight only, 20 minutes at home', 'bands only, upper body', 'dumbbells, full body, 45 minutes',
           'quick core finisher', 'beginner legs day, machines'].map(x =>
          `<button class="mk-chip" data-mk="eg" data-val="${esc(x)}">${esc(x)}</button>`).join('')}
      </div>
      ${s.error ? `<p class="mk-err">${esc(s.error)}${canAsk ? '' : ''}</p>` : ''}
      <p class="hint">${canAsk
        ? 'Asks your assistant, which picks from the library. If it cannot be reached, the same request is built here instead.'
        : 'Built here from the library. Connect Google Sheets and add a Gemini key for a coach to choose instead.'}</p>
    </div>
    ${list.length ? `<div class="gym-grid">${list.map(r => `
      <button class="gym-card" data-mk="open" data-id="${r.id}">
        <div class="gym-card-top">
          <span class="chip blue">${plural(r.blocks.length, 'exercise')}</span>
          ${r.minutes ? `<span class="chip">${r.minutes} min</span>` : ''}
          <span class="chip ${r.source === 'ai' ? 'violet' : ''}">${r.source === 'ai' ? 'Coach' : 'Library'}</span>
        </div>
        <b>${esc(r.title)}</b>
        <p>${esc(r.focus || r.request || '')}</p>
        <span class="gym-muscles">${esc(ago(r.updated))}</span>
      </button>`).join('')}</div>`
      : `<div class="card">${emptyState('dumbbell', 'Nothing generated yet',
          'Describe the session you want and it will be saved here, ready to change.')}</div>`}`;
  },

  detail(id) {
    const r = this.find(id);
    if (!r) { this.state().open = ''; return this.html(); }
    const pool = GYM_EXERCISES.slice().sort((a, b) => a.name.localeCompare(b.name));
    return `
    <div class="gym-tools">
      <button class="btn btn-ghost sm" data-mk="back">${icon('chevL', 14)} All workouts</button>
      <span class="spacer"></span>
      <button class="btn btn-ghost sm" data-mk="rename" data-id="${r.id}">${icon('edit', 14)} Rename</button>
      <button class="btn btn-ghost sm" data-mk="del" data-id="${r.id}">${icon('trash', 14)} Delete</button>
      <button class="btn btn-primary sm" data-mk="logall" data-id="${r.id}">${icon('check', 14)} Log it all</button>
    </div>
    <div class="card">
      <h3 class="gym-title">${esc(r.title)}</h3>
      <p class="gym-summary">${esc(r.focus || '')}${r.request ? ` <span class="hint">— asked for “${esc(r.request)}”</span>` : ''}</p>
      <div class="list">${r.blocks.map((b, i) => {
        const e = this.look(b.slug);
        return `<div class="item mk-block">
          <div class="mk-ord">
            <button class="icon-btn sm" data-mk="up" data-id="${r.id}" data-i="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>${icon('chevL', 14)}</button>
            <span>${i + 1}</span>
            <button class="icon-btn sm" data-mk="down" data-id="${r.id}" data-i="${i}" aria-label="Move down"${i === r.blocks.length - 1 ? ' disabled' : ''}>${icon('chevR', 14)}</button>
          </div>
          <div class="grow">
            <button class="mk-name" data-gym="open" data-slug="${b.slug}">${esc(e ? e.name : b.slug)}</button>
            <div class="s">${esc(e ? e.kit + ' · ' + e.primary.join(', ') : '')}${b.note ? ' · ' + esc(b.note) : ''}</div>
            <div class="mk-fields">
              <label>Sets<input class="input sm" type="number" min="1" max="10" value="${b.sets}" data-mk="set" data-id="${r.id}" data-i="${i}" data-field="sets"></label>
              <label>Reps<input class="input sm" value="${esc(String(b.reps))}" data-mk="set" data-id="${r.id}" data-i="${i}" data-field="reps"></label>
              <label>Rest<input class="input sm" type="number" min="0" max="300" step="5" value="${b.rest}" data-mk="set" data-id="${r.id}" data-i="${i}" data-field="rest"></label>
            </div>
          </div>
          <button class="icon-btn danger" data-mk="drop" data-id="${r.id}" data-i="${i}" aria-label="Remove">${icon('x', 15)}</button>
        </div>`;
      }).join('')}</div>
      <div class="mk-add">
        <select class="select sm" data-mk="addpick" data-id="${r.id}">
          <option value="">Add an exercise…</option>
          ${pool.map(e => `<option value="${e.slug}">${esc(e.name)} — ${esc(e.kit)}</option>`).join('')}
        </select>
      </div>
    </div>`;
  },

  /* ---------------- wiring ---------------- */
  click(e) {
    const hit = e.target.closest('[data-mk]');
    if (!hit) return;
    const s = this.state();
    const what = hit.dataset.mk;
    const id = hit.dataset.id;
    if (what === 'go') this.generate();
    else if (what === 'eg') { s.request = hit.dataset.val; render(); setTimeout(() => this.generate(), 0); }
    else if (what === 'open') { s.open = id; render(); }
    else if (what === 'back') { s.open = ''; render(); }
    else if (what === 'rename') this.rename(id);
    else if (what === 'del') this.remove(id);
    else if (what === 'logall') this.logAll(id);
    else if (what === 'up') this.move(id, Number(hit.dataset.i), -1);
    else if (what === 'down') this.move(id, Number(hit.dataset.i), 1);
    else if (what === 'drop') this.drop(id, Number(hit.dataset.i));
  },

  init() {
    if (typeof DB === 'undefined' || typeof Gym === 'undefined') return;
    this.styles();

    // a fourth tab beside the log, the library and the programmes
    const tabs = Gym.tabs.bind(Gym);
    Gym.tabs = () => {
      const tab = UI.exTab || 'log';
      return tabs().replace('</div>',
        `<button class="btn ${tab === 'made' ? 'btn-primary' : 'btn-ghost'} sm" data-gym="tab" data-key="made">Generated</button></div>`);
    };
    const host = typeof RENDER !== 'undefined' ? RENDER : SCREENS;
    const mine = host.exercise;
    host.exercise = () => (UI.exTab === 'made' ? Gym.tabs() + this.html() : mine());

    document.addEventListener('click', e => this.click(e));
    document.addEventListener('input', e => {
      const hit = e.target.closest('[data-mk="request"]');
      if (hit) { this.state().request = hit.value; return; }
      const field = e.target.closest('[data-mk="set"]');
      if (field) this.edit(field.dataset.id, Number(field.dataset.i), field.dataset.field, field.value);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.closest('[data-mk="request"]')) { e.preventDefault(); this.generate(); }
    });
    document.addEventListener('change', e => {
      const pick = e.target.closest('[data-mk="addpick"]');
      if (pick && pick.value) { this.add(pick.dataset.id, pick.value); pick.value = ''; }
    });
  },

  styles() {
    const s = document.createElement('style');
    s.textContent = `
    .mk-ask{margin-bottom:14px}
    .mk-row{display:flex;gap:9px;margin-bottom:10px}
    .mk-row .input{flex:1}
    .mk-eg{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}
    .mk-chip{padding:6px 11px;border-radius:999px;cursor:pointer;font:inherit;font-size:12px;
      background:var(--surface-2);border:1px solid var(--border);color:var(--text-2)}
    .mk-chip:hover{border-color:var(--blue-2);color:var(--text)}
    .mk-err{margin:0 0 10px;font-size:13px;color:var(--amber-t)}
    .mk-block{align-items:flex-start;gap:10px}
    .mk-ord{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11.5px;color:var(--text-3);min-width:30px}
    .mk-ord .icon-btn.sm{width:26px;height:22px}
    .mk-ord .icon-btn.sm svg{transform:rotate(90deg)}
    .mk-name{background:none;border:0;padding:0;font:inherit;font-weight:600;font-size:14.5px;
      color:var(--text);cursor:pointer;text-align:left}
    .mk-name:hover{color:var(--blue-2)}
    .mk-fields{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}
    .mk-fields label{display:flex;flex-direction:column;gap:3px;font-size:10.5px;
      text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)}
    .mk-fields .input{width:74px;padding:6px 8px;font-size:13.5px;min-height:34px}
    .mk-add{margin-top:14px}
    @media (max-width:620px){
      .mk-row{flex-direction:column}
      .mk-fields .input{width:68px}
    }`;
    document.head.appendChild(s);
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => GymMake.init());
else GymMake.init();
