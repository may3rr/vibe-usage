import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

function normalizeRoot(path, home) {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return resolve(path);
}

export function resolveCodeartsAgentRoots(env = process.env, home = homedir()) {
  const override = env.VIBE_USAGE_CODEARTS_AGENT_DIRS?.trim();
  if (!override) return [join(home, '.codeartsdoer', 'codearts-data')];
  return override.split(delimiter)
    .map(path => path.trim())
    .filter(Boolean)
    .map(path => normalizeRoot(path, home));
}

function findDb(root) {
  const stat = statSync(root);
  const candidates = stat.isFile()
    ? [root]
    : [join(root, 'opencode.db'), join(root, 'codearts-data', 'opencode.db')];

  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      if (basename(candidate) !== 'opencode.db') continue;
      accessSync(candidate, constants.R_OK);
      return realpathSync(candidate);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
  }
  return null;
}

/**
 * Locate CodeArts Agent's accounting databases. An override may point at the
 * data directory, its `.codeartsdoer` parent, or `opencode.db` itself. The
 * default matches the home-relative location used by the desktop agent kernel;
 * the override also covers relocated and platform-specific profiles.
 */
export function findCodeartsAgentDbs({ env = process.env, home = homedir(), onWarning = () => {} } = {}) {
  const seen = new Set();
  const dbs = [];
  for (const root of resolveCodeartsAgentRoots(env, home)) {
    try {
      const db = findDb(root);
      if (!db || seen.has(db)) continue;
      seen.add(db);
      dbs.push(db);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
      onWarning(`CodeArts Agent: 无法读取数据目录 ${root}: ${err.message}`);
    }
  }
  return dbs;
}
