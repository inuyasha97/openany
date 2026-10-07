import fs from 'fs';
import path from 'path';
import os from 'os';
import { OPENCODE_CONFIG_DIR } from '../../openchamber/agent-config-files.js';

/**
 * OMP keeps no antigravity accounts file of its own (its Google Antigravity
 * credential is a `google-antigravity` OAuth row in `agent.db`), so this stays
 * the legacy pair OpenChamber has always read: OMP's agent/config directory
 * beside the rest of its state, then OpenCode's data directory for a leftover
 * file.
 */
const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

export const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json')
];

export const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

export const getAuthEntry = (auth, aliases) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

export const normalizeAuthEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry };
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};
