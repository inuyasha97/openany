/**
 * A checkpoint as git sees it: a commit holding the step's changes, or the
 * commit that is already HEAD when the step changed nothing.
 *
 * OMP keeps no file snapshots and no per-turn diff, so this commit is the only
 * thing that makes a confirmed step undoable. The message carries the run and
 * the step, which makes git history the checkpoint chain. A repository that
 * cannot answer is an error, never a checkpoint.
 */
import simpleGit from 'simple-git';

export const createGitDriver = () => ({
  status: (directory) => simpleGit(directory).status(),
  revparseHead: (directory) => simpleGit(directory).revparse(['HEAD']),
  add: (directory, files) => simpleGit(directory).add(files),
  commit: (directory, message) => simpleGit(directory).commit(message),
});

const changesOf = (status) => [
  ...(status?.files ?? []).map((file) => file.path),
  ...(status?.not_added ?? []),
].filter((file) => typeof file === 'string' && file.length > 0);

export const createCheckpointWriter = ({ git, now = Date.now }) => ({
  write: async ({ directory, runId, stepId, attemptIndex, artifacts = [] }) => {
    const status = await git.status(directory);
    const changed = [...new Set(changesOf(status))];
    const message = `step ${stepId} [run=${runId} step=${stepId} attempt=${attemptIndex}]`;
    if (changed.length === 0) {
      const commit = (await git.revparseHead(directory)).trim();
      return { at: now(), commit, clean: true, artifacts };
    }
    await git.add(directory, changed);
    const result = await git.commit(directory, message);
    const commit = result?.commit ?? (await git.revparseHead(directory)).trim();
    return { at: now(), commit, clean: false, artifacts };
  },
});
