import { describe, expect, test } from 'bun:test';

import { isExpandableTool, isStandaloneTool, isStaticTool } from './toolRenderUtils';

describe('tool rendering classification', () => {
    test('keeps navigation tools compact', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(isStaticTool('skill')).toBe(true);
        expect(isExpandableTool('read')).toBe(false);
        expect(isExpandableTool('skill')).toBe(false);
    });

    test('expands built-in tools without direct navigation', () => {
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('webfetch')).toBe(true);
        expect(isExpandableTool('bash')).toBe(true);
        expect(isExpandableTool('plan_exit')).toBe(true);
    });

    test('expands custom and MCP tools', () => {
        expect(isExpandableTool('linear_list_issues')).toBe(true);
        expect(isExpandableTool('my-plugin_publish')).toBe(true);
        expect(isStaticTool('linear_list_issues')).toBe(false);
    });

    test('normalizes dotted and indexed tool names', () => {
        expect(isStaticTool('runtime.read:2')).toBe(true);
        expect(isExpandableTool('runtime.custom_tool:2')).toBe(true);
    });

    test('keeps a sub-agent call on its own row', () => {
        expect(isStandaloneTool('subagent')).toBe(true);
        expect(isStandaloneTool('task')).toBe(true);
        expect(isStandaloneTool('hub')).toBe(true);
        expect(isStandaloneTool('shell')).toBe(false);
    });
});
