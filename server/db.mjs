import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createSeed } from './seed.mjs';

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(pin), salt, 64).toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const [salt, expected] = stored.split(':');
  const actual = scryptSync(String(pin), salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function openStore(dataDir, seedData) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'naryad.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS auth(user_id TEXT PRIMARY KEY,login TEXT NOT NULL UNIQUE,pin_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);`);
  const listStmt = db.prepare('SELECT data FROM records WHERE kind=?');
  const getStmt = db.prepare('SELECT data FROM records WHERE kind=? AND id=?');
  const putStmt = db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data');
  const store = {
    db,
    list: (kind) => listStmt.all(kind).map(row => JSON.parse(row.data)),
    get: (kind, id) => { const row = getStmt.get(kind, id); return row ? JSON.parse(row.data) : null; },
    put: (kind, value) => putStmt.run(kind, value.id, JSON.stringify(value)),
    remove: (kind, id) => db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id),
    setting: (key, fallback) => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; },
    setSetting: (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)),
    transaction: (work) => { db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    close: () => db.close(),
  };
  if (!store.setting('initialized', false)) {
    const seed = seedData ?? createSeed();
    store.transaction(() => {
      for (const kind of ['users', 'sites', 'equipment', 'brigades', 'faults', 'materials', 'orders']) {
        for (const record of seed[kind] ?? []) {
          if (kind === 'users') {
            const { pin, pinHash, ...safe } = record;
            store.put(kind, safe);
            db.prepare('INSERT INTO auth(user_id,login,pin_hash) VALUES(?,?,?)').run(record.id, record.login, hashPin(pin ?? '1234'));
          } else store.put(kind, record);
        }
      }
      store.setSetting('initialized', true);
      store.setSetting('reminderMinutes', 30);
      store.setSetting('repeatMinutes', 30);
      store.setSetting('sequence', Math.max(1000, ...(seed.orders ?? []).map(order => Number(String(order.number).replace(/\D/g, '')) || 0)));
    });
  }
  return store;
}
