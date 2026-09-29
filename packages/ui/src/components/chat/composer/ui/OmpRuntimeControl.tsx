/**
 * Picks which runtime owns the session being drafted.
 *
 * Only shown while a session is being drafted and the server reports the OMP
 * runtime mounted, so it never appears on an existing session and never offers
 * a runtime the server cannot serve. The choice lives on the draft and is
 * passed to `createSession`.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useOmpRuntimeAvailable } from '@/lib/agent/omp-availability';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';

type RuntimeOption = { id: string; label: string };

// Product names stay literal; only the label and aria text are translated.
const RUNTIMES: RuntimeOption[] = [
    { id: 'opencode', label: 'OpenCode' },
    { id: 'omp', label: 'OMP' },
];

export function OmpRuntimeControl() {
    const { t } = useI18n();
    const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
    const available = useOmpRuntimeAvailable(draftOpen);
    const runtimeId = useSessionUIStore((state) => state.newSessionDraft.runtimeId);
    const setRuntime = useSessionUIStore((state) => state.setNewSessionDraftRuntime);

    if (!available || !draftOpen) return null;

    const selected = RUNTIMES.find((option) => option.id === runtimeId) ?? RUNTIMES[0];
    const label = t('chat.chatInput.runtime.label');

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button type="button" className={cn(dropdownTriggerVariants({ size: 'sm' }), 'max-w-32')} title={label} aria-label={label}>
                    <Icon name="robot" />
                    <span className="truncate">{selected.label}</span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {RUNTIMES.map((option) => (
                    <DropdownMenuItem
                        key={option.id}
                        onSelect={() => setRuntime(option.id === 'opencode' ? undefined : option.id)}
                    >
                        <span className="flex size-4 items-center justify-center">
                            {option.id === selected.id ? <Icon name="check" /> : null}
                        </span>
                        {option.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}