import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

const skip = process.platform === 'win32' ? 'POSIX permissions only' : false;
const mode = (p) => fs.statSync(p).mode & 0o777;

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-db-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('openDb creates the data directory 0700 and the database files 0600', { skip }, (t) => {
  const dir = path.join(tempRoot(t), 'data');
  const file = path.join(dir, 'scheduler.db');
  const db = openDb(file);
  t.after(() => db.close());

  assert.equal(mode(dir).toString(8), '700');
  assert.equal(mode(file).toString(8), '600');
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) assert.equal(mode(file + suffix).toString(8), '600', suffix);
  }
});

test('openDb tightens an existing data directory and database files that are too open', { skip }, (t) => {
  const dir = path.join(tempRoot(t), 'data');
  const file = path.join(dir, 'scheduler.db');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  openDb(file).close();
  fs.chmodSync(file, 0o644);

  const db = openDb(file);
  t.after(() => db.close());
  assert.equal(mode(dir).toString(8), '700');
  assert.equal(mode(file).toString(8), '600');
});
