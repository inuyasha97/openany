/**
 * Workflow definitions read from `<projectDirectory>/.openchamber/workflows/*.yaml`.
 *
 * A definition is validated the same way in the engine and in the UI: every
 * failure is reported as `{ field, message }` rather than thrown, so a broken
 * file shows up in the screens instead of disappearing from the list.
 */
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

const WORKFLOW_DIR = '.openchamber/workflows';
const DEFINITION_EXTENSIONS = ['.yaml', '.yml'];
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const STEP_FIELDS = new Set(['id', 'title', 'prompt', 'session', 'permissions', 'verify']);
const DEFINITION_FIELDS = new Set(['id', 'name', 'version', 'inputs', 'sandbox', 'steps']);
const INPUT_FIELDS = new Set(['name', 'description', 'required']);
const VERIFY_FIELDS = new Set(['artifacts', 'commands']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const isWorkflowId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

const findPlaceholders = (text) => [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1].trim());

/**
 * A refusal the routes answer with. The parser's own first error is the message,
 * so the person reads the schema's reason rather than a rewritten one, and the
 * status travels with the error the way `WorkflowError`'s does.
 */
class DefinitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DefinitionError';
    this.code = code;
    this.status = code === 'conflict' ? 409 : 400;
  }
}

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
  // Where the run executes is a declaration, not a preference: a value the
  // engine does not know would silently change what a person asked for.
  if (raw.sandbox !== undefined && !['worktree', 'working-tree'].includes(raw.sandbox)) {
    errors.push({ field: 'sandbox', message: 'must be "worktree" or "working-tree"' });
  }

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
      if (STEP_FIELDS.has(key)) continue;
      // `confirm` was a decision the engine made on a person's behalf, so it is
      // refused by name with a migration hint rather than read as a typo.
      if (key === 'confirm') {
        errors.push({ field: `${field}.confirm`, message: '"confirm" is gone: every step becomes done only when a person confirms it' });
        continue;
      }
      errors.push({ field, message: `unknown field "${key}"` });
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
    if (!isName(step.id) || !isText(step.prompt)) return null;
    return {
      id: step.id,
      title: typeof step.title === 'string' && step.title.trim() ? step.title : step.id,
      prompt: step.prompt,
      session: step.session === 'reuse' ? 'reuse' : 'new',
      permissions: step.permissions === 'auto' ? 'auto' : 'ask',
      verify: { artifacts, commands },
    };
  }).filter(Boolean);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    // A definition written before this field existed means `worktree`: every run
    // records the mode it actually used, so an old run keeps reading the way it ran.
    definition: {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      sandbox: raw.sandbox === 'working-tree' ? 'working-tree' : 'worktree',
      inputs: normalizedInputs,
      steps,
      file,
    },
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
      // The hash is of the bytes on disk, so an editor can hand it back on a save
      // and be told when someone else changed the file in between. A file that
      // cannot be read has no hash to answer, the same way it has no id.
      let hash = null;
      try {
        const raw = await fsPromises.readFile(path.join(directory, name), 'utf8');
        hash = hashOf(raw);
        parsed = parseDefinition(raw, { file: name });
      } catch (error) {
        results.push({ file: name, hash, id: null, name: null, version: null, errors: [{ field: '$', message: error?.message ?? 'unreadable' }], definition: null });
        continue;
      }
      results.push(parsed.ok
        ? { file: name, hash, id: parsed.definition.id, name: parsed.definition.name, version: parsed.definition.version, errors: [], definition: parsed.definition }
        : { file: name, hash, id: null, name: null, version: null, errors: parsed.errors, definition: null });
    }
    return results;
  };

  const read = async (projectId, workflowId) => {
    const found = (await list(projectId)).find((entry) => entry.id === workflowId && entry.definition);
    return found ? found.definition : null;
  };

  const hashOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

  const exists = async (file) => {
    try {
      await fsPromises.access(file);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * The file a definition already lives in, or `null`. `list` accepts both
   * extensions, so a write that ignored an existing `.yml` would give one id two
   * files: two rows in the list and two hashes for one definition's text.
   */
  const existingFile = async (directory, workflowId) => {
    for (const extension of DEFINITION_EXTENSIONS) {
      const file = path.join(directory, `${workflowId}${extension}`);
      if (await exists(file)) return file;
    }
    return null;
  };

  const fileFor = async (projectId, workflowId) => {
    const directory = directoryFor(projectId);
    if (!directory) throw new DefinitionError('invalid', 'the project has no directory to write a workflow into');
    // The id is the file name, so it is checked before it is ever joined: an id
    // the parser would refuse must not name a file, least of all outside the
    // workflows directory.
    if (!isWorkflowId(workflowId)) throw new DefinitionError('invalid', `invalid workflow id "${workflowId}"`);
    const file = (await existingFile(directory, workflowId)) ?? path.join(directory, `${workflowId}${DEFINITION_EXTENSIONS[0]}`);
    return { directory, file, name: path.basename(file) };
  };

  /**
   * Write a definition, but only after the parser accepts it and its `id` matches
   * the id being written. A body that fails to parse, or that renames itself,
   * would either not load or orphan the runs that reference the old id, and the
   * person would have lost the file they had.
   *
   * The text lands through a temporary in the same directory, so a reader sees
   * the old file or the new one and never half of either. `expectedHash` is the
   * hash of the text the caller read; a file someone else changed since then is
   * refused rather than silently overwritten.
   */
  const write = async (projectId, workflowId, rawText, options = {}) => {
    if (typeof rawText !== 'string') throw new DefinitionError('invalid', 'the definition text is required');
    const parsed = parseDefinition(rawText, { file: `${workflowId}.yaml` });
    if (!parsed.ok) {
      const first = parsed.errors[0];
      throw new DefinitionError('invalid', `${first.field}: ${first.message}`);
    }
    if (parsed.definition.id !== workflowId) {
      throw new DefinitionError('invalid', `the definition's id "${parsed.definition.id}" does not match ${workflowId}.yaml`);
    }
    const { directory, file, name } = await fileFor(projectId, workflowId);
    if (options.expectedHash) {
      const current = await fsPromises.readFile(file, 'utf8').catch(() => null);
      if (current !== null && hashOf(current) !== options.expectedHash) {
        throw new DefinitionError('conflict', `${name} changed on disk since it was read`);
      }
    }
    await fsPromises.mkdir(directory, { recursive: true });
    // One temporary per write: two overlapping writes of the same definition
    // must not share a name, or the second `writeFile` (flag `w`, truncating)
    // could cut what the first wrote while this path awaits before the rename.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fsPromises.writeFile(temporary, rawText, 'utf8');
      await fsPromises.rename(temporary, file);
    } catch (error) {
      // A half-written temporary is the one trace a failed write could leave in
      // a person's project; it is removed before the failure travels.
      await fsPromises.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return { file: name, id: workflowId, hash: hashOf(rawText) };
  };

  /** Delete a definition's file. `false` means there was nothing to delete. */
  const remove = async (projectId, workflowId) => {
    const { file } = await fileFor(projectId, workflowId);
    try {
      await fsPromises.unlink(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };

  /**
   * The text an editor opens, with the hash it was read at and the file it came
   * from, or `null`. A definition that is not there yet is the ordinary first
   * case for this call — an editor asks for the file before a person has written
   * it — so a missing or unreadable file is answered, not thrown.
   */
  const readSource = async (projectId, workflowId) => {
    const directory = directoryFor(projectId);
    if (!directory || !isWorkflowId(workflowId)) return null;
    const file = await existingFile(directory, workflowId);
    if (!file) return null;
    try {
      const raw = await fsPromises.readFile(file, 'utf8');
      return { raw, hash: hashOf(raw), file: path.basename(file) };
    } catch {
      return null;
    }
  };

  return { list, read, write, remove, readSource, directoryFor };
};
