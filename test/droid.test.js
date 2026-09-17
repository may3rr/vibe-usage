import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, resolveDroidModel } from '../src/parsers/droid.js';
import { parsers } from '../src/parsers/index.js';
import { detectInstalledTools, getDroidSessionsDir, getDroidSettingsPaths, TOOLS } from '../src/tools.js';

function writeSession(root, projectSlug, sessionId, { settings, records }) {
  const dir = join(root, projectSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`),
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  writeFileSync(join(dir, `${sessionId}.settings.json`), `${JSON.stringify(settings, null, 2)}\n`);
}

async function withDroidSessions(run, { catalog } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-droid-'));
  const previousSessions = process.env.VIBE_USAGE_DROID_SESSIONS;
  const previousSettings = process.env.VIBE_USAGE_DROID_SETTINGS;
  process.env.VIBE_USAGE_DROID_SESSIONS = root;
  if (catalog) {
    const settingsPath = join(root, 'factory-settings.json');
    writeFileSync(settingsPath, `${JSON.stringify({ customModels: catalog }, null, 2)}\n`);
    process.env.VIBE_USAGE_DROID_SETTINGS = settingsPath;
  } else {
    delete process.env.VIBE_USAGE_DROID_SETTINGS;
  }
  try {
    return await run(root);
  } finally {
    if (previousSessions === undefined) delete process.env.VIBE_USAGE_DROID_SESSIONS;
    else process.env.VIBE_USAGE_DROID_SESSIONS = previousSessions;
    if (previousSettings === undefined) delete process.env.VIBE_USAGE_DROID_SETTINGS;
    else process.env.VIBE_USAGE_DROID_SETTINGS = previousSettings;
    rmSync(root, { recursive: true, force: true });
  }
}

function records(ts = '2026-09-17T09:51:33.807Z') {
  return [
    {
      type: 'message', id: 'u1', timestamp: ts,
      message: { role: 'user', content: [{ type: 'text', text: 'DO NOT UPLOAD' }] },
    },
    {
      type: 'message', id: 'a1', timestamp: '2026-09-17T09:52:06.089Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'VIBE-REPRO-OK' }] },
    },
  ];
}

test('Droid is registered and honors VIBE_USAGE_DROID_SESSIONS', async () => {
  assert.equal(typeof parsers.droid, 'function');
  const tool = TOOLS.find(entry => entry.id === 'droid');
  assert.equal(tool?.name, 'Droid');
  assert.ok(tool?.dataDir.endsWith(join('.factory', 'sessions')));
  assert.equal(getDroidSessionsDir(), join(homedir(), '.factory', 'sessions'));
  await withDroidSessions(async (root) => {
    mkdirSync(join(root, 'proj'), { recursive: true });
    assert.equal(getDroidSessionsDir(), root);
    assert.deepEqual(getDroidSettingsPaths(), []);
    assert.equal(detectInstalledTools().some(entry => entry.id === 'droid'), true);
  });
});

test('Droid resolves Factory slot ids to the upstream API model', () => {
  const catalog = new Map([
    ['custom:deepseek-v4.1-flash-[gw]-1', 'acme/deepseek-v4.1-flash'],
    ['custom:Union-Alpha-Free-0', 'union-alpha'],
    ['custom:auto-[gw]-0', 'auto'],
  ]);
  assert.equal(resolveDroidModel('custom:gpt-6-astra-[gw]-0'), 'gpt-6-astra');
  assert.equal(resolveDroidModel('custom:gpt-5.4-[gw]-0'), 'gpt-5.4');
  assert.equal(resolveDroidModel('custom:gpt-5.4-fast-[gw]-17'), 'gpt-5.4-fast');
  assert.equal(resolveDroidModel('custom:claude-opus-4-6-[gw]-13'), 'claude-opus-4-6');
  assert.equal(
    resolveDroidModel('custom:deepseek-v4.1-flash-[gw]-1', catalog),
    'acme/deepseek-v4.1-flash',
  );
  assert.equal(resolveDroidModel('custom:deepseek-v4.1-flash-[gw]-1'), 'deepseek-v4.1-flash');
  assert.equal(resolveDroidModel('custom:Union-Alpha-Free-0', catalog), 'union-alpha');
  assert.equal(resolveDroidModel('custom:Union-Alpha-Free-0'), 'custom:Union-Alpha-Free-0');
  assert.equal(resolveDroidModel('claude-opus-4-6'), 'claude-opus-4-6');
  assert.equal(resolveDroidModel('custom:auto-[gw]-0', catalog), 'droid-auto');
  assert.equal(resolveDroidModel(''), 'unknown');
});

test('Droid keeps Factory sidecar inputTokens as uncached input', async () => withDroidSessions(async (root) => {
  // Numbers from a live 2026-09-17 BYOK exec (custom:gpt-6-astra, providerLock
  // openai). Factory's own log recorded inputTokens=1048 as uncached and
  // cacheReadInputTokens=10752 separately (totalInputTokens=11800).
  writeSession(root, 'private-tmp', '11111111-1111-1111-1111-111111111111', {
    settings: {
      model: 'custom:gpt-6-astra-[gw]-0',
      providerLock: 'openai',
      tokenUsage: {
        inputTokens: 1048,
        outputTokens: 11,
        cacheCreationTokens: 0,
        cacheReadTokens: 10752,
        thinkingTokens: 0,
        factoryCredits: 8713,
      },
    },
    records: records(),
  });

  const result = await parse();
  assert.equal(result.buckets.length, 1);
  const bucket = result.buckets[0];
  assert.equal(bucket.source, 'droid');
  assert.equal(bucket.model, 'gpt-6-astra');
  assert.equal(bucket.project, 'tmp');
  assert.equal(bucket.inputTokens, 1048);
  assert.equal(bucket.cachedInputTokens, 10752);
  assert.equal(bucket.outputTokens, 11);
  assert.equal(bucket.reasoningOutputTokens, 0);
  assert.equal(bucket.cacheCreation5mTokens, 0);
  assert.equal(bucket.totalTokens, 1059);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
}));

test('Droid catalog maps a slot id whose slug is not the API model', async () => withDroidSessions(async (root) => {
  writeSession(root, 'demo-ses', 'flash-1', {
    settings: {
      model: 'custom:deepseek-v4.1-flash-[gw]-1',
      tokenUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 },
    },
    records: records(),
  });
  const [bucket] = (await parse()).buckets;
  assert.equal(bucket.model, 'acme/deepseek-v4.1-flash');
  assert.equal(bucket.inputTokens, 10);
}, {
  catalog: [
    { id: 'custom:deepseek-v4.1-flash-[gw]-1', model: 'acme/deepseek-v4.1-flash' },
  ],
}));

test('Droid session fixtures do not read the real Factory settings catalog', async () => withDroidSessions(async (root) => {
  writeSession(root, 'union-project', 'union-1', {
    settings: {
      model: 'custom:Union-Alpha-Free-0',
      tokenUsage: { inputTokens: 5, outputTokens: 1 },
    },
    records: records('2026-09-16T02:00:00.000Z'),
  });
  const [bucket] = (await parse()).buckets;
  assert.equal(bucket.model, 'custom:Union-Alpha-Free-0');
}));

test('Droid books cache writes to the 5m column and splits thinking out of output', async () => withDroidSessions(async (root) => {
  writeSession(root, 'demo-project', 'think-cache-write', {
    settings: {
      model: 'custom:glm-5-[gw]-11',
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 80,
        cacheCreationTokens: 40,
        cacheReadTokens: 20,
        thinkingTokens: 30,
      },
    },
    records: [
      {
        type: 'message', id: 'u1', timestamp: '2026-03-16T09:30:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'message', id: 'a1', timestamp: '2026-03-16T09:30:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
    ],
  });

  const [bucket] = (await parse()).buckets;
  assert.equal(bucket.model, 'glm-5');
  assert.equal(bucket.inputTokens, 100);
  assert.equal(bucket.cachedInputTokens, 20);
  assert.equal(bucket.outputTokens, 50);
  assert.equal(bucket.reasoningOutputTokens, 30);
  assert.equal(bucket.cacheCreation5mTokens, 40);
  assert.equal(bucket.cacheCreation1hTokens, 0);
  assert.equal(bucket.totalTokens, 220);
}));

test('Droid skips buckets when tokenUsage is missing or all zero, but still emits sessions', async () => withDroidSessions(async (root) => {
  writeSession(root, 'doubao-project', 'missing-usage', {
    settings: {
      model: 'custom:volcengine/doubao-seed-2-0-code-preview-260215-[gw]-6',
      providerLock: 'generic-chat-completion-api',
    },
    records: [
      {
        type: 'message', id: 'u1', timestamp: '2026-03-20T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'message', id: 'a1', timestamp: '2026-03-20T10:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    ],
  });
  writeSession(root, 'union-project', 'zero-usage', {
    settings: {
      model: 'custom:Union-Alpha-Free-0',
      providerLock: 'anthropic',
      tokenUsage: {
        inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
        cacheReadTokens: 0, thinkingTokens: 0, factoryCredits: 0,
      },
    },
    records: [
      {
        type: 'message', id: 'u1', timestamp: '2026-09-16T02:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'message', id: 'a1', timestamp: '2026-09-16T02:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    ],
  });

  const result = await parse();
  assert.deepEqual(result.buckets, []);
  assert.equal(result.sessions.length, 2);
}));
