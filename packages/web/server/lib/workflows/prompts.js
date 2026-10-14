/**
 * Prompt text assembly for a step.
 *
 * OMP expands a prompt that starts with `/name args`, so such a prompt has to
 * lead the text: context placed in front of it would hide the slash and the
 * command would be sent as literal text. Every other prompt reads better with
 * its context first.
 */

export const substituteInputs = (template, values) => {
  const missing = [];
  const text = String(template).replace(/\{\{([^}]+)\}\}/g, (match, rawName) => {
    const name = rawName.trim();
    const value = values?.[name];
    if (typeof value !== 'string' || value.length === 0) {
      if (!missing.includes(name)) missing.push(name);
      return match;
    }
    return value;
  });
  return { text, missing };
};

export const assemblePromptBlocks = ({ prompt, context = [] }) => {
  const text = String(prompt ?? '');
  const blocks = (Array.isArray(context) ? context : [])
    .filter((block) => typeof block === 'string' && block.trim().length > 0);
  if (blocks.length === 0) return text;
  return text.trimStart().startsWith('/')
    ? [text, ...blocks].join('\n\n')
    : [...blocks, text].join('\n\n');
};
