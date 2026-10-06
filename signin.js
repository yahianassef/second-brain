/* =========================================================
   SIGN IN WITH GMAIL
   A device that is not connected yet shows one button. Tapping it asks your
   Apps Script to email you a "Yes, it's me" link; opening that link (on any
   device) approves the request, and the waiting device collects its
   connection by itself. Nothing to type: no address, no secret, no token.
   ========================================================= */
const SIGNIN = {
  // Your Apps Script web app. Not a secret on its own: everything behind it
  // still needs the secret, which only an approved sign-in hands out.
  api: (window.SB_CONNECT && window.SB_CONNECT.api) || '',
  KEY: 'secondBrain.signin',
  timer: null,

  ready() { return !!this.api && typeof Sheets !== 'undefined'; },

  async post(action, body) {
    const res = await fetch(this.api, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...body })
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'Sign-in failed');
    return out.result;
  },

  hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); },
  async sha(text) { return this.hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))); },
  device() { return typeof PhonePush !== 'undefined' ? PhonePush.device().replace(/^device$/, 'device') : 'device'; },

  pending() { try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch (e) { return null; } },
  setPending(p) { try { p ? localStorage.setItem(this.KEY, JSON.stringify(p)) : localStorage.removeItem(this.KEY); } catch (e) { /* private mode */ } },

  /** Step 1, from the button: ask for the email. */
  async start() {
    const nonce = this.hex(crypto.getRandomValues(new Uint8Array(16)));
    const proof = this.hex(crypto.getRandomValues(new Uint8Array(32)));
    const r = await this.post('signinStart', { nonce, check: await this.sha(proof), device: this.device() });
    const p = { nonce, proof, code: r.code, to: r.sentTo, ts: Date.now() };
    this.setPending(p);
    return p;
  },

  /** Step 2, by itself: wait for the approval and collect the connection. */
  async claim() {
    const p = this.pending();
    if (!p) return 'none';
    if (Date.now() - p.ts > 15 * 60000) { this.setPending(null); return 'expired'; }
    const r = await this.post('signinClaim', { nonce: p.nonce, proof: p.proof });
    if (r.status === 'expired') { this.setPending(null); return 'expired'; }
    if (r.status !== 'approved') return 'waiting';
    this.setPending(null);
    Sheets.load();
    Sheets.cfg.url = this.api; Sheets.cfg.secret = r.secret; Sheets.cfg.auto = true;
    Sheets.save();
    try { Sheets.init(); await Sheets.sync('manual'); } catch (e) { /* sync retries on its own */ }
    return 'approved';
  },

  /** The sign-in sheet shown on a device that is not connected. */
  open() {
    if (!this.ready() || $('.overlay')) return;
    const m = openModal(`
      <div class="modal-head"><div><div class="eyebrow">Welcome</div><h3>Sign in to Second Brain</h3></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body" id="siBody"></div>
      <div class="modal-foot"><button class="btn btn-ghost" data-close>Not now</button></div>`, false, 'small');
    const body = $('#siBody', m);
    const idle = msg => {
      body.innerHTML = `<p style="color:var(--text-2)">Your tasks, notes, money and reminders come with you — no codes or links to paste.</p>
        <button class="btn btn-primary" id="siGo" style="width:100%;margin-top:14px;justify-content:center">${icon('check', 16)} Sign in with Gmail</button>
        ${msg ? `<p class="hint" style="margin-top:10px">${msg}</p>` : ''}`;
      $('#siGo', m).onclick = async () => {
        $('#siGo', m).disabled = true;
        try { await this.start(); waiting(); } catch (err) { idle(`<span class="txt-red">${esc(err.message)}</span>`); }
      };
    };
    const waiting = () => {
      const p = this.pending();
      body.innerHTML = `<p style="color:var(--text-2)">We emailed <b>${esc(p.to)}</b>. Open it and tap <b>Yes, it’s me</b>.</p>
        <div style="font-size:34px;font-weight:700;letter-spacing:.1em;text-align:center;margin:16px 0 4px">${esc(p.code)}</div>
        <p class="hint" style="text-align:center">The email shows the same code.</p>
        <p class="hint" id="siState" style="margin-top:12px;text-align:center">Waiting for you to approve…</p>
        <button class="btn btn-ghost sm" id="siAgain" style="margin:10px auto 0;display:flex">Send the email again</button>`;
      $('#siAgain', m).onclick = () => { this.setPending(null); idle(); };
      this.poll(m, ok => {
        if (ok === 'approved') {
          body.innerHTML = `<p style="font-size:17px;font-weight:600">You’re in.</p><p class="hint">Your data is loading now.</p>`;
          setTimeout(() => { closeModal(); render(); toast('Signed in — your data is here'); this.afterSignIn(); }, 900);
        } else if (ok === 'expired') idle('That request expired. Send a new one.');
      });
    };
    this.pending() ? waiting() : idle();
  },

  poll(m, done) {
    clearInterval(this.timer);
    const tick = async () => {
      if (!document.body.contains(m)) { clearInterval(this.timer); return; }
      if (document.visibilityState !== 'visible') return;
      try { const r = await this.claim(); if (r !== 'waiting') { clearInterval(this.timer); done(r); } } catch (e) { /* try again next tick */ }
    };
    this.timer = setInterval(tick, 3000);
    tick();
  },

  afterSignIn() {
    try { localStorage.removeItem('secondBrain.pushOffered'); } catch (e) { /* fine */ }
    if (typeof PhonePush !== 'undefined') setTimeout(() => PhonePush.offer(), 1500);
  },

  /** Opened from the email: approve the request. */
  async approveFromLink() {
    const m = location.hash.match(/[#&]approve=([a-f0-9]{32})\.([a-f0-9]{64})/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    if (!this.api) return false;
    const box = openModal(`
      <div class="modal-head"><div><div class="eyebrow">Sign in</div><h3>Approving…</h3></div><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body" id="apBody"><p class="hint">One moment.</p></div>
      <div class="modal-foot"><button class="btn btn-primary" data-close>Close</button></div>`, false, 'small');
    try {
      const r = await this.post('signinApprove', { nonce: m[1], sig: m[2] });
      $('h3', box).textContent = 'Approved';
      $('#apBody', box).innerHTML = `<p>Your <b>${esc(r.device)}</b> (code <b>${esc(r.code)}</b>) is signing in now.</p><p class="hint" style="margin-top:8px">Go back to Second Brain on that device — it continues by itself.</p>`;
    } catch (err) {
      $('h3', box).textContent = 'Could not approve';
      $('#apBody', box).innerHTML = `<p class="txt-red">${esc(err.message)}</p>`;
    }
    return true;
  }
};

window.addEventListener('load', () => setTimeout(async () => {
  if (!SIGNIN.ready()) return;
  if (await SIGNIN.approveFromLink()) return;
  if (Sheets.connected()) { SIGNIN.setPending(null); return; }
  // a request still waiting (the app was closed while you were in Gmail): pick it up
  if (SIGNIN.pending()) { SIGNIN.open(); return; }
  try { if (sessionStorage.getItem('secondBrain.signinLater')) return; } catch (e) { /* private mode */ }
  SIGNIN.open();
}, 700));
document.addEventListener('click', e => {
  if (e.target.closest('#siBody') || !e.target.closest('[data-close]') || !$('#siBody')) return;
  try { sessionStorage.setItem('secondBrain.signinLater', '1'); } catch (err) { /* private mode */ }
}, true);
