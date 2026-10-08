// The one place that writes the agent's own files inside a space, so an OMP format change is
// a one-file edit (DESIGN.md, "Parts"). Today: the provider configuration that sends a provider's
// model calls through the gatekeeper's window. The login record for the short OpenAI token and
// the move of a chat to the host's archive belong here too, in their stages.
//
// What is written here cooperates and enforces nothing. The agent can change or delete the file;
// the gatekeeper is what keeps the key out of the space and the space away from the internet.

import yaml from 'yaml';

import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { IMAGE_ONLY_PATH, IMAGE_SH, SPACE_AGENT_DIRECTORY, SPACE_MODELS_CONFIG_PATH, spaceWindowUrl } from './layout.js';

// OMP takes this as the provider's key and its own auth resolution stays out of the way; the
// window throws it away and puts the real one in its place. It is not a secret and never was one.
export const WINDOW_PLACEHOLDER_KEY = 'space-window';

// Through a temporary name, so OMP never reads half a file. The configuration is YAML on
// stdin: nothing of it is an argument.
const WRITE_CONFIG_SCRIPT = [
  IMAGE_ONLY_PATH,
  `mkdir -p ${SPACE_AGENT_DIRECTORY}`,
  `&& cat > ${SPACE_MODELS_CONFIG_PATH}.new && mv ${SPACE_MODELS_CONFIG_PATH}.new ${SPACE_MODELS_CONFIG_PATH}`,
].join(' ');

/**
 * OMP's provider overrides for a space with these model grants: each provider, under the id the
 * host's catalog gives it, with its base URL at the window and a placeholder key. The composer
 * offers the host's catalog, and the same provider id inside is what makes that choice work in the
 * space unchanged. Decided with the maintainer on 2026-09-26.
 *
 * The shape is OMP's `models.yml`: `providers.<id>.baseUrl` and `providers.<id>.apiKey`
 * (`pi-coding-agent/src/config/models-config-schema-bundle.ts`, `ProviderConfigSchema`). No
 * `$schema` and no `provider.options` wrapper, the two things the replaced agent's file carried.
 */
export function buildProviderConfig(grants) {
  const providers = {};
  for (const grant of grants) {
    if (grant.kind !== 'model') continue;
    providers[grant.provider] = { baseUrl: spaceWindowUrl(grant.id), apiKey: WINDOW_PLACEHOLDER_KEY };
  }
  return { providers };
}

/** `exec` is the place operation, always for the space container. */
export function createSpaceAgent({ exec }) {
  /** Writes the whole provider configuration from the model grants the record holds. */
  const writeProviderConfig = async (spaceId, grants) => {
    const text = yaml.stringify(buildProviderConfig(grants), { indent: 2 });
    const result = await exec(spaceId, [IMAGE_SH, '-c', WRITE_CONFIG_SCRIPT], { stdin: text });
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not write the provider configuration inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
  };

  return { writeProviderConfig };
}
