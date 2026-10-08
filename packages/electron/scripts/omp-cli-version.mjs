/**
 * The OMP CLI release the desktop stages into `resources/omp-cli`.
 *
 * `prepare-omp-cli.mjs` copies the matching GitHub release artifact and
 * `verify-linux-appimage.mjs` asserts the packaged binary reports this version.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const DEFAULT_OMP_CLI_VERSION = '18.1.11';

/** `OPENCHAMBER_OMP_CLI_VERSION` overrides the pin for a one-off packaging run. */
export const readPinnedOmpCliVersion = () => {
  const version = String(process.env.OPENCHAMBER_OMP_CLI_VERSION || DEFAULT_OMP_CLI_VERSION).trim();
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`OPENCHAMBER_OMP_CLI_VERSION must be an exact version, got: ${version || '(missing)'}`);
  }
  return version;
};

/** `omp --version` answers `omp/18.1.11`; older output is a bare version. */
export const parseOmpCliVersion = (output) => {
  const match = /(\d+)\.(\d+)\.(\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(output || ''));
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
};
