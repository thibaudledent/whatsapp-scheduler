import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/server.js';
import { FakeClock, FakeSender, silentLogger, testConfig } from './helpers.js';

const PASSWORD = 'correct horse battery';

function start(configOverrides, { db = openDb(':memory:') } = {}) {
  const config = testConfig(configOverrides);
  const sender = new FakeSender();
  const scheduler = new Scheduler({ db, sender, config, logger: silentLogger, sleep: async () => {} });
  const app = createApp({ config, db, sender, scheduler, logger: silentLogger });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://localhost:${server.address().port}`;
      resolve({ server, base, db, sender });
    });
  });
}

const json = (body, extra = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});

let open, locked;
before(async () => {
  open = await start();
  locked = await start({ adminPassword: PASSWORD });
});
after(() => {
  open.server.close();
  locked.server.close();
});

test('health check is public', async () => {
  let res = await fetch(`${locked.base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  res = await fetch(`${locked.base}/api/login`, json({ password: PASSWORD }));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  res = await fetch(`${locked.base}/healthz`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, whatsapp: locked.sender.state.status, pending: 0 });
});

// fetch() won't let us override Host, so use a raw request.
const statusWithHost = (base, host) =>
  new Promise((resolve, reject) => {
    const { port } = new URL(base);
    http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });

test('rejects unknown Host headers (DNS rebinding)', async () => {
  assert.equal(await statusWithHost(open.base, 'evil.example'), 403);
  assert.equal(await statusWithHost(open.base, 'localhost:1234'), 200);
});

test('bodiless cross-site POSTs are refused (CSRF)', async () => {
  const res = await fetch(`${open.base}/api/whatsapp/logout`, { method: 'POST' });
  assert.equal(res.status, 415);
});

test('sets security headers', async () => {
  const res = await fetch(`${open.base}/`);
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('API requires sign-in when a password is set', async () => {
  const res = await fetch(`${locked.base}/api/messages`);
  assert.equal(res.status, 401);
});

test('wrong password is rejected, right password signs in', async () => {
  let res = await fetch(`${locked.base}/api/login`, json({ password: 'nope' }));
  assert.equal(res.status, 401);

  res = await fetch(`${locked.base}/api/login`, json({ password: PASSWORD }));
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  res = await fetch(`${locked.base}/api/messages`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(res.status, 200);
});

test('a tampered session cookie is rejected', async () => {
  const res = await fetch(`${locked.base}/api/messages`, {
    headers: { Cookie: `wa_session=${Date.now() + 1e9}.${'0'.repeat(64)}` },
  });
  assert.equal(res.status, 401);
});

test('non-JSON state changes are refused (CSRF)', async () => {
  const res = await fetch(`${open.base}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'to=1&body=x',
  });
  assert.equal(res.status, 415);
});

test('creates, lists, edits and cancels a message', async () => {
  const sendAt = new Date(Date.now() + 3600_000).toISOString();
  let res = await fetch(`${open.base}/api/messages`, json({ to: '+966 50 000 0000', body: 'Hello', sendAt, repeat: 'monthly' }));
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.to, '966500000000@s.whatsapp.net');
  assert.equal(created.status, 'pending');

  res = await fetch(`${open.base}/api/messages/${created.id}`, { ...json({ to: created.to, body: 'Edited', sendAt }), method: 'PUT' });
  assert.equal((await res.json()).body, 'Edited');

  const list = await (await fetch(`${open.base}/api/messages`)).json();
  assert.equal(list.length, 1);

  res = await fetch(`${open.base}/api/messages/${created.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 200);
  const history = await (await fetch(`${open.base}/api/messages?view=history`)).json();
  assert.equal(history[0].status, 'cancelled');
});

test('validates input', async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const cases = [
    [{ body: 'x', sendAt: future }, /Pick a chat/],
    [{ to: '+966500000000', body: '  ', sendAt: future }, /empty/],
    [{ to: '+966500000000', body: 'x', sendAt: '2020-01-01T00:00:00Z' }, /past/],
    [{ to: '+966500000000', body: 'x', sendAt: 'tomorrow' }, /Invalid date/],
    [{ to: '+966500000000', body: 'x'.repeat(5000), sendAt: future }, /too long/],
    [{ to: '+966500000000', body: 'x', sendAt: future, repeat: 'hourly' }, /repeat/],
  ];
  for (const [body, pattern] of cases) {
    const res = await fetch(`${open.base}/api/messages`, json(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, pattern);
  }
});

test('contact search finds saved contacts and groups', async () => {
  open.db.contacts.upsertMany([
    { jid: '1@s.whatsapp.net', name: 'Mom', isGroup: false },
    { jid: '2@g.us', name: 'Family 100%', isGroup: true },
  ]);
  const found = await (await fetch(`${open.base}/api/contacts?q=fam`)).json();
  assert.deepEqual(found, [{ jid: '2@g.us', name: 'Family 100%', isGroup: true }]);
  const literal = await (await fetch(`${open.base}/api/contacts?q=${encodeURIComponent('100%')}`)).json();
  assert.equal(literal.length, 1);
});

// Each contact-search test gets its own database so rows from other tests don't leak in.
async function withContacts(t, rows) {
  const clock = new FakeClock();
  const db = openDb(':memory:', { now: clock.now });
  for (const row of rows) {
    db.contacts.upsertMany([row]);
    clock.advance(1000); // distinct updated_at, in insertion order
  }
  const app = await start(undefined, { db });
  t.after(() => app.server.close());
  return async (q) => {
    const res = await fetch(`${app.base}/api/contacts${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`);
    assert.equal(res.status, 200);
    return res.json();
  };
}

const MARIE = '33612345678@s.whatsapp.net';
const searchRows = [
  { jid: MARIE, savedName: 'Marie', notifyName: 'Zazie ✨' },
  { jid: '447700900123@s.whatsapp.net', notifyName: 'Tom' },
  { jid: '336120000000001@lid', savedName: 'Lid only' },
  { jid: '120363336120000@g.us', name: 'Book club', isGroup: true },
];
const jids = (list) => list.map((c) => c.jid);

test('contact search matches the profile name', async (t) => {
  const search = await withContacts(t, searchRows);
  assert.deepEqual(await search('zazie'), [{ jid: MARIE, name: 'Marie', isGroup: false }]);
  assert.deepEqual(jids(await search('tom')), ['447700900123@s.whatsapp.net']);
});

test('contact search matches the digits of the phone-number jid', async (t) => {
  const search = await withContacts(t, searchRows);
  for (const q of ['33612345678', '+33612345678', '+33 6 12 34 56 78', '0033612345678', '00 33 6 12', '612 345', '5678']) {
    assert.deepEqual(await search(q), [{ jid: MARIE, name: 'Marie', isGroup: false }], q);
  }
});

test('contact search by digits ignores @lid and group ids', async (t) => {
  const search = await withContacts(t, searchRows);
  // Both the @lid and the group id contain "33612", but neither is a phone number.
  assert.deepEqual(jids(await search('33612')), [MARIE]);
  assert.deepEqual(await search('120363'), []);
});

// Builds rows in update order: each row is newer than the ones before it.
const people = (n, base = 1000) => Array.from({ length: n }, (_, i) => ({ jid: `${base + i + 1}@s.whatsapp.net`, savedName: `Person ${i + 1}` }));
const groups = (n, base = 2000) => Array.from({ length: n }, (_, i) => ({ jid: `${base + i + 1}@g.us`, name: `Group ${i + 1}`, isGroup: true }));
const newestFirst = (rows, count = rows.length) => rows.map((r) => r.jid).reverse().slice(0, count);

test('an empty query lists people first, newest first, then fills up with the newest groups', async (t) => {
  const p = people(25);
  const g = groups(10);
  const search = await withContacts(t, [...p, ...g]); // groups were updated last
  const expected = [...newestFirst(p), ...newestFirst(g, 5)];
  assert.deepEqual(jids(await search('')), expected);
  assert.deepEqual(jids(await search('   ')), expected);
  assert.deepEqual(jids(await search(undefined)), expected);
});

test('an empty query shows every person even when there are more than 30 newer groups', async (t) => {
  const p = people(3);
  const g = groups(35);
  const search = await withContacts(t, [...p, ...g]); // all 35 groups are newer than the people
  assert.deepEqual(jids(await search('')), [...newestFirst(p), ...newestFirst(g, 27)]);
});

test('an empty query with more than 30 people shows the 30 newest people and no groups', async (t) => {
  const p = people(32);
  const g = groups(5);
  const search = await withContacts(t, [...g, ...p]);
  assert.deepEqual(jids(await search('')), newestFirst(p, 30));
});

test('contact search treats LIKE wildcards and quotes literally', async (t) => {
  const search = await withContacts(t, [
    ...searchRows,
    { jid: '4915112345678@s.whatsapp.net', savedName: "50% O'Brien_x" },
  ]);
  assert.deepEqual(await search('%'), [{ jid: '4915112345678@s.whatsapp.net', name: "50% O'Brien_x", isGroup: false }]);
  assert.deepEqual(jids(await search('_')), ['4915112345678@s.whatsapp.net']);
  assert.deepEqual(jids(await search("o'brien")), ['4915112345678@s.whatsapp.net']);
  assert.deepEqual(await search("' OR 1=1 --"), []);
  assert.deepEqual(await search('\\'), []);
});

test('unknown API routes return JSON 404', async () => {
  const res = await fetch(`${open.base}/api/nope`);
  assert.equal(res.status, 404);
});

test('editing a message clears its WhatsApp id so it goes out under a fresh one', async () => {
  const app = await start();
  try {
    const sendAt = new Date(Date.now() + 3600_000).toISOString();
    const created = await (await fetch(`${app.base}/api/messages`, json({ to: '+966 50 000 0000', body: 'Hello', sendAt }))).json();
    // As if an earlier attempt timed out and the message is waiting to retry.
    app.db.messages.update(created.id, { waId: 'OLD1', attempts: 1, error: 'timed out' });

    const res = await fetch(`${app.base}/api/messages/${created.id}`, { ...json({ to: created.to, body: 'Edited', sendAt }), method: 'PUT' });
    assert.equal(res.status, 200);
    assert.equal(app.db.messages.get(created.id).waId, null);
  } finally {
    app.server.close();
  }
});
