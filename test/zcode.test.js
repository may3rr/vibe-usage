import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, resolveZcodeDbPath } from '../src/parsers/zcode.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS } from '../src/tools.js';

// The real schema (ZCode 0.11) in the two tables the parser reads.
const schema = `
CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
`;

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function fixtureDb(rows = '') {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-zcode-'));
  const path = join(root, 'db.sqlite');
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Node 20 exercises the sqlite3 CLI fallback used by queryDbJson().
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(path);
    try {
      db.exec(`${schema}${rows}`);
    } finally {
      db.close();
    }
  } else {
    execFileSync('sqlite3', [path, `${schema}${rows}`]);
  }
  return { root, path };
}

/**
 * One assistant message. `modelKey` is the spelling under test: builds up to
 * ZCode 0.10 wrote `modelID` (+ `providerID`), later builds wrote `modelId`
 * (+ `providerId`).
 */
function assistantRow(id, sessionId, ts, modelKey, model) {
  const data = JSON.stringify({
    role: 'assistant',
    [modelKey]: model,
    providerId: 'builtin:zai-start-plan',
    path: { root: '/work/demo', cwd: '/work/demo' },
    tokens: { total: 1100, input: 1000, output: 100, reasoning: 10, cache: { read: 400, write: 0 } },
  });
  return `INSERT INTO message VALUES (${sql(id)},${sql(sessionId)},${ts},${ts},${sql(data)});`;
}

async function withDb(path, fn) {
  const previous = process.env.VIBE_USAGE_ZCODE_DB;
  process.env.VIBE_USAGE_ZCODE_DB = path;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_ZCODE_DB;
    else process.env.VIBE_USAGE_ZCODE_DB = previous;
  }
}

test('zcode is registered and honors the fixture override', () => {
  assert.equal(typeof parsers.zcode, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'zcode')?.name, 'ZCode');
  assert.equal(resolveZcodeDbPath({ VIBE_USAGE_ZCODE_DB: '/tmp/zcode.sqlite' }), '/tmp/zcode.sqlite');
});

test('zcode reads the current and the legacy model key spelling', async () => {
  const db = await fixtureDb(`
    INSERT INTO session VALUES ('s1','/work/demo');
    ${assistantRow('m1', 's1', 1781605706649, 'modelID', 'GLM-5.2')}
    ${assistantRow('m2', 's1', 1781605741898, 'modelId', 'GLM-5.3')}
  `);
  try {
    const result = await withDb(db.path, parse);
    assert.equal(result.skipped, undefined);
    assert.deepEqual(result.buckets.map(bucket => bucket.model).sort(), ['GLM-5.2', 'GLM-5.3']);
    for (const bucket of result.buckets) {
      assert.equal(bucket.project, 'demo');
      assert.equal(bucket.inputTokens, 600);
      assert.equal(bucket.cachedInputTokens, 400);
      assert.equal(bucket.outputTokens, 90);
      assert.equal(bucket.reasoningOutputTokens, 10);
      // Bucket totalTokens is input + output + reasoning; the server re-adds
      // cached input when it computes the displayed 总 Token.
      assert.equal(bucket.totalTokens, 700);
    }
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});

test('zcode still reports unknown for an assistant message without any model key', async () => {
  const db = await fixtureDb(`
    INSERT INTO session VALUES ('s1','/work/demo');
    INSERT INTO message VALUES ('m1','s1',1781605706649,1781605706649,'{"role":"assistant","tokens":{"input":10,"output":5}}');
  `);
  try {
    const result = await withDb(db.path, parse);
    assert.deepEqual(result.buckets.map(bucket => bucket.model), ['unknown']);
  } finally { rmSync(db.root, { recursive: true, force: true }); }
});
