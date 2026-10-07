/**
 * Whether the server has the OMP runtime mounted.
 *
 * In this fork OMP is the only runtime and its routes are always registered, so
 * the runtime is always available. The probe is kept as a constant-returning
 * module so callers that gate on availability need no change, and no request is
 * spent asking a question with one answer.
 */

/** Always true: the OMP routes are registered unconditionally. */
export const isOmpRuntimeAvailable = (): Promise<boolean> => Promise.resolve(true)
