import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const BACKEND_ROOT = dirname(fileURLToPath(import.meta.url));
const rawDatabasePath = process.env.DATABASE_PATH || 'data/linkdrop.sqlite';
const databasePath = rawDatabasePath === ':memory:' ? rawDatabasePath : isAbsolute(rawDatabasePath) ? rawDatabasePath : resolve(BACKEND_ROOT, '..', rawDatabasePath);
mkdirSync(dirname(databasePath), { recursive: true });

export const database = new DatabaseSync(databasePath);
database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
database.exec(readFileSync(resolve(BACKEND_ROOT, 'schema.sql'), 'utf8'));

const now = Date.now();
database.prepare(`
  UPDATE pairing_sessions
  SET status = 'closed', code_hash = NULL, closed_at = ?
  WHERE status IN ('waiting', 'paired') AND expires_at <= ?
`).run(now, now);
database.prepare("DELETE FROM pairing_sessions WHERE created_at < ?").run(now - 30 * 24 * 60 * 60 * 1000);

const createSessionStatement = database.prepare(`
  INSERT INTO pairing_sessions (id, code_hash, status, created_at, expires_at)
  VALUES (?, ?, 'waiting', ?, ?)
`);
const connectSessionStatement = database.prepare(`
  UPDATE pairing_sessions SET status = 'paired', paired_at = ?, expires_at = ? WHERE id = ?
`);
const touchSessionStatement = database.prepare('UPDATE pairing_sessions SET expires_at = ? WHERE id = ?');
const closeSessionStatement = database.prepare(`
  UPDATE pairing_sessions SET status = 'closed', code_hash = NULL, closed_at = ? WHERE id = ?
`);
const insertActivityStatement = database.prepare(`
  INSERT INTO activity_events (id, session_id, kind, sender_role, byte_size, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const findSessionStatement = database.prepare(`
  SELECT id FROM pairing_sessions
  WHERE code_hash = ? AND status IN ('waiting', 'paired') AND expires_at > ?
  LIMIT 1
`);
const getSessionStatement = database.prepare(`
  SELECT id, status, created_at, paired_at, expires_at
  FROM pairing_sessions
  WHERE code_hash = ? AND status IN ('waiting', 'paired') AND expires_at > ?
  LIMIT 1
`);
const activityForSessionStatement = database.prepare(`
  SELECT kind, sender_role, byte_size, created_at
  FROM activity_events WHERE session_id = ?
  ORDER BY created_at DESC LIMIT 100
`);

export function createPairingSession(id, codeHash, createdAt, expiresAt) {
  createSessionStatement.run(id, codeHash, createdAt, expiresAt);
}

export function markPairingConnected(id, pairedAt, expiresAt) {
  connectSessionStatement.run(pairedAt, expiresAt, id);
}

export function touchPairingSession(id, expiresAt) {
  touchSessionStatement.run(expiresAt, id);
}

export function closePairingSession(id, closedAt = Date.now()) {
  closeSessionStatement.run(closedAt, id);
}

export function recordActivity({ id, sessionId, kind, senderRole, byteSize, createdAt = Date.now() }) {
  insertActivityStatement.run(id, sessionId, kind, senderRole, byteSize, createdAt);
  database.prepare('DELETE FROM activity_events WHERE created_at < ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

export function listActivityForCode(codeHash) {
  const pair = findSessionStatement.get(codeHash, Date.now());
  if (!pair) return null;
  return activityForSessionStatement.all(pair.id).map((event) => ({
    kind: event.kind,
    senderRole: event.sender_role,
    byteSize: event.byte_size,
    createdAt: new Date(event.created_at).toISOString(),
  }));
}

export function getPairingByCodeHash(codeHash) {
  return getSessionStatement.get(codeHash, Date.now()) || null;
}

export function getDatabasePath() { return databasePath; }
