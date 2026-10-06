/* =========================================================
   PHONE NOTIFICATIONS — no app to install
   On an iPhone this works once the site is on the Home Screen and opened from
   there (Apple only allows it that way). Turning it on asks the phone for
   permission, gets an address your Apps Script can knock on, and hands the
   script that address. Shared by the desktop and phone builds.
   ========================================================= */
const PhonePush = {
  ios: /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  homeScreen: window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches,

  /** 'ready' | 'needs-home-screen' | 'unsupported' | 'blocked' */
  can() {
    if (!('serviceWorker' in navigator)) return this.ios && !this.homeScreen ? 'needs-home-screen' : 'unsupported';
    if (!('PushManager' in window) || !('Notification' in window)) return this.ios && !this.homeScreen ? 'needs-home-screen' : 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    return 'ready';
  },

  async registration() {
    return navigator.serviceWorker.register('sw.js', { scope: './' }).then(() => navigator.serviceWorker.ready);
  },

  /** Is this device already signed up with the script? */
  async isOn() {
    try {
      if (this.can() !== 'ready' || Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.getRegistration('./');
      const sub = reg && await reg.pushManager.getSubscription();
      const cfg = await this.kv('cfg');
      return !!(sub && cfg && cfg.token);
    } catch (e) { return false; }
  },

  device() {
    const ua = navigator.userAgent;
    return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
      : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'device';
  },

  /** Must run from a tap — Safari only asks for permission then. */
  async enable() {
    const state = this.can();
    if (state === 'needs-home-screen') throw new Error('Add the site to your Home Screen first (Share → Add to Home Screen), then open it from there.');
    if (state === 'unsupported') throw new Error('This browser cannot receive notifications from a website.');
    if (state === 'blocked') throw new Error('Notifications are blocked for this app. Allow them in the phone’s Settings → Notifications → Second Brain.');
    if (!Sheets.connected()) throw new Error('Connect Google Sheets sync first — reminders are sent by your Apps Script.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications were not allowed. You can allow them later in the phone’s Settings.');
    const ping = await Sheets.call('ping', {}, 'GET');
    if (!ping.version || ping.version < 16) throw new Error('Your Apps Script needs the latest version for this. Paste the new Code.gs and deploy a new version.');
    const key = (await Sheets.call('pushKey', {})).result.publicKey;
    const reg = await this.registration();
    let sub = await reg.pushManager.getSubscription();
    if (sub) { try { await sub.unsubscribe(); } catch (e) { /* replaced below */ } }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.keyBytes(key) });
    const r = (await Sheets.call('pushSubscribe', { subscription: sub.toJSON(), device: this.device() })).result;
    await this.kv('cfg', { url: Sheets.cfg.url, token: r.token, since: Date.now() });
    return r;
  },

  async disable() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('./');
      const sub = reg && await reg.pushManager.getSubscription();
      const cfg = await this.kv('cfg');
      if (sub) {
        try { await Sheets.call('pushUnsubscribe', { endpoint: sub.endpoint, token: cfg && cfg.token }); } catch (e) { /* the script drops it on its own next time */ }
        await sub.unsubscribe();
      }
      await this.kv('cfg', null);
    } catch (e) { /* nothing to undo */ }
  },

  keyBytes(b64) {
    const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  },

  /* the service worker cannot read localStorage, so the script's address and
     this device's token live in IndexedDB, which both can reach */
  kv(key, val) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('secondBrainPush', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (val === undefined) {
          const r = db.transaction('kv').objectStore('kv').get(key);
          r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined);
        } else {
          const t = db.transaction('kv', 'readwrite');
          val === null ? t.objectStore('kv').delete(key) : t.objectStore('kv').put(val, key);
          t.oncomplete = () => resolve(val); t.onerror = () => reject(t.error);
        }
      };
    });
  }
};

/* Keep the helper current, and keep the script's address current if sync moves. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration('./');
      if (!reg) return;
      reg.update();
      const cfg = await PhonePush.kv('cfg');
      if (cfg && typeof Sheets !== 'undefined' && Sheets.cfg.url && cfg.url !== Sheets.cfg.url) await PhonePush.kv('cfg', { ...cfg, url: Sheets.cfg.url });
    } catch (e) { /* notifications are optional */ }
  });
}
