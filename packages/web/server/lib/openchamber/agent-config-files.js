import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'yaml';

/**
 * File layer for agents, commands, skills and snippets, resolved against OMP's
 * own on-disk layout instead of OpenCode's.
 *
 * OMP's layout (read from the installed runtime: `@oh-my-pi/pi-utils/dirs.ts`,
 * `@oh-my-pi/pi-coding-agent/config/settings.ts`, `discovery/*`):
 *
 *   config root   ~/.omp                     (PI_CONFIG_DIR renames the dir)
 *   agent dir     ~/.omp/agent               (PI_CODING_AGENT_DIR overrides it;
 *                                             a named OMP_PROFILE/PI_PROFILE moves it
 *                                             to ~/.omp/profiles/<name>/agent)
 *   agents        <agent dir>/agents/*.md    and <project>/.omp/agents/*.md
 *   commands      <agent dir>/commands/*.md  and <project>/.omp/commands/*.md
 *   skills        <agent dir>/skills/<n>/SKILL.md  and <project>/.omp/skills/<n>/SKILL.md
 *   settings      <agent dir>/config.yml     and <project>/.omp/config.yml   (YAML)
 *   providers     <agent dir>/models.yml     (providers.<id>.apiKey — YAML)
 *
 * OMP additionally *reads* OpenCode's own trees for compatibility
 * (`discovery/opencode.ts`: `~/.config/opencode`, `<project>/.opencode`) plus
 * Claude (`.claude`) and the agent dirs (`.agent`/`.agents`). Those are read
 * paths here; writes always target OMP's native directories.
 */

// ============== PATH CONSTANTS ==============

/** OMP's `PI_CONFIG_DIR` override, default `.omp` (relative to the home dir). */
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR?.trim() || '.omp';

/**
 * The active OMP profile, or null for the default profile. `OMP_PROFILE` wins
 * over the legacy `PI_PROFILE`; an empty value or the literal `default` selects
 * the default profile. A named profile pins the agent dir (OMP ignores
 * `PI_CODING_AGENT_DIR` while one is active).
 */
function resolveProfileName() {
  const raw = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
  const name = typeof raw === 'string' ? raw.trim() : '';
  return name === '' || name === 'default' ? null : name;
}

const PROFILE_NAME = resolveProfileName();

const HOME_CONFIG_ROOT = path.join(os.homedir(), CONFIG_DIR_NAME);

/**
 * OMP's agent/config directory. Kept under its historical export name because
 * the quota and skills-catalog consumers import `OPENCODE_CONFIG_DIR`.
 */
const OPENCODE_CONFIG_DIR = PROFILE_NAME
  ? path.join(HOME_CONFIG_ROOT, 'profiles', PROFILE_NAME, 'agent')
  : process.env.PI_CODING_AGENT_DIR?.trim()
    ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
    : path.join(HOME_CONFIG_ROOT, 'agent');

const AGENT_DIR = path.join(OPENCODE_CONFIG_DIR, 'agents');
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, 'commands');
const SKILL_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');
// OMP reads YAML settings only: `config.yml` is the canonical write target and
// `config.yaml` is accepted as a legacy fallback (`MAIN_CONFIG_FILENAMES`).
const CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'config.yml');
const CONFIG_FILE_FALLBACK = path.join(OPENCODE_CONFIG_DIR, 'config.yaml');
// Provider credentials/base URLs configured on disk live in `models.yml`.
const MODELS_FILE = path.join(OPENCODE_CONFIG_DIR, 'models.yml');
const PROMPT_FILE_PATTERN = /^\{file:(.+)\}$/i;

/** OpenCode's own config trees, which OMP still reads for compatibility. */
const OPENCODE_HOME_DIR = path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_PROJECT_DIR = '.opencode';
/** The `~/.omp` root (skills/agents under the agent dir live one level deeper). */
const OMP_HOME_ROOT = HOME_CONFIG_ROOT;
const OMP_PROJECT_DIR = '.omp';

// ============== SCOPE TYPE CONSTANTS ==============

const AGENT_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
};

const COMMAND_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
};

const SKILL_SCOPE = {
  USER: 'user',
  PROJECT: 'project'
};

// ============== DIRECTORY OPERATIONS ==============

function ensureDirs() {
  for (const dir of [OPENCODE_CONFIG_DIR, AGENT_DIR, COMMAND_DIR, SKILL_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ============== MARKDOWN FILE OPERATIONS ==============

// Mirror of the markdown frontmatter sanitizer other coding agents apply:
// unquoted colons in YAML values (e.g. `description: Build agent: creates
// builds`) are accepted there, which strict YAML rejects. Rewrite those values
// as block scalars and retry the parse, so files those agents accept are parsed
// identically here.
function sanitizeFrontmatter(frontmatter) {
  return frontmatter
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.trim().startsWith('#') || line.trim() === '' || /^\s+/.test(line)) return [line];
      const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (!entry) return [line];
      const value = entry[2].trim();
      if (value === '' || value === '>' || value === '|' || value.startsWith('"') || value.startsWith("'")) return [line];
      if (!value.includes(':')) return [line];
      return [`${entry[1]}: |-`, `  ${value}`];
    })
    .join('\n');
}

function parseMdFile(filePath) {
  const rawContent = fs.readFileSync(filePath, 'utf8');
  // Strip a UTF-8 BOM so frontmatter is recognized regardless of the editor
  // that saved the file.
  const content = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  // The closing `---` may sit at end-of-file without a trailing newline.
  // gray-matter (the parser OMP's markdown readers mirror) accepts that, so we
  // must too: otherwise the whole file is treated as the prompt body and a
  // later save rewrites the existing YAML block into the body, duplicating the
  // frontmatter.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }

  let frontmatter = {};
  try {
    frontmatter = yaml.parse(match[1]) || {};
  } catch (error) {
    // Lenient fallback for frontmatter that strict YAML rejects but other
    // agents still accept (unquoted colons in scalar values).
    try {
      frontmatter = yaml.parse(sanitizeFrontmatter(match[1])) || {};
    } catch {
      console.warn(`Failed to parse markdown frontmatter ${filePath}, treating as empty:`, error);
      frontmatter = {};
    }
  }

  const body = match[2].trim();
  return { frontmatter, body };
}

function writeMdFile(filePath, frontmatter, body) {
  try {
    const cleanedFrontmatter = Object.fromEntries(
      Object.entries(frontmatter).filter(([, value]) => value != null)
    );
    const yamlStr = yaml.stringify(cleanedFrontmatter);
    const content = `---\n${yamlStr}---\n\n${body}`;
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Successfully wrote markdown file: ${filePath}`);
  } catch (error) {
    console.error(`Failed to write markdown file ${filePath}:`, error);
    throw new Error('Failed to write agent markdown file');
  }
}

// ============== CONFIG FILE OPERATIONS ==============

/**
 * Project settings file. OMP merges `<project>/.omp/config.yml` on top of the
 * user settings and reads no second project file, so there is exactly one
 * candidate (and it is both the read and the write target).
 */
function getProjectConfigCandidates(workingDirectory) {
  if (!workingDirectory) return [];
  return [path.join(workingDirectory, OMP_PROJECT_DIR, 'config.yml')];
}

function getProjectConfigPath(workingDirectory) {
  if (!workingDirectory) return null;

  const candidates = getProjectConfigCandidates(workingDirectory);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

/**
 * `PI_CONFIG_FILES` lists extra settings files OMP merges as a config overlay;
 * later entries win, so the last existing one is the layer this module treats
 * as the highest-precedence custom layer.
 */
function resolveCustomConfigPath() {
  const entries = process.env.PI_CONFIG_FILES?.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (entries.length === 0) return null;
  const existing = entries.map((entry) => path.resolve(entry)).filter((entry) => fs.existsSync(entry));
  return existing.length > 0 ? existing[existing.length - 1] : null;
}

function getConfigPaths(workingDirectory) {
  return {
    userPaths: [CONFIG_FILE, CONFIG_FILE_FALLBACK],
    projectPath: getProjectConfigPath(workingDirectory),
    modelsPath: MODELS_FILE,
    // Resolve at call time so PI_CONFIG_FILES changes (and tests) take effect.
    customPath: resolveCustomConfigPath(),
  };
}

function getPrimaryUserConfigPath(userPaths) {
  for (const userPath of userPaths) {
    if (fs.existsSync(userPath)) {
      return userPath;
    }
  }

  return CONFIG_FILE;
}

const INVALID_CONFIG = 'INVALID_CONFIG';

function isInvalidConfigError(error) {
  return Boolean(error && typeof error === 'object' && error.code === INVALID_CONFIG);
}

function formatConfigParseError(filePath, detail) {
  return `OMP configuration at ${filePath} contains invalid YAML and cannot be loaded safely${detail ? ` (${detail})` : ''}`;
}

function parseConfigObject(content, filePath) {
  let parsed;
  try {
    parsed = yaml.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    const invalid = new Error(formatConfigParseError(filePath, detail));
    invalid.code = INVALID_CONFIG;
    throw invalid;
  }
  // A settings file that is empty or holds only comments parses to null.
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    const invalid = new Error(formatConfigParseError(filePath, 'the document root is not a mapping'));
    invalid.code = INVALID_CONFIG;
    throw invalid;
  }
  return parsed;
}

function readConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const normalized = content.trim();
    if (!normalized) {
      return {};
    }
    // Refuse a document we cannot fully parse. Ignoring a parse failure
    // previously let mutations rewrite a truncated object over the full config.
    return parseConfigObject(normalized, filePath);
  } catch (error) {
    if (isInvalidConfigError(error)) {
      throw error;
    }
    console.error(`Failed to read config file: ${filePath}`, error);
    throw new Error('Failed to read OMP configuration');
  }
}

/**
 * `models.yml` holds the provider credentials OMP resolves from disk
 * (`providers.<id>.apiKey`). Project it into the `provider.<id>.options` view
 * the config readers expose, so a provider apiKey configured for OMP is found
 * through the same call shape OpenCode's `provider.<id>.options.apiKey` used.
 */
function projectModelsConfig(modelsConfig) {
  const providers = isPlainObject(modelsConfig?.providers) ? modelsConfig.providers : null;
  if (!providers) {
    return {};
  }

  const provider = {};
  for (const [id, entry] of Object.entries(providers)) {
    if (!isPlainObject(entry)) continue;
    provider[id] = {
      options: {
        apiKey: entry.apiKey,
        baseURL: entry.baseUrl,
        headers: entry.headers,
      },
    };
  }
  return { provider };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfigs(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key in result) {
      const baseValue = result[key];
      if (isPlainObject(baseValue) && isPlainObject(value)) {
        result[key] = mergeConfigs(baseValue, value);
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readConfigLayer(filePath) {
  try {
    return { config: readConfigFile(filePath), error: null };
  } catch (error) {
    if (isInvalidConfigError(error)) {
      console.error(error.message);
      return { config: {}, error };
    }
    throw error;
  }
}

function readConfigLayers(workingDirectory) {
  const { userPaths, projectPath, modelsPath, customPath } = getConfigPaths(workingDirectory);
  const userPath = getPrimaryUserConfigPath(userPaths);
  // OMP loads `config.yaml` only as the fallback for a missing `config.yml`,
  // so the other file, when present, is the override layer.
  const userOverridePath = userPaths.find((candidate) => candidate !== userPath && fs.existsSync(candidate)) ?? null;
  const modelsLayer = readConfigLayer(modelsPath);
  const modelsConfig = projectModelsConfig(modelsLayer.config);
  const userLayer = readConfigLayer(userPath);
  const userOverrideLayer = readConfigLayer(userOverridePath);
  const projectLayer = readConfigLayer(projectPath);
  const customLayer = readConfigLayer(customPath);
  const mergedConfig = mergeConfigs(
    mergeConfigs(
      mergeConfigs(mergeConfigs(modelsConfig, userLayer.config), userOverrideLayer.config),
      projectLayer.config,
    ),
    customLayer.config,
  );

  const layerErrors = [];
  const pushError = (error, filePath) => {
    if (error && filePath) {
      layerErrors.push({ path: filePath, code: error.code, message: error.message });
    }
  };
  pushError(modelsLayer.error, modelsPath);
  pushError(userLayer.error, userPath);
  pushError(userOverrideLayer.error, userOverridePath);
  pushError(projectLayer.error, projectPath);
  pushError(customLayer.error, customPath);

  return {
    modelsConfig,
    userConfig: userLayer.config,
    userOverrideConfig: userOverrideLayer.config,
    projectConfig: projectLayer.config,
    customConfig: customLayer.config,
    mergedConfig,
    paths: { modelsPath, userPath, userOverridePath, projectPath, customPath },
    layerErrors,
  };
}

function readConfig(workingDirectory) {
  return readConfigLayers(workingDirectory).mergedConfig;
}

function getConfigForPath(layers, targetPath) {
  if (!targetPath) {
    return layers.userConfig;
  }
  if (layers.paths.modelsPath && targetPath === layers.paths.modelsPath) {
    return layers.modelsConfig;
  }
  if (layers.paths.customPath && targetPath === layers.paths.customPath) {
    return layers.customConfig;
  }
  if (layers.paths.projectPath && targetPath === layers.paths.projectPath) {
    return layers.projectConfig;
  }
  return layers.userConfig;
}

/**
 * Write an OMP settings file. OMP itself serializes settings with Bun's YAML
 * printer; the `yaml` printer used here produces the equivalent document shape.
 */
function writeConfig(config, filePath = CONFIG_FILE) {
  try {
    if (fs.existsSync(filePath)) {
      // Defense in depth: never overwrite a file we cannot fully parse.
      const existing = fs.readFileSync(filePath, 'utf8').trim();
      if (existing) {
        parseConfigObject(existing, filePath);
      }

      const backupFile = `${filePath}.openchamber.backup`;
      fs.copyFileSync(filePath, backupFile);
      console.log(`Created config backup: ${backupFile}`);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, yaml.stringify(config, { indent: 2 }), 'utf8');
    console.log(`Successfully wrote config file: ${filePath}`);
  } catch (error) {
    if (isInvalidConfigError(error)) {
      throw error;
    }
    console.error(`Failed to write config file: ${filePath}`, error);
    throw new Error('Failed to write OMP configuration');
  }
}

function getLayerError(layers, filePath) {
  if (!filePath || !Array.isArray(layers?.layerErrors)) {
    return null;
  }
  return layers.layerErrors.find((entry) => entry.path === filePath) || null;
}

function throwIfLayerError(layers, filePath) {
  const failed = getLayerError(layers, filePath);
  if (!failed) {
    return;
  }
  const error = new Error(failed.message);
  error.code = failed.code;
  throw error;
}

// OMP keeps agents, commands and MCP servers as files on disk (`agents/*.md`,
// `commands/*.md`, `mcp.json`) and provider records in `models.yml`; its
// `config.yml` has no per-entity sections, so there is no config entry to look
// up, edit in place or write to.
const NO_CONFIG_SECTIONS =
  'OMP has no agents/commands/providers/mcp sections in config.yml: agents and commands are markdown files '
  + '(agents/ and commands/ under its config directory) and MCP servers live in mcp.json files.';

function unsupportedConfigSection(operation) {
  const error = new Error(`${operation} is not available: ${NO_CONFIG_SECTIONS}`);
  error.code = 'OMP_UNSUPPORTED_CONFIG_SECTION';
  return error;
}

function lookupSectionEntry(_config, _sectionKind, _entryName) {
  throw unsupportedConfigSection('Config section lookup');
}

function getJsonEntrySource(_layers, _sectionKind, _entryName) {
  throw unsupportedConfigSection('Config entry source lookup');
}

function getJsonWriteTarget(_layers, _preferredScope) {
  throw unsupportedConfigSection('Config entry write-target lookup');
}

// ============== GIT/WORKTREE HELPERS ==============

function getAncestors(startDir, stopDir) {
  if (!startDir) return [];
  const result = [];
  let current = path.resolve(startDir);
  const resolvedStop = stopDir ? path.resolve(stopDir) : null;

  while (true) {
    result.push(current);
    if (resolvedStop && current === resolvedStop) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return result;
}

function findWorktreeRoot(startDir) {
  if (!startDir) return null;
  let current = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

// ============== PROMPT FILE HELPERS ==============

function isPromptFileReference(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return PROMPT_FILE_PATTERN.test(value.trim());
}

function resolvePromptFilePath(reference) {
  const match = typeof reference === 'string' ? reference.trim().match(PROMPT_FILE_PATTERN) : null;
  if (!match) {
    return null;
  }
  let target = match[1].trim();
  if (!target) {
    return null;
  }

  if (target.startsWith('./')) {
    target = target.slice(2);
    target = path.join(OPENCODE_CONFIG_DIR, target);
  } else if (!path.isAbsolute(target)) {
    target = path.join(OPENCODE_CONFIG_DIR, target);
  }

  return target;
}

function writePromptFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content ?? '', 'utf8');
  console.log(`Updated prompt file: ${filePath}`);
}

// ============== SKILL FILE OPERATIONS ==============

function walkSkillMdFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const results = [];
  // Real paths of the directories on the current walk path. Links (symlinks and
  // Windows junctions) are followed at any depth; a link back to one of its own
  // ancestors is skipped instead of recursing forever. Two links to the same
  // target elsewhere in the tree are both walked, as the top level always did.
  const ancestors = new Set();
  const walk = (dir) => {
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (ancestors.has(realDir)) return;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    ancestors.add(realDir);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Junctions report as links, not directories. A link whose target cannot be
      // stat'ed is skipped, the way an unreadable directory is, instead of failing
      // the whole scan.
      let isDirectoryEntry = entry.isDirectory();
      let isFileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(fullPath);
          isDirectoryEntry = target.isDirectory();
          isFileEntry = target.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectoryEntry) {
        walk(fullPath);
        continue;
      }
      if (isFileEntry && entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
    ancestors.delete(realDir);
  };

  walk(rootDir);
  return results;
}

function addSkillFromMdFile(skillsMap, skillMdPath, scope, source) {
  let parsed;
  try {
    parsed = parseMdFile(skillMdPath);
  } catch {
    return;
  }

  const name = typeof parsed.frontmatter?.name === 'string'
    ? parsed.frontmatter.name.trim()
    : '';
  const description = typeof parsed.frontmatter?.description === 'string'
    ? parsed.frontmatter.description
    : '';

  if (!name) {
    return;
  }

  skillsMap.set(name, {
    name,
    path: skillMdPath,
    scope,
    source,
    description,
  });
}

/**
 * Config roots whose `skills/` directory OMP scans for `SKILL.md` files. The
 * caller walks `<root>/skills` recursively, so these are roots, not skill dirs.
 * Every root listed here is one OMP itself reads (`builtin.ts` for `.omp`,
 * `discovery/agents.ts` for `.agent`/`.agents`, `discovery/claude.ts` for
 * `.claude`, `discovery/opencode.ts` for `.config/opencode` and `.opencode`).
 */
function resolveSkillSearchDirectories(workingDirectory) {
  const directories = [];
  const pushDir = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!directories.includes(resolved)) {
      directories.push(resolved);
    }
  };

  pushDir(OPENCODE_CONFIG_DIR);
  pushDir(path.join(os.homedir(), '.agent'));
  pushDir(path.join(os.homedir(), '.agents'));
  pushDir(path.join(os.homedir(), '.claude'));
  pushDir(OPENCODE_HOME_DIR);

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    for (const dir of getAncestors(workingDirectory, worktreeRoot)) {
      pushDir(path.join(dir, OMP_PROJECT_DIR));
      pushDir(path.join(dir, '.agent'));
      pushDir(path.join(dir, '.agents'));
      pushDir(path.join(dir, '.claude'));
      pushDir(path.join(dir, OPENCODE_PROJECT_DIR));
    }
  }

  return directories;
}

function listSkillSupportingFiles(skillDir) {
  if (!fs.existsSync(skillDir)) {
    return [];
  }

  const files = [];

  function walkDir(dir, relativePath = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (entry.name !== 'SKILL.md') {
        files.push({
          name: entry.name,
          path: relPath,
          fullPath: fullPath
        });
      }
    }
  }

  walkDir(skillDir);
  return files;
}

function assertPathWithinSkillDir(skillDir, relativePath) {
  const root = fs.realpathSync(skillDir);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  const isWithin = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

  if (!isWithin) {
    const error = new Error('Access to file denied');
    error.code = 'EACCES';
    throw error;
  }

  return target;
}

function readSkillSupportingFile(skillDir, relativePath) {
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return fs.readFileSync(fullPath, 'utf8');
}

function writeSkillSupportingFile(skillDir, relativePath, content) {
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function deleteSkillSupportingFile(skillDir, relativePath) {
  const root = fs.realpathSync(skillDir);
  const fullPath = assertPathWithinSkillDir(skillDir, relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
    let parentDir = path.dirname(fullPath);
    while (parentDir !== root) {
      try {
        const entries = fs.readdirSync(parentDir);
        if (entries.length === 0) {
          fs.rmdirSync(parentDir);
          parentDir = path.dirname(parentDir);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }
}

export {
  OPENCODE_CONFIG_DIR,
  AGENT_DIR,
  COMMAND_DIR,
  SKILL_DIR,
  CONFIG_FILE,
  MODELS_FILE,
  OMP_HOME_ROOT,
  OMP_PROJECT_DIR,
  OPENCODE_HOME_DIR,
  OPENCODE_PROJECT_DIR,
  AGENT_SCOPE,
  COMMAND_SCOPE,
  SKILL_SCOPE,
  ensureDirs,
  parseMdFile,
  writeMdFile,
  readConfigFile,
  readConfigLayer,
  isPlainObject,
  readConfigLayers,
  readConfig,
  getConfigForPath,
  writeConfig,
  lookupSectionEntry,
  getJsonEntrySource,
  getJsonWriteTarget,
  getAncestors,
  findWorktreeRoot,
  isPromptFileReference,
  resolvePromptFilePath,
  writePromptFile,
  walkSkillMdFiles,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
};
