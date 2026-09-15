import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, resolveMimocodeDbPath } from '../src/parsers/mimocode.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function createFixtureDb(dbPath, sql) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Node 20 exercises the same sqlite3 CLI fallback used by queryDbJson().
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  execFileSync('sqlite3', [dbPath, sql]);
}

test('MiMoCode is registered as a parser and detected tool', () => {
  assert.equal(typeof parsers.mimocode, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'mimocode')?.name, 'MiMoCode');
});

test('resolveMimocodeDbPath follows MiMoCode environment precedence', () => {
  assert.equal(resolveMimocodeDbPath({
    MIMOCODE_HOME: '/tmp/mimo-home',
    MIMOCODE_DB: 'channel.db',
  }), '/tmp/mimo-home/data/channel.db');
  assert.equal(resolveMimocodeDbPath({
    MIMOCODE_HOME: '/tmp/mimo-home',
    MIMOCODE_DB: '/tmp/custom.db',
  }), '/tmp/custom.db');
  assert.equal(resolveMimocodeDbPath({
    XDG_DATA_HOME: '/tmp/xdg-data',
  }), '/tmp/xdg-data/mimocode/mimocode.db');
});

test('parse reads exact token usage and session timing from MiMoCode SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-mimocode-test-'));
  const dbPath = join(root, 'mimocode.db');
  const userCreated = Date.parse('2026-07-27T08:00:00.000Z');
  const assistantCreated = Date.parse('2026-07-27T08:10:00.000Z');
  await createFixtureDb(dbPath, `
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      INSERT INTO session (id, directory) VALUES ('ses_1', '/repo/mimo-app');
      INSERT INTO message (id, session_id, time_created, data)
      VALUES ('msg_user', 'ses_1', ${userCreated}, ${sqlLiteral(JSON.stringify({
      role: 'user',
      time: { created: userCreated },
      model: { modelID: 'mimo-v2.5-pro' },
    }))});
      INSERT INTO message (id, session_id, time_created, data)
      VALUES ('msg_assistant', 'ses_1', ${assistantCreated}, ${sqlLiteral(JSON.stringify({
      role: 'assistant',
      time: { created: assistantCreated, completed: assistantCreated + 5_000 },
      modelID: 'mimo-v2.5-pro',
      tokens: {
        input: 120,
        output: 30,
        reasoning: 10,
        cache: { read: 400, write: 20 },
      },
    }))});
  `);

  const previousDb = process.env.MIMOCODE_DB;
  process.env.MIMOCODE_DB = dbPath;
  try {
    const result = await parse();
    assert.deepEqual(result.buckets, [{
      source: 'mimocode',
      model: 'mimo-v2.5-pro',
      project: 'mimo-app',
      bucketStart: '2026-07-27T08:00:00.000Z',
      inputTokens: 140,
      outputTokens: 30,
      cachedInputTokens: 400,
      reasoningOutputTokens: 10,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      totalTokens: 180,
    }]);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].source, 'mimocode');
    assert.equal(result.sessions[0].project, 'mimo-app');
    assert.equal(result.sessions[0].firstMessageAt, '2026-07-27T08:00:00.000Z');
    assert.equal(result.sessions[0].lastMessageAt, '2026-07-27T08:10:00.000Z');
    assert.equal(result.sessions[0].durationSeconds, 600);
    assert.equal(result.sessions[0].messageCount, 2);
    assert.equal(result.sessions[0].userMessageCount, 1);
  } finally {
    if (previousDb === undefined) delete process.env.MIMOCODE_DB;
    else process.env.MIMOCODE_DB = previousDb;
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse excludes sessions imported from other supported tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-mimocode-import-test-'));
  const dbPath = join(root, 'mimocode.db');
  const created = Date.parse('2026-07-27T09:00:00.000Z');
  await createFixtureDb(dbPath, `
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE external_import (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL
      );
      INSERT INTO session (id, directory) VALUES ('ses_native', '/repo/native');
      INSERT INTO session (id, directory) VALUES ('ses_imported', '/repo/imported');
      INSERT INTO external_import (id, session_id, source)
      VALUES ('import_1', 'ses_imported', 'claude-code');
      INSERT INTO message (id, session_id, time_created, data)
      VALUES ('msg_native', 'ses_native', ${created}, ${sqlLiteral(JSON.stringify({
      role: 'assistant',
      time: { created },
      modelID: 'mimo-v2.5-pro',
      tokens: { input: 10, output: 5 },
    }))});
      INSERT INTO message (id, session_id, time_created, data)
      VALUES ('msg_imported', 'ses_imported', ${created}, ${sqlLiteral(JSON.stringify({
      role: 'assistant',
      time: { created },
      modelID: 'claude-sonnet-4',
      tokens: { input: 1000, output: 500 },
    }))});
  `);

  const previousDb = process.env.MIMOCODE_DB;
  process.env.MIMOCODE_DB = dbPath;
  try {
    const result = await parse();
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].model, 'mimo-v2.5-pro');
    assert.equal(result.buckets[0].totalTokens, 15);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].project, 'native');
  } finally {
    if (previousDb === undefined) delete process.env.MIMOCODE_DB;
    else process.env.MIMOCODE_DB = previousDb;
    rmSync(root, { recursive: true, force: true });
  }
});
