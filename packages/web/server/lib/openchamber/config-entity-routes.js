/**
 * Config-entity routes on OMP storage: agents, commands, MCP servers and the
 * global AGENTS.md.
 *
 * OMP keeps agents and commands as markdown files under its agent directory
 * (`<agent dir>/agents`, `<agent dir>/commands`) and a project's `.omp/`
 * equivalents; MCP servers live in `mcp.json` files and the global behavior
 * prompt is `<agent dir>/AGENTS.md`. OMP's `config.yml` has no per-entity
 * sections, so the OpenCode-shaped JSON half of every entity (an entry in
 * `opencode.json`) has no home here: the routes that genuinely need it throw
 * the typed `OMP_UNSUPPORTED_CONFIG_SECTION` error instead of inventing values,
 * while the routes that can answer from markdown keep the markdown data in the
 * same response shape.
 *
 * The request and response shapes are the ones the deleted OpenCode config
 * routes served, so the existing UI stores keep working unchanged:
 * - `GET /api/config/agents/:name` -> `{ name, sources, scope, isBuiltIn }`
 * - `GET /api/config/agents/:name/config` -> `{ source, scope, path, legacy, config }`
 * - `GET /api/config/agents/:name/permissions` -> `{ global, agent, effective, source, path }`
 * - `POST/PATCH/DELETE /api/config/agents/:name`
 * - the same five for `/api/config/commands/:name`
 * - `GET /api/config/mcp`, `GET/POST/PATCH/DELETE /api/config/mcp/:name`
 * - `GET/PUT /api/behavior/agents-md`
 *
 * The entity projections are a port of the deleted OpenCode v2 conversions
 * (`config-v2.js`), restricted to the fields the UI speaks; the file layer is
 * OMP's own.
 */

import fs from 'fs';
import path from 'path';

import {
  AGENT_SCOPE,
  COMMAND_SCOPE,
  OPENCODE_CONFIG_DIR,
  OMP_PROJECT_DIR,
  findWorktreeRoot,
  getAncestors,
  getJsonEntrySource,
  parseMdFile,
  readConfigLayers,
  writeMdFile,
} from './agent-config-files.js';
import { buildAppliedResponse } from './config-mutation-response.js';
import { readCredentialIdsFromDb, resolveCredentialDbPath } from './credentials.js';

// ============== UNSUPPORTED SECTIONS ==============

const OMP_UNSUPPORTED_CONFIG_SECTION = 'OMP_UNSUPPORTED_CONFIG_SECTION';
const UNSUPPORTED_CONFIG_SECTION_STATUS = 501;

const isUnsupportedConfigSection = (error) =>
  Boolean(error && typeof error === 'object' && error.code === OMP_UNSUPPORTED_CONFIG_SECTION);

// ============== GENERIC HELPERS ==============

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickDefined(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== null));
}

function trimmedString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

// ============== PERMISSIONS (OpenCode v2 projection) ==============

const PERMISSION_EFFECTS = new Set(['allow', 'deny', 'ask']);

function normalizePermissionAction(action) {
  if (action === 'write' || action === 'patch') return 'edit';
  if (action === 'task') return 'subagent';
  if (action === 'bash') return 'shell';
  return action;
}

function makeRule(action, resource, effect) {
  return { action: String(action), resource: String(resource), effect };
}

/** Translate a v1 `permission` value into the ordered v2 rule array. */
function permissionMapToRules(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return PERMISSION_EFFECTS.has(value) ? [makeRule('*', '*', value)] : [];
  }
  if (!isRecord(value)) return [];
  const rules = [];
  for (const [rawAction, raw] of Object.entries(value)) {
    const action = normalizePermissionAction(rawAction);
    if (typeof raw === 'string') {
      if (PERMISSION_EFFECTS.has(raw)) rules.push(makeRule(action, '*', raw));
      continue;
    }
    if (!isRecord(raw)) continue;
    for (const [resource, effect] of Object.entries(raw)) {
      if (PERMISSION_EFFECTS.has(effect)) rules.push(makeRule(action, resource, effect));
    }
  }
  return rules;
}

/** v1 `tools: { websearch: false }` becomes deny/allow rules. */
function toolsToRules(value) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, enabled]) => typeof enabled === 'boolean')
    .map(([action, enabled]) => makeRule(normalizePermissionAction(action), '*', enabled ? 'allow' : 'deny'));
}

function isPermissionRule(value) {
  return (
    isRecord(value)
    && typeof value.action === 'string'
    && typeof value.resource === 'string'
    && PERMISSION_EFFECTS.has(value.effect)
  );
}

function normalizePermissionRules(value) {
  if (Array.isArray(value)) return value.filter(isPermissionRule).map((rule) => makeRule(rule.action, rule.resource, rule.effect));
  return permissionMapToRules(value);
}

function effectiveAgentRules(globalRules, agentRules) {
  return [
    ...normalizePermissionRules(globalRules).map((rule) => ({ ...rule, source: 'global' })),
    ...normalizePermissionRules(agentRules).map((rule) => ({ ...rule, source: 'agent' })),
  ];
}

/** Global rules of a config object: v1 `tools`, then v1 `permission`, then native `permissions`. */
function readGlobalPermissionRules(config) {
  if (!isRecord(config)) return [];
  return [
    ...toolsToRules(config.tools),
    ...permissionMapToRules(config.permission),
    ...normalizePermissionRules(config.permissions),
  ];
}

// ============== MODEL SELECTION ==============

function parseModelSelection(model, variant) {
  if (isRecord(model)) {
    return parseModelSelection(
      typeof model.providerID === 'string' && typeof (model.modelID ?? model.model) === 'string'
        ? `${model.providerID}/${model.modelID ?? model.model}`
        : undefined,
      model.variant,
    );
  }
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  const separator = trimmed.indexOf('/');
  if (separator <= 0) return null;
  const providerID = trimmed.slice(0, separator);
  if (providerID.includes('#')) return null;
  const hash = trimmed.indexOf('#', separator + 1);
  const modelID = trimmed.slice(separator + 1, hash === -1 ? undefined : hash);
  const embedded = hash === -1 ? undefined : trimmed.slice(hash + 1);
  if (!modelID) return null;
  const chosen = embedded !== undefined ? embedded : (typeof variant === 'string' ? variant.trim() : undefined);
  if (chosen !== undefined && (!chosen || chosen.includes('#'))) return { providerID, modelID };
  return chosen ? { providerID, modelID, variant: chosen } : { providerID, modelID };
}

function formatModelSelection(selection) {
  if (typeof selection === 'string') {
    const parsed = parseModelSelection(selection);
    return parsed ? formatModelSelection(parsed) : null;
  }
  if (!isRecord(selection)) return null;
  const providerID = typeof selection.providerID === 'string' ? selection.providerID.trim() : '';
  const modelID = typeof (selection.modelID ?? selection.model) === 'string'
    ? String(selection.modelID ?? selection.model).trim()
    : '';
  if (!providerID || !modelID) return null;
  const variant = typeof selection.variant === 'string' ? selection.variant.trim() : '';
  return variant ? `${providerID}/${modelID}#${variant}` : `${providerID}/${modelID}`;
}

// ============== AGENTS (markdown half) ==============

const AGENT_NATIVE_KEYS = new Set([
  'model',
  'request',
  'system',
  'description',
  'mode',
  'hidden',
  'color',
  'steps',
  'disabled',
  'permissions',
]);

const AGENT_REQUEST_BODY_KEYS = ['temperature', 'top_p'];

const AGENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const AGENT_COLOR_FALLBACK = '#aaaaaa';

function toAgentColor(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return AGENT_COLOR_PATTERN.test(trimmed) ? trimmed : AGENT_COLOR_FALLBACK;
}

function normalizeRequest(value, legacy) {
  const headers = isRecord(value?.headers) ? { ...value.headers } : undefined;
  const fromNative = isRecord(value?.body) ? { ...value.body } : {};
  const fromLegacy = isRecord(legacy?.options) ? { ...legacy.options } : {};
  for (const key of AGENT_REQUEST_BODY_KEYS) {
    if (typeof legacy?.[key] === 'number') fromLegacy[key] = legacy[key];
  }
  const body = { ...fromLegacy, ...fromNative };
  const request = pickDefined([
    ['headers', headers && Object.keys(headers).length ? headers : undefined],
    ['body', Object.keys(body).length ? body : undefined],
  ]);
  return Object.keys(request).length ? request : undefined;
}

/**
 * Read an agent from either spelling into the canonical API shape. `body` is
 * the markdown body for `.md` agents and wins over a frontmatter `system`.
 */
function toAgentEntity(raw, body) {
  const source = isRecord(raw) ? raw : {};
  const system = typeof body === 'string' && body.length > 0
    ? body
    : (typeof source.system === 'string' ? source.system : (typeof source.prompt === 'string' ? source.prompt : undefined));
  const model = formatModelSelection(
    isRecord(source.model) ? source.model : parseModelSelection(source.model, source.variant),
  );
  const steps = typeof source.steps === 'number'
    ? source.steps
    : (typeof source.maxSteps === 'number' ? source.maxSteps : undefined);
  const disabled = typeof source.disabled === 'boolean'
    ? source.disabled
    : (typeof source.disable === 'boolean' ? source.disable : undefined);
  const permissions = source.permissions !== undefined
    ? normalizePermissionRules(source.permissions)
    : permissionMapToRules(source.permission);
  return pickDefined([
    ['system', system],
    ['description', typeof source.description === 'string' ? source.description : undefined],
    ['model', model],
    ['mode', ['primary', 'subagent', 'all'].includes(source.mode) ? source.mode : undefined],
    ['hidden', typeof source.hidden === 'boolean' ? source.hidden : undefined],
    ['color', toAgentColor(source.color)],
    ['steps', steps],
    ['disabled', disabled],
    ['request', normalizeRequest(source.request, source)],
    ['permissions', source.permissions !== undefined || source.permission !== undefined ? permissions : undefined],
  ]);
}

/** Native fields for persistence; `system` is the markdown body, not frontmatter. */
function fromAgentEntity(entity) {
  const canonical = toAgentEntity(entity);
  const { system, ...fields } = canonical;
  return { fields, system: typeof system === 'string' ? system : '' };
}

function isLegacyAgentFrontmatter(frontmatter) {
  if (!isRecord(frontmatter)) return false;
  return Object.keys(frontmatter).some((key) => key !== 'variant' && !AGENT_NATIVE_KEYS.has(key));
}

// v1 agent fields that no longer exist at the top level of a v2 entity.
const AGENT_REQUEST_BODY_FIELDS = ['temperature', 'top_p'];

function deleteRequestBodyField(entity, key) {
  if (!isRecord(entity.request) || !isRecord(entity.request.body)) return;
  delete entity.request.body[key];
  if (Object.keys(entity.request.body).length === 0) delete entity.request.body;
  if (Object.keys(entity.request).length === 0) delete entity.request;
}

function stripModelVariant(entity) {
  const parsed = parseModelSelection(entity.model);
  if (!parsed) return;
  const stripped = formatModelSelection({ providerID: parsed.providerID, modelID: parsed.modelID });
  if (stripped) entity.model = stripped;
}

function deleteAgentField(entity, field) {
  if (field === 'permission' || field === 'permissions') {
    delete entity.permissions;
    return;
  }
  if (field === 'variant') {
    stripModelVariant(entity);
    return;
  }
  if (AGENT_REQUEST_BODY_FIELDS.includes(field)) {
    deleteRequestBodyField(entity, field);
    return;
  }
  delete entity[field === 'prompt' ? 'system' : field];
}

/** Merge a partial update: `null` removes a field, `undefined` leaves it alone. */
function applyAgentUpdates(entity, updates) {
  const next = { ...entity };
  if (isRecord(next.request)) {
    const request = { ...next.request };
    if (isRecord(request.body)) request.body = { ...request.body };
    if (isRecord(request.headers)) request.headers = { ...request.headers };
    next.request = request;
  }
  for (const [field, value] of Object.entries(isRecord(updates) ? updates : {})) {
    if (field === 'scope' || value === undefined) continue;
    if (value === null) {
      deleteAgentField(next, field);
      continue;
    }
    if (field === 'permission' || field === 'permissions') {
      const rules = normalizePermissionRules(value);
      if (rules.length === 0) delete next.permissions;
      else next.permissions = rules;
      continue;
    }
    next[field === 'prompt' ? 'system' : field] = value;
  }
  return toAgentEntity(next);
}

// ============== COMMANDS (markdown half) ==============

function toCommandEntity(raw, body) {
  const source = isRecord(raw) ? raw : {};
  const template = typeof body === 'string' && body.length > 0
    ? body
    : (typeof source.template === 'string' ? source.template : undefined);
  const subagent = typeof source.subagent === 'boolean'
    ? source.subagent
    : (typeof source.subtask === 'boolean' ? source.subtask : undefined);
  return pickDefined([
    ['template', template],
    ['description', typeof source.description === 'string' ? source.description : undefined],
    ['agent', typeof source.agent === 'string' ? source.agent : undefined],
    ['model', formatModelSelection(isRecord(source.model) ? source.model : parseModelSelection(source.model, source.variant))],
    ['subagent', subagent],
  ]);
}

function fromCommandEntity(entity) {
  const canonical = toCommandEntity(entity);
  const { template, ...fields } = canonical;
  return { fields, template: typeof template === 'string' ? template : '' };
}

const COMMAND_NATIVE_KEYS = new Set(['template', 'description', 'agent', 'model', 'subagent']);

function isLegacyCommandFrontmatter(frontmatter) {
  if (!isRecord(frontmatter)) return false;
  return Object.keys(frontmatter).some((key) => !COMMAND_NATIVE_KEYS.has(key));
}

function applyCommandUpdates(entity, updates) {
  const next = { ...entity };
  for (const [field, value] of Object.entries(isRecord(updates) ? updates : {})) {
    if (field === 'scope' || value === undefined) continue;
    if (value === null) {
      if (field === 'variant') {
        stripModelVariant(next);
      } else {
        delete next[field === 'subtask' ? 'subagent' : field];
      }
      continue;
    }
    next[field === 'subtask' ? 'subagent' : field] = value;
  }
  return toCommandEntity(next);
}

// ============== MCP (mcp.json half) ==============

/** OMP's `mcpServers` name pattern (`mcp-schema.json`). */
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,100}$/;

function validateMcpName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('MCP server name is required');
  }
  if (!MCP_NAME_PATTERN.test(name)) {
    throw new Error('MCP server name must be 1-100 characters of letters, digits, dots, hyphens or underscores');
  }
}

function cleanStringMap(value) {
  if (!isRecord(value)) return undefined;
  const cleaned = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key && entry !== undefined && entry !== null) cleaned[key] = String(entry);
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

/** OMP `oauth` (camelCase) -> the OpenCode v2 `oauth` (snake_case) the UI reads. */
function ompOAuthToEntity(value) {
  if (value === false) return false;
  if (!isRecord(value)) return undefined;
  const oauth = pickDefined([
    ['client_id', trimmedString(value.clientId)],
    ['client_secret', trimmedString(value.clientSecret)],
    ['scope', trimmedString(value.scope)],
    ['callback_port', positiveInt(value.callbackPort)],
    ['redirect_uri', trimmedString(value.redirectUri)],
  ]);
  return Object.keys(oauth).length ? oauth : undefined;
}

/**
 * The OpenCode v2 `oauth` -> OMP's `oauth` (camelCase). `false` (an explicit
 * "no OAuth" the UI can send) has no OMP spelling, so the key is omitted.
 */
function entityOAuthToOmp(value) {
  if (!isRecord(value)) return undefined;
  const oauth = pickDefined([
    ['clientId', trimmedString(value.client_id)],
    ['clientSecret', trimmedString(value.client_secret)],
    ['scope', trimmedString(value.scope)],
    ['callbackPort', positiveInt(value.callback_port)],
    ['redirectUri', trimmedString(value.redirect_uri)],
  ]);
  return Object.keys(oauth).length ? oauth : undefined;
}

/**
 * Canonical MCP entity from an OMP `mcpServers[name]` entry. `type` collapses
 * OMP's `stdio`/`http`/`sse` onto the UI's `local`/`remote`; the single OMP
 * `timeout` maps to the entity's `execution` phase. `credentialId` and
 * `authenticated` report OMP's own OAuth state: the `auth.credentialId` the
 * entry points at, and whether that id still resolves in the agent database.
 */
function toMcpEntity(raw, { disabled, credentialIds } = {}) {
  const source = isRecord(raw) ? raw : {};
  const credentialId = trimmedString(source.auth?.credentialId);
  const remote = source.type === 'http' || source.type === 'sse' || (source.type === undefined && typeof source.url === 'string');
  const shared = pickDefined([
    ['disabled', typeof disabled === 'boolean' ? disabled : (source.enabled === false ? true : undefined)],
    ['timeout', positiveInt(source.timeout) === undefined ? undefined : { execution: positiveInt(source.timeout) }],
    ['credentialId', credentialId],
    ['authenticated', Boolean(credentialId) && credentialIds instanceof Set && credentialIds.has(credentialId)],
  ]);
  if (remote) {
    return pickDefined([
      ['type', 'remote'],
      ['url', trimmedString(source.url)],
      ['headers', cleanStringMap(source.headers)],
      ['oauth', ompOAuthToEntity(source.oauth)],
      ...Object.entries(shared),
    ]);
  }
  const command = typeof source.command === 'string' && source.command
    ? [source.command, ...(Array.isArray(source.args) ? source.args.map(String) : [])]
    : undefined;
  return pickDefined([
    ['type', 'local'],
    ['command', command],
    ['cwd', trimmedString(source.cwd)],
    ['environment', cleanStringMap(source.env)],
    ...Object.entries(shared),
  ]);
}

/** The OMP `mcpServers[name]` entry for a canonical MCP entity. */
function fromMcpEntity(entity) {
  const source = isRecord(entity) ? entity : {};
  const remote = source.type === 'remote';
  const disabled = typeof source.disabled === 'boolean' ? source.disabled : undefined;
  const timeout = positiveInt(source.timeout?.execution);
  const shared = pickDefined([
    ['enabled', disabled === undefined ? undefined : !disabled],
    ['timeout', timeout],
  ]);
  if (remote) {
    return pickDefined([
      ['type', 'http'],
      ['url', trimmedString(source.url)],
      ['headers', cleanStringMap(source.headers)],
      ['oauth', entityOAuthToOmp(source.oauth)],
      ...Object.entries(shared),
    ]);
  }
  const command = Array.isArray(source.command) ? source.command.map(String).filter((part) => part.length > 0) : [];
  return pickDefined([
    ['type', 'stdio'],
    ['command', command[0]],
    ['args', command.length > 1 ? command.slice(1) : undefined],
    ['cwd', trimmedString(source.cwd)],
    ['env', cleanStringMap(source.environment)],
    ...Object.entries(shared),
  ]);
}

/**
 * OMP's schema requires a command on a `stdio` server and a url on an `http`
 * one; an entry missing either is one OMP would refuse to load.
 */
function assertMcpEntryValid(name, entry) {
  if (entry.type === 'stdio' && !entry.command) {
    throw new Error(`MCP server "${name}" requires a command`);
  }
  if (entry.type === 'http' && !entry.url) {
    throw new Error(`MCP server "${name}" requires a url`);
  }
}

// ============== JSON FILES ==============

/** A missing file reads as null; an unparseable one throws so a writer refuses to clobber it. */
function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ============== ROUTE FACTORY ==============

export const registerConfigEntityRoutes = (app, dependencies = {}) => {
  const {
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
  } = dependencies;

  // The OMP agent directory (`~/.omp/agent`, or a profile's) that holds
  // `agents/`, `commands/`, `mcp.json` and the global `AGENTS.md`. Injectable
  // so a test can point the routes at a temp directory.
  const ompAgentDir = typeof dependencies.ompAgentDir === 'string' && dependencies.ompAgentDir
    ? path.resolve(dependencies.ompAgentDir)
    : OPENCODE_CONFIG_DIR;
  const agentsDir = path.join(ompAgentDir, 'agents');
  const commandsDir = path.join(ompAgentDir, 'commands');
  const agentsMdPath = path.join(ompAgentDir, 'AGENTS.md');
  const mcpUserPath = path.join(ompAgentDir, 'mcp.json');

  const projectDirPath = (directory, ...parts) => path.join(directory, OMP_PROJECT_DIR, ...parts);

  /**
   * The credential ids OMP's MCP OAuth rows resolve against, read lazily: a
   * listing whose servers claim no `auth.credentialId` has nothing to resolve,
   * so it never opens the agent database.
   */
  const resolveCredentialIds = (entries) => {
    const list = Array.isArray(entries) ? entries : [entries];
    const claimed = list.some((entry) =>
      isRecord(entry) && typeof entry.auth?.credentialId === 'string' && entry.auth.credentialId.trim().length > 0);
    if (!claimed) return null;
    return readCredentialIdsFromDb({ dbPath: resolveCredentialDbPath({ agentDir: ompAgentDir }) });
  };

  const respondUnsupported = (res, error) =>
    res.status(UNSUPPORTED_CONFIG_SECTION_STATUS).json({ error: error.message, code: error.code });

  const respondError = (res, error, fallback) => {
    if (isUnsupportedConfigSection(error)) return respondUnsupported(res, error);
    return res.status(500).json({ error: error?.message || fallback });
  };

  // ---- markdown path resolution ----

  /** An existing ancestor `.omp/agents/<name>.md` wins; otherwise the local path. */
  const getProjectAgentPath = (directory, name) => {
    const preferred = path.join(directory, OMP_PROJECT_DIR, 'agents', `${name}.md`);
    const worktreeRoot = findWorktreeRoot(directory) || path.resolve(directory);
    for (const base of getAncestors(directory, worktreeRoot)) {
      const candidate = path.join(base, OMP_PROJECT_DIR, 'agents', `${name}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return preferred;
  };

  const getProjectCommandPath = (directory, name) => {
    const preferred = path.join(directory, OMP_PROJECT_DIR, 'commands', `${name}.md`);
    const worktreeRoot = findWorktreeRoot(directory) || path.resolve(directory);
    for (const base of getAncestors(directory, worktreeRoot)) {
      const candidate = path.join(base, OMP_PROJECT_DIR, 'commands', `${name}.md`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return preferred;
  };

  const getUserMdPath = (dir, name) => path.join(dir, `${name}.md`);

  const resolveMdScope = (directory, name, { projectDir, userDir }) => {
    const projectCandidate = directory ? projectDir(directory, name) : null;
    const projectExists = Boolean(projectCandidate) && fs.existsSync(projectCandidate);
    const userCandidate = userDir(name);
    const userExists = fs.existsSync(userCandidate);
    return {
      projectPath: projectCandidate,
      projectExists,
      userPath: userCandidate,
      userExists,
      mdPath: projectExists ? projectCandidate : (userExists ? userCandidate : null),
      mdScope: projectExists ? 'project' : (userExists ? 'user' : null),
    };
  };

  // ---- shared entity route body ----

  /**
   * `kind` selects the conventions: markdown dirs, scope constants and entity
   * projections. Agents and commands share the whole envelope.
   */
  const createEntitySurface = ({ userDir, projectPathFor, scopeConstants, readMd, fromEntity, applyUpdates, label }) => {
    const getScope = (directory, name) => {
      const projectPath = directory ? projectPathFor(directory, name) : null;
      if (projectPath && fs.existsSync(projectPath)) return { scope: scopeConstants.PROJECT, path: projectPath };
      const userPath = getUserMdPath(userDir, name);
      if (fs.existsSync(userPath)) return { scope: scopeConstants.USER, path: userPath };
      return { scope: null, path: null };
    };

    const readJsonSource = (directory, name) => {
      const layers = readConfigLayers(directory);
      try {
        const source = getJsonEntrySource(layers, label.section, name);
        return {
          exists: Boolean(source.exists),
          path: source.path ?? null,
          scope: source.path === layers.paths.projectPath ? scopeConstants.PROJECT : scopeConstants.USER,
          sectionKey: source.sectionKey,
          legacy: Boolean(source.legacy),
          fields: [],
        };
      } catch (error) {
        if (!isUnsupportedConfigSection(error)) throw error;
        return { exists: false, unsupported: true, code: error.code, error: error.message };
      }
    };

    /** Canonical entity plus where it came from; no markdown means the JSON half, which OMP cannot serve. */
    const getConfig = (directory, name) => {
      const { scope, path: mdPath } = getScope(directory, name);
      if (mdPath) {
        const md = readMd(mdPath);
        return { source: 'md', scope, path: mdPath, legacy: md.legacy, config: md.entity };
      }
      // Throws the typed unsupported error: OMP has no JSON entity sections.
      getJsonEntrySource(readConfigLayers(directory), label.section, name);
      return { source: 'none', scope: null, path: null, legacy: false, config: {} };
    };

    const getSources = (directory, name) => {
      const { projectPath, projectExists, userPath, userExists, mdPath, mdScope } = resolveMdScope(directory, name, { projectDir: projectPathFor, userDir: (candidate) => getUserMdPath(userDir, candidate) });
      const sources = {
        md: { exists: Boolean(mdPath), path: mdPath, scope: mdScope, legacy: false, fields: [] },
        json: readJsonSource(directory, name),
        projectMd: { exists: projectExists, path: projectPath },
        userMd: { exists: userExists, path: userPath },
      };
      if (mdPath) {
        const md = readMd(mdPath);
        sources.md.legacy = md.legacy;
        sources.md.fields = Object.keys(md.entity);
      }
      return sources;
    };

    const writeEntityMd = (targetPath, entity) => {
      const { fields, body } = fromEntity(entity);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      writeMdFile(targetPath, fields, body);
    };

    const create = (directory, name, config, scope) => {
      const projectPath = directory ? projectPathFor(directory, name) : null;
      const userPath = getUserMdPath(userDir, name);
      if (projectPath && fs.existsSync(projectPath)) {
        throw new Error(`${label.noun} ${name} already exists as project-level .md file`);
      }
      if (fs.existsSync(userPath)) {
        throw new Error(`${label.noun} ${name} already exists as user-level .md file`);
      }
      const { scope: _ignoredScope, ...entity } = isRecord(config) ? config : {};
      let targetPath;
      let targetScope;
      if (scope === scopeConstants.PROJECT && directory) {
        targetPath = projectPath;
        targetScope = scopeConstants.PROJECT;
      } else {
        targetPath = userPath;
        targetScope = scopeConstants.USER;
      }
      writeEntityMd(targetPath, entity);
      return { scope: targetScope, path: targetPath };
    };

    const update = (directory, name, updates) => {
      const current = getConfig(directory, name);
      const entity = applyUpdates(current.config, updates);
      writeEntityMd(current.path, entity);
      return { source: 'md', scope: current.scope, path: current.path };
    };

    const remove = (directory, name, scope) => {
      const requestedScope = scope === scopeConstants.PROJECT || scope === scopeConstants.USER ? scope : null;
      if (!requestedScope || requestedScope === scopeConstants.PROJECT) {
        const projectPath = directory ? projectPathFor(directory, name) : null;
        if (projectPath && fs.existsSync(projectPath)) {
          fs.unlinkSync(projectPath);
          return;
        }
      }
      if (!requestedScope || requestedScope === scopeConstants.USER) {
        const userPath = getUserMdPath(userDir, name);
        if (fs.existsSync(userPath)) {
          fs.unlinkSync(userPath);
          return;
        }
      }
      // No markdown file: the remaining source would be a JSON entry OMP has
      // no home for, so the lookup surfaces the typed unsupported error.
      getJsonEntrySource(readConfigLayers(directory), label.section, name);
      throw new Error(`${label.noun} ${name} is built-in or not deletable`);
    };

    return { getConfig, getSources, create, update, remove };
  };

  const agentSurface = createEntitySurface({
    userDir: agentsDir,
    projectPathFor: getProjectAgentPath,
    scopeConstants: AGENT_SCOPE,
    readMd: (mdPath) => {
      const { frontmatter, body } = parseMdFile(mdPath);
      return { entity: toAgentEntity(frontmatter, body), legacy: isLegacyAgentFrontmatter(frontmatter) };
    },
    fromEntity: (entity) => {
      const { fields, system } = fromAgentEntity(entity);
      return { fields, body: system };
    },
    applyUpdates: applyAgentUpdates,
    label: { noun: 'Agent', section: 'agents' },
  });

  /**
   * Every agent markdown file OMP discovers for a directory: the user's agent
   * directory first, then the project's `.omp/agents`. OMP reads both, so this
   * is the set it will run, not a separate catalog. The per-name routes answer
   * each entry's sources and permissions.
   */
  const listAgentFiles = (directory) => {
    const scopes = [
      { scope: AGENT_SCOPE.USER, dir: agentsDir },
      { scope: AGENT_SCOPE.PROJECT, dir: path.join(directory, OMP_PROJECT_DIR, 'agents') },
    ];
    const agents = [];
    for (const { scope, dir } of scopes) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const filePath = path.join(dir, entry.name);
        let entity = {};
        try {
          const { frontmatter, body } = parseMdFile(filePath);
          entity = toAgentEntity(frontmatter, body);
        } catch {
          // An unreadable file is still an agent OMP would try to load: list it
          // by name rather than hiding it from the page that edits it.
          entity = {};
        }
        agents.push({
          name: entry.name.replace(/\.md$/, ''),
          description: typeof entity.description === 'string' ? entity.description : '',
          mode: typeof entity.mode === 'string' ? entity.mode : undefined,
          hidden: entity.hidden === true,
          scope,
          path: filePath,
        });
      }
    }
    return agents;
  };

  const commandSurface = createEntitySurface({
    userDir: commandsDir,
    projectPathFor: getProjectCommandPath,
    scopeConstants: COMMAND_SCOPE,
    readMd: (mdPath) => {
      const { frontmatter, body } = parseMdFile(mdPath);
      return { entity: toCommandEntity(frontmatter, body), legacy: isLegacyCommandFrontmatter(frontmatter) };
    },
    fromEntity: (entity) => {
      const { fields, template } = fromCommandEntity(entity);
      return { fields, body: template };
    },
    applyUpdates: applyCommandUpdates,
    label: { noun: 'Command', section: 'commands' },
  });

  const registerEntityRoutes = ({ surface, routeLabel, noun, registerPermissions }) => {
    app.get(`/api/config/${routeLabel}/:name`, async (req, res) => {
      try {
        const name = req.params.name;
        const { directory, error } = await resolveProjectDirectory(req);
        if (!directory) return res.status(400).json({ error });
        const sources = surface.getSources(directory, name);
        const scope = sources.md.exists ? sources.md.scope : (sources.json.exists ? sources.json.scope : null);
        res.json({ name, sources, scope, isBuiltIn: !sources.md.exists && !sources.json.exists });
      } catch (error) {
        respondError(res, error, `Failed to get ${noun.toLowerCase()} configuration metadata`);
      }
    });

    app.get(`/api/config/${routeLabel}/:name/config`, async (req, res) => {
      try {
        const { directory, error } = await resolveProjectDirectory(req);
        if (!directory) return res.status(400).json({ error });
        res.json(surface.getConfig(directory, req.params.name));
      } catch (error) {
        respondError(res, error, `Failed to get ${noun.toLowerCase()} configuration`);
      }
    });

    if (registerPermissions) {
      app.get(`/api/config/${routeLabel}/:name/permissions`, async (req, res) => {
        try {
          const { directory, error } = await resolveProjectDirectory(req);
          if (!directory) return res.status(400).json({ error });
          const config = surface.getConfig(directory, req.params.name);
          const layers = readConfigLayers(directory);
          const global = [
            ...readGlobalPermissionRules(layers.userConfig),
            ...readGlobalPermissionRules(layers.projectConfig),
            ...readGlobalPermissionRules(layers.customConfig),
          ];
          const agentRules = config.config.permissions ?? [];
          res.json({
            global,
            agent: agentRules,
            effective: effectiveAgentRules(global, agentRules),
            source: config.source,
            path: config.path,
          });
        } catch (error) {
          respondError(res, error, 'Failed to get agent permissions');
        }
      });
    }

    app.post(`/api/config/${routeLabel}/:name`, async (req, res) => {
      try {
        const name = req.params.name;
        const { scope, ...config } = req.body || {};
        const { directory, error } = await resolveProjectDirectory(req);
        if (!directory) return res.status(400).json({ error });
        const created = surface.create(directory, name, config, scope);
        res.json(buildAppliedResponse(`${noun} ${name} created successfully.`, created));
      } catch (error) {
        respondError(res, error, `Failed to create ${noun.toLowerCase()}`);
      }
    });

    app.patch(`/api/config/${routeLabel}/:name`, async (req, res) => {
      try {
        const name = req.params.name;
        const { directory, error } = await resolveProjectDirectory(req);
        if (!directory) return res.status(400).json({ error });
        const updated = surface.update(directory, name, req.body || {});
        res.json(buildAppliedResponse(`${noun} ${name} updated successfully.`, updated));
      } catch (error) {
        respondError(res, error, `Failed to update ${noun.toLowerCase()}`);
      }
    });

    app.delete(`/api/config/${routeLabel}/:name`, async (req, res) => {
      try {
        const name = req.params.name;
        const { directory, error } = await resolveProjectDirectory(req);
        if (!directory) return res.status(400).json({ error });
        surface.remove(directory, name, req.body?.scope);
        res.json(buildAppliedResponse(`${noun} ${name} deleted successfully.`));
      } catch (error) {
        respondError(res, error, `Failed to delete ${noun.toLowerCase()}`);
      }
    });
  };

  registerEntityRoutes({ surface: agentSurface, routeLabel: 'agents', noun: 'Agent', registerPermissions: true });

  /**
   * Every agent markdown file OMP discovers for a directory: the user's agent
   * directory first, then the project's `.omp/agents`. OMP reads both, so this
   * is the set it will run, not a separate catalog. The per-name routes above
   * answer each entry's sources and permissions.
   */
  app.get('/api/config/agents', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) return res.status(400).json({ error });
      res.json({ agents: listAgentFiles(directory) });
    } catch (error) {
      respondError(res, error, 'Failed to list agents');
    }
  });
  registerEntityRoutes({ surface: commandSurface, routeLabel: 'commands', noun: 'Command', registerPermissions: false });

  // ---- MCP ----

  const projectMcpPath = (directory) => projectDirPath(directory, 'mcp.json');

  /**
   * Writes the OMP user-level deny/force-enable lists so a disabled server
   * stays disabled (or an enabled one stops being hidden) the way OMP itself
   * toggles them.
   */
  const applyMcpDisabledLists = (userFile, name, disabled) => {
    if (typeof disabled !== 'boolean') return userFile;
    const next = { ...userFile };
    const disabledNames = new Set(next.disabledServers ?? []);
    const enabledNames = new Set(next.enabledServers ?? []);
    if (disabled) {
      disabledNames.add(name);
      enabledNames.delete(name);
    } else {
      disabledNames.delete(name);
      enabledNames.delete(name);
    }
    if (disabledNames.size > 0) next.disabledServers = [...disabledNames].sort();
    else delete next.disabledServers;
    if (enabledNames.size > 0) next.enabledServers = [...enabledNames].sort();
    else delete next.enabledServers;
    return next;
  };

  const mcpDisabledOf = (name, entry, userFile) => {
    if ((userFile.disabledServers ?? []).includes(name)) return true;
    if ((userFile.enabledServers ?? []).includes(name)) return false;
    if (entry.enabled === false) return true;
    if (entry.enabled === true) return false;
    return undefined;
  };

  /** The defining file of a server, user winning a name that exists in both. */
  const resolveMcpLocation = (directory, name, userFile, projectFile) => {
    if (isRecord(userFile.mcpServers) && Object.hasOwn(userFile.mcpServers, name)) {
      return { scope: 'user', entry: userFile.mcpServers[name], path: mcpUserPath };
    }
    if (isRecord(projectFile.mcpServers) && Object.hasOwn(projectFile.mcpServers, name)) {
      return { scope: 'project', entry: projectFile.mcpServers[name], path: projectMcpPath(directory) };
    }
    return null;
  };

  const listMcp = (directory) => {
    const userFile = readJsonFile(mcpUserPath) ?? {};
    const projectFile = directory ? (readJsonFile(projectMcpPath(directory)) ?? {}) : {};
    const userServers = userFile.mcpServers ?? {};
    const projectServers = projectFile.mcpServers ?? {};
    const names = [...new Set([...Object.keys(projectServers), ...Object.keys(userServers)])];
    const entries = names.map((name) => (Object.hasOwn(userServers, name) ? userServers[name] : projectServers[name]));
    // OMP keys an MCP server's OAuth credential by the `auth.credentialId` in
    // its `mcp.json`; the agent-dir database is where that id either resolves
    // or does not. The store is opened only when a server claims a credential,
    // so a listing without one never touches the database.
    const credentialIds = resolveCredentialIds(entries);
    return names.map((name, index) => {
      const inUser = Object.hasOwn(userServers, name);
      const entry = entries[index];
      return {
        name,
        ...toMcpEntity(entry, { disabled: mcpDisabledOf(name, entry, userFile), credentialIds }),
        scope: inUser ? 'user' : 'project',
        sectionKey: 'mcpServers',
        legacy: false,
      };
    });
  };

  const getMcp = (directory, name) => listMcp(directory).find((entry) => entry.name === name) ?? null;

  const createMcp = (directory, name, config, scope) => {
    validateMcpName(name);
    const userFile = readJsonFile(mcpUserPath) ?? {};
    const projectFile = directory ? (readJsonFile(projectMcpPath(directory)) ?? {}) : {};
    if (resolveMcpLocation(directory, name, userFile, projectFile)) {
      throw new Error(`MCP server "${name}" already exists`);
    }
    const { name: _ignoredName, scope: _ignoredScope, ...entity } = config || {};
    const targetScope = scope === 'project' ? 'project' : 'user';
    if (targetScope === 'project' && !directory) {
      throw new Error('Project scope requires a working directory');
    }
    const entry = fromMcpEntity(entity);
    assertMcpEntryValid(name, entry);
    if (targetScope === 'project') {
      const nextProject = { ...projectFile, mcpServers: { ...(projectFile.mcpServers ?? {}), [name]: entry } };
      writeJsonFile(projectMcpPath(directory), nextProject);
      const nextUser = applyMcpDisabledLists(userFile, name, entity.disabled);
      if (nextUser !== userFile) writeJsonFile(mcpUserPath, nextUser);
      return { path: projectMcpPath(directory) };
    }
    let nextUser = { ...userFile, mcpServers: { ...(userFile.mcpServers ?? {}), [name]: entry } };
    nextUser = applyMcpDisabledLists(nextUser, name, entity.disabled);
    writeJsonFile(mcpUserPath, nextUser);
    return { path: mcpUserPath };
  };

  const updateMcp = (directory, name, updates) => {
    const userFile = readJsonFile(mcpUserPath) ?? {};
    const projectFile = directory ? (readJsonFile(projectMcpPath(directory)) ?? {}) : {};
    const location = resolveMcpLocation(directory, name, userFile, projectFile);
    if (!location) {
      throw new Error(`MCP server "${name}" not found`);
    }
    const existing = toMcpEntity(location.entry, {
      disabled: mcpDisabledOf(name, location.entry, userFile),
      credentialIds: resolveCredentialIds([location.entry]),
    });
    const { name: _ignoredName, scope: _ignoredScope, ...updateData } = updates || {};
    const entity = { ...existing, ...updateData };
    const entry = fromMcpEntity(entity);
    assertMcpEntryValid(name, entry);
    if (location.scope === 'user') {
      let nextUser = { ...userFile, mcpServers: { ...userFile.mcpServers, [name]: entry } };
      nextUser = applyMcpDisabledLists(nextUser, name, entity.disabled);
      writeJsonFile(mcpUserPath, nextUser);
    } else {
      const nextProject = { ...projectFile, mcpServers: { ...projectFile.mcpServers, [name]: entry } };
      writeJsonFile(projectMcpPath(directory), nextProject);
      const nextUser = applyMcpDisabledLists(userFile, name, entity.disabled);
      if (nextUser !== userFile) writeJsonFile(mcpUserPath, nextUser);
    }
    return { path: location.path };
  };

  const deleteMcp = (directory, name) => {
    const userFile = readJsonFile(mcpUserPath) ?? {};
    const projectFile = directory ? (readJsonFile(projectMcpPath(directory)) ?? {}) : {};
    const location = resolveMcpLocation(directory, name, userFile, projectFile);
    if (!location) {
      throw new Error(`MCP server "${name}" not found`);
    }
    if (location.scope === 'user') {
      const { [name]: _removed, ...remaining } = userFile.mcpServers;
      let nextUser = { ...userFile };
      if (Object.keys(remaining).length > 0) nextUser.mcpServers = remaining;
      else delete nextUser.mcpServers;
      nextUser = applyMcpDisabledLists(nextUser, name, false);
      writeJsonFile(mcpUserPath, nextUser);
    } else {
      const { [name]: _removed, ...remaining } = projectFile.mcpServers;
      const nextProject = { ...projectFile };
      if (Object.keys(remaining).length > 0) nextProject.mcpServers = remaining;
      else delete nextProject.mcpServers;
      writeJsonFile(projectMcpPath(directory), nextProject);
      const nextUser = applyMcpDisabledLists(userFile, name, false);
      if (nextUser !== userFile) writeJsonFile(mcpUserPath, nextUser);
    }
    return { path: location.path };
  };

  // Persist to disk immediately; no restart is involved, so mutations report plain success.
  const completeMcpMutation = (res, action, name, applyChange) => {
    const result = applyChange();
    const past = action === 'delete' ? 'deleted' : `${action}d`;
    return res.json(buildAppliedResponse(`MCP server "${name}" ${past}.`, result));
  };

  app.get('/api/config/mcp', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      res.json(listMcp(directory));
    } catch (error) {
      respondError(res, error, 'Failed to list MCP configs');
    }
  });

  app.get('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      const config = getMcp(directory, name);
      if (!config) return res.status(404).json({ error: `MCP server "${name}" not found` });
      res.json(config);
    } catch (error) {
      respondError(res, error, 'Failed to get MCP config');
    }
  });

  app.post('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { scope, ...config } = req.body || {};
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      completeMcpMutation(res, 'create', name, () => createMcp(directory, name, config, scope));
    } catch (error) {
      respondError(res, error, 'Failed to create MCP server');
    }
  });

  app.patch('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      completeMcpMutation(res, 'update', name, () => updateMcp(directory, name, req.body || {}));
    } catch (error) {
      if (error?.message === `MCP server "${req.params.name}" not found`) {
        return res.status(404).json({ error: error.message });
      }
      respondError(res, error, 'Failed to update MCP server');
    }
  });

  app.delete('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) return res.status(400).json({ error });
      completeMcpMutation(res, 'delete', name, () => deleteMcp(directory, name));
    } catch (error) {
      respondError(res, error, 'Failed to delete MCP server');
    }
  });

  // ---- Global AGENTS.md ----

  const MAX_AGENTS_MD_BYTES = 1024 * 1024; // 1 MB

  app.get('/api/behavior/agents-md', async (_req, res) => {
    try {
      if (!fs.existsSync(agentsMdPath)) {
        return res.json({ content: '', exists: false, path: agentsMdPath });
      }
      const content = await fs.promises.readFile(agentsMdPath, 'utf8');
      return res.json({ content, exists: true, path: agentsMdPath });
    } catch (error) {
      console.error('Failed to read AGENTS.md:', error);
      return res.status(500).json({ error: 'Failed to read AGENTS.md' });
    }
  });

  app.put('/api/behavior/agents-md', async (req, res) => {
    try {
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

      if (content.length > MAX_AGENTS_MD_BYTES) {
        return res.status(413).json({ error: `Content exceeds maximum size of ${MAX_AGENTS_MD_BYTES} bytes` });
      }

      // `expectedContent` is what the editor loaded (null: no file). A file
      // changed on disk since then is not overwritten with the stale copy.
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'expectedContent')) {
        const expected = req.body.expectedContent;
        let current = null;
        try {
          current = await fs.promises.readFile(agentsMdPath, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (current !== expected) {
          return res.status(409).json({
            error: 'AGENTS.md changed on disk since it was loaded',
            code: 'AGENTS_MD_CONFLICT',
          });
        }
      }

      fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
      await fs.promises.writeFile(agentsMdPath, content, 'utf8');

      return res.json(buildAppliedResponse('AGENTS.md saved.'));
    } catch (error) {
      console.error('Failed to write AGENTS.md:', error);
      return res.status(500).json({ error: error.message || 'Failed to write AGENTS.md' });
    }
  });
};
