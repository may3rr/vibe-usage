import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cursor from '../src/parsers/cursor.js';

const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|cursor-test-user' })).toString('base64url')}.test-signature`;
const CSV = [
  'Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens',
  '2026-09-07T01:02:00Z,test-model,10,20,30,40',
].join('\n');

async function withCursorDb(t) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-cursor-test-'));
  const dbPath = join(root, 'state.vscdb');
  const previous = process.env.CURSOR_STATE_DB_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.CURSOR_STATE_DB_PATH;
    else process.env.CURSOR_STATE_DB_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });

  const sql = `CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', '${TOKEN}');`;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Exercise the same Node 20 fallback as the other SQLite parser fixtures.
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try { db.exec(sql); } finally { db.close(); }
  } else {
    execFileSync('sqlite3', [dbPath, sql]);
  }
  process.env.CURSOR_STATE_DB_PATH = dbPath;
}

function networkError(code) {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('network failure'), { code }),
  });
}

test('Cursor fetch timeout accepts positive integers and defaults invalid values', () => {
  assert.equal(typeof cursor.resolveCursorFetchTimeout, 'function');

  // The default has to clear a slow full-account export: 10s and 30s each
  // locked heavy accounts out of every sync (issue #72 and its sequel).
  const cases = [
    [undefined, 120_000],
    ['', 120_000],
    ['0', 120_000],
    ['-1', 120_000],
    ['1.5', 120_000],
    ['Infinity', 120_000],
    ['2147483648', 120_000],
    ['45000', 45_000],
    ['300000', 300_000],
  ];

  for (const [value, expected] of cases) {
    assert.equal(cursor.resolveCursorFetchTimeout(value), expected);
  }
});

test('Cursor reports underlying network codes and skips without trying other credentials', async (t) => {
  await withCursorDb(t);
  for (const [code, hint] of [
    ['ENOTFOUND', /DNS/],
    ['EAI_AGAIN', /DNS/],
    ['UND_ERR_CONNECT_TIMEOUT', /代理/],
    ['ECONNRESET', /网络/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /证书/],
  ]) {
    await t.test(code, async (t) => {
      const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw networkError(code); });
      const result = await cursor.parse();
      assert.equal(result.skipped, true);
      assert.deepEqual(result.buckets, []);
      assert.deepEqual(result.sessions, []);
      assert.match(result.warnings[0], new RegExp(code));
      assert.match(result.warnings[0], hint);
      assert.equal(fetchMock.mock.callCount(), 1);
    });
  }
});

test('Cursor reports nested IPv4/IPv6 connection failures without exposing error messages', async (t) => {
  await withCursorDb(t);
  const detail = `https://proxy-user:proxy-password@proxy.invalid/ ${TOKEN}`;
  const aggregate = new AggregateError([
    Object.assign(new Error(detail), { code: 'ETIMEDOUT' }),
    Object.assign(new Error(detail), { code: 'ENETUNREACH' }),
    Object.assign(new Error(detail), { code: 'ETIMEDOUT' }),
  ]);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError(detail, { cause: aggregate });
  });

  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.match(result.warnings[0], /ETIMEDOUT/);
  assert.match(result.warnings[0], /ENETUNREACH/);
  assert.equal(result.warnings[0].match(/ETIMEDOUT/g).length, 1);
  assert.doesNotMatch(result.warnings[0], /proxy-user|proxy-password|proxy\.invalid|test-signature/);
});

test('Cursor gives a network hint even when fetch has no underlying error code', async (t) => {
  await withCursorDb(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.match(result.warnings[0], /network: fetch failed/);
  assert.match(result.warnings[0], /代理/);
});

test('Cursor soft-skips a CSV body connection failure after successful response headers', async (t) => {
  await withCursorDb(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: async () => { throw networkError('UND_ERR_SOCKET'); },
  }));

  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.deepEqual(result.sessions, []);
  assert.match(result.warnings[0], /UND_ERR_SOCKET/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('Cursor recognizes the export deadline during both fetch and CSV body reads', async (t) => {
  await withCursorDb(t);
  for (const phase of ['headers', 'body']) {
    await t.test(phase, async (t) => {
      const controller = new AbortController();
      t.mock.method(AbortSignal, 'timeout', () => controller.signal);
      const abort = () => {
        controller.abort(new DOMException('deadline reached', 'TimeoutError'));
        // Fetch body consumption often throws AbortError, not TimeoutError.
        throw new DOMException('The operation was aborted.', 'AbortError');
      };
      t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
        assert.equal(signal, controller.signal);
        if (phase === 'headers') abort();
        return { ok: true, text: async () => abort() };
      });

      const result = await cursor.parse();
      assert.equal(result.skipped, true);
      assert.match(result.warnings[0], /timeout/);
      assert.match(result.warnings[0], /VIBE_USAGE_CURSOR_FETCH_TIMEOUT_MS/);
      assert.deepEqual(result.buckets, []);
    });
  }
});

test('Cursor retains CSV accounting and cookie fallback after an auth rejection', async (t) => {
  await withCursorDb(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { headers, signal }) => {
    assert.ok(signal instanceof AbortSignal);
    calls++;
    if (calls === 1) {
      assert.equal(headers.Cookie, `WorkosCursorSessionToken=auth0|cursor-test-user%3A%3A${TOKEN}`);
      return new Response('', { status: 401, statusText: 'Unauthorized' });
    }
    assert.equal(headers.Cookie, `WorkosCursorSessionToken=cursor-test-user%3A%3A${TOKEN}`);
    return new Response(CSV);
  });

  const result = await cursor.parse();
  assert.equal(calls, 2);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.buckets, [{
    source: 'cursor', model: 'test-model', project: 'unknown', hostname: 'cursor-cloud',
    bucketStart: '2026-09-07T01:00:00.000Z',
    inputTokens: 30, outputTokens: 40, cachedInputTokens: 30,
    reasoningOutputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
    totalTokens: 70,
  }]);
});

test('Cursor still surfaces expired credentials and soft-skips server failures', async (t) => {
  await withCursorDb(t);
  for (const status of [401, 403, 429, 503]) {
    await t.test(String(status), async (t) => {
      const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
      if (status === 401 || status === 403) {
        await assert.rejects(cursor.parse(), /Cursor session rejected.*sign in again/);
        assert.equal(fetchMock.mock.callCount(), 4);
      } else {
        const result = await cursor.parse();
        assert.equal(result.skipped, true);
        assert.match(result.warnings[0], new RegExp(`HTTP ${status}`));
        assert.equal(fetchMock.mock.callCount(), 1);
      }
    });
  }
});

test('Cursor skips a renamed export header instead of uploading an empty snapshot', async (t) => {
  await withCursorDb(t);
  // Cursor renaming a column used to degrade into "zero tokens everywhere" —
  // an empty upload that also pruned the incremental state. The header check
  // must turn that into a skipped run with a warning.
  t.mock.method(globalThis, 'fetch', async () => new Response([
    'Date,Model,Kind,Input Tokens,Output',
    '2026-09-07T01:02:00Z,test-model,Included,10,20',
  ].join('\n')));

  const result = await cursor.parse();
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.deepEqual(result.sessions, []);
  assert.match(result.warnings[0], /导出表头与预期不符/);
});
