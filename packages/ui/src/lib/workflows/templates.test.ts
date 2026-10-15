import { describe, expect, it } from 'bun:test';
import { parse } from 'yaml';

import { SDLC_FEATURE_TEMPLATE, sdlcTemplateFor, sdlcTemplateSummary } from './templates';

/**
 * One field of a parsed mapping, or `undefined` when the parse produced something
 * else. `yaml` parses to `any`, so the template is read through this rather than
 * through a cast: every assertion below is then about the mapping the template
 * really parses to, not about the shape a cast promised.
 */
const fieldOf = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const entry = Object.entries(value).find(([name]) => name === key);
  return entry === undefined ? undefined : entry[1];
};

/** The step ids the text declares, in the order it declares them. */
const stepIdsOf = (value: unknown): unknown[] => {
  const steps = fieldOf(value, 'steps');
  return Array.isArray(steps) ? steps.map((step) => fieldOf(step, 'id')) : [];
};

/** The parsed template, so each assertion reads a field rather than the text. */
const template: unknown = parse(SDLC_FEATURE_TEMPLATE);

const steps = fieldOf(template, 'steps');
const stepList: unknown[] = Array.isArray(steps) ? steps : [];

describe('SDLC template', () => {
  it('parses to a definition: an id, a name, a version and a sandbox', () => {
    expect(fieldOf(template, 'id')).toBe('sdlc-feature');
    expect(fieldOf(template, 'name')).toBe('SDLC, feature work');
    expect(fieldOf(template, 'version')).toBe(1);
    expect(fieldOf(template, 'sandbox')).toBe('worktree');
  });

  it('declares the five SDLC steps in order', () => {
    expect(stepIdsOf(template)).toEqual(['spec', 'plan', 'implement', 'verify', 'bring-back']);
  });

  it('declares the input its first prompt interpolates', () => {
    expect(fieldOf(template, 'inputs')).toEqual([
      { name: 'request', description: "What to build, in the requester's words", required: true },
    ]);
    // The placeholder is the input's own name: the parser refuses a placeholder
    // that no input declares.
    expect(fieldOf(stepList[0], 'prompt')).toContain('{{request}}');
  });

  it('carries no confirm field on any step, which the schema refuses', () => {
    // A step is done only when a person confirms it, so the field is gone from
    // the schema and a template carrying it would not load at all.
    expect(stepList.filter((step) => fieldOf(step, 'confirm') !== undefined)).toEqual([]);
  });

  it('gives every step that produces something a verifier, and the others none', () => {
    const verified = stepList.filter((step) => fieldOf(step, 'verify') !== undefined).map((step) => fieldOf(step, 'id'));
    expect(verified).toEqual(['spec', 'plan', 'verify']);
  });
});

describe('sdlcTemplateFor', () => {
  it('names the template by the id it is given, and keeps every other field', () => {
    const seeded: unknown = parse(sdlcTemplateFor('login-flow'));

    expect(fieldOf(seeded, 'id')).toBe('login-flow');
    expect(fieldOf(seeded, 'name')).toBe(fieldOf(template, 'name'));
    expect(fieldOf(seeded, 'sandbox')).toBe(fieldOf(template, 'sandbox'));
    expect(stepIdsOf(seeded)).toEqual(stepIdsOf(template));
  });

  it('substitutes only the id line', () => {
    expect(sdlcTemplateFor('login-flow')).toBe(SDLC_FEATURE_TEMPLATE.replace('id: sdlc-feature', 'id: login-flow'));
  });
});

describe('sdlcTemplateSummary', () => {
  it('names the file the write will use, which is the id a person typed', () => {
    expect(sdlcTemplateSummary('login-flow')).toEqual({ id: 'login-flow', file: 'login-flow.yaml' });
  });
});
