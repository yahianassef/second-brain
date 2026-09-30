/* =========================================================
   ASSISTANT — say it or type it, and it gets filed
   =========================================================
   "45 dirhams at carrefour on groceries" → an expense row in your sheet.
   "remind me to renew the registration friday" → a task.
   "felt good today, finished the report" → a journal entry.

   Nothing is saved until you see what it understood and press Save. Money in
   particular is never written on a guess: a misheard fifteen-versus-fifty is
   worse than one extra tap.

   The Gemini key is NOT here. Requests go to your own Apps Script, which holds
   the key in Script Properties — see apps-script/Code.gs. What leaves this
   page: your sentence (or recording), today's date, and the *names* of your
   categories, payment methods, projects and habits so it can match them.
   Never your amounts, balances or history.
   ========================================================= */
const ASSIST_MAX_SECONDS = 60;

const Assist = {
  busy: false, actions: [], reply: '', heard: '',
  rec: null, chunks: [], recording: false, startedAt: 0, tick: null,

  /** It rides on the Sheets connection, since that is what proxies to Gemini. */
  available() { return typeof Sheets !== 'undefined' && Sheets.connected(); },

  /* ---------------- what it can file ---------------- */
  KINDS: {
    expense: { noun: 'Expense', icon: 'wallet', needs: ['amount'], to: 'your Expenses sheet' },
    income: { noun: 'Income', icon: 'trend', needs: ['amount'], to: 'Finances' },
    task: { noun: 'Task', icon: 'tasks', needs: ['title'], to: 'Tasks' },
    note: { noun: 'Note', icon: 'note', needs: [], to: 'Notes' },
    journal: { noun: 'Journal entry', icon: 'book', needs: ['content'], to: 'Journal' },
    habit: { noun: 'Habit', icon: 'repeat', needs: ['habit'], to: 'today' },
    fuel: { noun: 'Fill-up', icon: 'droplet', needs: ['amount', 'odometer'], to: 'your car sheet' },
    service: { noun: 'Service', icon: 'wrench', needs: ['amount', 'title'], to: 'your car sheet' },
    unclear: { noun: 'Not sure', icon: 'help', needs: [], to: '' }
  },

  /** The handful of fields worth showing on the confirm card, per kind. */
  fieldsFor(kind) {
    const cur = { k: 'currency', l: 'Currency', t: 'select', o: () => this.currencies() };
    const date = { k: 'date', l: 'Date', t: 'date' };
    return {
      expense: [{ k: 'title', l: 'What', t: 'text' }, { k: 'amount', l: 'Amount', t: 'number' }, cur,
                { k: 'category', l: 'Category', t: 'text' }, { k: 'method', l: 'Paid with', t: 'text' }, date],
      income: [{ k: 'title', l: 'What', t: 'text' }, { k: 'amount', l: 'Amount', t: 'number' },
               { k: 'category', l: 'Category', t: 'text' }, date],
      task: [{ k: 'title', l: 'Task', t: 'text' }, { k: 'due', l: 'Due', t: 'date' },
             { k: 'priority', l: 'Priority', t: 'select', o: () => ['High', 'Medium', 'Low'] }],
      note: [{ k: 'title', l: 'Title', t: 'text' }, { k: 'content', l: 'Note', t: 'textarea' }],
      journal: [{ k: 'content', l: 'Entry', t: 'textarea' }, date],
      habit: [{ k: 'habit', l: 'Habit', t: 'text' }, date],
      fuel: [{ k: 'amount', l: 'Cost', t: 'number' }, { k: 'odometer', l: 'Odometer', t: 'number' }, date],
      service: [{ k: 'title', l: 'What was done', t: 'text' }, { k: 'amount', l: 'Cost', t: 'number' },
                { k: 'odometer', l: 'Odometer', t: 'number' }, date],
      unclear: []
    }[kind] || [];
  },

  currencies() {
    try { return currencyChoices().map(c => (c.v || c)); } catch (e) { return ['AED', 'EGP']; }
  },

  /** Names only — enough to match what you said, nothing about the amounts. */
  context() {
    const names = (list, key) => (list || []).map(x => x[key]).filter(Boolean).slice(0, 60);
    let methods = [];
    try {
      methods = [...new Set((Sheets.data.expenses || []).map(r => r.method).filter(Boolean))].slice(0, 20);
    } catch (e) { methods = []; }
    let cats = [];
    try {
      cats = [...new Set([...(LISTS.expenseCats || []),
        ...(Sheets.data.expenses || []).map(r => r.category).filter(Boolean)])].slice(0, 40);
    } catch (e) { cats = LISTS.expenseCats || []; }
    return {
      currencies: this.currencies(),
      categories: cats,
      methods: methods,
      projects: names(DB.projects, 'name'),
      habits: names(DB.habits, 'name')
    };
  },

  /* ---------------- asking ---------------- */
  async ask(payload) {
    if (this.busy) return;
    this.busy = true;
    this.paint();
    try {
      const out = await Sheets.call('assist', { ...payload, ...this.context() });
      const r = out.result || {};
      this.actions = r.actions || [];
      this.reply = r.reply || '';
      this.heard = r.transcript || payload.text || '';
      if (!this.actions.length) this.reply = this.reply || 'I did not catch anything to file.';
    } catch (err) {
      this.actions = [];
      this.reply = '';
      this.error = err.message || 'That did not work';
    } finally {
      this.busy = false;
      this.paint();
    }
  },

  /* ---------------- saving ---------------- */
  missing(a) {
    const needs = (this.KINDS[a.kind] || {}).needs || [];
    return needs.filter(k => a[k] === undefined || a[k] === '' || a[k] === null);
  },

  apply(a) {
    const when = a.date || today();
    switch (a.kind) {
      case 'expense':
        Sheets.addRow('expense', {
          name: a.title || a.category || 'Expense',
          amount: Number(a.amount) || 0,
          currency: a.currency || baseCur(),
          category: a.category || '',
          method: a.method || '',
          date: when
        });
        return `${a.currency || baseCur()} ${a.amount} saved to your sheet`;

      case 'income': {
        const cats = LISTS.incomeCats || [];
        DB.transactions.unshift({
          id: uid(), created: today(), updated: today(), ts: Date.now(),
          type: 'Income', amount: Number(a.amount) || 0,
          description: a.title || 'Income',
          category: cats.includes(a.category) ? a.category : 'Other Income',
          date: when, account: 'Checking'
        });
        saveDB();
        return 'Income recorded';
      }

      case 'task': {
        const project = this.match(DB.projects, 'name', a.project);
        DB.tasks.unshift({
          id: uid(), created: today(), updated: today(), ts: Date.now(),
          title: a.title || 'Untitled task',
          priority: a.priority || 'Medium',
          status: 'To Do',
          due: a.due || '',                 // no invented deadline — an unasked-for due date is just future guilt
          projectId: project ? project.id : '',
          notes: a.content || '', completed: ''
        });
        saveDB();
        return 'Task added';
      }

      case 'note': {
        const cats = LISTS.noteCats || [];
        const body = a.content || a.title || '';
        DB.notes.unshift({
          id: uid(), created: today(), updated: today(), ts: Date.now(),
          title: a.title || body.split(/[.\n]/)[0].slice(0, 60) || 'Note',
          category: cats.includes(a.category) ? a.category : 'Ideas',
          tags: [], content: body, pinned: false
        });
        saveDB();
        return 'Note saved';
      }

      case 'journal': {
        const entry = {
          id: uid(), created: today(), updated: today(), ts: Date.now(),
          date: when, tags: [], mood: a.mood || 4,
          title: a.title || '', content: a.content || ''
        };
        if (!entry.title) {
          try { entry.title = fmtDate(entry.date, { weekday: 'long', month: 'short', day: 'numeric' }); }
          catch (e) { entry.title = entry.date; }
        }
        DB.journal.unshift(entry);
        saveDB();
        return 'Journal entry saved';
      }

      case 'habit': {
        const h = this.match(DB.habits, 'name', a.habit);
        if (!h) throw new Error(`No habit called "${a.habit}"`);
        const done = (DB.habitLogs || []).find(l => l.habitId === h.id && l.date === when && l.done);
        if (done) return `${h.name} was already ticked`;
        toggleHabit(h.id, when);
        return `${h.name} ticked`;
      }

      case 'fuel':
        Sheets.addRow('fuel', { date: when, cost: Number(a.amount) || 0, odometer: Number(a.odometer) || 0 });
        return 'Fill-up saved to your car sheet';

      case 'service':
        Sheets.addRow('service', {
          item: a.title || 'Service', cost: Number(a.amount) || 0,
          date: when, odometer: Number(a.odometer) || 0
        });
        return 'Service saved to your car sheet';

      default:
        throw new Error('Nothing to save');
    }
  },

  match(list, key, name) {
    if (!name || !list) return null;
    const want = String(name).toLowerCase().trim();
    return list.find(x => String(x[key] || '').toLowerCase() === want)
      || list.find(x => String(x[key] || '').toLowerCase().includes(want))
      || list.find(x => want.includes(String(x[key] || '').toLowerCase()) && String(x[key] || '').length > 2)
      || null;
  },

  saveOne(i) {
    const a = this.actions[i];
    if (!a) return;
    const gaps = this.missing(a);
    if (gaps.length) { toast(`Still needs ${gaps.join(' and ')}`, { tone: 'error' }); return; }
    try {
      const said = this.apply(a);
      this.actions.splice(i, 1);
      toast(said);
      render();
      if (!this.actions.length) closeModal(); else this.paint();
    } catch (err) {
      toast(err.message || 'Could not save that', { tone: 'error' });
    }
  },

  saveAll() {
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const a = this.actions[i];
      if (a.kind === 'unclear' || this.missing(a).length) continue;
      try { this.apply(a); this.actions.splice(i, 1); } catch (e) { /* reported below */ }
    }
    render();
    if (!this.actions.length) { closeModal(); toast('All saved'); } else { this.paint(); toast('Saved what I could'); }
  },

  /* ---------------- talking ---------------- */
  canRecord() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  },
  pickMime() {
    const want = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return want.find(t => MediaRecorder.isTypeSupported(t)) || '';
  },
  async toggleMic() {
    if (this.recording) { this.stopMic(); return; }
    if (!this.canRecord()) { toast('This browser will not let a web app use the microphone', { tone: 'error' }); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast(/denied|not allowed/i.test(err.name + err.message)
        ? 'Microphone access was refused — allow it in your browser settings'
        : 'No microphone available', { tone: 'error' });
      return;
    }
    const mime = this.pickMime();
    try {
      this.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      this.rec = new MediaRecorder(stream);
    }
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      this.recording = false;
      clearInterval(this.tick);
      const blob = new Blob(this.chunks, { type: this.rec.mimeType || mime || 'audio/mp4' });
      this.chunks = [];
      if (blob.size < 1200) { this.paint(); toast('That was too short to hear'); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const b64 = String(fr.result).split(',')[1] || '';
        this.ask({ audio: b64, mime: (blob.type || 'audio/mp4').split(';')[0] });
      };
      fr.readAsDataURL(blob);
    };
    this.rec.start();
    this.recording = true;
    this.startedAt = Date.now();
    this.paint();
    this.tick = setInterval(() => {
      if (Date.now() - this.startedAt > ASSIST_MAX_SECONDS * 1000) this.stopMic();
      else this.paint(true);
    }, 500);
  },
  stopMic() {
    clearInterval(this.tick);
    if (this.rec && this.rec.state !== 'inactive') { try { this.rec.stop(); } catch (e) { /* already gone */ } }
    this.recording = false;
  },

  /* ---------------- the panel ---------------- */
  open(prefill) {
    if (!this.available()) {
      toast('Connect Google Sheets first — the assistant runs through your script', { tone: 'error' });
      if (typeof Sheets !== 'undefined') Sheets.openPanel();
      return;
    }
    this.actions = []; this.reply = ''; this.heard = ''; this.error = '';
    const m = openModal(`
      <div class="modal-head">
        <div><div class="eyebrow">Assistant</div><h3>Just say it</h3></div>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="as-input">
          <textarea class="input" id="asText" rows="2" placeholder="45 dirhams at carrefour on groceries"
            autocomplete="off" spellcheck="false">${esc(prefill || '')}</textarea>
          <div class="as-row">
            <button class="btn btn-ghost" id="asMic" title="Hold a thought — record it">${icon('mic', 15)} <span>Talk</span></button>
            <span class="as-hint" id="asHint">Enter to send</span>
            <span class="spacer"></span>
            <button class="btn btn-primary" id="asSend">${icon('sparkle', 15)} Send</button>
          </div>
        </div>
        <div id="asOut"></div>
        <div class="as-eg">
          <b>Try:</b> "spent 32 dhs on lunch with the adcb card" · "remind me to book the service on friday"
          · "idea: batch the weekly review into sunday morning" · "filled up 180 dirhams at 229400 km"
        </div>
      </div>`, false, '');

    $('#asSend', m).onclick = () => this.send();
    $('#asMic', m).onclick = () => this.toggleMic();
    const ta = $('#asText', m);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    setTimeout(() => { if (!/iPhone|iPad|Android/i.test(navigator.userAgent)) ta.focus(); }, 60);
  },

  send() {
    const ta = $('#asText');
    const text = ta ? ta.value.trim() : '';
    if (!text) { toast('Type something first, or tap Talk'); return; }
    this.ask({ text });
  },

  /* ---------------- drawing ---------------- */
  paint(timerOnly) {
    const out = $('#asOut');
    if (!out) return;
    const mic = $('#asMic');
    if (mic) {
      const secs = this.recording ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
      mic.classList.toggle('rec', this.recording);
      const label = mic.querySelector('span');
      if (label) label.textContent = this.recording ? `Stop · ${secs}s` : 'Talk';
    }
    if (timerOnly) return;

    if (this.busy) { out.innerHTML = `<div class="as-wait">${icon('sparkle', 15)} Working it out…</div>`; return; }
    if (this.error) { out.innerHTML = `<div class="as-err">${esc(this.error)}</div>`; return; }
    if (!this.actions.length && !this.reply) { out.innerHTML = ''; return; }

    const heard = this.heard ? `<div class="as-heard">“${esc(this.heard)}”</div>` : '';
    const cards = this.actions.map((a, i) => this.card(a, i)).join('');
    const many = this.actions.filter(a => a.kind !== 'unclear').length > 1;
    out.innerHTML = `${heard}
      ${this.reply ? `<p class="as-reply">${esc(this.reply)}</p>` : ''}
      ${cards}
      ${many ? `<div class="btn-row" style="margin-top:10px"><button class="btn btn-primary" id="asSaveAll">${icon('check', 15)} Save all</button></div>` : ''}`;

    this.actions.forEach((a, i) => {
      const card = out.querySelector(`[data-as="${i}"]`);
      if (!card) return;
      card.querySelectorAll('[data-k]').forEach(inp => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.k;
          a[k] = inp.type === 'number' ? (inp.value === '' ? undefined : Number(inp.value)) : inp.value;
          const warn = card.querySelector('[data-gap]');
          if (warn) warn.textContent = this.missing(a).length ? `Needs ${this.missing(a).join(' and ')}` : '';
        });
      });
      const save = card.querySelector('[data-save-one]');
      if (save) save.onclick = () => this.saveOne(i);
      const drop = card.querySelector('[data-drop]');
      if (drop) drop.onclick = () => { this.actions.splice(i, 1); this.paint(); };
    });
    const all = $('#asSaveAll', out);
    if (all) all.onclick = () => this.saveAll();
  },

  card(a, i) {
    const meta = this.KINDS[a.kind] || this.KINDS.unclear;
    if (a.kind === 'unclear') {
      return `<div class="as-card" data-as="${i}">
        <div class="as-kind">${icon('help', 15)} Not sure what to do with that</div>
        <p class="as-gap">Try naming the amount, or start with "task", "note" or "journal".</p>
      </div>`;
    }
    const fields = this.fieldsFor(a.kind).map(f => {
      const v = a[f.k] === undefined || a[f.k] === null ? '' : a[f.k];
      if (f.t === 'textarea') {
        return `<label class="as-f full"><span>${f.l}</span><textarea class="input" rows="3" data-k="${f.k}">${esc(String(v))}</textarea></label>`;
      }
      if (f.t === 'select') {
        const opts = (f.o ? f.o() : []).map(o => `<option${String(o) === String(v) ? ' selected' : ''}>${esc(String(o))}</option>`).join('');
        return `<label class="as-f"><span>${f.l}</span><select class="input" data-k="${f.k}">${opts}</select></label>`;
      }
      return `<label class="as-f"><span>${f.l}</span><input class="input" type="${f.t}" data-k="${f.k}"
        ${f.t === 'number' ? 'step="0.01" inputmode="decimal"' : ''} value="${esc(String(v))}"></label>`;
    }).join('');
    const gaps = this.missing(a);
    return `<div class="as-card" data-as="${i}">
      <div class="as-kind">${icon(meta.icon, 15)} ${meta.noun}${meta.to ? ` <span>→ ${meta.to}</span>` : ''}</div>
      <div class="as-fields">${fields}</div>
      <p class="as-gap" data-gap>${gaps.length ? `Needs ${gaps.join(' and ')}` : ''}</p>
      <div class="btn-row">
        <button class="btn btn-primary" data-save-one>${icon('check', 15)} Save</button>
        <button class="btn btn-ghost" data-drop>Discard</button>
      </div>
    </div>`;
  },

  /* ---------------- wiring ---------------- */
  init() {
    if (typeof Sheets === 'undefined') return;
    this.icons();
    this.styles();
    this.button();
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (this.available()) this.open();
      }
    });
  },

  /** Two glyphs the app's own set does not carry yet. */
  icons() {
    if (typeof ICONS === 'undefined') return;
    if (!ICONS.mic) ICONS.mic = '<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5"/>';
    if (!ICONS.help) ICONS.help = '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6"/><path d="M12 17.2h.01"/>';
  },

  button() {
    const btn = document.createElement('button');
    btn.id = 'assistBtn';
    btn.title = 'Assistant — say or type it (Ctrl J)';
    const foot = document.querySelector('.sidebar-foot');
    if (foot) {
      btn.className = 'nav-item as-btn';
      btn.innerHTML = `${icon('mic')}<span>Assistant</span>`;
      foot.insertBefore(btn, foot.firstChild);
    } else {
      btn.className = 'top-act as-btn';
      btn.setAttribute('aria-label', 'Assistant');
      btn.innerHTML = icon('mic', 19);
      const anchor = document.getElementById('searchBtn') || document.getElementById('syncBtn');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
      else document.querySelector('header')?.appendChild(btn);
    }
    btn.addEventListener('click', () => this.open());
  },

  styles() {
    const css = `
    .as-btn svg{color:var(--blue-2)}
    .as-input{background:var(--surface-2);border:1px solid var(--border);border-radius:14px;padding:10px}
    .as-input textarea{border:0;background:none;resize:none;min-height:46px;font-size:15px}
    .as-input textarea:focus{outline:none;box-shadow:none}
    .as-row{display:flex;align-items:center;gap:10px;margin-top:6px}
    .as-row .spacer{flex:1}
    .as-hint{font-size:11.5px;color:var(--text-3)}
    #asMic.rec{background:var(--red);color:#fff;border-color:transparent;animation:asPulse 1.2s infinite}
    @keyframes asPulse{50%{opacity:.72}}
    .as-wait{margin-top:14px;color:var(--text-2);font-size:13.5px;display:flex;align-items:center;gap:8px}
    .as-err{margin-top:14px;padding:11px 13px;border-radius:12px;font-size:13px;
      background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.3);color:#FFC9D2}
    .as-heard{margin-top:14px;font-size:13px;color:var(--text-3);font-style:italic}
    .as-reply{margin:6px 0 12px;font-size:14px;color:var(--text)}
    .as-card{background:var(--surface-2);border:1px solid var(--border);border-radius:14px;padding:13px;margin-bottom:10px}
    .as-kind{font-size:12px;font-weight:650;letter-spacing:.02em;text-transform:uppercase;color:var(--blue-2);
      display:flex;align-items:center;gap:7px;margin-bottom:11px}
    .as-kind span{color:var(--text-3);text-transform:none;letter-spacing:0;font-weight:500}
    .as-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:9px}
    .as-f{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--text-2)}
    .as-f.full{grid-column:1/-1}
    .as-f .input{font-size:14px;padding:8px 10px;min-height:38px}
    .as-gap{min-height:15px;margin:9px 0 4px;font-size:12px;color:var(--amber)}
    .as-eg{margin-top:16px;padding-top:13px;border-top:1px solid var(--border);
      font-size:11.5px;line-height:1.7;color:var(--text-3)}
    .as-eg b{color:var(--text-2)}`;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Assist.init());
else Assist.init();
