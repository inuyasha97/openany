/**
 * OMP MCP configuration files.
 *
 * OMP keeps MCP servers in `mcp.json` files, not behind an RPC command: a
 * user-level `<omp home>/mcp.json` and a project-level `<cwd>/.omp/mcp.json`.
 * The server reads and writes those files the way OMP does, so the MCP panel
 * works without an RPC surface.
 *
 * Merge rules, matching OMP's own precedence:
 * - `mcpServers` are unioned, project first, user second (user wins a name).
 * - `disabledServers` hides a name regardless of its `enabled` flag.
 * - `enabledServers` force-enables a name whose source config says `enabled: false`.
 *
 * Enable/disable is written to the user file only, as OMP does, so a project
 * file committed to a repository is never rewritten.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultOmpHome = () =>
  process.env.OPENCHAMBER_OMP_HOME?.trim() || path.join(os.homedir(), '.omp');

/**
 * A missing file is `null`; an existing file that does not parse throws, so a
 * writer refuses to replace a hand-edited file with an empty one and erase the
 * settings it holds.
 */
const readJsonFile = (file) => {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const writeJsonFile = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

export function createOmpConfig({ home } = {}) {
  const ompHome = home ?? defaultOmpHome();
  const userPath = path.join(ompHome, 'mcp.json');
  const projectPath = (directory) => path.join(directory || process.cwd(), '.omp', 'mcp.json');

  const listMcp = (directory) => {
    const user = readJsonFile(userPath) ?? {};
    const project = directory ? readJsonFile(projectPath(directory)) ?? {} : {};
    // OMP reads the deny and force-enable lists from the user file only: the
    // project `mcp.json` provider reads `mcpServers` and ignores both lists, so
    // honouring a project list here would report a server disabled that OMP
    // still runs.
    const disabled = new Set(user.disabledServers ?? []);
    const forced = new Set(user.enabledServers ?? []);
    const userServers = user.mcpServers ?? {};

    return Object.entries({ ...(project.mcpServers ?? {}), ...userServers }).map(([name, config]) => ({
      name,
      scope: Object.prototype.hasOwnProperty.call(userServers, name) ? 'user' : 'project',
      enabled: !disabled.has(name) && (forced.has(name) || config.enabled !== false),
      type: config.type ?? (config.url ? 'http' : 'stdio'),
      command: config.command,
      url: config.url,
    }));
  };

  const setMcpEnabled = (name, enabled) => {
    const user = readJsonFile(userPath) ?? {};
    const next = { ...user };
    const disabled = new Set(user.disabledServers ?? []);
    const forced = new Set(user.enabledServers ?? []);
    if (enabled) {
      disabled.delete(name);
      forced.add(name);
    } else {
      forced.delete(name);
      disabled.add(name);
    }
    if (disabled.size > 0) next.disabledServers = [...disabled].sort();
    else delete next.disabledServers;
    if (forced.size > 0) next.enabledServers = [...forced].sort();
    else delete next.enabledServers;
    writeJsonFile(userPath, next);
    return true;
  };

  const removeMcp = (name, scope = 'user', directory) => {
    const file = scope === 'project' ? projectPath(directory) : userPath;
    const config = readJsonFile(file);
    if (!config?.mcpServers?.[name]) return false;
    const { [name]: _removed, ...remaining } = config.mcpServers;
    writeJsonFile(file, { ...config, mcpServers: remaining });
    return true;
  };

  const addMcp = (definition, scope = 'user', directory) => {
    const file = scope === 'project' ? projectPath(directory) : userPath;
    const config = readJsonFile(file) ?? {};
    writeJsonFile(file, {
      ...config,
      mcpServers: { ...(config.mcpServers ?? {}), [definition.name]: definition.server },
    });
    return true;
  };

  return { listMcp, setMcpEnabled, removeMcp, addMcp };
}
