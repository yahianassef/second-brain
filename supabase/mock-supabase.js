/* A stand-in for Supabase, shared by the tests in this folder: accounts,
   tokens, and a rows table scoped to whoever's token made the call — so a test
   can prove one account never sees another's rows. The real isolation is
   enforced by row level security in schema.sql; this only checks that the
   client asks for the right things.

   Load it before cloud.js. It replaces window.fetch, so nothing leaves the page. */
(function () {
  const MockSB = {
    users: {},            // email -> { id, password, confirmed }
    tokens: {},           // access token -> user id
    refresh: {},          // refresh token -> user id
    rows: [],             // { user_id, coll, item_id, ts, deleted, data, updated_at }
    profiles: {},         // user_id -> { settings, ts, updated_at }
    clock: Date.parse('2026-01-01T00:00:00Z'),
    expireNext: false,
    calls: []
  };
  const mockIso = () => new Date(MockSB.clock += 1000).toISOString();
  const mockId = p => p + '-' + Math.random().toString(36).slice(2, 8);

  function mockIssue(userId) {
    const a = mockId('acc'), r = mockId('ref');
    MockSB.tokens[a] = userId; MockSB.refresh[r] = userId;
    return { access_token: a, refresh_token: r, expires_in: MockSB.expireNext ? -10 : 3600,
             user: { id: userId, email: Object.keys(MockSB.users).find(e => MockSB.users[e].id === userId) } };
  }
  function mockWho(headers) {
    const auth = (headers || {}).Authorization || '';
    return MockSB.tokens[auth.replace('Bearer ', '')] || null;
  }

  window.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'https://mock.supabase.co');
    const body = opts.body ? JSON.parse(opts.body) : {};
    const headers = opts.headers || {};
    MockSB.calls.push((opts.method || 'GET') + ' ' + u.pathname + u.search);
    const json = (status, obj) => ({ ok: status < 400, status,
      json: async () => obj, text: async () => JSON.stringify(obj) });

    if (headers.apikey !== 'anon-key-123') return json(401, { message: 'No API key found in request' });

    /* ---- accounts ---- */
    if (u.pathname === '/auth/v1/signup') {
      if (MockSB.users[body.email]) return json(400, { msg: 'User already registered' });
      if ((body.password || '').length < 6) return json(400, { msg: 'Password should be at least 6 characters' });
      const id = mockId('user');
      MockSB.users[body.email] = { id, password: body.password };
      return json(200, mockIssue(id));
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const acc = MockSB.users[body.email];
      if (!acc || acc.password !== body.password) return json(400, { error_description: 'Invalid login credentials' });
      return json(200, mockIssue(acc.id));
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
      const id = MockSB.refresh[body.refresh_token];
      if (!id) return json(400, { msg: 'Invalid Refresh Token' });
      MockSB.expireNext = false;
      return json(200, mockIssue(id));
    }
    if (u.pathname === '/auth/v1/recover') return json(200, {});
    if (u.pathname === '/auth/v1/logout') return json(204, {});

    /* ---- rows (scoped to the caller, like RLS does) ---- */
    const me = mockWho(headers);
    if (!me) return json(401, { message: 'JWT expired' });

    if (u.pathname === '/rest/v1/items') {
      if ((opts.method || 'GET') === 'GET') {
        const gt = (u.searchParams.get('updated_at') || 'gt.').replace('gt.', '');
        const limit = Number(u.searchParams.get('limit') || 1000);
        const mine = MockSB.rows
          .filter(r => r.user_id === me && r.updated_at > gt)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .slice(0, limit);
        return json(200, mine);
      }
      (Array.isArray(body) ? body : [body]).forEach(r => {
        const at = mockIso();
        const i = MockSB.rows.findIndex(x => x.user_id === me && x.coll === r.coll && x.item_id === r.item_id);
        const row = { user_id: me, coll: r.coll, item_id: r.item_id, ts: r.ts,
                      deleted: !!r.deleted, data: r.data || {}, updated_at: at };
        if (i < 0) MockSB.rows.push(row); else MockSB.rows[i] = row;
      });
      return json(201, []);
    }
    if (u.pathname === '/rest/v1/profiles') {
      if ((opts.method || 'GET') === 'GET') {
        const p = MockSB.profiles[me];
        return json(200, p ? [p] : []);
      }
      const r = Array.isArray(body) ? body[0] : body;
      MockSB.profiles[me] = { settings: r.settings, ts: r.ts, updated_at: mockIso() };
      return json(201, []);
    }
    if (u.pathname === '/rest/v1/rpc/delete_my_data') {
      MockSB.rows = MockSB.rows.filter(r => r.user_id !== me);
      delete MockSB.profiles[me];
      return json(204, {});
    }
    return json(404, { message: 'no route ' + u.pathname });
  };

  window.MockSB = MockSB;
})();
