/**
 * OMP MCP configuration files.
 *
 * OMP keeps MCP servers in `mcp.json` files, not behind an RPC command: a
 * user-level `<agent dir>/mcp.json` and a project-level `<cwd>/.omp/mcp.json`.
 * The server reads and writes those files the way OMP does, so the MCP panel
 * works without an RPC surface.
 *
 * The user file is the agent directory's, not `~/.omp/mcp.json`: OMP builds its
 * user-level candidates from the agent dir (`ls()` in its bundle returns
 * `$s.agentDir`), so a file written beside `agent.db` is the one it loads.
 * Both spellings OMP reads are honoured — `mcp.json` then `.mcp.json`, the
 * canonical name winning a clash.
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
import path from 'node:path';
import { OPENCODE_CONFIG_DIR } from '../openchamber/agent-config-files.js';

/** The directory OMP reads user MCP files from: its agent dir. */
export const defaultOmpAgentDir = () =>
  process.env.OPENCHAMBER_OMP_AGENT_DIR?.trim() || OPENCODE_CONFIG_DIR;

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

/**
 * OMP reads both spellings of each location. A missing pair is `null`; the
 * canonical file wins a name clash and the two deny/force lists are unioned,
 * because OMP applies both.
 */
const readJsonPair = (files) => {
  const [primary, fallback] = files;
  const secondary = readJsonFile(fallback);
  const main = readJsonFile(primary);
  if (!main && !secondary) return null;
  const mergeList = (key) => [...new Set([...(secondary?.[key] ?? []), ...(main?.[key] ?? [])])];
  const disabledServers = mergeList('disabledServers');
  const enabledServers = mergeList('enabledServers');
  return {
    ...secondary,
    ...main,
    mcpServers: { ...(secondary?.mcpServers ?? {}), ...(main?.mcpServers ?? {}) },
    ...(disabledServers.length > 0 ? { disabledServers } : {}),
    ...(enabledServers.length > 0 ? { enabledServers } : {}),
  };
};

export function createOmpConfig({ agentDir, home } = {}) {
  const directory = agentDir ?? home ?? defaultOmpAgentDir();
  const userPaths = [path.join(directory, 'mcp.json'), path.join(directory, '.mcp.json')];
  const userPath = userPaths[0];
  const projectPaths = (d) => [path.join(d, '.omp', 'mcp.json'), path.join(d, '.omp', '.mcp.json')];
  const projectPath = (directory) => projectPaths(directory || process.cwd())[0];

  const listMcp = (directory) => {
    const user = readJsonPair(userPaths) ?? {};
    const project = directory ? readJsonPair(projectPaths(directory)) ?? {} : {};
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
    // The deny and force lists live in the canonical user file, whichever
    // spelling the server itself came from: OMP applies both files' lists.
    const user = readJsonPair(userPaths) ?? {};
    const next = { ...readJsonFile(userPath) ?? {} };
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

  /** The file a name actually lives in, so an edit never duplicates it. */
  const sourceFileFor = (name, files) => {
    if (readJsonFile(files[0])?.mcpServers?.[name]) return files[0];
    if (readJsonFile(files[1])?.mcpServers?.[name]) return files[1];
    return files[0];
  };

  const removeMcp = (name, scope = 'user', directory) => {
    const files = scope === 'project' ? projectPaths(directory || process.cwd()) : userPaths;
    const file = sourceFileFor(name, files);
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
