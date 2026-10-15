import { describe, expect, it } from 'bun:test';

import { SDLC_FEATURE_TEMPLATE, sdlcTemplateFor, sdlcTemplateSummary } from './templates';

describe('SDLC template', () => {
  it('declares the five SDLC steps in order, each with a stop for a person', () => {
    const ids = [...SDLC_FEATURE_TEMPLATE.matchAll(/^  - id: (.+)$/gm)].map((match) => match[1]);
    expect(ids).toEqual(['spec', 'plan', 'implement', 'verify', 'bring-back']);
  });

  it('declares no confirm field, which the schema refuses', () => {
    // A step is done only when a person confirms it, so the field is gone from
    // the schema and a template carrying it would not load at all.
    expect(SDLC_FEATURE_TEMPLATE).not.toMatch(/confirm:/);
  });

  it('gives every step that produces something a verifier', () => {
    const verifyBlocks = [...SDLC_FEATURE_TEMPLATE.matchAll(/verify:/g)].length;
    expect(verifyBlocks).toBeGreaterThanOrEqual(3);   // spec, plan and verify
  });

  it('names the inputs it asks for', () => {
    expect(SDLC_FEATURE_TEMPLATE).toContain('{{request}}');
    expect(SDLC_FEATURE_TEMPLATE).toMatch(/inputs:/);
    // The prompt's placeholder is the input's own name: the parser refuses a
    // placeholder that no input declares.
    expect(SDLC_FEATURE_TEMPLATE).toContain('name: request');
  });
});

describe('sdlcTemplateFor', () => {
  it('names the template by the id it is given, and keeps the rest of the steps', () => {
    const seeded = sdlcTemplateFor('login-flow');
    expect(seeded).toMatch(/^id: login-flow$/m);
    expect(seeded).not.toMatch(/sdlc-feature/);
    expect([...seeded.matchAll(/^  - id: (.+)$/gm)].map((match) => match[1]))
      .toEqual(['spec', 'plan', 'implement', 'verify', 'bring-back']);
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
