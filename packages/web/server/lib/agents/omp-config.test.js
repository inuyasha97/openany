import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOmpConfig } from './omp-config.js';

let home;
let project;

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-config-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-project-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('createOmpConfig.listMcp', () => {
  it('merges project and user servers, with the user winning a name', () => {
    write(path.join(project, '.omp', 'mcp.json'), { mcpServers: { shared: { command: 'project-bin' }, proj: { command: 'proj' } } });
    write(path.join(home, 'mcp.json'), { mcpServers: { shared: { command: 'user-bin' }, user: { url: 'https://x' } } });

    const listed = createOmpConfig({ home }).listMcp(project);
    const byName = Object.fromEntries(listed.map((server) => [server.name, server]));

    expect(Object.keys(byName).sort()).toEqual(['proj', 'shared', 'user']);
    expect(byName.shared).toMatchObject({ scope: 'user', command: 'user-bin' });
    expect(byName.proj).toMatchObject({ scope: 'project', enabled: true, type: 'stdio' });
    expect(byName.user).toMatchObject({ scope: 'user', type: 'http' });
  });

  it('lets disabledServers win and enabledServers override an enabled:false source', () => {
    write(path.join(project, '.omp', 'mcp.json'), { mcpServers: { blocked: {}, off: { enabled: false } } });
    write(path.join(home, 'mcp.json'), {
      mcpServers: { off: { enabled: false } },
      disabledServers: ['blocked'],
      enabledServers: ['off'],
    });

    const byName = Object.fromEntries(createOmpConfig({ home }).listMcp(project).map((server) => [server.name, server]));

    expect(byName.blocked.enabled).toBe(false);
    expect(byName.off.enabled).toBe(true);
  });

  it('returns nothing when no config file exists', () => {
    expect(createOmpConfig({ home }).listMcp(project)).toEqual([]);
  });

  it('ignores project-level deny and force-enable lists, as OMP does', () => {
    write(path.join(project, '.omp', 'mcp.json'), {
      mcpServers: { a: {}, b: { enabled: false } },
      disabledServers: ['a'],
      enabledServers: ['b'],
    });

    const byName = Object.fromEntries(createOmpConfig({ home }).listMcp(project).map((server) => [server.name, server]));
    expect(byName.a.enabled).toBe(true);
    expect(byName.b.enabled).toBe(false);
  });
});

describe('createOmpConfig mutations', () => {
  it('writes enable and disable to the user file only', () => {
    write(path.join(project, '.omp', 'mcp.json'), { mcpServers: { a: {} } });
    const config = createOmpConfig({ home });

    config.setMcpEnabled('a', false);
    expect(read(path.join(home, 'mcp.json'))).toEqual({ disabledServers: ['a'] });
    expect(config.listMcp(project)[0].enabled).toBe(false);

    config.setMcpEnabled('a', true);
    expect(read(path.join(home, 'mcp.json'))).toEqual({ enabledServers: ['a'] });
    expect(config.listMcp(project)[0].enabled).toBe(true);

    // The project file is untouched throughout.
    expect(read(path.join(project, '.omp', 'mcp.json'))).toEqual({ mcpServers: { a: {} } });
  });

  it('removes a server from the named scope and reports a miss', () => {
    write(path.join(home, 'mcp.json'), { mcpServers: { user: {} } });
    write(path.join(project, '.omp', 'mcp.json'), { mcpServers: { proj: {} } });
    const config = createOmpConfig({ home });

    expect(config.removeMcp('proj', 'project', project)).toBe(true);
    expect(read(path.join(project, '.omp', 'mcp.json')).mcpServers).toEqual({});
    expect(config.removeMcp('user', 'project', project)).toBe(false);
    expect(config.removeMcp('user', 'user')).toBe(true);
    expect(read(path.join(home, 'mcp.json')).mcpServers).toEqual({});
  });

  it('refuses to overwrite a config file that does not parse', () => {
    const userFile = path.join(home, 'mcp.json');
    fs.writeFileSync(userFile, '{ "mcpServers": { "a": {} }, }\n');
    const config = createOmpConfig({ home });

    expect(() => config.setMcpEnabled('a', false)).toThrow();
    expect(fs.readFileSync(userFile, 'utf8')).toBe('{ "mcpServers": { "a": {} }, }\n');
  });

  it('adds a server definition to the named scope', () => {
    const config = createOmpConfig({ home });
    config.addMcp({ name: 'new', server: { command: 'bin', args: ['--x'] } }, 'user');

    expect(read(path.join(home, 'mcp.json')).mcpServers.new).toEqual({ command: 'bin', args: ['--x'] });
    expect(config.listMcp(project)).toEqual([
      { name: 'new', scope: 'user', enabled: true, type: 'stdio', command: 'bin', url: undefined },
    ]);
  });
});
