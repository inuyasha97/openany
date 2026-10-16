/**
 * The sub-agents a session spawned, and one of their transcripts.
 *
 * OMP writes each sub-agent's transcript beside the session file instead of
 * listing it as a session, so the session list cannot see them; the server
 * discovers them under `/sessions/:id/children` and the chat asks here. A
 * child's messages come back as the message page the session's own route
 * answers with, but nothing on this surface acts on them: a sub-agent is
 * prompted by the agent that spawned it, never by the person reading along.
 */

import React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getToolMetadata } from '@/lib/toolHelpers';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';

import { readProgressAgentName } from './taskToolModel';

/** One sub-agent transcript the server discovered for a session. */
export type SubagentChild = {
    /** The child's session id. The server resolves the agent's name too. */
    id: string;
    /** The name OMP gave the child, which is also its transcript's file name. */
    agent: string;
    /** When the child started (ISO), or `null` when its header carried none. */
    startedAt: string | null;
};

/** One rendered piece of a child's transcript: its words, or a tool it called. */
export type SubagentTranscriptLine =
    | { kind: 'text'; text: string }
    | { kind: 'tool'; name: string; output?: string };

export type SubagentTranscriptItem = {
    role: string;
    lines: SubagentTranscriptLine[];
};

export type FetchSubagentChildren = (sessionId: string) => Promise<SubagentChild[]>;
export type FetchSubagentMessages = (sessionId: string, childId: string) => Promise<SubagentTranscriptItem[]>;

const childSchema = z.looseObject({
    id: z.string().min(1),
    agent: z.string().min(1),
    startedAt: z.string().optional().nullable(),
});

const childrenResponseSchema = z.looseObject({ children: z.array(childSchema) });

/** A child transcript belongs to the session that spawned it, so both reads name that session. */
export const fetchSubagentChildren: FetchSubagentChildren = async (sessionId) => {
    const response = await runtimeFetch(`/api/agents/omp/sessions/${encodeURIComponent(sessionId)}/children`);
    if (!response.ok) throw new Error(`sub-agent list failed: ${response.status}`);
    const parsed = childrenResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('sub-agent list answered an unexpected shape');
    return parsed.data.children.map((child) => ({
        id: child.id,
        agent: child.agent,
        startedAt: child.startedAt ?? null,
    }));
};

const transcriptPartSchema = z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    tool: z.string().optional(),
    state: z.looseObject({
        output: z.string().optional(),
    }).optional(),
});

const transcriptPageSchema = z.looseObject({
    items: z.array(z.looseObject({
        info: z.looseObject({ role: z.string() }).optional(),
        parts: z.array(transcriptPartSchema).optional(),
    })).optional(),
});

/** How much of a tool's output the transcript shows on its one-line row. */
const MAX_TOOL_OUTPUT_CHARS = 160;

const firstOutputLine = (output: string | undefined): string | undefined => {
    const line = output?.split('\n').find((candidate) => candidate.trim().length > 0)?.trim();
    if (!line) return undefined;
    return line.length > MAX_TOOL_OUTPUT_CHARS ? `${line.slice(0, MAX_TOOL_OUTPUT_CHARS)}…` : line;
};

export const fetchSubagentMessages: FetchSubagentMessages = async (sessionId, childId) => {
    const url = `/api/agents/omp/sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(childId)}/messages`;
    const response = await runtimeFetch(url);
    if (!response.ok) throw new Error(`sub-agent transcript failed: ${response.status}`);
    const parsed = transcriptPageSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('sub-agent transcript answered an unexpected shape');

    const items: SubagentTranscriptItem[] = [];
    for (const item of parsed.data.items ?? []) {
        const lines: SubagentTranscriptLine[] = [];
        for (const part of item.parts ?? []) {
            if (part.type === 'text' && part.text?.trim()) {
                lines.push({ kind: 'text', text: part.text });
                continue;
            }
            if (part.type === 'tool' && part.tool) {
                const output = firstOutputLine(part.state?.output);
                lines.push(output
                    ? { kind: 'tool', name: getToolMetadata(part.tool).displayName, output }
                    : { kind: 'tool', name: getToolMetadata(part.tool).displayName });
            }
        }
        // OMP writes records this view has nothing to show (reasoning, model
        // switches); an item that renders no line is not a transcript entry.
        if (lines.length > 0) items.push({ role: item.info?.role ?? 'assistant', lines });
    }
    return items;
};

type SubagentRead<T> =
    | { status: 'loading' }
    | { status: 'ready'; value: T }
    | { status: 'error'; message: string };

/** Reads a child's messages once, for the child the row has open. */
export const useSubagentMessages = (
    sessionId: string | undefined,
    childId: string | undefined,
    fetchMessages: FetchSubagentMessages = fetchSubagentMessages,
): SubagentRead<SubagentTranscriptItem[]> => {
    const [read, setRead] = React.useState<SubagentRead<SubagentTranscriptItem[]>>({ status: 'loading' });
    // The reader is read through a ref so an inline prop cannot restart the
    // read on every render: only the child being read decides that.
    const reader = React.useRef(fetchMessages);
    React.useEffect(() => {
        reader.current = fetchMessages;
    }, [fetchMessages]);

    React.useEffect(() => {
        if (!sessionId || !childId) {
            setRead({ status: 'ready', value: [] });
            return;
        }
        let cancelled = false;
        setRead({ status: 'loading' });
        reader.current(sessionId, childId).then(
            (value) => {
                if (!cancelled) setRead({ status: 'ready', value });
            },
            // Both readers answer a failed read with an `Error`; a narrower
            // rejection would leave the row without the server's message.
            (reason: Error) => {
                if (!cancelled) setRead({ status: 'error', message: reason.message || 'Unknown sub-agent' });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [childId, sessionId]);

    return read;
};

/** One child's transcript, read-only. */
export const SubagentTranscript: React.FC<{
    sessionId: string | undefined;
    childId: string;
    fetchMessages?: FetchSubagentMessages;
}> = ({ sessionId, childId, fetchMessages }) => {
    const { t } = useI18n();
    const read = useSubagentMessages(sessionId, childId, fetchMessages);

    if (read.status === 'loading') {
        return <div className="typography-meta text-muted-foreground/70">{t('common.loading')}</div>;
    }
    if (read.status === 'error') {
        return (
            <div className="typography-meta" style={{ color: 'var(--status-error)' }}>
                {t('chat.toolPart.error')} {read.message}
            </div>
        );
    }
    if (read.value.length === 0) {
        return <div className="typography-meta text-muted-foreground/70">{t('chat.timeline.empty.session')}</div>;
    }

    return (
        <div className="space-y-2">
            {read.value.map((item, index) => (
                <div key={index} className={cn('space-y-1', item.role === 'user' && 'text-muted-foreground')}>
                    {item.lines.map((line, lineIndex) => (
                        line.kind === 'text' ? (
                            <SimpleMarkdownRenderer key={lineIndex} content={line.text} variant="tool" />
                        ) : (
                            <div key={lineIndex} className="flex min-w-0 items-baseline gap-1.5 typography-meta text-muted-foreground">
                                <Icon name="tools" className="size-3.5 flex-shrink-0" />
                                <span className="flex-shrink-0">{line.name}</span>
                                {line.output ? <span className="min-w-0 truncate">{line.output}</span> : null}
                            </div>
                        )
                    ))}
                </div>
            ))}
        </div>
    );
};

/** A child the row knows about either from the server's list or from a job name. */
type SubagentRow = SubagentChild;

const toRows = (children: SubagentChild[], jobNames: string[]): SubagentRow[] => {
    const rows = children.map((child) => ({ ...child }));
    const known = new Set(rows.map((row) => row.agent));
    for (const name of jobNames) {
        // A `hub` job can name an agent the server has not listed yet (it writes
        // the transcript as it goes); the name is a child id the server resolves.
        if (known.has(name)) continue;
        known.add(name);
        rows.push({ id: name, agent: name, startedAt: null });
    }
    return rows;
};

const useSubagentChildren = (
    sessionId: string | undefined,
    fetchChildren: FetchSubagentChildren = fetchSubagentChildren,
): SubagentRead<SubagentChild[]> => {
    const [read, setRead] = React.useState<SubagentRead<SubagentChild[]>>({ status: 'loading' });
    // Same rule as `useSubagentMessages`: the session being listed decides when
    // to read, never the identity of the reader handed in.
    const reader = React.useRef(fetchChildren);
    React.useEffect(() => {
        reader.current = fetchChildren;
    }, [fetchChildren]);

    React.useEffect(() => {
        if (!sessionId) {
            setRead({ status: 'ready', value: [] });
            return;
        }
        let cancelled = false;
        setRead({ status: 'loading' });
        reader.current(sessionId).then(
            (value) => {
                if (!cancelled) setRead({ status: 'ready', value });
            },
            (reason: Error) => {
                if (!cancelled) setRead({ status: 'error', message: reason.message || 'Unknown session' });
            },
        );
        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    return read;
};

/**
 * The sub-agents a session spawned, each opening its transcript in place, plus
 * the status line the running call last reported.
 */
export const SubagentList: React.FC<{
    sessionId: string | undefined;
    /** OMP's own progress text for the call, shown while it runs. */
    progressText?: string;
    /** Agents named by a `hub` job list, shown before the server lists them. */
    jobNames?: string[];
    fetchChildren?: FetchSubagentChildren;
    fetchMessages?: FetchSubagentMessages;
}> = ({ sessionId, progressText, jobNames = [], fetchChildren, fetchMessages }) => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const read = useSubagentChildren(sessionId, fetchChildren);
    const [openChildId, setOpenChildId] = React.useState<string | undefined>(undefined);

    const rows = toRows(read.status === 'ready' ? read.value : [], jobNames);
    const activeAgent = readProgressAgentName(progressText);

    return (
        <div className="space-y-1">
            <div className="flex min-w-0 items-center gap-1.5 px-1">
                <Icon name="ai-agent" className="size-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="typography-micro font-medium text-muted-foreground">
                    {t('chat.workStatus.section.subagents')}
                </span>
                <span className="typography-micro text-muted-foreground/70">
                    {read.status === 'ready' ? rows.length : t('common.loading')}
                </span>
            </div>

            {read.status === 'error' ? (
                <div className="px-1 typography-meta" style={{ color: 'var(--status-error)' }}>
                    {t('chat.toolPart.error')} {read.message}
                </div>
            ) : null}

            {progressText ? (
                <div className="px-1 typography-meta text-muted-foreground/70">{progressText}</div>
            ) : null}

            <ul className="space-y-0.5">
                {rows.map((row) => {
                    const isOpen = openChildId === row.id;
                    const label = t('chat.workStatus.action.openSubagent', { name: row.agent });
                    const startedAt = row.startedAt ? formatTimeForPreference(new Date(row.startedAt), timeFormatPreference) : '';
                    return (
                        <li key={row.id} className="min-w-0">
                            <button
                                type="button"
                                className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-interactive-hover"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setOpenChildId(isOpen ? undefined : row.id);
                                }}
                                title={label}
                                aria-label={label}
                                aria-expanded={isOpen}
                            >
                                <Icon name="ai-agent" className="size-3.5 flex-shrink-0 text-muted-foreground" />
                                <span className="min-w-0 truncate typography-meta text-foreground">{row.agent}</span>
                                {row.agent === activeAgent ? (
                                    <span className="flex-shrink-0 typography-micro text-muted-foreground/70">
                                        {t('chat.workStatus.subagent.working')}
                                    </span>
                                ) : null}
                                {startedAt ? (
                                    <span className="flex-shrink-0 typography-micro text-muted-foreground/70">{startedAt}</span>
                                ) : null}
                                <Icon
                                    name={isOpen ? 'arrow-down-s' : 'arrow-right-s'}
                                    className="ml-auto size-3.5 flex-shrink-0 text-muted-foreground"
                                />
                            </button>
                            {isOpen ? (
                                <div className="mt-1 ml-2 border-l pl-2" style={{ borderColor: 'var(--tools-border)' }}>
                                    <SubagentTranscript
                                        sessionId={sessionId}
                                        childId={row.id}
                                        fetchMessages={fetchMessages}
                                    />
                                </div>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};
