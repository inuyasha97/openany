/**
 * Workflow definitions read from `<projectDirectory>/.openchamber/workflows/*.yaml`.
 *
 * A definition is validated the same way in the engine and in the UI: every
 * failure is reported as `{ field, message }` rather than thrown, so a broken
 * file shows up in the screens instead of disappearing from the list.
 */
import { parse as parseYaml } from 'yaml';

const WORKFLOW_DIR = '.openchamber/workflows';
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const STEP_FIELDS = new Set(['id', 'title', 'prompt', 'session', 'permissions', 'verify', 'confirm']);
const DEFINITION_FIELDS = new Set(['id', 'name', 'version', 'inputs', 'steps']);
const INPUT_FIELDS = new Set(['name', 'description', 'required']);
const VERIFY_FIELDS = new Set(['artifacts', 'commands']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const isWorkflowId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

const findPlaceholders = (text) => [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1].trim());

const normalizeArtifacts = (value, field, errors) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be a list' });
    return [];
  }
  return value.map((entry, index) => {
    if (typeof entry === 'string') {
      return isText(entry)
        ? { glob: entry, hash: false }
        : (errors.push({ field: `${field}[${index}]`, message: 'must be a non-empty string' }), null);
    }
    if (isRecord(entry)) {
      const extra = Object.keys(entry).filter((key) => key !== 'glob' && key !== 'hash');
      if (extra.length > 0) errors.push({ field: `${field}[${index}]`, message: `unknown field "${extra[0]}"` });
      if (!isText(entry.glob)) errors.push({ field: `${field}[${index}].glob`, message: 'must be a non-empty string' });
      if (entry.hash !== undefined && typeof entry.hash !== 'boolean') errors.push({ field: `${field}[${index}].hash`, message: 'must be a boolean' });
      return isText(entry.glob) ? { glob: entry.glob, hash: entry.hash === true } : null;
    }
    errors.push({ field: `${field}[${index}]`, message: 'must be a string or a mapping' });
    return null;
  }).filter(Boolean);
};

const normalizeCommands = (value, field, errors) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'must be a list' });
    return [];
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      errors.push({ field: `${field}[${index}]`, message: 'must be a mapping' });
      return null;
    }
    const extra = Object.keys(entry).filter((key) => !['run', 'expectExit', 'timeoutMs'].includes(key));
    if (extra.length > 0) errors.push({ field: `${field}[${index}]`, message: `unknown field "${extra[0]}"` });
    if (!isText(entry.run)) errors.push({ field: `${field}[${index}].run`, message: 'must be a non-empty string' });
    if (entry.expectExit !== undefined && !Number.isInteger(entry.expectExit)) {
      errors.push({ field: `${field}[${index}].expectExit`, message: 'must be an integer' });
    }
    if (entry.timeoutMs !== undefined && !(Number.isInteger(entry.timeoutMs) && entry.timeoutMs > 0)) {
      errors.push({ field: `${field}[${index}].timeoutMs`, message: 'must be a positive integer' });
    }
    if (!isText(entry.run)) return null;
    return {
      run: entry.run,
      expectExit: Number.isInteger(entry.expectExit) ? entry.expectExit : 0,
      timeoutMs: Number.isInteger(entry.timeoutMs) ? entry.timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS,
    };
  }).filter(Boolean);
};

export const parseDefinition = (rawText, { file = 'unknown.yaml' } = {}) => {
  const errors = [];
  let raw;
  try {
    raw = parseYaml(rawText);
  } catch (error) {
    return { ok: false, errors: [{ field: '$', message: error?.message ?? 'invalid YAML' }] };
  }
  if (!isRecord(raw)) return { ok: false, errors: [{ field: '$', message: 'must be a mapping' }] };

  for (const key of Object.keys(raw)) {
    if (!DEFINITION_FIELDS.has(key)) errors.push({ field: key, message: `unknown field "${key}"` });
  }
  if (!isWorkflowId(raw.id)) errors.push({ field: 'id', message: 'must be lowercase words, dots or dashes' });
  if (!isText(raw.name)) errors.push({ field: 'name', message: 'is required' });
  if (!Number.isInteger(raw.version) || raw.version < 1) errors.push({ field: 'version', message: 'must be a positive integer' });

  const inputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  if (raw.inputs !== undefined && !Array.isArray(raw.inputs)) errors.push({ field: 'inputs', message: 'must be a list' });
  const inputNames = new Set();
  const normalizedInputs = inputs.map((input, index) => {
    if (!isRecord(input)) {
      errors.push({ field: `inputs[${index}]`, message: 'must be a mapping' });
      return null;
    }
    for (const key of Object.keys(input)) {
      if (!INPUT_FIELDS.has(key)) errors.push({ field: `inputs[${index}]`, message: `unknown field "${key}"` });
    }
    if (!isName(input.name)) errors.push({ field: `inputs[${index}].name`, message: 'must be lowercase words or dashes' });
    if (inputNames.has(input.name)) errors.push({ field: `inputs[${index}].name`, message: `duplicate input "${input.name}"` });
    inputNames.add(input.name);
    if (input.description !== undefined && typeof input.description !== 'string') {
      errors.push({ field: `inputs[${index}].description`, message: 'must be a string' });
    }
    return isName(input.name) ? { name: input.name, description: input.description ?? '', required: input.required === true } : null;
  }).filter(Boolean);

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    errors.push({ field: 'steps', message: 'must be a non-empty list' });
    return { ok: false, errors };
  }

  const stepIds = new Set();
  const steps = raw.steps.map((step, index) => {
    const field = `steps[${index}]`;
    if (!isRecord(step)) {
      errors.push({ field, message: 'must be a mapping' });
      return null;
    }
    for (const key of Object.keys(step)) {
      if (!STEP_FIELDS.has(key)) errors.push({ field, message: `unknown field "${key}"` });
    }
    if (!isName(step.id)) errors.push({ field: `${field}.id`, message: 'must be lowercase words or dashes' });
    if (isName(step.id)) {
      if (stepIds.has(step.id)) errors.push({ field: `${field}.id`, message: `duplicate step id "${step.id}"` });
      stepIds.add(step.id);
    }
    if (step.title !== undefined && typeof step.title !== 'string') errors.push({ field: `${field}.title`, message: 'must be a string' });
    if (!isText(step.prompt)) errors.push({ field: `${field}.prompt`, message: 'is required' });
    if (step.session !== undefined && !['new', 'reuse'].includes(step.session)) {
      errors.push({ field: `${field}.session`, message: 'must be "new" or "reuse"' });
    }
    if (step.permissions !== undefined && !['ask', 'auto'].includes(step.permissions)) {
      errors.push({ field: `${field}.permissions`, message: 'must be "ask" or "auto"' });
    }
    if (step.confirm !== undefined && !['human', 'auto'].includes(step.confirm)) {
      errors.push({ field: `${field}.confirm`, message: 'must be "human" or "auto"' });
    }
    if (isText(step.prompt)) {
      for (const placeholder of findPlaceholders(step.prompt)) {
        if (!inputNames.has(placeholder)) errors.push({ field: `${field}.prompt`, message: `unknown input "${placeholder}"` });
      }
    }
    const verify = isRecord(step.verify) ? step.verify : {};
    if (step.verify !== undefined && !isRecord(step.verify)) errors.push({ field: `${field}.verify`, message: 'must be a mapping' });
    for (const key of Object.keys(verify)) {
      if (!VERIFY_FIELDS.has(key)) errors.push({ field: `${field}.verify`, message: `unknown field "${key}"` });
    }
    const artifacts = normalizeArtifacts(verify.artifacts, `${field}.verify.artifacts`, errors);
    const commands = normalizeCommands(verify.commands, `${field}.verify.commands`, errors);
    const confirm = step.confirm === 'auto' ? 'auto' : 'human';
    if (confirm === 'auto' && artifacts.length === 0 && commands.length === 0) {
      errors.push({ field, message: 'confirm: auto needs a verifier, or the step advances on a guess' });
    }
    if (!isName(step.id) || !isText(step.prompt)) return null;
    return {
      id: step.id,
      title: typeof step.title === 'string' && step.title.trim() ? step.title : step.id,
      prompt: step.prompt,
      session: step.session === 'reuse' ? 'reuse' : 'new',
      permissions: step.permissions === 'auto' ? 'auto' : 'ask',
      verify: { artifacts, commands },
      confirm,
    };
  }).filter(Boolean);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    definition: { id: raw.id, name: raw.name, version: raw.version, inputs: normalizedInputs, steps, file },
  };
};

const readDirectory = async (fsPromises, directory) => {
  try {
    return await fsPromises.readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

export const createWorkflowDefinitions = ({ fsPromises, path, projectPathFromId }) => {
  const directoryFor = (projectId) => {
    const projectDirectory = projectPathFromId(projectId);
    if (!projectDirectory) return null;
    return path.join(projectDirectory, WORKFLOW_DIR);
  };

  const list = async (projectId) => {
    const directory = directoryFor(projectId);
    if (!directory) return [];
    const entries = (await readDirectory(fsPromises, directory))
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
      .sort();
    const results = [];
    for (const name of entries) {
      let parsed;
      try {
        const raw = await fsPromises.readFile(path.join(directory, name), 'utf8');
        parsed = parseDefinition(raw, { file: name });
      } catch (error) {
        results.push({ file: name, id: null, name: null, version: null, errors: [{ field: '$', message: error?.message ?? 'unreadable' }], definition: null });
        continue;
      }
      results.push(parsed.ok
        ? { file: name, id: parsed.definition.id, name: parsed.definition.name, version: parsed.definition.version, errors: [], definition: parsed.definition }
        : { file: name, id: null, name: null, version: null, errors: parsed.errors, definition: null });
    }
    return results;
  };

  const read = async (projectId, workflowId) => {
    const found = (await list(projectId)).find((entry) => entry.id === workflowId && entry.definition);
    return found ? found.definition : null;
  };

  return { list, read, directoryFor };
};
