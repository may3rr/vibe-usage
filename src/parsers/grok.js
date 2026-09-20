import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { findGrokDataDirs, getGrokSessionsDir } from '../tools.js';
import { grokSessionsDir, normalizeExtraRoot } from '../extra-roots.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { readJsonSafe, projectFromPath } from './fs-utils.js';

const SOURCE = 'grok';

/**
 * Grok (Grok Build TUI / CLI) parser.
 *
 * Layout (see ~/.grok/docs/user-guide/17-sessions.md):
 *   $GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/
 *     summary.json     — cwd, model, timestamps
 *     updates.jsonl    — ACP session updates; turn_completed carries exact usage
 *     events.jsonl     — turn_started / turn_ended timing
 *
 * GROK_HOME defaults to ~/.grok. Override with GROK_HOME or
 * VIBE_USAGE_GROK_SESSIONS (tests / relocated session trees).
 *
 * Token usage comes from updates.jsonl `turn_completed.usage` (and per-model
 * `modelUsage` when present). inputTokens is non-cached prompt (total − cache
 * reads), matching Codex/Copilot so totalTokens does not double-count cache.
 */

/** Decode a sessions group dirname; fall back to basename after decode. */
function projectFromGroupDir(groupName, groupPath, strict = false) {
  const cwdFile = join(groupPath, '.cwd');
  if (existsSync(cwdFile)) {
    try {
      const raw = readFileSync(cwdFile, 'utf-8').trim();
      if (raw) return projectFromPath(raw);
    } catch (err) {
      if (strict) throw err;
    }
  }
  try {
    const decoded = decodeURIComponent(groupName);
    if (decoded.includes('/') || decoded.includes('\\')) {
      return projectFromPath(decoded);
    }
  } catch {
    // not URI-encoded
  }
  return groupName || 'unknown';
}

function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds (Grok updates.jsonl) vs milliseconds
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function pushUsageEntry(entries, { model, project, timestamp, usage }) {
  if (!usage || typeof usage !== 'object') return;
  if (!timestamp) return;

  const totalInput = Math.max(0, Number(usage.inputTokens) || 0);
  const cached = Math.max(0, Number(usage.cachedReadTokens) || 0);
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  const reasoning = Math.max(0, Number(usage.reasoningTokens) || 0);

  // Prefer exclusive fields when both are present (Codex-style).
  const inputTokens = Math.max(0, totalInput - cached);
  const outputTokens = Math.max(0, output - reasoning);

  if (inputTokens + outputTokens + cached + reasoning === 0) return;

  entries.push({
    source: SOURCE,
    model: model || 'unknown',
    project,
    timestamp,
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    reasoningOutputTokens: reasoning,
  });
}

function emitTurnUsage(entries, { usage, project, timestamp, fallbackModel }) {
  if (!usage || typeof usage !== 'object') return;

  const modelUsage = usage.modelUsage;
  if (modelUsage && typeof modelUsage === 'object' && Object.keys(modelUsage).length > 0) {
    for (const [model, mUsage] of Object.entries(modelUsage)) {
      pushUsageEntry(entries, {
        model,
        project,
        timestamp,
        usage: mUsage && typeof mUsage === 'object' ? mUsage : usage,
      });
    }
    return;
  }

  pushUsageEntry(entries, {
    model: fallbackModel,
    project,
    timestamp,
    usage,
  });
}

async function forEachJsonlLine(filePath, onLine, strict = false) {
  if (!existsSync(filePath)) return;
  let stream;
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' });
  } catch (err) {
    if (strict) throw err;
    return;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      onLine(obj);
    }
  } catch (err) {
    if (strict) throw err;
    // unreadable / truncated mid-write — keep what we have
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Grok 1.0 moved per-turn token accounting out of the ACP stream into a
 * dedicated `<session>/usage.json` ledger — `grok usage <session-id>` is its
 * documented reader, and the sessions guide says to use that "instead of
 * reading session files". Older builds (0.2.x) wrote the same numbers into
 * `updates.jsonl` `turn_completed.usage`; those sessions have no usage.json.
 *
 * The ledger holds token totals per turn but neither timestamps nor a model
 * id, so callers pair its turns with the session's `turn_completed` events by
 * order and fall back to the summary's model.
 */
function readUsageLedger(sessionPath, strict = false) {
  const ledgerPath = join(sessionPath, 'usage.json');
  if (!existsSync(ledgerPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
  } catch (err) {
    if (strict) throw err;
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  const session = parsed.session && typeof parsed.session === 'object' ? parsed.session : null;
  if (turns.length === 0 && !session) return null;
  return { session, turns };
}

/** Map one ledger record (turn or session totals) onto the usage shape the
 *  ACP stream uses. Cache writes are folded into input — Grok publishes no
 *  separate cache-write rate and pre-1.0 those tokens were part of
 *  `inputTokens`, so folding keeps cross-version totals identical and leaves
 *  the Anthropic-only cache-creation columns untouched. Any per-model
 *  `modelUsage` map is carried through (and folded the same way) so the
 *  caller's model attribution works exactly like the ACP path. */
function ledgerRecordUsage(record) {
  if (!record || typeof record !== 'object') return null;
  const fold = (entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const input = Math.max(0, Number(entry.inputTokens) || 0);
    const cacheCreation = Math.max(0, Number(entry.cacheCreationTokens) || 0);
    return { ...entry, inputTokens: input + cacheCreation };
  };
  const folded = fold(record);
  const modelUsage = record.modelUsage && typeof record.modelUsage === 'object'
    ? Object.fromEntries(Object.entries(record.modelUsage).map(([model, entry]) => [model, fold(entry)]))
    : null;
  const usage = { ...folded, ...(modelUsage ? { modelUsage } : {}) };
  const total =
    Number(usage.inputTokens || 0) +
    Number(usage.cachedReadTokens || 0) +
    Number(usage.outputTokens || 0) +
    Number(usage.reasoningTokens || 0);
  return total > 0 ? usage : null;
}

function listSessionDirs(sessionsDir, strict = false) {
  const results = [];
  if (!existsSync(sessionsDir)) {
    if (strict) throw new Error(`missing sessions directory: ${sessionsDir}`);
    return results;
  }

  let groups;
  try {
    groups = readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (strict) throw err;
    return results;
  }

  for (const group of groups) {
    if (!group.isDirectory()) continue;
    // Skip non-project group dirs (e.g. future index folders).
    const groupPath = join(sessionsDir, group.name);
    let children;
    try {
      children = readdirSync(groupPath, { withFileTypes: true });
    } catch (err) {
      if (strict) throw err;
      continue;
    }

    const projectFallback = projectFromGroupDir(group.name, groupPath, strict);

    for (const child of children) {
      if (!child.isDirectory()) continue;
      const sessionPath = join(groupPath, child.name);
      // A real session always has summary.json (or at least updates/chat history).
      if (
        !existsSync(join(sessionPath, 'summary.json')) &&
        !existsSync(join(sessionPath, 'updates.jsonl'))
      ) {
        continue;
      }
      results.push({
        sessionId: child.name,
        sessionPath,
        projectFallback,
      });
    }
  }

  return results;
}

/**
 * Parse all Grok sessions under the configured sessions root(s).
 * @returns {Promise<{ buckets: object[], sessions: object[] }>}
 */
export async function parse({ extraRoots = [] } = {}) {
  if (!process.env.VIBE_USAGE_GROK_SESSIONS?.trim()) {
    for (const root of extraRoots) {
      const sessionsDir = grokSessionsDir(root);
      try {
        if (!statSync(sessionsDir).isDirectory()) throw new Error('not a directory');
      } catch {
        return {
          buckets: [],
          sessions: [],
          skipped: true,
          warnings: [`grok: 额外根目录不可用，已跳过本次 Grok 同步: ${normalizeExtraRoot(root)}`],
        };
      }
    }
  }
  const strictRoots = process.env.VIBE_USAGE_GROK_SESSIONS?.trim()
    ? new Set()
    : new Set(extraRoots.map(grokSessionsDir));
  const sessionRoots = findGrokDataDirs(extraRoots);
  for (const configuredRoot of strictRoots) {
    if (!sessionRoots.includes(configuredRoot)) sessionRoots.push(configuredRoot);
  }
  // findGrokDataDirs returns sessions dirs; also allow empty → try default once
  const roots = sessionRoots.length > 0 ? sessionRoots : [getGrokSessionsDir()].filter(existsSync);
  if (roots.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];
  const unreadSessions = [];

  const candidates = [];
  for (const sessionsDir of roots) {
    const strict = strictRoots.has(sessionsDir);
    try {
      for (const session of listSessionDirs(sessionsDir, strict)) {
        candidates.push({ ...session, strict, configuredRoot: sessionsDir });
      }
    } catch {
      return {
        buckets: [], sessions: [], skipped: true,
        warnings: [`grok: 额外根目录读取失败，已保留上次同步数据: ${sessionsDir}`],
      };
    }
  }

  let sessionsToParse = candidates;
  if (roots.length > 1) {
    const selectedSessions = new Map();
    for (const session of candidates) {
      const fileSize = (name) => {
        try {
          return statSync(join(session.sessionPath, name)).size;
        } catch {
          return 0;
        }
      };
      const score = [fileSize('updates.jsonl'), fileSize('events.jsonl'), fileSize('summary.json')];
      const previous = selectedSessions.get(session.sessionId);
      const moreComplete = !previous || score.some((value, index) => (
        value !== previous.score[index] && value > previous.score[index]
        && score.slice(0, index).every((prior, priorIndex) => prior === previous.score[priorIndex])
      ));
      if (moreComplete) selectedSessions.set(session.sessionId, { ...session, score });
    }
    sessionsToParse = [...selectedSessions.values()];
  }

  for (const {
    sessionId,
    sessionPath,
    projectFallback,
    strict,
    configuredRoot,
  } of sessionsToParse) {
    try {
      const summaryPath = join(sessionPath, 'summary.json');
      let summary;
      if (strict && existsSync(summaryPath)) {
        summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      } else {
        summary = readJsonSafe(summaryPath) || {};
      }
      const cwd = summary.info?.cwd || summary.git_root_dir || null;
      const project = cwd ? projectFromPath(cwd) : projectFallback;
      const fallbackModel = summary.current_model_id || 'unknown';
      const sessionEntryStart = entries.length;

      // Prefer updates.jsonl turn_completed for exact usage + message timings.
      // `turnTimestamps` keeps their order so a 1.x usage.json ledger (which
      // has no timestamps of its own) can be paired turn-by-turn below.
      let sawUserOrAssistant = false;
      let usageFromUpdates = 0;
      const turnTimestamps = [];
      await forEachJsonlLine(join(sessionPath, 'updates.jsonl'), (obj) => {
        const update = obj?.params?.update;
        if (!update || typeof update !== 'object') return;

        const kind = update.sessionUpdate;
        const timestamp = toDate(obj.timestamp);

        if (kind === 'turn_completed' && timestamp) {
          turnTimestamps.push(timestamp);
          const before = entries.length;
          emitTurnUsage(entries, {
            usage: update.usage,
            project,
            timestamp,
            fallbackModel,
          });
          if (entries.length > before) usageFromUpdates += 1;
        }

        if (!timestamp) return;

        if (kind === 'user_message_chunk') {
          sawUserOrAssistant = true;
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp,
            role: 'user',
          });
        } else if (kind === 'agent_message_chunk' || kind === 'turn_completed') {
          sawUserOrAssistant = true;
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp,
            role: 'assistant',
          });
        }
      }, strict);

      // 1.x sessions keep per-turn totals in usage.json instead of the ACP
      // stream. Consulted only when updates.jsonl yielded no usage, so a
      // session that carries both is never counted twice.
      if (usageFromUpdates === 0) {
        const ledger = readUsageLedger(sessionPath, strict);
        const records = ledger?.turns?.length ? ledger.turns : (ledger?.session ? [ledger.session] : []);
        if (records.length > 0) {
          const sessionTimestamp = toDate(summary.updated_at || summary.last_active_at || summary.created_at);
          for (const [index, record] of records.entries()) {
            const usage = ledgerRecordUsage(record);
            if (!usage) continue;
            const timestamp = turnTimestamps[index] || sessionTimestamp;
            if (!timestamp) continue;
            emitTurnUsage(entries, { usage, project, timestamp, fallbackModel });
          }
        }
      }

      // Canary for the next on-disk format move: a session whose signals.json
      // reports completed turns (and a model) but whose usage we could not read
      // from either source is a silent collection gap, not an idle session —
      // 1.0 moved the ledger to usage.json exactly like this.
      if (entries.length === sessionEntryStart) {
        const signals = readJsonSafe(join(sessionPath, 'signals.json'));
        const turnCount = Number(signals?.turnCount) || 0;
        const modelsUsed = Array.isArray(signals?.modelsUsed) ? signals.modelsUsed.filter(Boolean) : [];
        if (turnCount > 0 && modelsUsed.length > 0) {
          unreadSessions.push({ sessionId, turnCount });
        }
      }

      // Fallback timing from events.jsonl when updates lack message chunks
      // (short/aborted sessions, older builds).
      if (!sawUserOrAssistant) {
        await forEachJsonlLine(join(sessionPath, 'events.jsonl'), (obj) => {
          const timestamp = toDate(obj.ts || obj.timestamp);
          if (!timestamp) return;
          if (obj.type === 'turn_started') {
            sessionEvents.push({
              sessionId,
              source: SOURCE,
              project,
              timestamp,
              role: 'user',
            });
          } else if (obj.type === 'turn_ended' || obj.type === 'first_token') {
            sessionEvents.push({
              sessionId,
              source: SOURCE,
              project,
              timestamp,
              role: 'assistant',
            });
          }
        }, strict);
      }

      // Last-resort session envelope from summary timestamps so a session with
      // no parseable turns still appears once usage lands later.
      if (sessionEvents.every((e) => e.sessionId !== sessionId)) {
        const created = toDate(summary.created_at || summary.info?.created_at);
        const updated = toDate(summary.updated_at || summary.last_active_at);
        if (created) {
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp: created,
            role: 'user',
          });
        }
        if (updated && (!created || updated.getTime() !== created.getTime())) {
          sessionEvents.push({
            sessionId,
            source: SOURCE,
            project,
            timestamp: updated,
            role: 'assistant',
          });
        }
      }
    } catch (err) {
      if (!strict) throw err;
      return {
        buckets: [], sessions: [], skipped: true,
        warnings: [`grok: 额外根目录读取失败，已保留上次同步数据: ${configuredRoot}`],
      };
    }
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(sessionEvents),
    ...(unreadSessions.length > 0 && {
      warnings: [
        `grok: ${unreadSessions.length} 个会话有已完成轮次但未读到用量（例如 ${unreadSessions[0].sessionId}，${unreadSessions[0].turnCount} 轮），` +
        '可能是 Grok 又更改了用量落盘格式，请反馈；本次未上传这些会话的用量。',
      ],
    }),
  };
}
