import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSkill,
  deleteSkill,
  discoverSkills,
  getSkillSources,
  isManagedSkillPath,
  mergeDiscoveredSkills,
  renameSkill,
  updateSkill,
} from './skills.js';

const tempProject = () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-skills-'));
  fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  return projectDir;
};

const writeSkill = (dir, name, frontmatter, body = 'Use this skill.') => {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  const yaml = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join('\n');
  fs.writeFileSync(filePath, `---\n${yaml}\n---\n\n${body}\n`, 'utf8');
  return filePath;
};

const createdProjects = [];
const newProject = () => {
  const projectDir = tempProject();
  createdProjects.push(projectDir);
  return projectDir;
};

afterEach(() => {
  while (createdProjects.length > 0) {
    fs.rmSync(createdProjects.pop(), { recursive: true, force: true });
  }
});

describe('discoverSkills', () => {
  it('discovers OMP-native project skills under .omp/skills', () => {
    const projectDir = newProject();
    const skillPath = writeSkill(path.join(projectDir, '.omp', 'skills'), 'repo-skill', {
      name: 'repo-skill',
      description: 'Native OMP project skill',
    });

    const match = discoverSkills(projectDir).find((skill) => skill.name === 'repo-skill');

    expect(match).toEqual({
      name: 'repo-skill',
      path: skillPath,
      scope: 'project',
      source: 'opencode',
      description: 'Native OMP project skill',
    });
  });

  it('discovers repository-local .agents skills for the project directory', () => {
    const projectDir = newProject();
    const skillPath = writeSkill(path.join(projectDir, '.agents', 'skills'), 'agents-skill', {
      name: 'agents-skill',
      description: 'Repository-local agents skill',
    });

    const match = discoverSkills(projectDir).find((skill) => skill.name === 'agents-skill');

    expect(match).toEqual({
      name: 'agents-skill',
      path: skillPath,
      scope: 'project',
      source: 'agents',
      description: 'Repository-local agents skill',
    });
  });

  it('keeps discovering skills from the OpenCode tree OMP still reads', () => {
    const projectDir = newProject();
    const skillPath = writeSkill(path.join(projectDir, '.opencode', 'skills'), 'legacy-skill', {
      name: 'legacy-skill',
      description: 'OpenCode-era project skill',
    });

    const match = discoverSkills(projectDir).find((skill) => skill.name === 'legacy-skill');

    expect(match).toEqual({
      name: 'legacy-skill',
      path: skillPath,
      scope: 'project',
      source: 'opencode',
      description: 'OpenCode-era project skill',
    });
  });
});

describe('skill sources', () => {
  it('resolves the OMP-native project skill file and its frontmatter fields', () => {
    const projectDir = newProject();
    const skillPath = writeSkill(
      path.join(projectDir, '.omp', 'skills'),
      'editable-skill',
      { name: 'editable-skill', description: 'Editable' },
      'Body text.',
    );
    fs.writeFileSync(path.join(path.dirname(skillPath), 'reference.md'), 'extra', 'utf8');

    const sources = getSkillSources('editable-skill', projectDir);

    expect(sources.projectMd).toEqual({
      exists: true,
      path: skillPath,
      dir: path.dirname(skillPath),
    });
    expect(sources.md.path).toBe(skillPath);
    expect(sources.md.scope).toBe('project');
    expect(sources.md.fields).toEqual(['name', 'description', 'instructions']);
    expect(sources.md.instructions).toBe('Body text.');
    expect(sources.md.supportingFiles.map((file) => file.path)).toEqual(['reference.md']);
  });

  it('resolves a built-in skill without touching the filesystem', () => {
    const sources = getSkillSources('built-in-skill', '/tmp/omp-skills-missing-project', {
      name: 'built-in-skill',
      path: '<built-in>',
      scope: 'user',
      source: 'opencode',
      description: 'Built in',
      content: 'Built-in instructions',
    });

    expect(sources.md).toMatchObject({
      exists: true,
      scope: 'user',
      source: 'opencode',
      instructions: 'Built-in instructions',
      fields: ['description', 'instructions'],
    });
  });
});

describe('createSkill', () => {
  it('writes a project skill into .omp/skills and reports it through getSkillSources', () => {
    const projectDir = newProject();

    createSkill('new-skill', { description: 'Fresh', instructions: 'Do it.' }, projectDir, 'project');

    const skillPath = path.join(projectDir, '.omp', 'skills', 'new-skill', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const sources = getSkillSources('new-skill', projectDir);
    expect(sources.md.instructions).toBe('Do it.');
    expect(isManagedSkillPath(skillPath, projectDir)).toBe(true);
  });

  it('rejects a duplicate skill name', () => {
    const projectDir = newProject();
    createSkill('dup-skill', { description: 'First' }, projectDir, 'project');

    expect(() => createSkill('dup-skill', { description: 'Second' }, projectDir, 'project')).toThrowError(/already exists/);
  });

  it('rejects an invalid skill name', () => {
    const projectDir = newProject();
    expect(() => createSkill('Not Valid', { description: 'x' }, projectDir, 'project')).toThrowError(/Invalid skill name/);
  });
});

describe('updateSkill, renameSkill and deleteSkill', () => {
  it('updates the instructions of a discovered project skill in place', () => {
    const projectDir = newProject();
    const skillPath = writeSkill(path.join(projectDir, '.omp', 'skills'), 'update-skill', {
      name: 'update-skill',
      description: 'Before',
    });

    updateSkill('update-skill', { instructions: 'After', description: 'Changed' }, projectDir);

    const sources = getSkillSources('update-skill', projectDir);
    expect(sources.md.path).toBe(skillPath);
    expect(sources.md.instructions).toBe('After');
    expect(sources.md.description).toBe('Changed');
  });

  it('renames the skill directory and rewrites the frontmatter name', () => {
    const projectDir = newProject();
    writeSkill(path.join(projectDir, '.omp', 'skills'), 'old-skill', { name: 'old-skill', description: 'Old' });

    renameSkill('old-skill', 'new-skill', projectDir);

    expect(fs.existsSync(path.join(projectDir, '.omp', 'skills', 'old-skill'))).toBe(false);
    const renamed = getSkillSources('new-skill', projectDir);
    expect(renamed.md.exists).toBe(true);
    expect(renamed.md.name).toBe('new-skill');
  });

  it('refuses to rename a skill outside the managed directories', () => {
    const projectDir = newProject();
    writeSkill(path.join(projectDir, 'vendor', 'skills'), 'vendor-skill', { name: 'vendor-skill', description: 'V' });

    expect(() => renameSkill('vendor-skill', 'renamed-skill', projectDir)).toThrowError(/not found|outside managed/);
  });

  it('deletes a project skill directory', () => {
    const projectDir = newProject();
    createSkill('doomed-skill', { description: 'Doomed' }, projectDir, 'project');

    deleteSkill('doomed-skill', projectDir);

    expect(fs.existsSync(path.join(projectDir, '.omp', 'skills', 'doomed-skill'))).toBe(false);
    expect(() => deleteSkill('doomed-skill', projectDir)).toThrowError(/not found/);
  });
});

describe('mergeDiscoveredSkills', () => {
  it('keeps discovered skills first and appends the ones only live discovery knows', () => {
    const merged = mergeDiscoveredSkills(
      [
        { name: 'existing-native-skill', path: '/home/user/.omp/agent/skills/existing-native-skill/SKILL.md', source: 'opencode' },
        { name: 'existing-agent-skill', path: '/home/user/.agents/skills/existing-agent-skill/SKILL.md', source: 'agents' },
      ],
      [
        { name: 'existing-agent-skill', path: '/home/user/.agents/skills/existing-agent-skill/SKILL.md', source: 'agents' },
        { name: 'live-only-skill', path: '<built-in>', source: 'opencode' },
      ],
    );

    expect(merged.map((skill) => skill.name)).toEqual([
      'existing-native-skill',
      'existing-agent-skill',
      'live-only-skill',
    ]);
  });
});
