/**
 * READ-ONLY view of the provider credentials OMP uses.
 *
 * OMP is the only agent runtime this fork ships, and the credentials the quota
 * providers, the voice keys and the routing classifier read are the ones OMP
 * itself uses. This module answers them from OMP's own stores.
 *
 * Where OMP keeps a provider credential, in resolution order:
 *
 * - `<agent dir>/agent.db`, table `auth_credentials`: every credential entered
 *   through `/login` or as an API key, one row per credential
 *   (`credential_type` `api_key` / `oauth`, `data` JSON). A credential the user
 *   deleted stays as a tombstone with `disabled_cause` set, so this reader
 *   filters on `disabled_cause IS NULL` exactly like OMP's own
 *   `listActiveByProvider` query, and an empty answer stays authoritative.
 * - `<agent dir>/models.yml`, `providers.<id>.apiKey`: the key of a provider
 *   declared on disk. A `!command` value is reported as unreadable instead of
 *   executed, matching how OMP's catalog inspection treats it.
 * - the environment: OMP's catalog declares one or two variables per provider
 *   (`OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`, …). Consulted only for a provider
 *   with no stored credential.
 *
 * OMP keeps no credential in `config.yml` (its settings have no `apiKey`
 * field), and `secrets.yml` is a redaction list, not a store. When the auth
 * broker (`OMP_AUTH_BROKER_URL`) serves the credentials they live on the broker
 * and are not readable here; the local store is then simply empty.
 *
 * Entries are projected into the legacy `auth.json` shape the consumers were
 * written against (`{ type: 'api', key }` / `{ type: 'oauth', access, refresh,
 * expires, … }`). OMP renamed some providers on the way in (`opencode` →
 * `opencode-zen`, `openai` → `openai-codex`, `kimi-for-coding` → `kimi-code`,
 * …), so a verified rename is also published under the key those consumers'
 * alias lists search for; a provider that really exists under the old id wins.
 *
 * OMP also loads `.env` files (`<cwd>/.env`, `<agent dir>/.env`, `~/.omp/.env`,
 * `~/.env`); this reader sees only the process environment.
 *
 * Nothing here writes: OMP owns the store, and a write from this process would
 * drift from the credential the runtime actually uses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { MODELS_FILE, OPENCODE_CONFIG_DIR, isPlainObject, readConfigFile } from './agent-config-files.js';

/** OMP's agent database filename inside the agent directory. */
export const CREDENTIAL_DB_FILE = 'agent.db';

/**
 * OMP's credential database path, mirroring `getAgentDbPath()`: after
 * `omp config init-xdg` the database lives at `$XDG_DATA_HOME/omp/agent.db`
 * instead of inside the agent directory. XDG applies only to the default agent
 * directory — an explicit `PI_CODING_AGENT_DIR` or an active profile pins the
 * location, which is how OMP's own resolver behaves.
 */
export const resolveCredentialDbPath = ({ agentDir = OPENCODE_CONFIG_DIR, env = process.env, dbFile = CREDENTIAL_DB_FILE, exists = fs.existsSync, path: pathModule = path } = {}) => {
  const pinnedByEnv = Boolean(env.PI_CODING_AGENT_DIR?.trim());
  const profile = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  const pinnedByProfile = Boolean(profile) && profile !== 'default';
  const xdgData = env.XDG_DATA_HOME?.trim();
  if (xdgData && !pinnedByEnv && !pinnedByProfile) {
    const xdgRoot = pathModule.join(xdgData, 'omp');
    if (exists(xdgRoot)) return pathModule.join(xdgRoot, dbFile);
  }
  return pathModule.join(agentDir, dbFile);
};

/**
 * A minimal read-only connection: `all(sql)` and `close()`. Node provides it
 * through `node:sqlite`, Bun through `bun:sqlite`; both are built in. Neither
 * being available yields null, and the caller falls back to the other sources
 * rather than inventing a credential.
 */
let openConnection;
const loadSqlite = () => {
  if (openConnection !== undefined) return openConnection;
  const require = createRequire(import.meta.url);
  openConnection = null;
  try {
    const node = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
    const { DatabaseSync } = node ?? require('node:sqlite');
    if (typeof DatabaseSync === 'function') {
      openConnection = (dbPath) => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
      };
      return openConnection;
    }
  } catch {
    // Not Node, or a Node without node:sqlite; try Bun next.
  }
  try {
    const { Database } = require('bun:sqlite');
    if (typeof Database === 'function') {
      openConnection = (dbPath) => {
        const db = new Database(dbPath, { readonly: true });
        return { all: (sql) => db.query(sql).all(), close: () => db.close() };
      };
    }
  } catch {
    // No sqlite runtime at all.
  }
  return openConnection;
};

/**
 * Project one `auth_credentials` row into the legacy entry shape. Returns null
 * for a credential this reader does not understand, so a future
 * `credential_type` is skipped rather than passed on mislabelled.
 *
 * `expires` stays in OMP's epoch milliseconds: every consumer normalizes a
 * seconds/ms value itself (`normalizeTimestamp`, or `Date.now()` arithmetic in
 * the xAI provider), and converting here would create a second meaning.
 */
export const projectCredential = (credentialType, raw) => {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  if (credentialType === 'api_key') {
    if (typeof data.key !== 'string' || !data.key) return null;
    return { type: 'api', key: data.key };
  }

  if (credentialType === 'oauth') {
    if (typeof data.access !== 'string' || !data.access) return null;
    if (typeof data.refresh !== 'string') return null;
    const entry = {
      type: 'oauth',
      access: data.access,
      refresh: data.refresh,
      expires: Number(data.expires) || 0,
    };
    // OMP's OAuthCredential is a superset of the legacy entry; carry every
    // identifier a consumer may display or forward, skipping absent ones.
    for (const field of ['accountId', 'enterpriseUrl', 'projectId', 'email', 'orgId', 'orgName', 'authorizedAt', 'apiEndpoint']) {
      if (data[field] !== undefined) entry[field] = data[field];
    }
    return entry;
  }

  return null;
};

/**
 * Run `read` against OMP's credential store. Returns null when the database,
 * the sqlite runtime or the table is unavailable, so the caller can tell "no
 * credentials" from "could not look".
 */
const withCredentialsDb = ({ dbPath, fileSystem = fs }, read) => {
  const open = loadSqlite();
  if (!open || !dbPath || !fileSystem.existsSync(dbPath)) return null;

  let db;
  try {
    db = open(dbPath);
    return read(db);
  } catch (error) {
    console.warn('Could not read the OMP credentials database:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // The connection is read-only; a failed close changes nothing.
    }
  }
};

/**
 * Every active credential in OMP's database, one entry per provider, in the
 * legacy shape. A provider can hold several credentials (one per account) and
 * the map has one slot, so the most recently updated one wins.
 *
 * @returns {Record<string, object> | null} null when the database, the sqlite
 *   runtime or the `auth_credentials` table is unavailable, so the caller can
 *   tell "no credentials" from "could not look".
 */
export const readCredentialsFromDb = ({ dbPath, fs: fileSystem = fs } = {}) =>
  withCredentialsDb({ dbPath, fileSystem }, (db) => {
    const rows = db.all(
      'SELECT provider, credential_type, data FROM auth_credentials ' +
        'WHERE disabled_cause IS NULL AND provider IS NOT NULL ' +
        'ORDER BY updated_at DESC, id DESC',
    );
    const result = {};
    for (const row of rows) {
      const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
      if (!provider || provider in result) continue;
      const entry = projectCredential(row.credential_type, row.data);
      if (entry) result[provider] = entry;
    }
    return result;
  });

/**
 * The `provider` keys of every active `auth_credentials` row — the credential
 * ids OMP can resolve. OMP stores an MCP server's OAuth credential under the
 * `auth.credentialId` its `mcp.json` points at (`mcp_oauth:…`), so membership
 * here is exactly "that pointer still resolves".
 *
 * @returns {Set<string> | null} null when the database, the sqlite runtime or
 *   the table is unavailable, so the caller can tell "no such credential" from
 *   "could not look".
 */
export const readCredentialIdsFromDb = ({ dbPath, fs: fileSystem = fs } = {}) =>
  withCredentialsDb({ dbPath, fileSystem }, (db) => {
    const rows = db.all('SELECT provider FROM auth_credentials WHERE disabled_cause IS NULL AND provider IS NOT NULL');
    const ids = new Set();
    for (const row of rows) {
      const id = typeof row.provider === 'string' ? row.provider.trim() : '';
      if (id) ids.add(id);
    }
    return ids;
  });

/**
 * `providers.<id>.apiKey` from OMP's models.yml, through the same reader the
 * rest of the OMP file layer uses. A `!command` value is skipped: executing it
 * needs OMP's shell semantics, and passing the command string to a provider
 * would be worse than reporting the provider unconfigured.
 */
export const readApiKeysFromModelsConfig = ({ modelsPath = MODELS_FILE } = {}) => {
  const modelsConfig = readConfigFile(modelsPath);
  const providers = isPlainObject(modelsConfig?.providers) ? modelsConfig.providers : null;
  if (!providers) return {};
  const result = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!isPlainObject(entry)) continue;
    const apiKey = entry.apiKey;
    if (typeof apiKey !== 'string') continue;
    const key = apiKey.trim();
    if (!key || key.startsWith('!')) continue;
    result[id] = { type: 'api', key };
  }
  return result;
};

/**
 * OMP's catalog env fallback per provider (`providers/<id>.kdl` `env` in
 * `pi-catalog/src/compat/rules`), for the providers these consumers look up.
 * Only the process environment is read.
 */
export const PROVIDER_ENV_VARS = {
  'opencode-zen': ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zhipu-coding-plan': ['ZHIPU_API_KEY'],
  'kimi-code': ['KIMI_API_KEY'],
  'wafer-serverless': ['WAFER_SERVERLESS_API_KEY'],
  nanogpt: ['NANO_GPT_API_KEY'],
  'minimax-code': ['MINIMAX_CODE_API_KEY'],
  'minimax-code-cn': ['MINIMAX_CODE_CN_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  'cline-pass': ['CLINE_API_KEY'],
  'charm-hyper': ['CHARM_HYPER_API_KEY', 'HYPER_API_KEY'],
  'xai-oauth': ['XAI_OAUTH_TOKEN', 'XAI_API_KEY'],
};

/**
 * OMP provider ids the consumers' alias lists predate, and the key they search
 * for. Each pairing was verified against OMP's catalog (display name, endpoint,
 * default model or client id) in `pi-catalog/src/compat/rules`. Published as an
 * extra key only when that key is not already a provider of its own.
 */
export const LEGACY_PROVIDER_KEYS = {
  'opencode-zen': ['opencode'],
  'openai-codex': ['openai'],
  'kimi-code': ['kimi-for-coding'],
  'wafer-serverless': ['wafer'],
  'zhipu-coding-plan': ['zhipuai-coding-plan'],
  'charm-hyper': ['hyper'],
  'xai-oauth': ['xai'],
  'minimax-code': ['minimax-coding-plan'],
  'minimax-code-cn': ['minimax-cn-coding-plan'],
  'google-gemini-cli': ['google.oauth'],
  'vercel-ai-gateway': ['vercel'],
};

const credentialsFromEnv = (env) => {
  const result = {};
  for (const [provider, names] of Object.entries(PROVIDER_ENV_VARS)) {
    for (const name of names) {
      const value = env[name]?.trim();
      if (!value) continue;
      result[provider] = { type: 'api', key: value };
      break;
    }
  }
  return result;
};

/**
 * The credentials OMP uses, keyed by provider id, in the legacy entry shape.
 *
 * The database is authoritative for the providers it answers: a tombstoned
 * credential stays deleted and the environment does not resurrect it, matching
 * OMP's own resolution. A provider the database cannot supply (unreadable, no
 * sqlite runtime, or simply no row) falls back to models.yml, then to the
 * provider's environment variable. A database that cannot be read at all still
 * leaves the other sources.
 *
 * @param {{ dbPath?: string, modelsPath?: string, agentDir?: string, env?: NodeJS.ProcessEnv, fileSystem?: typeof fs }} [options] test seams; production callers pass nothing.
 */
export const readAuthFile = (options = {}) => {
  const {
    agentDir = OPENCODE_CONFIG_DIR,
    dbPath = resolveCredentialDbPath({ agentDir, env: options.env }),
    modelsPath = MODELS_FILE,
    env = process.env,
    fileSystem = fs,
  } = options;

  const stored = readCredentialsFromDb({ dbPath, fs: fileSystem });

  let configured = {};
  try {
    configured = readApiKeysFromModelsConfig({ modelsPath });
  } catch (error) {
    // A hand-edited models.yml must not read as "no credentials". It is still
    // only fatal when the database could not answer either, the same precedence
    // the file/database pair had before.
    if (stored === null) throw error;
    console.warn('Could not read OMP provider apiKeys from models.yml:', error instanceof Error ? error.message : error);
  }

  const auth = { ...(stored ?? {}) };
  for (const [provider, entry] of Object.entries(configured)) {
    if (!(provider in auth)) auth[provider] = entry;
  }
  for (const [provider, entry] of Object.entries(credentialsFromEnv(env))) {
    if (!(provider in auth)) auth[provider] = entry;
  }
  // Renames last, so a provider the user really has keeps its own key.
  for (const [provider, legacyKeys] of Object.entries(LEGACY_PROVIDER_KEYS)) {
    const entry = auth[provider];
    if (!entry) continue;
    for (const legacyKey of legacyKeys) {
      if (!(legacyKey in auth)) auth[legacyKey] = entry;
    }
  }
  return auth;
};

/** One provider's credential, or null. */
export const getProviderAuth = (providerId) => readAuthFile()[providerId] ?? null;

/** The provider ids that have a configured credential. */
export const listProviderAuths = () => Object.keys(readAuthFile());
