/**
 * A step's checks: artifacts on disk and commands that must exit as declared.
 *
 * A failure is a result, not an exception: the screen shows which check failed
 * and what it printed. `ok` is true only when every check passed, and a pattern
 * that matched nothing is a failed check, never a quiet pass.
 */
import path from 'node:path';
import { inspectArtifacts, hashFile } from './artifacts.js';
import { runCommandCheck } from './commands.js';

export const runVerifiers = async ({ step, directory, deps = {} }) => {
  const inspect = deps.inspectArtifacts ?? inspectArtifacts;
  const runCommand = deps.runCommand ?? runCommandCheck;
  const patterns = step?.verify?.artifacts ?? [];
  const commands = step?.verify?.commands ?? [];

  let artifacts = [];
  let inspectionError = null;
  if (patterns.length > 0) {
    try {
      artifacts = await inspect({ directory, patterns });
    } catch (error) {
      // A verification that could not run is a failed check, never a crashed
      // run: the person sees which pattern could not be read, and why.
      inspectionError = error?.message ?? 'the artifacts could not be inspected';
      artifacts = patterns.map((pattern) => ({ glob: pattern.glob, path: null, exists: false, size: null, sha256: null }));
    }
  }
  const commandResults = [];
  for (const command of commands) {
    try {
      commandResults.push(await runCommand({
        directory,
        run: command.run,
        expectExit: command.expectExit,
        timeoutMs: command.timeoutMs,
      }));
    } catch (error) {
      commandResults.push({
        run: command.run,
        expectExit: command.expectExit,
        exitCode: null,
        stdout: '',
        stderr: error?.message ?? 'the command could not be started',
        timedOut: false,
        truncated: false,
        durationMs: 0,
        ok: false,
      });
    }
  }

  const ok = artifacts.every((entry) => entry.exists) && commandResults.every((entry) => entry.ok) && inspectionError === null;
  return inspectionError === null
    ? { ok, artifacts, commands: commandResults }
    : { ok, artifacts, commands: commandResults, error: inspectionError };
};

export const verifyCheckpoint = async ({ checkpoint, directory, deps = {} }) => {
  const hash = deps.hashFile ?? hashFile;
  const mismatches = [];
  for (const artifact of checkpoint?.artifacts ?? []) {
    const absolute = path.join(directory, artifact.path);
    let current;
    try {
      current = await hash(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        mismatches.push({ path: artifact.path, reason: 'missing' });
        continue;
      }
      throw error;
    }
    // A checkpoint carries a digest only for an artifact the definition marks
    // `hash: true`. For every other artifact the contract is that the file is
    // still there, so a file that changed is not a mismatch: comparing a real
    // digest against the recorded `null` would report every unhashed step as
    // broken the first time the server restarted.
    if (artifact.sha256 !== null && artifact.sha256 !== undefined) {
      if (current.size !== artifact.size || current.sha256 !== artifact.sha256) {
        mismatches.push({ path: artifact.path, reason: 'changed' });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
};
