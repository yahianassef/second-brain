/* =========================================================
   SERVICE WORKER — only here to receive reminders.
   It caches nothing and answers no page requests, so it can never hold an
   old copy of the app. When your Apps Script knocks, this reads the new
   reminder from the script's inbox and shows it on the lock screen.
   ========================================================= */
const DB_NAME = 'secondBrainPush';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key) {
  const db = await idb();
  return new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });
}
async function kvSet(key, val) {
  const db = await idb();
  return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = res; t.onerror = res; });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function showReminders() {
  const cfg = await kvGet('cfg');
  const opts = { icon: 'icon-192.png', badge: 'icon-192.png' };
  let messages = [];
  if (cfg && cfg.url && cfg.token) {
    try {
      const u = new URL(cfg.url);
      u.searchParams.set('action', 'pushInbox');
      u.searchParams.set('token', cfg.token);
      u.searchParams.set('since', String(cfg.since || 0));
      const out = await (await fetch(u.toString(), { redirect: 'follow', cache: 'no-store' })).json();
      if (out.ok) messages = out.result.messages || [];
    } catch (e) { /* fall through to the plain notice */ }
  }
  if (!messages.length) {
    // every knock has to show something, or the phone stops delivering them
    const last = cfg && cfg.last;
    return self.registration.showNotification(last ? last.title : 'Second Brain',
      { ...opts, body: last ? last.body : 'You have a reminder — open the app to see it.', tag: 'second-brain' });
  }
  const newest = messages[messages.length - 1];
  await kvSet('cfg', { ...cfg, since: newest.ts, last: { title: newest.title, body: newest.body } });
  await Promise.all(messages.slice(-4).map(m =>
    self.registration.showNotification(m.title, { ...opts, body: m.body, tag: m.id, timestamp: m.ts })));
}

self.addEventListener('push', e => e.waitUntil(showReminders()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow('./m.html');
  })());
});
