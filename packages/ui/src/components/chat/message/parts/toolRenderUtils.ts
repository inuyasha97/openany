import { OPENCODE_TOOLS, normalizeToolName, type ToolName } from '@/lib/opencode/tools';

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.read, OPENCODE_TOOLS.skill]);

// A sub-agent call keeps its own chronological row: its card lists the agents
// it spawned, which a group's collapsed summary cannot show.
const STANDALONE_TOOL_NAMES = {
    [OPENCODE_TOOLS.subagent]: true,
    [OPENCODE_TOOLS.task]: true,
    [OPENCODE_TOOLS.hub]: true,
} as const;

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: ToolName): boolean => {
    return Object.hasOwn(STANDALONE_TOOL_NAMES, normalizeToolName(toolName));
};

export const isStaticTool = (toolName: ToolName): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};
