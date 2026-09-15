import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/parsers/cola.js';
import { parsePiSessionJsonl } from '../src/parsers/pi-session-jsonl.js';
import { parsers } from '../src/parsers/index.js';
import { findColaDataDirs, getColaSessionsDir } from '../src/cola-roots.js';
import { detectInstalledTools } from '../src/tools.js';

const originalTime = '2026-09-10T01:00:00.000Z';
const copyTime = '2026-09-10T03:00:00.000Z';
const sessionHash = id => createHash('sha256').update(id).digest('hex').slice(0, 16);

function history() {
  return [
    { type: 'message', id: '1234abcd', parentId: null, timestamp: '2026-09-10T01:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'private prompt' }] } },
    { type: 'message', id: '5678abcd', parentId: '1234abcd', timestamp: '2026-09-10T01:00:02.000Z',
      message: { role: 'assistant', model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'private answer' }],
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 4, cost: { total: 123 } } } },
  ];
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cola-test-'));
  const previous = process.env.COLA_DATA_DIR;
  process.env.COLA_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.COLA_DATA_DIR;
    else process.env.COLA_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const sessionsDir = join(root, 'sessions');
  function write(scope, { id = 'original', timestamp = originalTime, cwd = '/work/project', messages = history() } = {}) {
    const dir = join(sessionsDir, scope);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'session.jsonl');
    const lines = [{ type: 'session', version: 3, id, timestamp, ...(cwd ? { cwd } : {}) }, ...messages];
    writeFileSync(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    return path;
  }
  return { root, sessionsDir, write };
}

test('Cola is registered and parses exclusive tokens without retaining content or cost', async t => {
  const { sessionsDir, write } = fixture(t);
  write('desktop-local');
  assert.equal(parsers.cola, parse);
  assert.equal(getColaSessionsDir(), sessionsDir);
  assert.deepEqual(findColaDataDirs(), [sessionsDir]);
  assert.ok(detectInstalledTools().some(tool => tool.id === 'cola'));
  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.deepEqual(result.buckets[0], {
    source: 'cola', model: 'claude-haiku-4-5-20251001', project: 'project',
    bucketStart: '2026-09-10T01:00:00.000Z', inputTokens: 110,
    outputTokens: 16, reasoningOutputTokens: 4, cachedInputTokens: 30,
    cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, totalTokens: 130,
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].messageCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /private|cost|\/work\//);
});

test('Cola copies with new headers count once and stay attributed to the original session', async t => {
  const { write } = fixture(t);
  // Deliberately visit the newer copy first to test traversal independence.
  write('a-copy', { id: 'copy', timestamp: copyTime, cwd: '/work/copied-project' });
  write('z-original');
  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].totalTokens, 130);
  assert.equal(result.buckets[0].project, 'project');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionHash, sessionHash('original'));
  assert.equal(result.sessions[0].messageCount, 2);
});

test('Cola counts new calls after copied history in the child session', async t => {
  const { write } = fixture(t);
  write('original');
  const newMessages = history().map((record, i) => ({
    ...record, id: `new-${i}`, parentId: i === 0 ? '5678abcd' : 'new-0',
    timestamp: `2026-09-10T03:00:0${i + 1}.000Z`,
  }));
  write('copy', { id: 'copy', timestamp: copyTime, messages: [...history(), ...newMessages] });
  const result = await parse();
  assert.equal(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0), 260);
  assert.equal(result.sessions.length, 2);
  assert.ok(result.sessions.every(session => session.messageCount === 2));
});

test('Cola retains the only remaining copy of a session', async t => {
  const { write } = fixture(t);
  write('copy', { id: 'copy', timestamp: copyTime });
  const result = await parse();
  assert.equal(result.buckets[0].totalTokens, 130);
  assert.equal(result.sessions[0].sessionHash, sessionHash('copy'));
});

test('Cola keeps richer usage from a copy without changing original project ownership', async t => {
  const { write } = fixture(t);
  write('original');
  const messages = history();
  messages[1].message.usage.input = 200;
  write('copy', { id: 'copy', timestamp: copyTime, cwd: '/work/copy', messages });
  const result = await parse();
  assert.equal(result.buckets[0].inputTokens, 210);
  assert.equal(result.buckets[0].project, 'project');
  assert.equal(result.sessions[0].sessionHash, sessionHash('original'));
});

for (const dimension of ['timestamp', 'parentId', 'model']) {
  test(`Cola does not merge short message-id collisions with a different ${dimension}`, async t => {
    const { write } = fixture(t);
    write('first');
    const messages = history();
    if (dimension === 'model') messages[1].message.model = 'gpt-5.6-luna';
    else messages[1][dimension] = dimension === 'timestamp' ? '2026-09-10T01:00:03.000Z' : 'other-parent';
    write('second', { id: 'second', messages });
    const result = await parse();
    assert.equal(result.buckets.reduce((sum, b) => sum + b.totalTokens, 0), 260);
  });
}

test('Cola never derives a project from a channel or contact scope', async t => {
  const { write } = fixture(t);
  write('channel-person-123', { cwd: null });
  const result = await parse();
  assert.equal(result.buckets[0].project, 'unknown');
  assert.equal(result.sessions[0].project, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /channel-person/);
});

test('Cola copy dedup leaves existing Pi-family session identities unchanged', async t => {
  const { write, sessionsDir } = fixture(t);
  write('original');
  write('copy', { id: 'copy', timestamp: copyTime });
  const result = await parsePiSessionJsonl({ source: 'pi-coding-agent', sessionsDirs: [sessionsDir] });
  assert.equal(result.buckets[0].totalTokens, 260);
  assert.equal(result.sessions.length, 2);
});

test('Cola ignores missing stores and malformed non-record values', async t => {
  const { write } = fixture(t);
  assert.deepEqual(await parse(), { buckets: [], sessions: [] });
  const path = write('desktop');
  writeFileSync(path, 'null\n"not a record"\n{broken\n');
  assert.deepEqual(await parse(), { buckets: [], sessions: [] });
});

test('Cola suppresses partial results and protects state when a scope is unreadable', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const { write, sessionsDir } = fixture(t);
  write('readable');
  write('blocked', { id: 'blocked' });
  const blocked = join(sessionsDir, 'blocked');
  chmodSync(blocked, 0);
  try {
    const result = await parse();
    assert.equal(result.skipped, true);
    assert.ok(result.warnings.some(warning => /cannot read directory/.test(warning)));
    assert.deepEqual(result.buckets, []);
    assert.deepEqual(result.sessions, []);
  } finally {
    chmodSync(blocked, 0o700);
  }
});
