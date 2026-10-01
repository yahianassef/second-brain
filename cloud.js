/* =========================================================
   CLOUD MODE — accounts and per-user storage (the public edition)
   =========================================================
   Loaded only where a cloud-config.js exists, so the personal build (Google
   Sheets, gist, local-only) is untouched by any of this.

   Talks to Supabase over plain HTTPS rather than pulling in their SDK, so the
   app keeps its "no external scripts" rule. Two endpoints are all it needs:
   GoTrue for accounts and PostgREST for rows.

   Storage shape matches the app's own: one row per item carrying that item's
   JSON and the `ts` the app already stamps on every edit, so the existing merge
   rules apply unchanged — newest edit wins, deletions travel as tombstones.
   ========================================================= */
const CLOUD_SESSION = 'secondBrain.cloud.session';
const CLOUD_STATE = 'secondBrain.cloud.state';
const CLOUD_COLLECTIONS = ['projects', 'tasks', 'transactions', 'budgets', 'goals', 'journal',
  'courses', 'notes', 'habits', 'habitLogs', 'study', 'workouts', 'links'];
const CLOUD_PAGE = 500;

const Cloud = {
  cfg: null,                       // { url, anonKey } from cloud-config.js
  session: null,                   // { access_token, refresh_token, expires_at, user }
  state: { cursor: '', pushedTs: 0 },
  status: 'off', message: '', busy: false, applying: false, timer: null, poll: null,

  /* ---------------- setup ---------------- */
  enabled() { return !!(this.cfg && this.cfg.url && this.cfg.anonKey); },
  signedIn() { return !!(this.session && this.session.access_token); },
  user() { return this.session && this.session.user ? this.session.user : null; },

  load() {
    this.cfg = (typeof window !== 'undefined' && window.SB_CLOUD_CONFIG) || null;
    try { this.session = JSON.parse(localStorage.getItem(CLOUD_SESSION) || 'null'); } catch (e) { this.session = null; }
    try { Object.assign(this.state, JSON.parse(localStorage.getItem(CLOUD_STATE) || '{}')); } catch (e) { /* ignore */ }
  },
  saveSession() {
    try {
      if (this.session) localStorage.setItem(CLOUD_SESSION, JSON.stringify(this.session));
      else localStorage.removeItem(CLOUD_SESSION);
    } catch (e) { /* ignore */ }
  },
  saveState() { try { localStorage.setItem(CLOUD_STATE, JSON.stringify(this.state)); } catch (e) { /* ignore */ } },

  /* ---------------- accounts ---------------- */
  async auth(path, body, useToken) {
    const res = await fetch(`${this.cfg.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: Object.assign(
        { apikey: this.cfg.anonKey, 'Content-Type': 'application/json' },
        useToken && this.session ? { Authorization: `Bearer ${this.session.access_token}` } : {}
      ),
      body: JSON.stringify(body || {})
    });
    let out = {};
    try { out = await res.json(); } catch (e) { out = {}; }
    if (!res.ok) throw new Error(this.explain(res.status, out));
    return out;
  },
  /** Supabase's own wording is terse and sometimes cryptic; say what to do. */
  explain(status, body) {
    const msg = String((body && (body.error_description || body.msg || body.message || body.error)) || '');
    if (/already registered/i.test(msg)) return 'That email already has an account — sign in instead.';
    if (/invalid login/i.test(msg)) return 'Email or password is not right.';
    if (/email not confirmed/i.test(msg)) return 'Check your email and confirm the address first.';
    if (/password/i.test(msg) && /least/i.test(msg)) return 'Password needs to be at least 6 characters.';
    if (status === 429) return 'Too many attempts — wait a minute and try again.';
    if (status === 0) return 'Could not reach the server.';
    return msg || `Server error ${status}`;
  },
  keep(res) {
    if (!res || !res.access_token) return null;
    this.session = {
      access_token: res.access_token,
      refresh_token: res.refresh_token,
      expires_at: Date.now() + (Number(res.expires_in || 3600) * 1000),
      user: res.user ? { id: res.user.id, email: res.user.email } : (this.session || {}).user
    };
    this.saveSession();
    return this.session;
  },

  async signUp(email, password) {
    const res = await this.auth('signup', { email, password });
    // With email confirmation on, there is no session until they click the link.
    if (res.access_token) { this.keep(res); return { signedIn: true }; }
    return { signedIn: false, confirmEmail: true };
  },
  async signIn(email, password) {
    const res = await this.auth('token?grant_type=password', { email, password });
    this.keep(res);
    return { signedIn: true };
  },
  async resetPassword(email) {
    await this.auth('recover', { email });
    return true;
  },
  async refresh() {
    if (!this.session || !this.session.refresh_token) throw new Error('Signed out');
    const res = await this.auth('token?grant_type=refresh_token', { refresh_token: this.session.refresh_token });
    if (!this.keep(res)) throw new Error('Signed out');
    return this.session;
  },
  async signOut(keepLocal) {
    try { if (this.signedIn()) await this.auth('logout', {}, true); } catch (e) { /* going anyway */ }
    this.session = null;
    this.saveSession();
    this.state = { cursor: '', pushedTs: 0 };
    this.saveState();
    clearInterval(this.poll);
    this.status = 'off';
    // Someone else may use this browser next, so the data does not stay behind
    // unless explicitly asked for.
    if (!keepLocal) {
      DB = emptyDB();
      try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { /* ignore */ }
    }
  },

  /* ---------------- rows ---------------- */
  async rest(path, opts = {}, retry = true) {
    if (!this.signedIn()) throw new Error('Signed out');
    if (this.session.expires_at && Date.now() > this.session.expires_at - 60000) await this.refresh();
    const res = await fetch(`${this.cfg.url}/rest/v1/${path}`, Object.assign({}, opts, {
      headers: Object.assign({
        apikey: this.cfg.anonKey,
        Authorization: `Bearer ${this.session.access_token}`,
        'Content-Type': 'application/json'
      }, opts.headers || {})
    }));
    if (res.status === 401 && retry) { await this.refresh(); return this.rest(path, opts, false); }
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch (e) { /* ignore */ }
      throw new Error(this.explain(res.status, body));
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },

  /** Everything the server has seen change since this device last looked. */
  async pull() {
    const since = this.state.cursor || '1970-01-01T00:00:00Z';
    const rows = [];
    let cursor = since;
    for (let page = 0; page < 40; page++) {   // 20k rows is far beyond a real account
      const batch = await this.rest(
        `items?select=coll,item_id,ts,deleted,data,updated_at&updated_at=gt.${encodeURIComponent(cursor)}` +
        `&order=updated_at.asc&limit=${CLOUD_PAGE}`);
      if (!batch || !batch.length) break;
      rows.push(...batch);
      cursor = batch[batch.length - 1].updated_at;
      if (batch.length < CLOUD_PAGE) break;
    }
    const profile = await this.rest('profiles?select=settings,ts,updated_at&limit=1');
    return { rows, profile: profile && profile[0] ? profile[0] : null, cursor };
  },

  /** Upserts a batch; the primary key is (user, collection, item). */
  async push(rows) {
    for (let i = 0; i < rows.length; i += CLOUD_PAGE) {
      await this.rest('items?on_conflict=user_id,coll,item_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows.slice(i, i + CLOUD_PAGE))
      });
    }
  },
  async pushProfile(settings, ts) {
    await this.rest('profiles?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ settings, ts }])
    });
  },

  /* ---------------- turning local data into rows and back ---------------- */
  localChanges() {
    const since = Number(this.state.pushedTs) || 0;
    const rows = [];
    let newest = since;
    CLOUD_COLLECTIONS.forEach(coll => {
      (DB[coll] || []).forEach(item => {
        const ts = Number(item.ts) || 0;
        if (!item.id) return;
        // An item with no stamp at all predates syncing; send it once, on the
        // first sync of this device, rather than leaving it stranded.
        if (!ts) { if (!since) rows.push({ coll, item_id: String(item.id), ts: 0, deleted: false, data: item }); return; }
        if (ts <= since) return;
        rows.push({ coll, item_id: String(item.id), ts, deleted: false, data: item });
        if (ts > newest) newest = ts;
      });
    });
    (DB.trash || []).forEach(t => {
      const ts = Number(t.ts) || 0;
      if (ts <= since || !t.id) return;
      // the collection is unknown for a tombstone, so it is recorded under a
      // reserved name and applied to whichever list still holds that id
      rows.push({ coll: '_trash', item_id: String(t.id), ts, deleted: true, data: {} });
      if (ts > newest) newest = ts;
    });
    return { rows, newest };
  },

  applyRemote(rows) {
    if (!rows.length) return false;
    let changed = false;
    const tomb = [];
    rows.forEach(row => {
      if (row.deleted || row.coll === '_trash') { tomb.push({ id: row.item_id, ts: Number(row.ts) || 0 }); return; }
      const list = DB[row.coll];
      if (!Array.isArray(list)) return;
      const i = list.findIndex(x => String(x.id) === row.item_id);
      const incoming = row.data || {};
      if (i < 0) { list.unshift(incoming); changed = true; }
      else if ((Number(incoming.ts) || 0) > (Number(list[i].ts) || 0)) { list[i] = incoming; changed = true; }
    });
    if (tomb.length) {
      const known = new Set((DB.trash || []).map(t => t.id));
      tomb.forEach(t => {
        if (!known.has(t.id)) { DB.trash = (DB.trash || []).concat(t); changed = true; }
        CLOUD_COLLECTIONS.forEach(coll => {
          const list = DB[coll];
          if (!Array.isArray(list)) return;
          const i = list.findIndex(x => String(x.id) === t.id && (Number(x.ts) || 0) <= t.ts);
          if (i >= 0) { list.splice(i, 1); changed = true; }
        });
      });
    }
    return changed;
  },

  /* ---------------- the sync cycle ---------------- */
  async sync(mode = 'manual') {
    if (!this.enabled() || !this.signedIn() || this.busy) return;
    if (!navigator.onLine) { this.status = 'error'; this.message = 'Offline — changes go up when you reconnect'; this.paint(); return; }
    this.busy = true; this.status = 'syncing'; this.message = 'Syncing…'; this.paint();
    const startedAt = Date.now();
    try {
      // send first, so a device that has been offline does not lose an edit to
      // an incoming copy of the same item
      const mine = this.localChanges();
      if (mine.rows.length) {
        await this.push(mine.rows);
        this.state.pushedTs = mine.newest;
      }
      const settingsTs = Number((DB.settings || {}).ts) || 0;
      if (settingsTs > (Number(this.state.settingsTs) || 0)) {
        await this.pushProfile(DB.settings || {}, settingsTs);
        this.state.settingsTs = settingsTs;
      }

      const { rows, profile, cursor } = await this.pull();
      this.applying = true;
      let changed = this.applyRemote(rows);
      if (profile && (Number(profile.ts) || 0) > settingsTs) {
        DB.settings = Object.assign({}, DB.settings, profile.settings || {});
        this.state.settingsTs = Number(profile.ts) || 0;
        changed = true;
      }
      if (changed) { try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { /* ignore */ } }
      this.applying = false;

      // Anything that came down is already on the server, so the push watermark
      // can move past it — otherwise a device that has just signed in would
      // upload its whole pull straight back. It stops at the moment this cycle
      // began, so an edit made while syncing is still picked up next time.
      const newestIn = rows.reduce((m, r) => Math.max(m, Number(r.ts) || 0), 0);
      const safe = Math.min(newestIn, startedAt);
      if (safe > (Number(this.state.pushedTs) || 0)) this.state.pushedTs = safe;

      this.state.cursor = cursor;
      this.saveState();
      this.status = 'idle';
      this.message = 'Synced ' + new Date().toLocaleTimeString();
      if (changed) { try { render(); } catch (e) { /* view not ready */ } }
      if (mode === 'manual') toast(changed ? 'Synced — this device updated' : 'Everything is up to date');
    } catch (err) {
      this.applying = false;
      this.status = 'error';
      this.message = err.message || 'Sync failed';
      if (/signed out/i.test(this.message)) { await this.signOut(true); try { render(); } catch (e) { /* ignore */ } }
      else if (mode !== 'auto') toast(this.message, { tone: 'error' });
    } finally {
      this.busy = false;
      this.paint();
    }
  },
  queue(soon) {
    if (!this.enabled() || !this.signedIn() || this.applying) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync('auto'), soon ? 1200 : 4000);
  },
  start() {
    clearInterval(this.poll);
    if (!this.signedIn()) return;
    this.sync('startup');
    this.poll = setInterval(() => { if (!document.hidden) this.sync('auto'); }, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.sync('auto'); });
    window.addEventListener('online', () => this.sync('auto'));
  },

  /** Wipes this account's rows, for "delete my data". */
  async deleteEverything() {
    await this.rest('rpc/delete_my_data', { method: 'POST', body: '{}' });
    this.state = { cursor: '', pushedTs: 0 };
    this.saveState();
  },

  label() {
    if (!this.signedIn()) return 'Signed out';
    if (this.status === 'syncing') return 'Syncing…';
    if (this.status === 'error') return 'Sync issue';
    return this.user() ? this.user().email : 'Signed in';
  },
  paint() {
    document.querySelectorAll('[data-cloud-status]').forEach(el => {
      el.dataset.state = this.signedIn() ? this.status : 'off';
      const t = el.querySelector('[data-cloud-text]');
      (t || el).textContent = this.label();
      el.title = this.message || '';
    });
  }
};
