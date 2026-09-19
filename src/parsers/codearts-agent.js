import { projectFromCwd, toCount } from './fs-utils.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import {
  isSqliteUnavailableError,
  queryDbJsonSnapshotOnLock,
  sqliteUnavailableError,
} from './sqlite.js';
import { findCodeartsAgentDbs } from '../codearts-roots.js';

const SOURCE = 'codearts-agent';

// CodeArts Agent 26.9.101 uses an OpenCode-derived WAL database, but it is a
// separate product/account and therefore a separate Vibe Usage source. The
// recursive map folds child-agent sessions into their top-level user session;
// all child model calls remain billable while their injected `user` messages
// never become human prompts. Only identity, timing, model, project and token
// counters are selected. Message/part content, tools, errors, costs, account
// data and the CodeArts JSON/log files stay unread.
const USAGE_SQL = `
  WITH RECURSIVE session_tree(
    sessionId, logicalSessionId, logicalDirectory, isChild, trail
  ) AS (
    SELECT s.id, s.id, s.directory, 0, ',' || s.id || ','
    FROM session AS s
    WHERE s.parent_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM session AS p WHERE p.id = s.parent_id)
    UNION ALL
    SELECT s.id, t.logicalSessionId, t.logicalDirectory, 1,
      t.trail || s.id || ','
    FROM session AS s
    JOIN session_tree AS t ON s.parent_id = t.sessionId
    WHERE instr(t.trail, ',' || s.id || ',') = 0
  ), session_map AS (
    SELECT
      s.id AS sessionId,
      coalesce(t.logicalSessionId, s.id) AS logicalSessionId,
      coalesce(t.logicalDirectory, s.directory) AS logicalDirectory,
      s.directory AS physicalDirectory,
      coalesce(t.isChild, 0) AS isChild
    FROM session AS s
    LEFT JOIN session_tree AS t ON t.sessionId = s.id
  )
  SELECT
    m.id AS messageId,
    m.session_id AS physicalSessionId,
    coalesce(sm.logicalSessionId, m.session_id) AS logicalSessionId,
    coalesce(sm.isChild, 0) AS isChild,
    sm.logicalDirectory AS logicalDirectory,
    sm.physicalDirectory AS physicalDirectory,
    m.time_created AS columnCreated,
    json_extract(m.data, '$.role') AS role,
    json_extract(m.data, '$.time.created') AS dataCreated,
    coalesce(
      json_extract(m.data, '$.modelID'),
      json_extract(m.data, '$.modelId'),
      json_extract(m.data, '$.model.modelID'),
      json_extract(m.data, '$.model.modelId')
    ) AS model,
    json_extract(m.data, '$.path.root') AS rootPath,
    json_extract(m.data, '$.path.cwd') AS cwdPath,
    json_extract(m.data, '$.tokens.input') AS inputTokens,
    json_extract(m.data, '$.tokens.output') AS outputTokens,
    json_extract(m.data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(m.data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(m.data, '$.tokens.reasoning') AS reasoningTokens
  FROM message AS m
  LEFT JOIN session_map AS sm ON sm.sessionId = m.session_id
  ORDER BY m.time_created, m.id
`;

function timestampFrom(value, fallback) {
  const raw = value ?? fallback;
  if (raw == null) return null;
  const number = Number(raw);
  let date;
  if (Number.isFinite(number) && number > 0) {
    date = new Date(number < 1e12 ? number * 1000 : number);
  } else if (typeof raw === 'string') {
    date = new Date(raw);
  } else {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function tokenFootprint(row) {
  return toCount(row.inputTokens) + toCount(row.outputTokens)
    + toCount(row.cacheReadTokens) + toCount(row.cacheWriteTokens)
    + toCount(row.reasoningTokens);
}

function projectFor(row) {
  return projectFromCwd(
    row.rootPath || row.cwdPath || row.logicalDirectory || row.physicalDirectory,
  );
}

export async function parse() {
  const warnings = [];
  const dbs = findCodeartsAgentDbs({ onWarning: message => warnings.push(message) });
  const records = new Map();

  for (const dbPath of dbs) {
    let rows;
    try {
      rows = queryDbJsonSnapshotOnLock(dbPath, USAGE_SQL, {
        tempPrefix: 'vibe-usage-codearts-agent',
      });
    } catch (err) {
      if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('CodeArts Agent');
      warnings.push(`CodeArts Agent: 无法读取 ${dbPath}: ${err.message}`);
      continue;
    }

    for (const [index, row] of rows.entries()) {
      const timestamp = timestampFrom(row.dataCreated, row.columnCreated);
      if (!timestamp) continue;
      const sessionId = row.physicalSessionId == null ? '' : String(row.physicalSessionId);
      const messageId = row.messageId == null ? '' : String(row.messageId);
      const key = sessionId && messageId
        ? JSON.stringify([sessionId, messageId])
        : JSON.stringify([dbPath, index]);
      const candidate = { ...row, timestamp };
      const previous = records.get(key);
      if (!previous || tokenFootprint(candidate) > tokenFootprint(previous)) {
        records.set(key, candidate);
      }
    }
  }

  // A partial multi-profile read would look like legitimate deletion to the
  // incremental sync layer. Suppress the entire source until every discovered
  // database can be read again.
  if (warnings.length) return { buckets: [], sessions: [], skipped: true, warnings };

  const entries = [];
  const events = [];
  const sessionsWithUserPrompt = new Set();

  for (const row of records.values()) {
    const project = projectFor(row);
    const logicalSessionId = String(row.logicalSessionId || row.physicalSessionId || 'unknown');
    if (row.role) {
      const isHumanPrompt = row.role === 'user' && !row.isChild;
      events.push({
        sessionId: logicalSessionId,
        source: SOURCE,
        project,
        timestamp: row.timestamp,
        role: isHumanPrompt ? 'user' : 'assistant',
      });
      if (isHumanPrompt) sessionsWithUserPrompt.add(logicalSessionId);
    }

    if (row.role !== 'assistant') continue;
    const inputTokens = toCount(row.inputTokens);
    const outputTokens = toCount(row.outputTokens);
    const cachedInputTokens = toCount(row.cacheReadTokens);
    const reasoningOutputTokens = toCount(row.reasoningTokens);
    // The store only gives one cache-write total with no per-TTL breakdown,
    // so an untyped write is priced as the cheaper 5m bucket rather than
    // folded into input: better to undercharge than overcharge an unknown TTL.
    const cacheCreation5mTokens = toCount(row.cacheWriteTokens);
    if (inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens
      + cacheCreation5mTokens === 0) continue;

    entries.push({
      source: SOURCE,
      model: row.model || 'unknown',
      project,
      timestamp: row.timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
      cacheCreation5mTokens,
    });
  }

  return {
    buckets: aggregateToBuckets(entries),
    sessions: extractSessions(events.filter(event => sessionsWithUserPrompt.has(event.sessionId))),
  };
}
