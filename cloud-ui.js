/* =========================================================
   CLOUD MODE — the parts you can see
   =========================================================
   Sits on top of cloud.js and does nothing at all unless a real cloud-config.js
   is present, so the personal build (Google Sheets, gist, local-only) behaves
   exactly as before.

   When it is present:
     • nothing opens until someone signs in — the app is per-account
     • the GitHub-gist and Google-Sheets controls disappear, since a public
       visitor has neither
     • the sidebar gets an account button: sync state, sign out, delete my data
   ========================================================= */
const CloudUI = {
  mode: 'signin',                  // signin | signup | reset
  busy: false,

  init() {
    if (typeof Cloud === 'undefined') return;
    Cloud.load();
    if (!Cloud.enabled()) return;   // personal build — leave everything alone

    document.body.classList.add('cloud-mode');
    this.styles();
    this.hidePersonalChrome();
    this.accountButton();

    // Every local save should reach the account, not a gist or a spreadsheet.
    const save = saveDB;
    saveDB = function (...a) { save.apply(null, a); try { Cloud.queue(true); } catch (e) { /* ignore */ } };

    if (Cloud.signedIn()) { this.open(); } else { this.gate(); }
  },

  /** Opens the app for a signed-in account. */
  open() {
    const g = document.getElementById('cloudGate');
    if (g) g.remove();
    document.body.classList.remove('cloud-locked');
    DB = loadDB();
    render(); this.repaintNav(); Cloud.paint();
    Cloud.start();
  },

  repaintNav() { try { if (typeof renderNav === 'function') renderNav(); } catch (e) { /* view not ready */ } },

  /* ---------------- chrome ---------------- */
  hidePersonalChrome() {
    // A visitor has no gist token and no spreadsheet of ours, and the car pages
    // read a Google Sheet directly, so that view is not offered here.
    if (typeof VIEWS !== 'undefined') delete VIEWS.car;
    if (typeof TITLES !== 'undefined') delete TITLES.car;
    if (typeof UI !== 'undefined' && UI.view === 'car') UI.view = 'dashboard';
  },

  accountButton() {
    const btn = document.createElement('button');
    btn.id = 'cloudBtn';
    btn.dataset.cloudStatus = '';
    btn.title = 'Your account';
    btn.innerHTML = `${this.personIcon(18)}<span data-cloud-text>Account</span>`;
    const foot = document.querySelector('.sidebar-foot');
    if (foot) {                                   // desktop: sits with the other footer buttons
      btn.className = 'nav-item';
      foot.insertBefore(btn, foot.firstChild);
    } else {                                      // phone: the top bar, where the sync button was
      btn.className = 'top-act';
      btn.setAttribute('aria-label', 'Your account');
      btn.innerHTML = this.personIcon(19);
      const sync = document.getElementById('syncBtn');
      if (sync && sync.parentNode) sync.parentNode.insertBefore(btn, sync);
      else document.querySelector('header')?.appendChild(btn);
    }
    btn.addEventListener('click', () => this.panel());
  },

  personIcon(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.9-3.7 3.9-5.6 7.5-5.6s6.6 1.9 7.5 5.6"/></svg>`;
  },

  /* ---------------- the sign-in gate ---------------- */
  gate() {
    document.getElementById('cloudGate')?.remove();
    document.body.classList.add('cloud-locked');
    const el = document.createElement('div');
    el.id = 'cloudGate';
    el.innerHTML = this.gateHtml();
    document.body.appendChild(el);
    this.wireGate(el);
  },

  gateHtml() {
    const m = this.mode;
    const title = m === 'signup' ? 'Create your account' : m === 'reset' ? 'Reset your password' : 'Welcome back';
    const sub = m === 'signup' ? 'Everything you add is private to you and follows you to every device.'
      : m === 'reset' ? 'We will email you a link to set a new password.'
      : 'Sign in to pick up where you left off.';
    const action = m === 'signup' ? 'Create account' : m === 'reset' ? 'Send reset link' : 'Sign in';
    return `
    <div class="cg-card" role="dialog" aria-modal="true" aria-labelledby="cgTitle">
      <div class="cg-brand">
        <span class="cg-mark"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="13" r="2.4"/><circle cx="6.5" cy="19" r="2"/><circle cx="18" cy="18.5" r="2"/><path d="M7.8 8.4 10.3 11.4M16.4 7.6l-2.8 3.6M10.5 14.9l-2.5 2.6M13.9 14.6l2.7 2.3"/></svg></span>
        <div><div class="cg-name">Second Brain</div><div class="cg-sub">Your personal operating system</div></div>
      </div>
      <h2 id="cgTitle">${title}</h2>
      <p class="cg-lead">${sub}</p>
      <form id="cgForm" autocomplete="on" novalidate>
        <label for="cgEmail">Email</label>
        <input id="cgEmail" name="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@example.com" spellcheck="false">
        ${m === 'reset' ? '' : `
        <label for="cgPass">Password</label>
        <input id="cgPass" name="password" type="password" required minlength="6"
               autocomplete="${m === 'signup' ? 'new-password' : 'current-password'}"
               placeholder="${m === 'signup' ? 'At least 6 characters' : 'Your password'}">`}
        <p class="cg-msg" id="cgMsg" role="status" aria-live="polite"></p>
        <button class="cg-go" type="submit">${action}</button>
      </form>
      <div class="cg-alt">
        ${m === 'signin' ? `<button data-mode="signup">Create an account</button><button data-mode="reset">Forgot password?</button>`
          : `<button data-mode="signin">Back to sign in</button>${m === 'signin' ? '' : ''}`}
      </div>
      <p class="cg-fine">Your entries are stored under your account and are not visible to other people using this app. You can export or delete everything at any time from the account menu.</p>
    </div>`;
  },

  wireGate(el) {
    el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      this.mode = b.dataset.mode;
      el.innerHTML = this.gateHtml();
      this.wireGate(el);
      el.querySelector('#cgEmail')?.focus();
    }));
    const form = el.querySelector('#cgForm');
    const msg = el.querySelector('#cgMsg');
    const go = el.querySelector('.cg-go');
    const say = (text, bad) => { msg.textContent = text; msg.className = 'cg-msg' + (bad ? ' bad' : text ? ' good' : ''); };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.busy) return;
      const email = el.querySelector('#cgEmail').value.trim();
      const pass = (el.querySelector('#cgPass') || {}).value || '';
      if (!email) return say('Enter your email address.', true);
      if (this.mode !== 'reset' && pass.length < 6) return say('Password needs to be at least 6 characters.', true);

      this.busy = true; go.disabled = true;
      const wording = this.mode === 'signup' ? 'Creating your account…' : this.mode === 'reset' ? 'Sending…' : 'Signing in…';
      say(wording);
      try {
        if (this.mode === 'reset') {
          await Cloud.resetPassword(email);
          say('Check your email for the reset link.');
        } else if (this.mode === 'signup') {
          const r = await Cloud.signUp(email, pass);
          if (r.signedIn) { this.open(); return; }
          say('Almost there — confirm the address from the email we just sent, then sign in.');
          this.mode = 'signin';
          setTimeout(() => { el.innerHTML = this.gateHtml(); this.wireGate(el); }, 2600);
        } else {
          await Cloud.signIn(email, pass);
          this.open();
          return;
        }
      } catch (err) {
        say(err.message || 'That did not work — try again.', true);
      } finally {
        this.busy = false; go.disabled = false;
      }
    });
    setTimeout(() => el.querySelector('#cgEmail')?.focus(), 60);
  },

  /* ---------------- account panel ---------------- */
  panel() {
    const email = (Cloud.user() || {}).email || '';
    const m = openModal(`
      <div class="modal-head">
        <div><div class="eyebrow">Account</div><h3>${esc(email || 'Signed in')}</h3></div>
        <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="sync-state" data-cloud-status><span class="sync-dot"></span><b data-cloud-text>${esc(Cloud.label())}</b></div>
        <p class="hint" style="margin-top:8px">${esc(Cloud.message || 'Your data syncs to your account automatically.')}</p>

        <div class="set-section"><h4>This device</h4>
          <p>Changes are saved here first and sent to your account within a few seconds, so the app keeps working if you lose signal.</p>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn btn-primary" id="cuSync">${icon('sparkle', 15)} Sync now</button>
            <button class="btn btn-ghost" id="cuOut">${icon('x', 15)} Sign out</button>
          </div>
        </div>

        <div class="set-section"><h4>Your data</h4>
          <p>Everything you add belongs to this account. Nobody else using this app can see it.</p>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn btn-ghost" id="cuExport">${icon('download', 15)} Download a copy</button>
            <button class="btn btn-danger" id="cuWipe">${icon('trash', 15)} Delete everything</button>
          </div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" data-close>Close</button></div>`, false, '');

    m.querySelector('#cuSync').onclick = () => Cloud.sync('manual');
    m.querySelector('#cuOut').onclick = () => confirmDialog(
      'Sign out of this device?',
      'Your data stays safe in your account. It is removed from this browser, so the next person using this device cannot read it.',
      'Sign out',
      async () => { await Cloud.signOut(); this.mode = 'signin'; this.gate(); render(); this.repaintNav(); });
    m.querySelector('#cuExport').onclick = () => {
      try {
        download(`second-brain-backup-${today()}.json`,
          JSON.stringify({ app: 'Second Brain', exported: new Date().toISOString(), ...DB }, null, 2),
          'application/json');
        toast('Backup downloaded');
      } catch (e) { toast('Could not build the file', { tone: 'error' }); }
    };
    m.querySelector('#cuWipe').onclick = () => confirmDialog(
      'Delete everything?',
      'This removes every project, task, note, journal entry and transaction from your account on every device. It cannot be undone.',
      'Delete everything',
      async () => {
        try {
          await Cloud.deleteEverything();
          DB = emptyDB();
          try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { /* ignore */ }
          render(); this.repaintNav();
          toast('Your account is now empty');
        } catch (err) { toast(err.message || 'Could not delete — try again', { tone: 'error' }); }
      });
  },

  /* ---------------- styles ---------------- */
  styles() {
    const css = `
    body.cloud-mode #syncBtn, body.cloud-mode #sheetsBtn { display:none }
    body.cloud-locked .app, body.cloud-locked .toasts { filter:blur(7px); pointer-events:none; user-select:none }
    #cloudGate{position:fixed;inset:0;z-index:300;display:grid;place-items:center;padding:20px;
      background:radial-gradient(1100px 600px at 50% -10%,rgba(0,120,255,.18),transparent 60%),rgba(7,9,13,.92);
      backdrop-filter:blur(6px);overflow:auto}
    .cg-card{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--border);
      border-radius:18px;padding:26px 24px 20px;box-shadow:var(--shadow);animation:cgIn .22s var(--ease)}
    @keyframes cgIn{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
    .cg-brand{display:flex;align-items:center;gap:11px;margin-bottom:20px}
    .cg-mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;
      background:linear-gradient(135deg,var(--blue),var(--blue-2));box-shadow:0 6px 18px -6px var(--blue-glow)}
    .cg-name{font-weight:700;letter-spacing:-.01em}
    .cg-sub{font-size:11.5px;color:var(--text-3)}
    .cg-card h2{font-size:21px;letter-spacing:-.02em;margin:0 0 5px}
    .cg-lead{color:var(--text-2);font-size:13.5px;margin:0 0 18px;line-height:1.55}
    .cg-card label{display:block;font-size:12px;font-weight:600;color:var(--text-2);margin:0 0 6px}
    .cg-card input{width:100%;background:var(--bg-2);color:var(--text);border:1px solid var(--border-2);
      border-radius:11px;padding:11px 13px;font:inherit;font-size:14.5px;margin-bottom:14px;min-height:44px}
    .cg-card input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-soft)}
    .cg-go{width:100%;min-height:46px;border:0;border-radius:11px;cursor:pointer;font:inherit;font-weight:650;
      font-size:14.5px;color:#fff;background:linear-gradient(135deg,var(--blue),var(--blue-2));
      box-shadow:0 10px 24px -12px var(--blue-glow);transition:transform .12s var(--ease),opacity .12s}
    .cg-go:hover{transform:translateY(-1px)} .cg-go:disabled{opacity:.6;cursor:default;transform:none}
    .cg-msg{min-height:18px;font-size:12.5px;margin:0 0 10px;color:var(--text-3)}
    .cg-msg.bad{color:var(--red)} .cg-msg.good{color:var(--text-2)}
    .cg-alt{display:flex;gap:14px;justify-content:space-between;flex-wrap:wrap;margin:16px 0 0}
    .cg-alt button{background:none;border:0;padding:0;cursor:pointer;font:inherit;font-size:12.5px;color:var(--blue-2)}
    .cg-alt button:hover{text-decoration:underline}
    .cg-fine{margin:16px 0 0;padding-top:14px;border-top:1px solid var(--border);
      font-size:11.5px;line-height:1.6;color:var(--text-3)}
    [data-cloud-status][data-state="error"] .sync-dot{background:var(--red)}
    [data-cloud-status][data-state="syncing"] .sync-dot{background:var(--amber)}`;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => CloudUI.init());
else CloudUI.init();
