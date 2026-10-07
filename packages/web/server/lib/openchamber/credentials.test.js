import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { readAuthFile, resolveCredentialDbPath } from './credentials.js';

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
})();

let dir;
let dbPath;
let modelsPath;

/** Seed OMP's `auth_credentials` table; `updated` orders competing rows. */
const seedDb = (rows) => {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, ' +
      'credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, ' +
      'identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)',
  );
  const insert = db.prepare(
    'INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.provider, row.type, JSON.stringify(row.data), row.disabledCause ?? null, row.updated ?? 1);
  }
  db.close();
};

/** Reads the local store with the environment and models.yml pinned, so neither leaks in. */
const read = (options = {}) => readAuthFile({ dbPath, modelsPath, env: {}, ...options });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-credentials-'));
  dbPath = path.join(dir, 'agent.db');
  modelsPath = path.join(dir, 'models.yml');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!sqlite)('readAuthFile', () => {
  it('projects OMP api_key and oauth rows into the legacy entry shape', () => {
    seedDb([
      { provider: 'deepseek', type: 'api_key', data: { key: 'sk-deepseek', source: 'login' } },
      {
        provider: 'anthropic',
        type: 'oauth',
        data: { access: 'access-token', refresh: 'refresh-token', expires: 1790147792745, email: 'a@b.test', orgId: 'org-1' },
      },
    ]);
    expect(read()).toEqual({
      deepseek: { type: 'api', key: 'sk-deepseek' },
      anthropic: {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires: 1790147792745,
        email: 'a@b.test',
        orgId: 'org-1',
      },
    });
  });

  it('keeps a deleted credential deleted: the tombstone is skipped, not answered from an env var', () => {
    seedDb([{ provider: 'deepseek', type: 'api_key', data: { key: 'sk-removed' }, disabledCause: 'deleted by user' }]);
    expect(read({ env: { DEEPSEEK_API_KEY: 'sk-env' } })).toEqual({ deepseek: { type: 'api', key: 'sk-env' } });
  });

  it('answers the most recently updated credential when a provider holds several', () => {
    seedDb([
      { provider: 'anthropic', type: 'oauth', data: { access: 'old', refresh: 'r', expires: 1 }, updated: 100 },
      { provider: 'anthropic', type: 'oauth', data: { access: 'new', refresh: 'r', expires: 2 }, updated: 200 },
    ]);
    expect(read().anthropic.access).toBe('new');
  });

  it('republishes a renamed provider under the key the consumers search for', () => {
    seedDb([{ provider: 'opencode-zen', type: 'api_key', data: { key: 'sk-zen' } }]);
    const auth = read();
    expect(auth['opencode-zen']).toEqual({ type: 'api', key: 'sk-zen' });
    expect(auth.opencode).toEqual({ type: 'api', key: 'sk-zen' });
  });

  it('lets a provider that really exists under the old id keep its own entry', () => {
    seedDb([
      { provider: 'openai-codex', type: 'oauth', data: { access: 'chatgpt', refresh: 'r', expires: 1 } },
      { provider: 'openai', type: 'api_key', data: { key: 'sk-api' } },
    ]);
    expect(read().openai).toEqual({ type: 'api', key: 'sk-api' });
  });

  it('reads a provider apiKey from models.yml when the database has no row, and never runs a !command', () => {
    fs.writeFileSync(
      modelsPath,
      ['providers:', '  wafer-serverless:', '    baseUrl: https://pass.wafer.ai/v1', '    apiKey: wfr_123', '  custom:', '    apiKey: "!op read op://vault/key"'].join('\n'),
    );
    seedDb([]);
    const auth = read();
    expect(auth.wafer).toEqual({ type: 'api', key: 'wfr_123' });
    expect(auth.custom).toBeUndefined();
  });

  it('falls back to the provider environment variable only when nothing is stored', () => {
    seedDb([{ provider: 'opencode-go', type: 'api_key', data: { key: 'sk-stored' } }]);
    const auth = read({ env: { OPENCODE_API_KEY: 'sk-env', OPENROUTER_API_KEY: 'or-env' } });
    expect(auth['opencode-go']).toEqual({ type: 'api', key: 'sk-stored' });
    expect(auth.openrouter).toEqual({ type: 'api', key: 'or-env' });
  });

  it('answers with no credentials when neither the database nor models.yml exists', () => {
    expect(read()).toEqual({});
  });

  it('reports an unparseable models.yml when it is the only source left', () => {
    fs.writeFileSync(modelsPath, 'providers: [ { not a map');
    expect(() => read()).toThrow(/invalid YAML/);
  });
});

describe('resolveCredentialDbPath', () => {
  it('follows OMP to the XDG data directory, but only for the default agent directory', () => {
    const exists = () => true;
    expect(resolveCredentialDbPath({ agentDir: '/home/u/.omp/agent', env: { XDG_DATA_HOME: '/xdg' }, exists, path }))
      .toBe(path.join('/xdg', 'omp', 'agent.db'));
    expect(resolveCredentialDbPath({
      agentDir: '/pinned',
      env: { XDG_DATA_HOME: '/xdg', PI_CODING_AGENT_DIR: '/pinned' },
      exists,
      path,
    })).toBe(path.join('/pinned', 'agent.db'));
  });
});
