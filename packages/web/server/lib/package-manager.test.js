import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  executeUpdate,
  getCurrentVersion,
} = await import('./package-manager.js');

/** Helper: create a fetch mock that routes by URL pattern */
function createFetchMock() {
  const handlers = new Map();

  const mock = vi.fn((url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }

    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });

  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };

  return mock;
}

const RELEASES = 'api.github.com/repos/inuyasha97/openany/releases';

const releaseFeed = (tag) => ({
  ok: true,
  json: async () => ({ tag_name: tag }),
});

describe('checkForUpdates', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('offers an update from this fork own releases', async () => {
    fetchMock.when(`${RELEASES}/latest`, releaseFeed('openany-v1.10.0'));

    const result = await checkForUpdates({ appType: 'desktop-electron', currentVersion: '1.9.10' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(result.currentVersion).toBe('1.9.10');
    expect(result.releaseUrl).toBe('https://github.com/inuyasha97/openany/releases/tag/openany-v1.10.0');
  });

  it('answers no update when the released version is the installed one', async () => {
    fetchMock.when(`${RELEASES}/latest`, releaseFeed('openany-v1.9.10'));

    const result = await checkForUpdates({ appType: 'desktop-electron', currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  it('ignores a release whose tag is not this build tag scheme', async () => {
    // An upstream-shaped tag on the fork's own repository is not a release of
    // this build, so it must not be offered as an update.
    fetchMock.when(`${RELEASES}/latest`, releaseFeed('v9.9.9'));

    const result = await checkForUpdates({ appType: 'desktop-electron', currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to determine versions');
  });

  it('reports no channel for a web install, and never fetches a package registry', async () => {
    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toMatch(/not installed from a package registry/);
    expect(result.error).toContain('https://github.com/inuyasha97/openany/releases');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports no channel for an extension install either', async () => {
    const result = await checkForUpdates({ appType: 'vscode', currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves an Android APK asset from the fork own release', async () => {
    fetchMock
      .when(`${RELEASES}/latest`, releaseFeed('openany-v1.10.0'))
      .when(`${RELEASES}/tags/openany-v1.10.0`, {
        ok: true,
        json: async () => ({
          assets: [
            { name: 'OpenAny-1.10.0-42-android.aab', browser_download_url: 'https://downloads.example/OpenAny-1.10.0-42-android.aab' },
            { name: 'app-release.apk', browser_download_url: 'https://downloads.example/app-release.apk' },
            { name: 'OpenAny-1.10.0-42-android.apk', browser_download_url: 'https://downloads.example/OpenAny-1.10.0-42-android.apk' },
          ],
        }),
      });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '1.9.10',
    });

    expect(result.downloadUrl).toBe('https://downloads.example/OpenAny-1.10.0-42-android.apk');
  });
});

describe('a deployment with its own update service', () => {
  afterEach(() => {
    delete process.env.OPENCHAMBER_UPDATE_API_URL;
    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    vi.resetModules();
  });

  it('uses it, and reports no usage in enterprise mode', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://updates.example/v1/update/check';
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    vi.resetModules();
    const fetchMock = createFetchMock().when('updates.example', {
      ok: true,
      json: async () => ({ latestVersion: '1.10.0', updateAvailable: true, releaseNotes: '' }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const { checkForUpdates: check } = await import('./package-manager.js');
      const result = await check({ appType: 'desktop-electron', currentVersion: '1.9.10', installId: 'abc' });

      expect(result.available).toBe(true);
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(sent.reportUsage).toBe(false);
      expect(sent.installId).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
  });

  it('refuses to install, rather than fetching upstream package over this build', () => {
    const result = executeUpdate();

    expect(result.success).toBe(false);
    expect(result.error).toContain('https://github.com/inuyasha97/openany/releases');
  });
});
