import { describe, expect, it } from 'vitest';
import { assemblePromptBlocks, substituteInputs } from './prompts.js';

describe('substituteInputs', () => {
  it('replaces every declared placeholder', () => {
    expect(substituteInputs('Design {{request}} for {{audience}}.', { request: 'a cache', audience: 'ops' }))
      .toEqual({ text: 'Design a cache for ops.', missing: [] });
  });

  it('reports a placeholder with no value instead of blanking it', () => {
    expect(substituteInputs('Design {{request}}.', {}))
      .toEqual({ text: 'Design {{request}}.', missing: ['request'] });
  });
});

describe('assemblePromptBlocks', () => {
  it('leads with a slash prompt so OMP still expands the command', () => {
    expect(assemblePromptBlocks({ prompt: '/plan-feature add caching', context: ['PROJECT NOTES'] }))
      .toBe('/plan-feature add caching\n\nPROJECT NOTES');
  });

  it('puts context in front of a plain prompt', () => {
    expect(assemblePromptBlocks({ prompt: 'Do the work', context: ['PROJECT NOTES'] }))
      .toBe('PROJECT NOTES\n\nDo the work');
  });

  it('drops empty context blocks', () => {
    expect(assemblePromptBlocks({ prompt: 'Do the work', context: ['', '   ', null] })).toBe('Do the work');
  });

  it('treats a leading space before the slash as leading', () => {
    expect(assemblePromptBlocks({ prompt: '   /plan-feature x', context: ['CTX'] })).toBe('   /plan-feature x\n\nCTX');
  });

  it('keeps the prompt text exactly as authored', () => {
    expect(assemblePromptBlocks({ prompt: 'Do the work  ', context: ['CTX'] })).toBe('CTX\n\nDo the work  ');
    // The authored trailing newline survives, so the join adds two more.
    expect(assemblePromptBlocks({ prompt: '/cmd x\n', context: ['CTX'] })).toBe('/cmd x\n\n\nCTX');
  });
});
