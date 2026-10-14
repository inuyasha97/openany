/**
 * Run state on disk: one JSON file per run, under
 * `<projectsDirPath>/<projectConfigFileStemOf(projectId)>/workflow-runs/<runId>.json`.
 *
 * Run state is an index, not the record. Artifacts and commits live in the
 * project; this file only says which step a run reached and which session each
 * attempt used, all of which is local to the machine. Writes to one run are
 * serialized and go through a temporary file and a rename, so a crash leaves
 * either the old file or the new one.
 */
// A project id is `path_<base64url of the project path>` (`createProjectIdFromPath`),
// so its length follows the path's: a 93-character path already exceeds 128
// characters. The cap is generous on purpose, and the safety comes from the
// character set plus the `..` refusal below, not from the length.
import { projectConfigFileStemOf } from '../projects/project-id.js';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,512}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const isValidProjectId = (value) => typeof value === 'string' && PROJECT_ID_PATTERN.test(value) && !value.includes('..');
export const isValidRunId = (value) => typeof value === 'string' && RUN_ID_PATTERN.test(value) && !value.includes('..');

export const createWorkflowRunStore = ({ fsPromises, path, projectsDirPath, now = Date.now }) => {
  // The directory name is the project's config stem, not the raw id: a
  // path-derived id (`path_<base64url>`) grows with the path and would cross the
  // 255-byte file name limit, so `projectConfigFileStemOf` hashes the long ones
  // exactly as the rest of the projects directory does.
  const directoryFor = (projectId) => path.join(projectsDirPath, projectConfigFileStemOf(projectId), 'workflow-runs');
  const pathFor = (projectId, runId) => path.join(directoryFor(projectId), `${runId}.json`);

  const assertIds = (projectId, runId) => {
    if (!isValidProjectId(projectId)) throw new Error(`invalid project id "${projectId}"`);
    if (runId !== undefined && !isValidRunId(runId)) throw new Error(`invalid run id "${runId}"`);
  };

  // One promise chain per run file keeps two writers from interleaving a read
  // and a rename on the same path.
  const chains = new Map();
  const serialize = (key, task) => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    chains.set(key, next.catch(() => undefined));
    return next;
  };

  const writeAtomic = async (filePath, value) => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsPromises.rename(temporary, filePath);
  };

  const read = async (projectId, runId) => {
    assertIds(projectId, runId);
    try {
      return JSON.parse(await fsPromises.readFile(pathFor(projectId, runId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  };

  const list = async (projectId) => {
    assertIds(projectId);
    let names = [];
    try {
      names = await fsPromises.readdir(directoryFor(projectId));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const runs = [];
    for (const name of names.filter((entry) => entry.endsWith('.json') && isValidRunId(entry.slice(0, -'.json'.length)))) {
      const parsed = await read(projectId, name.slice(0, -'.json'.length));
      if (parsed) runs.push(parsed);
    }
    return runs.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  };

  const write = (run) => serialize(`${run.projectId}/${run.runId}`, async () => {
    assertIds(run.projectId, run.runId);
    const next = { ...run, updatedAt: now() };
    await writeAtomic(pathFor(run.projectId, run.runId), next);
    return next;
  });

  const create = (run) => write({ createdAt: now(), ...run });

  const remove = (projectId, runId) => serialize(`${projectId}/${runId}`, async () => {
    assertIds(projectId, runId);
    try {
      await fsPromises.unlink(pathFor(projectId, runId));
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  });

  return { create, read, list, write, remove, pathFor, directoryFor };
};
