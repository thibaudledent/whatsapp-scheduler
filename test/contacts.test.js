import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { BaileysSender } from '../src/senders/baileys.js';
import { silentLogger } from './helpers.js';

// Payload shapes below are copied from what Baileys 7.0.0-rc14 emits.
const PN = '33612345678@s.whatsapp.net';
const LID = '123456789012345@lid';

function setup() {
  const db = openDb(':memory:');
  const sender = new BaileysSender({ db, logger: silentLogger });
  return { db, sender };
}

// Utils/sync-action-utils.js processContactAction (app-state address book).
const contactAction = (fullName, id = PN) => ({ id, name: fullName, username: undefined, lid: undefined, phoneNumber: id });
// Socket/chats.js upsertMessage: every incoming message with a pushName.
const pushNameUpdate = (notify, verifiedName = undefined, id = PN) => ({ id, notify, verifiedName });
// Utils/history.js PUSH_NAME sync.
const historyPushName = (notify, id = PN) => ({ id, notify });
// Utils/history.js BIZ_PRIVACY_MODE stub.
const historyBusiness = (verifiedName, id = PN) => ({ id, verifiedName });
// Utils/history.js conversation without any name.
const historyChat = (id, phoneNumber) => ({ id, name: undefined, username: undefined, lid: undefined, phoneNumber });
// Socket/messages-recv.js picture notification.
const pictureUpdate = (id = PN) => ({ id, imgUrl: 'changed' });
// Utils/chat-utils.js lidContactAction: saved name keyed by an @lid, no phone number.
const lidContactAction = (fullName, id = LID) => ({ id, name: fullName, username: undefined, lid: id, phoneNumber: undefined });

// --- Requirement 1: saved name and profile name are stored separately ---

test('saved name and profile name are kept in separate fields', () => {
  const { db, sender } = setup();
  sender.saveContacts([contactAction('Marie')]);
  sender.saveContacts([pushNameUpdate('Marie Dupont ✨')]);
  const c = db.contacts.get(PN);
  assert.equal(c.savedName, 'Marie');
  assert.equal(c.notifyName, 'Marie Dupont ✨');
  assert.equal(c.businessName, null);
});

test('a business name is stored in its own field', () => {
  const { db, sender } = setup();
  sender.saveContacts([pushNameUpdate('Bob', 'Bob Bakery Ltd')]);
  const c = db.contacts.get(PN);
  assert.equal(c.notifyName, 'Bob');
  assert.equal(c.businessName, 'Bob Bakery Ltd');
  assert.equal(c.savedName, null);
});

// --- Requirement 2: a later event never erases a field it does not carry ---

test('a notify-only update keeps the saved name', () => {
  const { db, sender } = setup();
  sender.saveContacts([contactAction('Marie')]);
  sender.saveContacts([pushNameUpdate('Marie D.')]);
  const c = db.contacts.get(PN);
  assert.equal(c.savedName, 'Marie');
  assert.equal(c.name, 'Marie');
});

test('a saved-name update keeps the profile and business names', () => {
  const { db, sender } = setup();
  sender.saveContacts([pushNameUpdate('Bob', 'Bob Bakery Ltd')]);
  sender.saveContacts([contactAction('Bobby')]);
  const c = db.contacts.get(PN);
  assert.equal(c.savedName, 'Bobby');
  assert.equal(c.notifyName, 'Bob');
  assert.equal(c.businessName, 'Bob Bakery Ltd');
});

test('undefined, empty and nameless payloads erase nothing', () => {
  const { db, sender } = setup();
  sender.saveContacts([contactAction('Marie'), pushNameUpdate('Marie D.', 'Marie SARL')]);
  sender.saveContacts([pushNameUpdate(undefined, undefined)]);
  sender.saveContacts([{ id: PN, name: '', notify: '  ', verifiedName: null }]);
  sender.saveContacts([pictureUpdate()]);
  sender.saveContacts([historyChat(PN, PN)]);
  const c = db.contacts.get(PN);
  assert.equal(c.savedName, 'Marie');
  assert.equal(c.notifyName, 'Marie D.');
  assert.equal(c.businessName, 'Marie SARL');
});

test('a carried field replaces the previous value', () => {
  const { db, sender } = setup();
  sender.saveContacts([historyPushName('Old profile')]);
  sender.saveContacts([pushNameUpdate('New profile')]);
  assert.equal(db.contacts.get(PN).notifyName, 'New profile');
});

// --- Requirement 3: display name precedence ---

test('display name prefers the saved name', () => {
  const { db, sender } = setup();
  sender.saveContacts([pushNameUpdate('Profile', 'Business'), contactAction('Saved')]);
  assert.equal(db.contacts.get(PN).name, 'Saved');
});

test('display name falls back to the profile name', () => {
  const { db, sender } = setup();
  sender.saveContacts([historyBusiness('Business'), historyPushName('Profile')]);
  assert.equal(db.contacts.get(PN).name, 'Profile');
});

test('display name falls back to the business name', () => {
  const { db, sender } = setup();
  sender.saveContacts([historyBusiness('Business')]);
  assert.equal(db.contacts.get(PN).name, 'Business');
});

test('display name falls back to +phone digits', () => {
  const { db, sender } = setup();
  sender.saveContacts([historyChat(PN, PN)]);
  assert.equal(db.contacts.get(PN).name, '+33612345678');
});

test('a contact keyed by @lid with a phone number is stored under the phone-number jid', () => {
  const { db, sender } = setup();
  sender.saveContacts([{ id: LID, name: 'Marie', lid: LID, phoneNumber: PN }]);
  assert.equal(db.contacts.get(PN).name, 'Marie');
  assert.equal(db.contacts.get(LID), undefined);
});

test('lidContactAction stores the saved name under the @lid jid', () => {
  const { db, sender } = setup();
  sender.saveContacts([lidContactAction('Marie')]);
  const c = db.contacts.get(LID);
  assert.equal(c.savedName, 'Marie');
  assert.equal(c.name, 'Marie');
  assert.equal(c.isGroup, false);
});

test('search matches any of the stored names and returns the display name', () => {
  const { db, sender } = setup();
  sender.saveContacts([contactAction('Marie'), pushNameUpdate('Zazie')]);
  assert.deepEqual(db.contacts.search('zazie'), [{ jid: PN, name: 'Marie', isGroup: false }]);
  assert.deepEqual(db.contacts.search('marie'), [{ jid: PN, name: 'Marie', isGroup: false }]);
});

// --- Requirement 4: phone-number contacts without a name are kept ---

test('a phone-number contact with no name is kept and found by its digits', () => {
  const { db, sender } = setup();
  sender.saveContacts([historyChat(PN, undefined)]);
  const c = db.contacts.get(PN);
  assert.ok(c, 'nameless phone-number contact should be stored');
  assert.equal(c.name, '+33612345678');
  assert.deepEqual(db.contacts.search('3361234'), [{ jid: PN, name: '+33612345678', isGroup: false }]);
});

test('nameless contacts without a phone-number jid are still dropped', () => {
  const { db, sender } = setup();
  sender.saveContacts([
    historyChat(LID, undefined),
    historyChat('status@broadcast', undefined),
    historyChat('120363000000000000@g.us', undefined),
    pictureUpdate(''),
  ]);
  for (const jid of [LID, 'status@broadcast', '120363000000000000@g.us', '']) {
    assert.equal(db.contacts.get(jid), undefined, jid);
  }
});

// --- Known limitation: no @lid <-> phone-number merging ---

test('known limitation: the same person under a phone-number jid and an @lid gives two rows', () => {
  const { db, sender } = setup();
  sender.saveContacts([contactAction('Marie')]);
  sender.saveContacts([lidContactAction('Marie')]);
  assert.equal(db.contacts.get(PN).name, 'Marie');
  assert.equal(db.contacts.get(LID).name, 'Marie');
  assert.equal(db.contacts.search('marie').length, 2);
});

// --- Migration from a version-1 database ---

const V1_SCHEMA = `CREATE TABLE messages (
     id            TEXT PRIMARY KEY,
     series_id     TEXT NOT NULL,
     to_jid        TEXT NOT NULL,
     to_name       TEXT NOT NULL,
     body          TEXT NOT NULL,
     send_at       INTEGER NOT NULL,
     repeat        TEXT NOT NULL DEFAULT 'none',
     repeat_day    INTEGER,
     status        TEXT NOT NULL DEFAULT 'pending',
     attempts      INTEGER NOT NULL DEFAULT 0,
     retry_at      INTEGER,
     next_spawned  INTEGER NOT NULL DEFAULT 0,
     wa_id         TEXT,
     ack           INTEGER,
     error         TEXT,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL,
     sent_at       INTEGER
   );
   CREATE INDEX messages_due ON messages (status, send_at);
   CREATE INDEX messages_wa_id ON messages (wa_id);
   CREATE TABLE contacts (
     jid        TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     is_group   INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

function v1Database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sched-'));
  const file = path.join(dir, 'app.db');
  const raw = new DatabaseSync(file);
  raw.exec(V1_SCHEMA);
  raw.exec('PRAGMA user_version = 1');
  raw.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?)').run(PN, 'Marie', 0, 1000);
  raw.prepare('INSERT INTO contacts VALUES (?, ?, ?, ?)').run('120363000000000000@g.us', 'Family', 1, 1000);
  raw.prepare(`INSERT INTO messages (id, series_id, to_jid, to_name, body, send_at, created_at, updated_at)
    VALUES ('m1', 'm1', ?, 'Marie', 'hello', 5000, 1000, 1000)`).run(PN);
  raw.prepare(`INSERT INTO auth_kv VALUES ('creds', '{}')`).run();
  raw.close();
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('migration upgrades a version-1 database and keeps existing contacts as saved names', (t) => {
  const { file, cleanup } = v1Database();
  t.after(cleanup);
  const db = openDb(file);
  t.after(() => db.close?.());

  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
  raw.close();

  const person = db.contacts.get(PN);
  assert.equal(person.savedName, 'Marie');
  assert.equal(person.notifyName, null);
  assert.equal(person.businessName, null);
  assert.equal(person.name, 'Marie');
  assert.equal(person.isGroup, false);

  const group = db.contacts.get('120363000000000000@g.us');
  assert.equal(group.name, 'Family');
  assert.equal(group.isGroup, true);

  // Unrelated tables survive untouched.
  assert.equal(db.messages.get('m1').body, 'hello');
  assert.equal(db.auth.get('creds'), '{}');

  // Requirement 2 holds for migrated rows: a profile name does not replace the saved name.
  const sender = new BaileysSender({ db, logger: silentLogger });
  sender.saveContacts([pushNameUpdate('Marie D.')]);
  assert.equal(db.contacts.get(PN).name, 'Marie');
  assert.equal(db.contacts.get(PN).notifyName, 'Marie D.');
});

test('a fresh database ends at version 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sched-'));
  try {
    const file = path.join(dir, 'app.db');
    openDb(file);
    const raw = new DatabaseSync(file);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
    raw.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
