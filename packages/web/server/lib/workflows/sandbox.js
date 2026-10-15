/**
 * The sandbox a run executes in.
 *
 * `worktree` mode gives every run its own checkout and branch, so its steps
 * cannot touch the project working tree and a checkpoint commit lands somewhere
 * reviewable. The branch outlives the worktree: removing the worktree is tidy-up,
 * the merge is a person's decision.
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
const waitForCheckout = async (directory, git) => {
  const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
  for (;;) {
    const status = await git.getWorktreeBootstrapStatus(directory);
    if (status?.status === 'failed') throw new Error(`the worktree could not be prepared: ${status.error || 'unknown error'}`);
    if (status?.status === 'ready' || status?.phase === 'git-ready' || status?.phase === 'setup-ready') return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the worktree checkout');
    await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_POLL_MS));
  }
};

export const prepareSandbox = async ({ run, projectPath, git }) => {
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
  await waitForCheckout(directory, git);
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
