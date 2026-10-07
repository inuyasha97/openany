import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OMP_CLI_VERSION, createPackedToolsSource, createRegistryToolsSource, readHostToolVersions, requireToolsSource, toolsContentKey } from './tools.js';

const IMAGE = 'node@sha256:aaaa';
const VERSIONS = { webVersion: '1.24.2', ompVersion: '18.1.11' };

let directory;
const tarball = (name, content) => {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-tools-test-'));
});

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('readHostToolVersions', () => {
  it('reads the version of this server, and the pinned OMP CLI it installs', () => {
    const fromEnvironment = process.env.OPENCHAMBER_OMP_CLI_VERSION;
    delete process.env.OPENCHAMBER_OMP_CLI_VERSION;
    try {
      const versions = readHostToolVersions();
      expect(versions.webVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(versions.ompVersion).toBe(OMP_CLI_VERSION);
    } finally {
      if (fromEnvironment !== undefined) process.env.OPENCHAMBER_OMP_CLI_VERSION = fromEnvironment;
    }
  });

  it('takes the OMP CLI version the host names, over the pin', () => {
    expect(readHostToolVersions(undefined, '18.2.0').ompVersion).toBe('18.2.0');
  });

  it('takes the version from the environment too, and the sources follow it', () => {
    const fromEnvironment = process.env.OPENCHAMBER_OMP_CLI_VERSION;
    process.env.OPENCHAMBER_OMP_CLI_VERSION = '18.2.0';
    try {
      expect(readHostToolVersions().ompVersion).toBe('18.2.0');
      expect(createRegistryToolsSource({ webVersion: '1.24.2' }).canonical.packages['@oh-my-pi/pi-coding-agent']).toBe('18.2.0');
    } finally {
      if (fromEnvironment === undefined) delete process.env.OPENCHAMBER_OMP_CLI_VERSION;
      else process.env.OPENCHAMBER_OMP_CLI_VERSION = fromEnvironment;
    }
  });

  it('rejects an OMP version that is a range or a URL', () => {
    expect(() => readHostToolVersions(undefined, '^18.1.0')).toThrow(expect.objectContaining({ code: 'invalid_tools_version' }));
    expect(() => createRegistryToolsSource({ ...VERSIONS, ompVersion: 'https://example.com/omp.tgz' })).toThrow(expect.objectContaining({ code: 'invalid_tools_version' }));
  });

  it('says when the manifest cannot be read', () => {
    expect(() => readHostToolVersions(pathToFileURL(path.join(directory, 'missing.json')))).toThrow(expect.objectContaining({ code: 'tools_versions_unreadable' }));
  });
});

describe('createRegistryToolsSource', () => {
  it('asks for exact versions, the OMP CLI among them', () => {
    const source = createRegistryToolsSource(VERSIONS);

    expect(source.description).toBe('web 1.24.2, omp 18.1.11');
    expect(source.files).toEqual([]);
    expect(JSON.parse(source.packageJson)).toEqual({
      name: 'openchamber-space-tools',
      private: true,
      dependencies: { '@openchamber/web': '1.24.2', '@oh-my-pi/pi-coding-agent': '18.1.11' },
    });
  });

  it('installs this host\'s pinned OMP CLI when the caller names no version', () => {
    const fromEnvironment = process.env.OPENCHAMBER_OMP_CLI_VERSION;
    delete process.env.OPENCHAMBER_OMP_CLI_VERSION;
    try {
      expect(createRegistryToolsSource({ webVersion: '1.24.2' }).canonical.packages).toEqual({ '@openchamber/web': '1.24.2', '@oh-my-pi/pi-coding-agent': OMP_CLI_VERSION });
    } finally {
      if (fromEnvironment !== undefined) process.env.OPENCHAMBER_OMP_CLI_VERSION = fromEnvironment;
    }
  });

  it.each(['^1.24.2', 'latest', '1.24', '', undefined, 'https://example.com/x.tgz', '1.24.2 || 2'])('rejects the web version %j', (version) => {
    expect(() => createRegistryToolsSource({ ...VERSIONS, webVersion: version })).toThrow(expect.objectContaining({ code: 'invalid_tools_version' }));
  });

  // `undefined` is absent, not invalid: it means "this host's pinned CLI", and that case is above.
  it.each(['^18.1.11', 'latest', '18.1', '', null, 'https://example.com/omp.tgz', '18.1.11 || 19'])('rejects the OMP version %j', (version) => {
    expect(() => createRegistryToolsSource({ ...VERSIONS, ompVersion: version })).toThrow(expect.objectContaining({ code: 'invalid_tools_version' }));
  });

  it('accepts a prerelease version', () => {
    expect(createRegistryToolsSource({ ...VERSIONS, webVersion: '1.25.0-beta.1' }).description).toContain('1.25.0-beta.1');
    expect(createRegistryToolsSource({ ...VERSIONS, ompVersion: '18.2.0-beta.1' }).description).toContain('18.2.0-beta.1');
  });
});

describe('createPackedToolsSource', () => {
  it('installs both tarballs by path and makes every sdk in the tree the local one', () => {
    const source = createPackedToolsSource({ webTarballPath: tarball('web.tgz', 'web bytes'), sdkTarballPath: tarball('sdk.tgz', 'sdk bytes'), ompVersion: '18.1.11' });

    expect(source.description).toBe('development build');
    expect(source.files).toEqual([
      { name: 'openchamber-web.tgz', bytes: Buffer.from('web bytes') },
      { name: 'openchamber-sdk.tgz', bytes: Buffer.from('sdk bytes') },
    ]);
    expect(JSON.parse(source.packageJson)).toEqual({
      name: 'openchamber-space-tools',
      private: true,
      dependencies: {
        '@openchamber/web': 'file:/tmp/openchamber-fill/openchamber-web.tgz',
        '@openchamber/sdk': 'file:/tmp/openchamber-fill/openchamber-sdk.tgz',
        '@oh-my-pi/pi-coding-agent': '18.1.11',
      },
      overrides: { '@openchamber/sdk': '$@openchamber/sdk' },
    });
  });

  it('hashes the tarballs once, when the source is made', () => {
    const webTarballPath = tarball('web-once.tgz', 'first');
    const source = createPackedToolsSource({ webTarballPath, sdkTarballPath: tarball('sdk-once.tgz', 'sdk'), ompVersion: '18.1.11' });
    const key = toolsContentKey(source, IMAGE);

    fs.writeFileSync(webTarballPath, 'changed later');
    expect(toolsContentKey(source, IMAGE)).toBe(key);
    expect(source.canonical.tarballs[0].sha256).toBe(crypto.createHash('sha256').update('first').digest('hex'));
  });

  it('says which tarball it could not read', () => {
    const missing = path.join(directory, 'nowhere.tgz');
    expect(() => createPackedToolsSource({ webTarballPath: missing, sdkTarballPath: missing, ompVersion: '18.1.11' }))
      .toThrow(expect.objectContaining({ code: 'tools_tarball_unreadable', message: expect.stringContaining('web') }));
  });
});

describe('toolsContentKey', () => {
  const packed = (webContent) => createPackedToolsSource({ webTarballPath: tarball(`web-${webContent}.tgz`, webContent), sdkTarballPath: tarball('sdk-key.tgz', 'sdk'), ompVersion: '18.1.11' });

  it('is 16 hex characters and the same for the same content', () => {
    const key = toolsContentKey(createRegistryToolsSource(VERSIONS), IMAGE);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(toolsContentKey(createRegistryToolsSource(VERSIONS), IMAGE)).toBe(key);
  });

  it('changes with a version, with the base image, with a tarball byte, and between the two kinds', () => {
    const keys = [
      toolsContentKey(createRegistryToolsSource(VERSIONS), IMAGE),
      toolsContentKey(createRegistryToolsSource({ ...VERSIONS, webVersion: '1.24.3' }), IMAGE),
      toolsContentKey(createRegistryToolsSource({ ...VERSIONS, ompVersion: '18.1.12' }), IMAGE),
      toolsContentKey(createRegistryToolsSource(VERSIONS), 'node@sha256:bbbb'),
      toolsContentKey(packed('a'), IMAGE),
      toolsContentKey(packed('b'), IMAGE),
      toolsContentKey(createRegistryToolsSource({ ...VERSIONS, revision: 'refill-1' }), IMAGE),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('revision', () => {
  it('changes the key and nothing that gets installed', () => {
    const plain = createRegistryToolsSource(VERSIONS);
    const revised = createRegistryToolsSource({ ...VERSIONS, revision: 'refill-1' });
    expect(revised.packageJson).toBe(plain.packageJson);
    expect(revised.description).toBe(plain.description);
  });

  it.each(['two words', 'a/b', 'x'.repeat(65)])('rejects %j', (revision) => {
    expect(() => createRegistryToolsSource({ ...VERSIONS, revision })).toThrow(expect.objectContaining({ code: 'invalid_tools_revision' }));
  });
});

describe('requireToolsSource', () => {
  it.each([undefined, null, 'registry', {}, { ...createRegistryToolsSource(VERSIONS) }])('rejects %j, which no factory here made', (source) => {
    expect(() => requireToolsSource(source)).toThrow(expect.objectContaining({ code: 'invalid_tools_source' }));
  });

  it('accepts a source from either factory', () => {
    const source = createRegistryToolsSource(VERSIONS);
    expect(requireToolsSource(source)).toBe(source);
  });
});
