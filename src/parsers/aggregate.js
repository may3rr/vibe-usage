import { createHash } from 'node:crypto';

// Shared bucket/session aggregation used by every parser. Lives in its own
// module (not the parser registry in index.js) so parsers never have to import
// the registry that imports them — that circular dependency only worked because
// these functions are hoisted declarations. Keeping them here breaks the cycle.
//
// Data model: parsers emit flat per-message "entries" (token usage) and
// per-message "events" (timing), and these two functions fold them into the
// bucket/session shapes described in AGENTS.md.

export function roundToHalfHour(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
  return d;
}

// Server column limits (usage_buckets: model varchar(100), project varchar(200)).
// Anything longer aborts the whole INSERT chunk with 22001, so clamp here.
const MODEL_MAX_LENGTH = 100;
const PROJECT_MAX_LENGTH = 200;

// Server token columns are bigint — a single fractional/NaN value aborts the
// whole INSERT chunk with 22P02, taking every other tool's rows in the batch
// down with it.
function toTokenCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

export function aggregateToBuckets(entries) {
  const map = new Map();

  for (const e of entries) {
    const model = String(e.model || 'unknown').slice(0, MODEL_MAX_LENGTH);
    const project = String(e.project || 'unknown').slice(0, PROJECT_MAX_LENGTH);
    const bucketStart = roundToHalfHour(e.timestamp).toISOString();
    const key = `${e.source}|${model}|${project}|${e.hostname || ''}|${bucketStart}`;

    if (!map.has(key)) {
      map.set(key, {
        source: e.source,
        model,
        project,
        // Cloud-sourced parsers (cursor) pre-set a fixed hostname sentinel; it
        // must survive aggregation, or sync.js stamps the machine hostname and
        // every machine gets its own duplicate row server-side.
        ...(e.hostname ? { hostname: e.hostname } : {}),
        bucketStart,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        // Prompt-cache *writes*, split by TTL. Anthropic prices them at 1.25x
        // (5m) and 2x (1h) the base input rate, so they cannot be folded into
        // inputTokens without under-billing. Parsers that cannot tell the two
        // TTLs apart leave these at 0 and keep their existing behaviour.
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
      });
    }

    const b = map.get(key);
    b.inputTokens += e.inputTokens || 0;
    b.outputTokens += e.outputTokens || 0;
    b.cachedInputTokens += e.cachedInputTokens || 0;
    b.reasoningOutputTokens += e.reasoningOutputTokens || 0;
    b.cacheCreation5mTokens += e.cacheCreation5mTokens || 0;
    b.cacheCreation1hTokens += e.cacheCreation1hTokens || 0;
  }

  // Clamp after summation, not per entry — rounding each entry first would
  // discard sub-integer values instead of letting them accumulate.
  return Array.from(map.values()).map((b) => {
    const inputTokens = toTokenCount(b.inputTokens);
    const outputTokens = toTokenCount(b.outputTokens);
    const cachedInputTokens = toTokenCount(b.cachedInputTokens);
    const reasoningOutputTokens = toTokenCount(b.reasoningOutputTokens);
    const cacheCreation5mTokens = toTokenCount(b.cacheCreation5mTokens);
    const cacheCreation1hTokens = toTokenCount(b.cacheCreation1hTokens);
    return {
      ...b,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningOutputTokens,
      cacheCreation5mTokens,
      cacheCreation1hTokens,
      // Cache writes stay inside totalTokens: they used to arrive folded into
      // inputTokens, and the server uses this field only as a `> 0` liveness
      // filter. Keeping them in makes the number bit-identical to what the same
      // logs produced before the split, so no bucket drops out of any view.
      totalTokens: inputTokens + outputTokens + reasoningOutputTokens +
        cacheCreation5mTokens + cacheCreation1hTokens,
    };
  });
}

/**
 * Incremental session aggregation for parsers whose event stream is already
 * chronological. `extractSessions()` below keeps the sorting fallback for
 * parsers that emit mixed or out-of-order sessions.
 */
export function createSessionAccumulator() {
  return {
    ordered: true,
    first: null,
    last: null,
    lastTimestampMs: null,
    activeSeconds: 0,
    turnStartMs: null,
    turnEndMs: null,
    waitingForFirstResponse: false,
    messageCount: 0,
    userMessageCount: 0,
    userPromptHours: new Array(24).fill(0),
  };
}

function commitTurn(accumulator) {
  const { turnStartMs, turnEndMs } = accumulator;
  if (turnStartMs !== null && turnEndMs !== null && turnEndMs > turnStartMs) {
    accumulator.activeSeconds += Math.round((turnEndMs - turnStartMs) / 1000);
  }
}

export function accumulateSessionEvent(accumulator, event) {
  const timestampMs = event.timestamp.getTime();
  if (accumulator.lastTimestampMs !== null && timestampMs < accumulator.lastTimestampMs) {
    accumulator.ordered = false;
  }
  if (accumulator.first === null) accumulator.first = event;
  accumulator.last = event;
  accumulator.lastTimestampMs = timestampMs;
  accumulator.messageCount++;

  if (event.role === 'user') {
    commitTurn(accumulator);
    accumulator.turnStartMs = null;
    accumulator.turnEndMs = null;
    accumulator.waitingForFirstResponse = true;
    accumulator.userMessageCount++;
    accumulator.userPromptHours[event.timestamp.getUTCHours()]++;
  } else if (accumulator.waitingForFirstResponse) {
    accumulator.turnStartMs = timestampMs;
    accumulator.turnEndMs = timestampMs;
    accumulator.waitingForFirstResponse = false;
  } else if (accumulator.turnStartMs !== null) {
    accumulator.turnEndMs = timestampMs;
  }
}

export function sessionAccumulatorIsOrdered(accumulator) {
  return accumulator.ordered;
}

export function finalizeSessionAccumulator(accumulator, sessionId, projectOverride) {
  if (accumulator.first === null || accumulator.last === null) return null;
  if (!accumulator.ordered) {
    throw new TypeError('Session accumulator received out-of-order events');
  }

  let activeSeconds = accumulator.activeSeconds;
  const { turnStartMs, turnEndMs } = accumulator;
  if (turnStartMs !== null && turnEndMs !== null && turnEndMs > turnStartMs) {
    activeSeconds += Math.round((turnEndMs - turnStartMs) / 1000);
  }

  const first = accumulator.first;
  const last = accumulator.last;
  const sessionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return {
    source: first.source,
    project: projectOverride || first.project || 'unknown',
    sessionHash,
    firstMessageAt: first.timestamp.toISOString(),
    lastMessageAt: last.timestamp.toISOString(),
    durationSeconds: Math.round((last.timestamp - first.timestamp) / 1000),
    activeSeconds,
    messageCount: accumulator.messageCount,
    userMessageCount: accumulator.userMessageCount,
    userPromptHours: accumulator.userPromptHours,
  };
}

/**
 * Extract session metadata from timing events.
 * Each event: { sessionId, source, project, timestamp: Date, role: 'user'|'assistant' }
 *
 * Turn = first AI response → last AI response before next user prompt.
 * activeSeconds = sum(generation durations), excluding queue/TTFT wait.
 * durationSeconds = wall clock from first to last message.
 */
export function extractSessions(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.sessionId)) groups.set(event.sessionId, []);
    groups.get(event.sessionId).push(event);
  }

  const sessions = [];
  for (const [sessionId, sessionEvents] of groups) {
    sessionEvents.sort((a, b) => a.timestamp - b.timestamp);
    const accumulator = createSessionAccumulator();
    for (const event of sessionEvents) accumulateSessionEvent(accumulator, event);
    const session = finalizeSessionAccumulator(accumulator, sessionId);
    if (session) sessions.push(session);
  }
  return sessions;
}
