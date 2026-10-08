/**
 * Shared response shape for config mutations.
 *
 * OMP reads every config source it is given — agents, commands, skills, MCP
 * servers — and rebuilds them when a file changes, so a mutation that lands on
 * disk is already live by the time the route answers: config mutations report
 * plain success with no restart flags.
 */

/**
 * `details` carries the file the mutation landed in (`{ path, scope, source }`),
 * so the caller can show the user exactly which file changed.
 */
export function buildAppliedResponse(message, details) {
  return {
    success: true,
    message,
    ...(details && typeof details === 'object' ? details : {}),
  };
}
