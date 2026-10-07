import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ENV_KEYS = ['PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_FILES'];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
};

/** Import the module fresh so its import-time path resolution sees the env. */
const loadModule = async (env = {}) => {
  vi.resetModules();
  restoreEnv();
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  return import('./agent-config-files.js');
};

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe('OMP config directory resolution', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('defaults to ~/.omp/agent with the OMP agent, command, skill and config paths', async () => {
    const mod = await loadModule();
    const home = os.homedir();
    expect(mod.OPENCODE_CONFIG_DIR).toBe(path.join(home, '.omp', 'agent'));
    expect(mod.AGENT_DIR).toBe(path.join(home, '.omp', 'agent', 'agents'));
    expect(mod.COMMAND_DIR).toBe(path.join(home, '.omp', 'agent', 'commands'));
    expect(mod.SKILL_DIR).toBe(path.join(home, '.omp', 'agent', 'skills'));
    expect(mod.CONFIG_FILE).toBe(path.join(home, '.omp', 'agent', 'config.yml'));
    expect(mod.MODELS_FILE).toBe(path.join(home, '.omp', 'agent', 'models.yml'));
  });

  it('honors PI_CONFIG_DIR as the config root name', async () => {
    const mod = await loadModule({ PI_CONFIG_DIR: '.omp-alt' });
    expect(mod.OPENCODE_CONFIG_DIR).toBe(path.join(os.homedir(), '.omp-alt', 'agent'));
  });

  it('honors PI_CODING_AGENT_DIR as the agent directory override', async () => {
    const mod = await loadModule({ PI_CODING_AGENT_DIR: '/tmp/custom-omp-agent' });
    expect(mod.OPENCODE_CONFIG_DIR).toBe(path.resolve('/tmp/custom-omp-agent'));
    expect(mod.SKILL_DIR).toBe(path.join('/tmp/custom-omp-agent', 'skills'));
  });

  it('moves the agent directory under profiles/<name> when a profile is active', async () => {
    const mod = await loadModule({ OMP_PROFILE: 'work', PI_CODING_AGENT_DIR: '/tmp/ignored-by-profile' });
    expect(mod.OPENCODE_CONFIG_DIR).toBe(path.join(os.homedir(), '.omp', 'profiles', 'work', 'agent'));
  });

  it('treats the literal "default" profile and an empty profile as the default profile', async () => {
    const withDefault = await loadModule({ OMP_PROFILE: 'default' });
    expect(withDefault.OPENCODE_CONFIG_DIR).toBe(path.join(os.homedir(), '.omp', 'agent'));

    const withEmpty = await loadModule({ OMP_PROFILE: '', PI_PROFILE: 'legacy-profile' });
    // An explicitly empty OMP_PROFILE selects the default profile rather than
    // falling through to the legacy PI_PROFILE value (OMP's own precedence).
    expect(withEmpty.OPENCODE_CONFIG_DIR).toBe(path.join(os.homedir(), '.omp', 'agent'));
  });
});

describe('markdown files', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir('omp-agent-config-md-');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips frontmatter and body through parse/write', async () => {
    const mod = await loadModule();
    const file = path.join(dir, 'agent.md');
    mod.writeMdFile(file, { name: 'task', description: 'A task agent' }, 'Do the thing.');

    const parsed = mod.parseMdFile(file);
    expect(parsed.frontmatter).toEqual({ name: 'task', description: 'A task agent' });
    expect(parsed.body).toBe('Do the thing.');
  });

  it('parses unquoted colons in a value that strict YAML rejects', async () => {
    const mod = await loadModule();
    const file = path.join(dir, 'colon.md');
    fs.writeFileSync(file, ['---', 'description: Build agent: creates builds', '---', '', 'Body'].join('\n'), 'utf8');

    const parsed = mod.parseMdFile(file);
    expect(parsed.frontmatter.description).toBe('Build agent: creates builds');
    expect(parsed.body).toBe('Body');
  });
});

describe('config layers', () => {
  let agentDir;
  let projectDir;

  beforeEach(() => {
    agentDir = tempDir('omp-agent-config-user-');
    projectDir = tempDir('omp-agent-config-project-');
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    restoreEnv();
  });

  const writeUserConfig = (content) => fs.writeFileSync(path.join(agentDir, 'config.yml'), content, 'utf8');
  const writeProjectConfig = (content) => {
    fs.mkdirSync(path.join(projectDir, '.omp'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.omp', 'config.yml'), content, 'utf8');
  };

  it('merges the user config.yml, the project .omp/config.yml and the models.yml provider view', async () => {
    const mod = await loadModule({ PI_CODING_AGENT_DIR: agentDir });
    writeUserConfig(['theme:', '  dark: titanium', 'skills:', '  customDirectories:', '    - ~/team-skills'].join('\n'));
    writeProjectConfig(['theme:', '  light: light'].join('\n'));
    fs.writeFileSync(
      path.join(agentDir, 'models.yml'),
      ['providers:', '  zhipuai:', '    apiKey: models-key', '    baseUrl: https://example.test'].join('\n'),
      'utf8',
    );

    const layers = mod.readConfigLayers(projectDir);
    expect(layers.layerErrors).toEqual([]);
    expect(layers.paths.userPath).toBe(path.join(agentDir, 'config.yml'));
    expect(layers.paths.projectPath).toBe(path.join(projectDir, '.omp', 'config.yml'));
    expect(layers.mergedConfig.theme).toEqual({ dark: 'titanium', light: 'light' });
    expect(layers.mergedConfig.skills.customDirectories).toEqual(['~/team-skills']);
    // The on-disk provider apiKey OMP resolves from models.yml stays reachable
    // through the `provider.<id>.options.apiKey` shape the config readers use.
    expect(layers.mergedConfig.provider.zhipuai.options.apiKey).toBe('models-key');
    expect(layers.mergedConfig.provider.zhipuai.options.baseURL).toBe('https://example.test');
  });

  it('reports invalid YAML as a layer error instead of reading it as an empty config', async () => {
    const mod = await loadModule({ PI_CODING_AGENT_DIR: agentDir });
    writeUserConfig('theme: [unclosed\n');

    const layers = mod.readConfigLayers();
    expect(layers.layerErrors).toHaveLength(1);
    expect(layers.layerErrors[0]).toMatchObject({ path: path.join(agentDir, 'config.yml'), code: 'INVALID_CONFIG' });
    expect(layers.mergedConfig).toEqual({});
  });

  it('throws on invalid YAML when the file is read directly', async () => {
    const mod = await loadModule({ PI_CODING_AGENT_DIR: agentDir });
    const file = path.join(agentDir, 'config.yml');
    fs.writeFileSync(file, 'theme: [unclosed\n', 'utf8');

    expect(() => mod.readConfigFile(file)).toThrowError(/invalid YAML/);
    try {
      mod.readConfigFile(file);
    } catch (error) {
      expect(error.code).toBe('INVALID_CONFIG');
    }
  });

  it('still reads a legacy config.yaml when config.yml is absent', async () => {
    const mod = await loadModule({ PI_CODING_AGENT_DIR: agentDir });
    fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'theme:\n  dark: titanium\n', 'utf8');

    const layers = mod.readConfigLayers();
    expect(layers.paths.userPath).toBe(path.join(agentDir, 'config.yaml'));
    expect(layers.mergedConfig.theme).toEqual({ dark: 'titanium' });
  });

  it('writes YAML through a backup and refuses to overwrite an unparseable file', async () => {
    const mod = await loadModule({ PI_CODING_AGENT_DIR: agentDir });
    const file = path.join(agentDir, 'config.yml');
    writeUserConfig('theme:\n  dark: titanium\n');

    mod.writeConfig({ theme: { dark: 'titanium', light: 'light' } }, file);
    expect(fs.existsSync(`${file}.openchamber.backup`)).toBe(true);
    expect(mod.readConfigFile(file)).toEqual({ theme: { dark: 'titanium', light: 'light' } });

    fs.writeFileSync(file, 'theme: [unclosed\n', 'utf8');
    expect(() => mod.writeConfig({ theme: { dark: 'titanium' } }, file)).toThrowError(/invalid YAML/);
    expect(fs.readFileSync(file, 'utf8')).toBe('theme: [unclosed\n');
  });

  it('has no config.yml entity sections to read or write', async () => {
    const mod = await loadModule({ PI_CODING_AGENT_DIR: agentDir });
    const layers = mod.readConfigLayers();

    expect(() => mod.lookupSectionEntry(layers.userConfig, 'agents', 'reviewer')).toThrowError(/no agents\/commands/);
    expect(() => mod.getJsonEntrySource(layers, 'commands', 'review')).toThrowError(/markdown files/);
    expect(() => mod.getJsonWriteTarget(layers, 'project')).toThrowError(/mcp\.json/);
    try {
      mod.getJsonWriteTarget(layers, 'project');
    } catch (error) {
      expect(error.code).toBe('OMP_UNSUPPORTED_CONFIG_SECTION');
    }
  });
});

describe('skill search roots', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = tempDir('omp-agent-config-roots-');
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    restoreEnv();
  });

  it('lists the OMP-native and compatibility roots OMP itself reads', async () => {
    const mod = await loadModule();
    const home = os.homedir();
    const roots = mod.resolveSkillSearchDirectories(projectDir);

    expect(roots).toContain(path.join(home, '.omp', 'agent'));
    expect(roots).toContain(path.join(home, '.agents'));
    expect(roots).toContain(path.join(home, '.claude'));
    expect(roots).toContain(path.join(home, '.config', 'opencode'));
    expect(roots).toContain(path.join(projectDir, '.omp'));
    expect(roots).toContain(path.join(projectDir, '.opencode'));
  });

  it('walks nested SKILL.md files and skips a symlink loop', async () => {
    const mod = await loadModule();
    const root = path.join(projectDir, '.omp', 'skills');
    fs.mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', 'deep', 'SKILL.md'), '---\nname: deep\n---\n', 'utf8');
    if (process.platform !== 'win32') {
      fs.symlinkSync(root, path.join(root, 'nested', 'loop'), 'dir');
    }

    const found = mod.walkSkillMdFiles(root).map((filePath) => path.relative(root, filePath));
    expect(found).toEqual([path.join('nested', 'deep', 'SKILL.md')]);
  });
});
