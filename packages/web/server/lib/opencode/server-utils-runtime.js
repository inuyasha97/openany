import { pathLooksUserConfigured, mergePathValues } from '../openchamber/path-utils.js';

/**
 * Shared PATH and SSE plumbing for the server's child processes.
 *
 * The OpenCode port/readiness/proxy wiring that used to live here is gone with
 * the OpenCode server; what remains is OpenChamber-owned: the augmented PATH a
 * spawned terminal, git or guest process needs, the Windows toolchain
 * directories, and the SSE data-block parser the event consumers share.
 */
export const createServerUtilsRuntime = (dependencies) => {
  const {
    fs,
    os,
    path,
    process,
    getLoginShellPath,
  } = dependencies;

  const getEnvValue = (name) => {
    const env = process.env || {};
    if (typeof env[name] === 'string') return env[name];
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key && typeof env[key] === 'string' ? env[key] : '';
  };

  const buildWindowsManagedToolchainPath = () => {
    if (process.platform !== 'win32') return '';

    const home = os.homedir();
    const userProfile = getEnvValue('USERPROFILE') || home;
    const appData = getEnvValue('APPDATA') || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const localAppData = getEnvValue('LOCALAPPDATA') || (userProfile ? path.join(userProfile, 'AppData', 'Local') : '');
    const programFiles = getEnvValue('ProgramFiles') || 'C:\\Program Files';
    const programFilesX86 = getEnvValue('ProgramFiles(x86)');
    const programData = getEnvValue('ProgramData') || 'C:\\ProgramData';
    const bunInstall = getEnvValue('BUN_INSTALL');
    const voltaHome = getEnvValue('VOLTA_HOME');
    const scoop = getEnvValue('SCOOP');
    const scoopGlobal = getEnvValue('SCOOP_GLOBAL');

    const candidates = [
      path.join(appData, 'npm'),
      path.join(programFiles, 'nodejs'),
      programFilesX86 ? path.join(programFilesX86, 'nodejs') : '',
      path.join(localAppData, 'Programs', 'nodejs'),
      getEnvValue('PNPM_HOME'),
      path.join(localAppData, 'pnpm'),
      bunInstall ? path.join(bunInstall, 'bin') : '',
      path.join(userProfile, '.bun', 'bin'),
      voltaHome ? path.join(voltaHome, 'bin') : '',
      path.join(localAppData, 'Volta', 'bin'),
      path.join(localAppData, 'Yarn', 'bin'),
      path.join(localAppData, 'Yarn', 'Data', 'global', 'node_modules', '.bin'),
      scoop ? path.join(scoop, 'shims') : '',
      path.join(userProfile, 'scoop', 'shims'),
      scoopGlobal ? path.join(scoopGlobal, 'shims') : '',
      path.join(programData, 'chocolatey', 'bin'),
      path.join(localAppData, 'Microsoft', 'WindowsApps'),
      path.join(userProfile, '.opencode', 'bin'),
      path.join(userProfile, '.local', 'bin'),
    ];

    const seen = new Set();
    const existing = [];
    for (const candidate of candidates) {
      const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      try {
        if (fs.existsSync(trimmed)) existing.push(trimmed);
      } catch {
      }
    }

    return existing.join(path.delimiter);
  };

  const buildAugmentedPath = () => {
    const currentPath = getEnvValue('PATH');
    const loginShellPath = getLoginShellPath();
    const home = os.homedir();
    const currentPathLooksUserConfigured = pathLooksUserConfigured(currentPath, home, path.delimiter);
    const primaryPath = currentPathLooksUserConfigured ? currentPath : loginShellPath;
    const fallbackPath = currentPathLooksUserConfigured ? loginShellPath : currentPath;

    return mergePathValues(primaryPath, fallbackPath, path.delimiter);
  };

  const buildManagedOpenCodePath = () => {
    const currentPath = getEnvValue('PATH');
    const loginShellPath = getLoginShellPath();
    const basePath = mergePathValues(loginShellPath || '', currentPath, path.delimiter);

    return mergePathValues(basePath, buildWindowsManagedToolchainPath(), path.delimiter);
  };

  const parseSseDataPayload = (block) => {
    if (!block || typeof block !== 'string') {
      return null;
    }
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^\s/, ''));

    if (dataLines.length === 0) {
      return null;
    }

    const payloadText = dataLines.join('\n').trim();
    if (!payloadText) {
      return null;
    }

    try {
      const parsed = JSON.parse(payloadText);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.payload === 'object' &&
        parsed.payload !== null
      ) {
        return parsed.payload;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  return {
    buildAugmentedPath,
    buildManagedOpenCodePath,
    parseSseDataPayload,
  };
};
