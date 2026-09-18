import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state.js and config.js resolve their directories at module load, so point
// both at a throwaway dir BEFORE importing them (each test file runs in its
// own process under node --test).
const dir = mkdtempSync(join(tmpdir(), 'vibe-usage-state-test-'));
process.env.VIBE_USAGE_STATE_DIR = dir;
process.env.VIBE_USAGE_CONFIG_DIR = dir;

const { loadState, saveState, clearState, pruneState, getStatePath, stateIdentity } = await import('../src/state.js');
const { saveConfig, getConfigPath } = await import('../src/config.js');

test('saveState/loadState round-trips buckets and sessions', () => {
  const state = { buckets: { 'codex|m|p|h|t': 'hash1' }, sessions: { 'kiro|abc': 'hash2' } };
  saveState(state);
  assert.deepEqual(loadState(), state);
});

test('saveState writes atomically without leaving temp files behind', () => {
  saveState({ buckets: { a: '1' }, sessions: {} });
  const files = readdirSync(dir);
  assert.equal(files.includes('state.json'), true);
  assert.equal(files.some((f) => f.endsWith('.tmp')), false);
});

test('loadState treats a corrupt state file as empty (full re-upload)', () => {
  writeFileSync(getStatePath(), 'not json{', 'utf-8');
  assert.deepEqual(loadState(), { buckets: {}, sessions: {} });
});

test('clearState deletes the state file so the next sync re-uploads everything', () => {
  saveState({ buckets: { a: '1' }, sessions: {} });
  assert.equal(existsSync(getStatePath()), true);
  clearState();
  assert.equal(existsSync(getStatePath()), false);
  assert.deepEqual(loadState(), { buckets: {}, sessions: {} });
  // Idempotent: clearing again must not throw.
  clearState();
});

// state.json records what was uploaded to one account on one server. Before
// 0.11.1 it recorded nothing about that target, so re-binding the CLI to a new
// account (init again, `config set apiKey`, or the desktop app rewriting
// config.json) left the old hashes in place and the incremental diff skipped
// every bucket the previous account had already received — the new account got
// no history at all while sync still reported success.
const ACCOUNT_A = stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey: 'vbu_account_a' });
const ACCOUNT_B = stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey: 'vbu_account_b' });
const OTHER_SERVER = stateIdentity({ apiUrl: 'http://127.0.0.1:3000', apiKey: 'vbu_account_a' });

test('the same identity round-trips buckets and sessions', () => {
  const state = { buckets: { 'codex|m|p|h|t': 'hash1' }, sessions: { 'kiro|abc': 'hash2' } };
  saveState(state, ACCOUNT_A);
  assert.deepEqual(loadState(ACCOUNT_A), state);
  clearState();
});

test('a different API key empties the state and reports the re-bind', () => {
  saveState({ buckets: { 'codex|m|p|h|t': 'hash1' }, sessions: { 'kiro|abc': 'hash2' } }, ACCOUNT_A);
  const reloaded = loadState(ACCOUNT_B);
  assert.deepEqual(reloaded.buckets, {});
  assert.deepEqual(reloaded.sessions, {});
  assert.equal(reloaded.identityChanged, true);
  clearState();
});

test('a different API URL empties the state even with the same key', () => {
  saveState({ buckets: { 'codex|m|p|h|t': 'hash1' }, sessions: { 'kiro|abc': 'hash2' } }, ACCOUNT_A);
  const reloaded = loadState(OTHER_SERVER);
  assert.deepEqual(reloaded.buckets, {});
  assert.deepEqual(reloaded.sessions, {});
  assert.equal(reloaded.identityChanged, true);
  clearState();
});

// Migration choice: a file written before 0.11.1 carries no identity, so it is
// adopted as-is instead of forcing every installed client to re-upload its
// whole history on upgrade day. The next save stamps the identity, which is
// what catches a re-bind from then on.
test('a pre-identity state file is adopted, then stamped on the next save', () => {
  writeFileSync(getStatePath(), JSON.stringify({
    buckets: { 'codex|m|p|h|t': 'hash1' },
    sessions: { 'kiro|abc': 'hash2' },
  }), 'utf-8');
  const legacy = loadState(ACCOUNT_A);
  assert.deepEqual(legacy.buckets, { 'codex|m|p|h|t': 'hash1' });
  assert.deepEqual(legacy.sessions, { 'kiro|abc': 'hash2' });
  assert.equal(legacy.identityChanged, undefined);

  saveState(legacy, ACCOUNT_A);
  const onDisk = JSON.parse(readFileSync(getStatePath(), 'utf-8'));
  assert.deepEqual(onDisk.identity, ACCOUNT_A);
  // Runtime-only signals must not be persisted.
  assert.equal('identityChanged' in onDisk, false);
  // Now bound: the other account no longer inherits these hashes.
  assert.equal(loadState(ACCOUNT_B).identityChanged, true);
  clearState();
});

test('the state file never contains the raw API key', () => {
  const apiKey = 'vbu_super_secret_key_value';
  saveState(
    { buckets: { 'codex|m|p|h|t': 'hash1' }, sessions: {} },
    stateIdentity({ apiUrl: 'https://vibecafe.ai', apiKey }),
  );
  const text = readFileSync(getStatePath(), 'utf-8');
  assert.equal(text.includes(apiKey), false);
  assert.match(text, /"keyFingerprint":"[0-9a-f]{16}"/);
  clearState();
});

test('pruneState drops keys the parsers no longer emit', () => {
  const state = {
    buckets: { 'codex|m|p|h|t': 'x', 'kiro|m|p|h|t': 'y' },
    sessions: { 'codex|s1': 'z' },
  };
  pruneState(state, new Set(['codex|m|p|h|t']), new Set());
  assert.deepEqual(state, { buckets: { 'codex|m|p|h|t': 'x' }, sessions: {} });
});

test('pruneState keeps keys of sources whose parser failed this run', () => {
  const state = {
    buckets: { 'codex|m|p|h|t': 'x', 'kiro|m|p|h|t': 'y' },
    sessions: { 'cursor|s1': 'z' },
  };
  // kiro's parser threw this sync (not in okSources) and emitted nothing
  // (not in live sets): its state must survive, or the next sync would
  // re-upload kiro's entire history. cursor succeeded and emitted nothing —
  // its stale key is correctly pruned.
  pruneState(state, new Set(), new Set(), new Set(['codex', 'cursor']));
  assert.deepEqual(state, { buckets: { 'kiro|m|p|h|t': 'y' }, sessions: {} });
});

test('saveConfig writes the API key file readable only by the owner', { skip: process.platform === 'win32' && 'POSIX owner/mode assertion; Windows config ACL privacy is not covered by this test' }, () => {
  saveConfig({ apiKey: 'vbu_secret' });
  const mode = statSync(getConfigPath()).mode & 0o777;
  assert.equal(mode, 0o600);
});
