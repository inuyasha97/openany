import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SKILL_DIR,
  OPENCODE_CONFIG_DIR,
  OPENCODE_HOME_DIR,
  OMP_PROJECT_DIR,
  OPENCODE_PROJECT_DIR,
  SKILL_SCOPE,
  ensureDirs,
  parseMdFile,
  writeMdFile,
  readConfig,
  walkSkillMdFiles,
  addSkillFromMdFile,
  resolveSkillSearchDirectories,
  listSkillSupportingFiles,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
  getAncestors,
  findWorktreeRoot,
} from './agent-config-files.js';

/**
 * Skill discovery and editing against OMP's skill layout.
 *
 * OMP loads skills from (verified in the installed runtime: `discovery/builtin.ts`,
 * `discovery/agents.ts`, `discovery/claude.ts`, `discovery/opencode.ts`,
 * `extensibility/skills.ts`):
 *
 *   native user     ~/.omp/agent/skills/<name>/SKILL.md
 *   native project  <ancestor>/.omp/skills/<name>/SKILL.md   (walk up to the repo root)
 *   agent dirs      ~/.agent/skills, ~/.agents/skills, and the project-level pair
 *   claude          ~/.claude/skills, <ancestor>/.claude/skills
 *   opencode        ~/.config/opencode/skills, <ancestor>/.opencode/skills
 *
 * Writes target the native `.omp` directories; the compatibility trees stay
 * editable in place, which is what makes an existing skill loadable and
 * manageable in the same place.
 */

const BUILT_IN_SKILL_LOCATION = '<built-in>';

/** Skill roots that belong to the user scope, not to a project. */
function getUserSkillRoots() {
  return [
    path.resolve(OPENCODE_CONFIG_DIR),
    path.resolve(path.join(os.homedir(), '.agent')),
    path.resolve(path.join(os.homedir(), '.agents')),
    path.resolve(path.join(os.homedir(), '.claude')),
    path.resolve(OPENCODE_HOME_DIR),
  ];
}

function ensureProjectSkillDir(workingDirectory) {
  const projectSkillDir = path.join(workingDirectory, OMP_PROJECT_DIR, 'skills');
  if (!fs.existsSync(projectSkillDir)) {
    fs.mkdirSync(projectSkillDir, { recursive: true });
  }
  return projectSkillDir;
}

function getProjectSkillDir(workingDirectory, skillName) {
  return path.join(workingDirectory, OMP_PROJECT_DIR, 'skills', skillName);
}

function getProjectSkillPath(workingDirectory, skillName) {
  return path.join(getProjectSkillDir(workingDirectory, skillName), 'SKILL.md');
}

function getUserSkillDir(skillName) {
  return path.join(SKILL_DIR, skillName);
}

function getUserSkillPath(skillName) {
  return path.join(getUserSkillDir(skillName), 'SKILL.md');
}

function getClaudeSkillDir(workingDirectory, skillName) {
  return path.join(workingDirectory, '.claude', 'skills', skillName);
}

function getClaudeSkillPath(workingDirectory, skillName) {
  return path.join(getClaudeSkillDir(workingDirectory, skillName), 'SKILL.md');
}

function getUserClaudeSkillDir(skillName) {
  return path.join(os.homedir(), '.claude', 'skills', skillName);
}

function getUserClaudeSkillPath(skillName) {
  return path.join(getUserClaudeSkillDir(skillName), 'SKILL.md');
}

function getUserAgentsSkillDir(skillName) {
  return path.join(os.homedir(), '.agents', 'skills', skillName);
}

function getUserAgentsSkillPath(skillName) {
  return path.join(getUserAgentsSkillDir(skillName), 'SKILL.md');
}

function getProjectAgentsSkillDir(workingDirectory, skillName) {
  return path.join(workingDirectory, '.agents', 'skills', skillName);
}

function getProjectAgentsSkillPath(workingDirectory, skillName) {
  return path.join(getProjectAgentsSkillDir(workingDirectory, skillName), 'SKILL.md');
}

/** The OpenCode-compat locations OMP still loads skills from. */
function getProjectOpencodeSkillDir(workingDirectory, skillName) {
  return path.join(workingDirectory, OPENCODE_PROJECT_DIR, 'skills', skillName);
}

function getUserOpencodeSkillDir(skillName) {
  return path.join(OPENCODE_HOME_DIR, 'skills', skillName);
}

function getSkillScope(skillName, workingDirectory) {
  const discovered = discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  if (discovered?.path) {
    return { scope: discovered.scope || null, path: discovered.path, source: discovered.source || null };
  }

  if (workingDirectory) {
    const projectPath = getProjectSkillPath(workingDirectory, skillName);
    if (fs.existsSync(projectPath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: projectPath, source: 'opencode' };
    }

    const claudePath = getClaudeSkillPath(workingDirectory, skillName);
    if (fs.existsSync(claudePath)) {
      return { scope: SKILL_SCOPE.PROJECT, path: claudePath, source: 'claude' };
    }
  }

  const userPath = getUserSkillPath(skillName);
  if (fs.existsSync(userPath)) {
    return { scope: SKILL_SCOPE.USER, path: userPath, source: 'opencode' };
  }

  const userClaudePath = getUserClaudeSkillPath(skillName);
  if (fs.existsSync(userClaudePath)) {
    return { scope: SKILL_SCOPE.USER, path: userClaudePath, source: 'claude' };
  }

  const userAgentsPath = getUserAgentsSkillPath(skillName);
  if (fs.existsSync(userAgentsPath)) {
    return { scope: SKILL_SCOPE.USER, path: userAgentsPath, source: 'agents' };
  }

  return { scope: null, path: null, source: null };
}

function getSkillWritePath(skillName, workingDirectory, requestedScope) {
  const existing = getSkillScope(skillName, workingDirectory);
  if (existing.path) {
    return existing;
  }

  const scope = requestedScope || SKILL_SCOPE.USER;
  if (scope === SKILL_SCOPE.PROJECT && workingDirectory) {
    return {
      scope: SKILL_SCOPE.PROJECT,
      path: getProjectSkillPath(workingDirectory, skillName),
      source: 'opencode'
    };
  }

  return {
    scope: SKILL_SCOPE.USER,
    path: getUserSkillPath(skillName),
    source: 'opencode'
  };
}

/** Source label for a search root, matching the tree it belongs to. */
function getSkillSourceForRoot(root) {
  const base = path.basename(root);
  if (base === '.claude') return 'claude';
  if (base === '.agent' || base === '.agents') return 'agents';
  return 'opencode';
}

function discoverSkills(workingDirectory) {
  const skills = new Map();
  const add = (root, scope, source) => {
    for (const skillMdPath of walkSkillMdFiles(root)) {
      addSkillFromMdFile(skills, skillMdPath, scope, source);
    }
  };

  const userSkillRoots = getUserSkillRoots();
  for (const dir of resolveSkillSearchDirectories(workingDirectory)) {
    const isUserConfigDir = userSkillRoots.includes(dir);
    add(
      path.join(dir, 'skills'),
      isUserConfigDir ? SKILL_SCOPE.USER : SKILL_SCOPE.PROJECT,
      getSkillSourceForRoot(dir),
    );
  }

  let configuredPaths = [];
  try {
    // OMP keeps extra skill sources in the `skills.customDirectories` setting.
    const config = readConfig(workingDirectory);
    configuredPaths = Array.isArray(config?.skills?.customDirectories) ? config.skills.customDirectories : [];
  } catch {
    configuredPaths = [];
  }
  for (const skillPath of configuredPaths) {
    if (typeof skillPath !== 'string' || !skillPath.trim()) continue;
    if (/^https?:\/\//i.test(skillPath.trim())) continue;
    const expanded = skillPath.startsWith('~/')
      ? path.join(os.homedir(), skillPath.slice(2))
      : skillPath;
    const resolved = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(workingDirectory || process.cwd(), expanded);
    add(resolved, SKILL_SCOPE.PROJECT, 'opencode');
  }

  return Array.from(skills.values());
}

function mergeDiscoveredSkills(primarySkills = [], fallbackSkills = []) {
  const merged = [];
  const seenNames = new Set();

  const appendSkill = (skill) => {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name || seenNames.has(name)) {
      return;
    }
    seenNames.add(name);
    merged.push(skill);
  };

  for (const skill of primarySkills || []) {
    appendSkill(skill);
  }
  for (const skill of fallbackSkills || []) {
    appendSkill(skill);
  }

  return merged;
}

function getSkillSources(skillName, workingDirectory, discoveredSkill = null) {
  const isReadableFile = (filePath) => {
    if (!filePath) return false;
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  };

  const projectPath = workingDirectory ? getProjectSkillPath(workingDirectory, skillName) : null;
  const projectExists = projectPath && fs.existsSync(projectPath);
  const projectDir = projectExists ? path.dirname(projectPath) : null;

  const claudePath = workingDirectory ? getClaudeSkillPath(workingDirectory, skillName) : null;
  const claudeExists = claudePath && fs.existsSync(claudePath);
  const claudeDir = claudeExists ? path.dirname(claudePath) : null;
  const userClaudePath = getUserClaudeSkillPath(skillName);
  const userClaudeExists = fs.existsSync(userClaudePath);
  const userClaudeDir = userClaudeExists ? path.dirname(userClaudePath) : null;

  const userPath = getUserSkillPath(skillName);
  const userExists = fs.existsSync(userPath);
  const userDir = userExists ? path.dirname(userPath) : null;

  const userAgentsPath = getUserAgentsSkillPath(skillName);
  const userAgentsExists = fs.existsSync(userAgentsPath);
  const userAgentsDir = userAgentsExists ? path.dirname(userAgentsPath) : null;

  const matchedDiscovered = discoveredSkill && discoveredSkill.name === skillName
    ? discoveredSkill
    : discoverSkills(workingDirectory).find((skill) => skill.name === skillName);
  const discoveredDescription =
    matchedDiscovered && typeof matchedDiscovered.description === 'string'
      ? matchedDiscovered.description
      : '';
  const discoveredContent =
    matchedDiscovered && typeof matchedDiscovered.content === 'string'
      ? matchedDiscovered.content
      : '';
  const discoveredPath =
    matchedDiscovered && typeof matchedDiscovered.path === 'string'
      ? matchedDiscovered.path
      : null;
  const isBuiltInDiscovered = discoveredPath === BUILT_IN_SKILL_LOCATION;

  let mdPath = null;
  let mdScope = null;
  let mdSource = null;
  let mdDir = null;

  if (isBuiltInDiscovered) {
    mdScope = matchedDiscovered.scope || SKILL_SCOPE.USER;
    mdSource = matchedDiscovered.source || 'opencode';
  } else if (discoveredPath) {
    mdPath = discoveredPath;
    mdScope = matchedDiscovered.scope || null;
    mdSource = matchedDiscovered.source || null;
    mdDir = isReadableFile(discoveredPath) ? path.dirname(discoveredPath) : null;
  } else if (projectExists) {
    mdPath = projectPath;
    mdScope = SKILL_SCOPE.PROJECT;
    mdSource = 'opencode';
    mdDir = projectDir;
  } else if (claudeExists) {
    mdPath = claudePath;
    mdScope = SKILL_SCOPE.PROJECT;
    mdSource = 'claude';
    mdDir = claudeDir;
  } else if (userExists) {
    mdPath = userPath;
    mdScope = SKILL_SCOPE.USER;
    mdSource = 'opencode';
    mdDir = userDir;
  } else if (userClaudeExists) {
    mdPath = userClaudePath;
    mdScope = SKILL_SCOPE.USER;
    mdSource = 'claude';
    mdDir = userClaudeDir;
  } else if (userAgentsExists) {
    mdPath = userAgentsPath;
    mdScope = SKILL_SCOPE.USER;
    mdSource = 'agents';
    mdDir = userAgentsDir;
  }

  const mdExists = isBuiltInDiscovered || isReadableFile(mdPath);
  if (!mdExists) {
    mdPath = null;
    mdDir = null;
    mdScope = null;
    mdSource = null;
  }

  const sources = {
    md: {
      exists: mdExists,
      path: mdPath,
      dir: mdDir,
      scope: mdScope,
      source: mdSource,
      fields: isBuiltInDiscovered ? ['description', 'instructions'] : [],
      supportingFiles: [],
      name: matchedDiscovered?.name || skillName,
      description: discoveredDescription,
      instructions: isBuiltInDiscovered ? discoveredContent : ''
    },
    projectMd: {
      exists: projectExists,
      path: projectPath,
      dir: projectDir
    },
    claudeMd: {
      exists: claudeExists,
      path: claudePath,
      dir: claudeDir
    },
    userMd: {
      exists: userExists,
      path: userPath,
      dir: userDir
    },
    userClaudeMd: {
      exists: userClaudeExists,
      path: userClaudePath,
      dir: userClaudeDir
    },
    userAgentsMd: {
      exists: userAgentsExists,
      path: userAgentsPath,
      dir: userAgentsDir
    }
  };

  if (mdExists && mdDir) {
    const { frontmatter, body } = parseMdFile(mdPath);
    sources.md.fields = Object.keys(frontmatter);
    sources.md.description = frontmatter.description || '';
    sources.md.name = frontmatter.name || skillName;
    if (body) {
      sources.md.fields.push('instructions');
      sources.md.instructions = body;
    } else {
      sources.md.instructions = '';
    }
    sources.md.supportingFiles = listSkillSupportingFiles(mdDir);
  }

  return sources;
}

function isValidSkillName(skillName) {
  return typeof skillName === 'string'
    && skillName.length > 0
    && skillName.length <= 64
    && /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(skillName);
}

function assertValidSkillName(skillName) {
  if (!isValidSkillName(skillName)) {
    throw new Error(`Invalid skill name "${skillName}". Must be 1-64 lowercase alphanumeric characters with hyphens, cannot start or end with hyphen.`);
  }
}

function createSkill(skillName, config, workingDirectory, scope) {
  ensureDirs();
  assertValidSkillName(skillName);

  const existing = getSkillScope(skillName, workingDirectory);
  if (existing.path) {
    throw new Error(`Skill ${skillName} already exists at ${existing.path}`);
  }

  let targetDir;
  let targetPath;
  let targetScope;

  const requestedScope = scope === SKILL_SCOPE.PROJECT ? SKILL_SCOPE.PROJECT : SKILL_SCOPE.USER;
  const requestedSource = config?.source === 'agents' ? 'agents' : 'opencode';

  if (requestedScope === SKILL_SCOPE.PROJECT && workingDirectory) {
    ensureProjectSkillDir(workingDirectory);
    if (requestedSource === 'agents') {
      targetDir = getProjectAgentsSkillDir(workingDirectory, skillName);
      targetPath = getProjectAgentsSkillPath(workingDirectory, skillName);
    } else {
      targetDir = getProjectSkillDir(workingDirectory, skillName);
      targetPath = getProjectSkillPath(workingDirectory, skillName);
    }
    targetScope = SKILL_SCOPE.PROJECT;
  } else {
    if (requestedSource === 'agents') {
      targetDir = getUserAgentsSkillDir(skillName);
      targetPath = getUserAgentsSkillPath(skillName);
    } else {
      targetDir = getUserSkillDir(skillName);
      targetPath = getUserSkillPath(skillName);
    }
    targetScope = SKILL_SCOPE.USER;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const { instructions, scope: _scopeFromConfig, source: _sourceFromConfig, supportingFiles, ...frontmatter } = config;
  void _scopeFromConfig;
  void _sourceFromConfig;

  if (!frontmatter.name) {
    frontmatter.name = skillName;
  }
  if (!frontmatter.description) {
    throw new Error('Skill description is required');
  }

  writeMdFile(targetPath, frontmatter, instructions || '');

  if (supportingFiles && Array.isArray(supportingFiles)) {
    for (const file of supportingFiles) {
      if (file.path && file.content !== undefined) {
        writeSkillSupportingFile(targetDir, file.path, file.content);
      }
    }
  }

  console.log(`Created new skill: ${skillName} (scope: ${targetScope}, path: ${targetPath})`);
}

function updateSkill(skillName, updates, workingDirectory, targetPath = null) {
  ensureDirs();

  const requestedPath = typeof targetPath === 'string' && targetPath.trim()
    ? path.resolve(targetPath.trim())
    : null;
  const existing = requestedPath && fs.existsSync(requestedPath)
    ? { scope: null, path: requestedPath, source: null }
    : getSkillScope(skillName, workingDirectory);
  if (!existing.path) {
    throw new Error(`Skill "${skillName}" not found`);
  }
  if (path.basename(existing.path) !== 'SKILL.md') {
    throw new Error(`Skill "${skillName}" target must be a SKILL.md file`);
  }

  const mdPath = existing.path;
  const mdDir = path.dirname(mdPath);
  const mdData = parseMdFile(mdPath);
  const frontmatterName = typeof mdData.frontmatter?.name === 'string' ? mdData.frontmatter.name : skillName;
  if (frontmatterName !== skillName) {
    throw new Error(`Skill "${skillName}" does not match ${mdPath}`);
  }

  let mdModified = false;

  for (const [field, value] of Object.entries(updates)) {
    if (field === 'scope' || field === 'source' || field === 'targetPath' || field === 'renameTo') {
      continue;
    }

    if (field === 'instructions') {
      const normalizedValue = typeof value === 'string' ? value : (value == null ? '' : String(value));
      mdData.body = normalizedValue;
      mdModified = true;
      continue;
    }

    if (field === 'supportingFiles') {
      if (Array.isArray(value)) {
        for (const file of value) {
          if (file.delete && file.path) {
            deleteSkillSupportingFile(mdDir, file.path);
          } else if (file.path && file.content !== undefined) {
            writeSkillSupportingFile(mdDir, file.path, file.content);
          }
        }
      }
      continue;
    }

    mdData.frontmatter[field] = value;
    mdModified = true;
  }

  if (mdModified) {
    writeMdFile(mdPath, mdData.frontmatter, mdData.body);
  }

  console.log(`Updated skill: ${skillName} (path: ${mdPath})`);
}

function deleteSkill(skillName, workingDirectory) {
  let deleted = false;

  const removeDir = (dir, label) => {
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Deleted ${label} skill directory: ${dir}`);
    deleted = true;
  };

  if (workingDirectory) {
    removeDir(getProjectSkillDir(workingDirectory, skillName), 'project-level');
    removeDir(getProjectOpencodeSkillDir(workingDirectory, skillName), 'project-level opencode-compat');
    removeDir(getClaudeSkillDir(workingDirectory, skillName), 'claude-compat');
    removeDir(getProjectAgentsSkillDir(workingDirectory, skillName), 'project-level agents');
  }

  removeDir(getUserSkillDir(skillName), 'user-level');
  removeDir(getUserOpencodeSkillDir(skillName), 'user-level opencode-compat');
  removeDir(getUserAgentsSkillDir(skillName), 'user-level agents');
  removeDir(getUserClaudeSkillDir(skillName), 'user-level claude');

  if (!deleted) {
    throw new Error(`Skill "${skillName}" not found`);
  }
}

function isPathInside(candidatePath, parentPath) {
  if (!candidatePath || !parentPath) return false;
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentPath);
  return resolvedCandidate === resolvedParent
    || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`);
}

function getManagedSkillRoots(workingDirectory) {
  const roots = [];
  const pushRoot = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (!roots.includes(resolved)) {
      roots.push(resolved);
    }
  };

  pushRoot(SKILL_DIR);
  pushRoot(path.join(OPENCODE_HOME_DIR, 'skills'));
  pushRoot(path.join(os.homedir(), '.agent', 'skills'));
  pushRoot(path.join(os.homedir(), '.agents', 'skills'));
  pushRoot(path.join(os.homedir(), '.claude', 'skills'));

  if (workingDirectory) {
    const worktreeRoot = findWorktreeRoot(workingDirectory) || path.resolve(workingDirectory);
    for (const ancestor of getAncestors(workingDirectory, worktreeRoot)) {
      pushRoot(path.join(ancestor, OMP_PROJECT_DIR, 'skills'));
      pushRoot(path.join(ancestor, OPENCODE_PROJECT_DIR, 'skills'));
      pushRoot(path.join(ancestor, '.agent', 'skills'));
      pushRoot(path.join(ancestor, '.agents', 'skills'));
      pushRoot(path.join(ancestor, '.claude', 'skills'));
    }
  }

  return roots;
}

function isManagedSkillPath(skillMdPath, workingDirectory) {
  if (!skillMdPath || skillMdPath === BUILT_IN_SKILL_LOCATION) {
    return false;
  }
  const skillDir = path.dirname(path.resolve(skillMdPath));
  return getManagedSkillRoots(workingDirectory).some((root) => isPathInside(skillDir, root));
}

function renameSkill(oldName, newName, workingDirectory) {
  ensureDirs();
  assertValidSkillName(newName);

  if (oldName === newName) {
    return;
  }

  const existing = getSkillScope(oldName, workingDirectory);
  if (!existing.path) {
    throw new Error(`Skill "${oldName}" not found`);
  }
  if (existing.path === BUILT_IN_SKILL_LOCATION || !fs.existsSync(existing.path)) {
    throw new Error(`Skill "${oldName}" cannot be renamed`);
  }
  if (path.basename(existing.path) !== 'SKILL.md') {
    throw new Error(`Skill "${oldName}" target must be a SKILL.md file`);
  }
  if (!isManagedSkillPath(existing.path, workingDirectory)) {
    throw new Error(`Skill "${oldName}" is outside managed skill directories and cannot be renamed`);
  }

  const mdDataBeforeMove = parseMdFile(existing.path);
  const frontmatterName = typeof mdDataBeforeMove.frontmatter?.name === 'string'
    ? mdDataBeforeMove.frontmatter.name
    : oldName;
  if (frontmatterName !== oldName) {
    throw new Error(`Skill "${oldName}" does not match ${existing.path}`);
  }

  const conflict = getSkillScope(newName, workingDirectory);
  if (conflict.path) {
    throw new Error(`Skill ${newName} already exists at ${conflict.path}`);
  }

  const oldDir = path.dirname(existing.path);
  const newDir = path.join(path.dirname(oldDir), newName);
  const directoriesDiffer = path.resolve(oldDir) !== path.resolve(newDir);

  if (directoriesDiffer && fs.existsSync(newDir)) {
    throw new Error(`Skill directory already exists at ${newDir}`);
  }

  // Rename the skill directory in place so supporting files and SKILL.md body are preserved.
  if (directoriesDiffer) {
    fs.renameSync(oldDir, newDir);
  }

  const newPath = path.join(newDir, 'SKILL.md');
  try {
    const mdData = parseMdFile(newPath);
    mdData.frontmatter = {
      ...mdData.frontmatter,
      name: newName,
    };
    writeMdFile(newPath, mdData.frontmatter, mdData.body);
  } catch (error) {
    if (directoriesDiffer && fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
      try {
        fs.renameSync(newDir, oldDir);
      } catch (rollbackError) {
        console.error(`Failed to rollback skill rename from ${newDir} to ${oldDir}:`, rollbackError);
      }
    }
    throw error;
  }

  console.log(`Renamed skill: ${oldName} -> ${newName} (path: ${newPath})`);
}

export {
  getSkillSources,
  discoverSkills,
  mergeDiscoveredSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  renameSkill,
  isManagedSkillPath,
};
