/**
 * The state that must survive a Vite HMR reload: the shutdown latch and the
 * signal-attachment latch. Both exist so a module-graph reload does not attach
 * a second set of signal handlers or lose the fact that a shutdown is already
 * under way.
 *
 * The OpenCode-era version of this module also carried a managed process, its
 * port, base URL, working directory, and a provider password. This fork runs no
 * such process: the agent runtime is hosted in process, so none of those values
 * had a writer or a reader left, and they are gone.
 */
export const createHmrStateRuntime = (dependencies) => {
  const {
    globalThisLike,
    stateKey,
  } = dependencies;

  const getOrCreateHmrState = () => {
    if (!globalThisLike[stateKey]) {
      globalThisLike[stateKey] = {
        isShuttingDown: false,
        signalsAttached: false,
      };
    }
    return globalThisLike[stateKey];
  };

  const syncStateFromRuntime = (hmrState, runtime) => {
    hmrState.isShuttingDown = runtime.isShuttingDown;
    hmrState.signalsAttached = runtime.signalsAttached;
  };

  const restoreRuntimeFromState = ({ hmrState }) => ({
    isShuttingDown: hmrState.isShuttingDown,
    signalsAttached: hmrState.signalsAttached,
  });

  return {
    getOrCreateHmrState,
    syncStateFromRuntime,
    restoreRuntimeFromState,
  };
};
