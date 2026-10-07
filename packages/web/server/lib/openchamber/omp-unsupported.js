/**
 * Something a feature asked OpenCode for that the OMP runtime has no
 * counterpart of (a synthetic message, a command dispatch, a session agent, a
 * model variant, prompt attachments).
 *
 * Thrown rather than dropped or substituted: a caller has to fail visibly
 * instead of silently losing the input or running a different request.
 */
export const unsupportedOnOmp = (what) => Object.assign(
  new Error(`${what} is not supported on the OMP runtime`),
  { name: 'OmpUnsupportedError', code: 'OMP_UNSUPPORTED', status: 501 },
);
