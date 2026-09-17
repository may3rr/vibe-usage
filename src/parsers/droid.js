import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { getDroidSessionsDir, getDroidSettingsPaths } from '../tools.js';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { readJsonSafe } from './fs-utils.js';

// Factory session sidecars store the local slot id (`custom:gpt-6-astra-[gw]-0`),
// not the API model. `customModels[].model` is what the provider actually sees.
// A bare routing word would collide with Cursor's pricing entry (PR #83).
const ROUTING_TIER_IDS = new Set([
  'auto', 'default', 'default-model', 'fast', 'turbo', 'lite', 'ultimate', 'performance', 'efficient',
]);
const CUSTOM_SLOT_ID = /^custom:(.+)-\[([^\]]+)\]-(\d+)$/;

export function loadDroidCustomModelCatalog() {
  const catalog = new Map();
  for (const settingsPath of getDroidSettingsPaths()) {
    const data = readJsonSafe(settingsPath);
    if (!data) continue;
    for (const list of [data.customModels, data.custom_models]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const model = typeof entry.model === 'string' ? entry.model.trim() : '';
        if (id && model) catalog.set(id, model);
      }
    }
  }
  return catalog;
}

export function resolveDroidModel(raw, catalog = new Map()) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return 'unknown';
  const mapped = catalog instanceof Map ? catalog.get(id) : undefined;
  const resolved = (typeof mapped === 'string' && mapped.trim())
    ? mapped.trim()
    : (id.match(CUSTOM_SLOT_ID)?.[1] || id);
  const lower = resolved.toLowerCase();
  return ROUTING_TIER_IDS.has(lower) ? `droid-${lower}` : resolved;
}

function findJsonlFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const nested of findJsonlFiles(fullPath)) results.push(nested);
      } else if (entry.name.endsWith('.jsonl') && !entry.name.endsWith('.settings.json')) {
        results.push(fullPath);
      }
    }
  } catch {
  }

  return results;
}

function extractProjectFromSlug(slug) {
  const parts = slug.split('-').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

function toSafeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function parse() {
  const entries = [];
  const sessionEvents = [];
  const sessionFiles = findJsonlFiles(getDroidSessionsDir());
  const catalog = loadDroidCustomModelCatalog();

  for (const filePath of sessionFiles) {
    const sessionId = basename(filePath, '.jsonl');
    const slug = basename(dirname(filePath));
    const project = extractProjectFromSlug(slug);
    let firstMessageTimestamp = null;

    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type !== 'message') continue;
      if (!obj.timestamp) continue;

      const ts = new Date(obj.timestamp);
      if (isNaN(ts.getTime())) continue;

      if (firstMessageTimestamp === null) firstMessageTimestamp = ts;

      sessionEvents.push({
        sessionId,
        source: 'droid',
        project,
        timestamp: ts,
        role: obj.message?.role === 'user' ? 'user' : 'assistant',
      });
    }

    const settingsPath = join(dirname(filePath), `${sessionId}.settings.json`);
    if (!existsSync(settingsPath) || firstMessageTimestamp === null) continue;

    let settings;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      continue;
    }

    const tokenUsage = settings?.tokenUsage;
    if (!tokenUsage) continue;

    // Factory already stores uncached prompt in inputTokens. Its session log
    // records `inputTokens` + `cacheReadInputTokens` = `totalInputTokens`;
    // subtracting cacheReadTokens here zeros BYOK input whenever cache > input.
    const cacheReadTokens = toSafeNumber(tokenUsage.cacheReadTokens);
    const thinkingTokens = toSafeNumber(tokenUsage.thinkingTokens);
    const cacheCreation5mTokens = toSafeNumber(tokenUsage.cacheCreationTokens);
    const inputTokens = toSafeNumber(tokenUsage.inputTokens);
    const outputTokens = Math.max(0, toSafeNumber(tokenUsage.outputTokens) - thinkingTokens);
    if (inputTokens + outputTokens + cacheReadTokens + thinkingTokens + cacheCreation5mTokens === 0) {
      continue;
    }

    entries.push({
      source: 'droid',
      model: resolveDroidModel(settings.model, catalog),
      project,
      timestamp: firstMessageTimestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheReadTokens,
      reasoningOutputTokens: thinkingTokens,
      cacheCreation5mTokens,
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
