/**
 * The sandbox a run executes in.
 *
 * `worktree` mode gives every run its own checkout and branch, so its steps
 * cannot touch the project working tree and anything a step commits stays on a
 * branch of its own. The branch outlives the worktree: removing the worktree is
 * tidy-up, the merge is a person's decision.
 *
 * A git refusal is an error. A run never falls back to the project's working
 * tree, because a person who asked for isolation would be getting the opposite
 * while the screen said `worktree`.
 */
const branchFor = (run) => `omp/wf/${run.runId}`;
const nameFor = (run) => `wf-${run.runId}`;

// `createWorktree` attaches the checkout with `git worktree add --no-checkout`
// and populates it (`git reset --hard`, the post-checkout hook) in a queued
// task (`service.js:1913`), so it returns while the directory is still empty.
// A run whose first step started then would read an empty tree, so the sandbox
// waits for the checkout to be there first — the same wait a session opened on
// a worktree does (`openchamber-sessions/routes.js:408`). `setup-ready` is not
// required: that phase is the project's own setup script, which may be a long
// dependency install and is not what makes the checkout real.
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const BOOTSTRAP_POLL_MS = 150;
// The deadline and the poll are parameters so a test can prove the timeout
// branch without spending the real minute; the defaults are what a run gets.
const waitForCheckout = async (directory, git, { timeoutMs = BOOTSTRAP_TIMEOUT_MS, pollMs = BOOTSTRAP_POLL_MS } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await git.getWorktreeBootstrapStatus(directory);
    if (status?.status === 'failed') throw new Error(`the worktree could not be prepared: ${status.error || 'unknown error'}`);
    if (status?.status === 'ready' || status?.phase === 'git-ready' || status?.phase === 'setup-ready') return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the worktree checkout');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

export const prepareSandbox = async ({ run, projectPath, git, waitOptions = {} }) => {
  if (run.sandbox !== 'worktree') return { directory: projectPath, branch: null, created: false };
  if (run.worktreeBranch && run.directory && run.directory !== projectPath) {
    return { directory: run.directory, branch: run.worktreeBranch, created: false };
  }
  // `createWorktree(projectPath, input)` decides the directory itself, under the
  // app's worktree root, from the name it is handed: it takes no target path
  // (`packages/web/server/lib/git/service.js:4967`, `resolveCandidateDirectory`).
  // The `path` it returns is the run's directory from here on.
  const created = await git.createWorktree(projectPath, { mode: 'new', worktreeName: nameFor(run), branchName: branchFor(run) });
  const directory = created?.path;
  if (!directory) throw new Error('the worktree was created without a directory');
  try {
    await waitForCheckout(directory, git, waitOptions);
  } catch (error) {
    // A checkout that never finished preparing is not a sandbox. The run has
    // recorded neither its directory nor its branch, so nothing would ever
    // release them, and the branch name alone (`omp/wf/<runId>`) would refuse
    // every later attempt with `Branch already exists`. Tear the checkout down
    // here, branch included, and let the original failure be what the person
    // sees: a release that fails is recoverable by hand, the prepare error is
    // what explains the run.
    try {
      await git.removeWorktree(projectPath, { directory, deleteLocalBranch: true });
    } catch {
      // Deliberately swallowed so the prepare error is the one that surfaces.
    }
    throw error;
  }
  return { directory, branch: created.branch ?? branchFor(run), created: true };
};

export const releaseSandbox = async ({ run, projectPath, git }) => {
  if (run.sandbox !== 'worktree' || !run.worktreeBranch || !run.directory || run.directory === projectPath) {
    return { removed: false };
  }
  // `removeWorktree(projectPath, { directory })`: the first argument is the
  // project the worktree belongs to, the second names the checkout to remove
  // (`service.js:5118`). The branch is deliberately left behind.
  await git.removeWorktree(projectPath, { directory: run.directory, deleteLocalBranch: false });
  return { removed: true };
};
