/**
 * OpenChamber-owned environment and binary resolution.
 *
 * This is the part of the deleted OpenCode environment runtime that never had
 * anything to do with the OpenCode CLI: the login-shell snapshot a Finder- or
 * Dock-launched process needs to inherit, the PATH search used to find `docker`
 * and `git`, and the Windows-aware `git` resolution the fs and terminal routes
 * spawn through. The OpenCode binary resolution that used to live beside it is
 * gone with the OpenCode server.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clearAppImageArgv0FromProcessEnv } from '../inherited-env.js';
import { mergePathValues } from './path-utils.js';
import { providedLoginShellEnvSnapshot } from './login-shell-env.js';

// Login-shell probes source the user's rc files. A slow or interactive rc
// (nvm, pyenv, a prompt waiting for input) must not hold server startup
// hostage: a probe that overruns is abandoned and resolution falls through
// to the next candidate. Electron's own login-shell probe uses the same bound.
const SHELL_PROBE_TIMEOUT_MS = 5_000;
// Windows probes run synchronously on the startup path; an unbounded one (a
// PowerShell profile on a stuck OneDrive folder, `where` walking a dead
// network drive in PATH) hangs the whole process with no output.
const WINDOWS_PROBE_TIMEOUT_MS = 10_000;

// Interactive rc files may print a banner, motd or other text to stdout before
// the shell runs the probe command. That text would otherwise fuse with the
// first `env -0` entry, so a marker line is echoed right before `env -0` and
// only what follows the last marker line is parsed. Electron's probe does the
// same.
const LOGIN_SHELL_ENV_MARKER = '__OPENCHAMBER_ENV__';
const LOGIN_SHELL_ENV_COMMAND = `echo ${LOGIN_SHELL_ENV_MARKER}; env -0`;

const state = {
  cachedLoginShellEnvSnapshot: undefined,
  resolvedGitBinary: null,
};

const stripShellStartupOutput = (text) => {
  const markerLine = `${LOGIN_SHELL_ENV_MARKER}\n`;
  const markerIndex = text.lastIndexOf(markerLine);
  return markerIndex === -1 ? text : text.slice(markerIndex + markerLine.length);
};

const parseNullSeparatedEnvSnapshot = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const result = {};
  const entries = raw.split('\0');
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const idx = entry.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    result[key] = value;
  }

  if (Object.keys(result).length === 0) {
    return null;
  }

  if (process.platform === 'win32' && typeof result.PATH !== 'string') {
    const pathEntry = Object.entries(result).find(([key]) => key.toLowerCase() === 'path');
    if (pathEntry && typeof pathEntry[1] === 'string') {
      result.PATH = pathEntry[1];
    }
  }

  return result;
};

export const isExecutable = (filePath) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const searchPathFor = (binaryName, searchPath = process.env.PATH || '') => {
  const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
  if (!trimmed) {
    return null;
  }

  const parts = searchPath.split(path.delimiter).filter(Boolean);
  const candidateNames = [];

  if (process.platform === 'win32' && !path.extname(trimmed)) {
    const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
    for (const ext of pathExt.split(';')) {
      const normalizedExt = ext.trim();
      if (!normalizedExt) continue;
      const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
      if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
        candidateNames.push(candidateName);
      }
    }
  }

  candidateNames.push(trimmed);

  for (const dir of parts) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(dir, candidateName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

export const resolveGitBinaryForSpawn = () => {
  if (process.platform !== 'win32') {
    return 'git';
  }

  if (state.resolvedGitBinary) {
    return state.resolvedGitBinary;
  }

  const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      state.resolvedGitBinary = candidate;
      return state.resolvedGitBinary;
    }
  }

  const candidates = [];
  const normalizeGitCandidate = (candidate) => {
    if (typeof candidate !== 'string') {
      return '';
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      return '';
    }
    const ext = path.extname(trimmed).toLowerCase();
    if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
      const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
      if (isExecutable(exeCandidate)) {
        return exeCandidate;
      }
    }
    return trimmed;
  };

  const pathCandidate = normalizeGitCandidate(searchPathFor('git'));
  if (pathCandidate && isExecutable(pathCandidate)) {
    candidates.push(pathCandidate);
  }

  const pathExeCandidate = normalizeGitCandidate(searchPathFor('git.exe'));
  if (pathExeCandidate && isExecutable(pathExeCandidate)) {
    candidates.push(pathExeCandidate);
  }

  const programRoots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const root of programRoots) {
    const installCandidates = [
      path.join(root, 'Git', 'cmd', 'git.exe'),
      path.join(root, 'Git', 'bin', 'git.exe'),
      path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'),
      path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'),
      path.join(root, 'Programs', 'Git', 'bin', 'git.exe'),
    ];
    for (const candidate of installCandidates) {
      const normalized = normalizeGitCandidate(candidate);
      if (normalized && isExecutable(normalized)) {
        candidates.push(normalized);
      }
    }
  }

  const preferredExe = candidates.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  state.resolvedGitBinary = preferredExe || candidates[0] || 'git.exe';
  return state.resolvedGitBinary;
};

const getWindowsShellEnvSnapshot = () => {
  const parseResult = (stdout) => parseNullSeparatedEnvSnapshot(typeof stdout === 'string' ? stdout : '');

  const psScript = [
    '$entries = [ordered]@{}',
    'Get-ChildItem Env: | ForEach-Object { $entries[$_.Name] = $_.Value }',
    "$pathValues = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Process')) | Where-Object { $_ }",
    "if ($pathValues.Count -gt 0) { $entries['Path'] = ($pathValues -join ';') }",
    "$entries.GetEnumerator() | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }",
  ].join('; ');

  const powershellCandidates = [
    'pwsh.exe',
    'powershell.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const shellPath of powershellCandidates) {
    try {
      const result = spawnSync(shellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        timeout: WINDOWS_PROBE_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        continue;
      }
      const parsed = parseResult(result.stdout);
      if (parsed) {
        return parsed;
      }
    } catch {
    }
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  try {
    const result = spawnSync(comspec, ['/d', '/s', '/c', 'set'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      timeout: WINDOWS_PROBE_TIMEOUT_MS,
    });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.length > 0) {
      return parseNullSeparatedEnvSnapshot(result.stdout.replace(/\r?\n/g, '\0'));
    }
  } catch {
  }

  return null;
};

export const getLoginShellEnvSnapshot = () => {
  if (state.cachedLoginShellEnvSnapshot !== undefined) {
    return state.cachedLoginShellEnvSnapshot;
  }

  // An embedding host (Desktop) that already probed the login shell hands
  // its snapshot over; see login-shell-env.js.
  const provided = providedLoginShellEnvSnapshot();
  if (provided !== undefined) {
    state.cachedLoginShellEnvSnapshot = provided;
    return provided;
  }

  if (process.platform === 'win32') {
    const windowsSnapshot = getWindowsShellEnvSnapshot();
    state.cachedLoginShellEnvSnapshot = windowsSnapshot;
    return windowsSnapshot;
  }

  const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);

  for (const shellPath of shellCandidates) {
    if (!isExecutable(shellPath)) {
      continue;
    }

    try {
      const result = spawnSync(shellPath, ['-lic', LOGIN_SHELL_ENV_COMMAND], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        timeout: SHELL_PROBE_TIMEOUT_MS,
      });

      if (result.status !== 0) {
        continue;
      }

      const parsed = parseNullSeparatedEnvSnapshot(stripShellStartupOutput(result.stdout || ''));
      if (parsed) {
        state.cachedLoginShellEnvSnapshot = parsed;
        return parsed;
      }
    } catch {
    }
  }

  state.cachedLoginShellEnvSnapshot = null;
  return null;
};

export const applyLoginShellEnvSnapshot = () => {
  // Always clear AppImage ARGV0, even when no login-shell snapshot is available.
  // Otherwise a leaked process.env.ARGV0 survives into later child spawns (#2588).
  clearAppImageArgv0FromProcessEnv();

  const snapshot = getLoginShellEnvSnapshot();
  if (!snapshot) {
    return;
  }

  const skipKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'ARGV0']);
  for (const [key, value] of Object.entries(snapshot)) {
    if (skipKeys.has(key)) {
      continue;
    }
    const existing = process.env[key];
    if (typeof existing === 'string' && existing.length > 0) {
      continue;
    }
    process.env[key] = value;
  }

  const currentPath = process.env.PATH || '';
  const shellPath = snapshot.PATH || '';
  if (!shellPath) {
    return;
  }

  process.env.PATH = mergePathValues(shellPath, currentPath, path.delimiter);
};
