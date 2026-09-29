/**
 * Picks which runtime owns the session being drafted.
 *
 * Only the runtimes the server reports as mounted are offered, alongside the
 * OpenCode default, and the control appears only while a session is drafting.
 * The choice lives on the draft and is passed to `createSession`.
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
import { useAcpRuntimeAvailable } from '@/lib/agent/acp-availability';
import { useOmpRuntimeAvailable } from '@/lib/agent/omp-availability';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';

type RuntimeOption = { id: string; label: string };

// Product names stay literal; only the label and aria text are translated.
const OPENCODE: RuntimeOption = { id: 'opencode', label: 'OpenCode' };
const OMP: RuntimeOption = { id: 'omp', label: 'OMP' };
const ACP: RuntimeOption = { id: 'acp', label: 'ACP' };

export function RuntimeControl() {
    const { t } = useI18n();
    const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
    const runtimeId = useSessionUIStore((state) => state.newSessionDraft.runtimeId);
    const setRuntime = useSessionUIStore((state) => state.setNewSessionDraftRuntime);
    const ompAvailable = useOmpRuntimeAvailable(draftOpen);
    const acpAvailable = useAcpRuntimeAvailable(draftOpen);

    const options = [OPENCODE, ...(ompAvailable ? [OMP] : []), ...(acpAvailable ? [ACP] : [])];
    if (!draftOpen || options.length < 2) return null;

    const selected = options.find((option) => option.id === runtimeId) ?? OPENCODE;
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
                {options.map((option) => (
                    <DropdownMenuItem
                        key={option.id}
                        onSelect={() => setRuntime(option.id === OPENCODE.id ? undefined : option.id)}
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
