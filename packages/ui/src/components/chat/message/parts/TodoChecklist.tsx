/**
 * A session's todo list, as OMP's `todo` tool last reported it.
 *
 * The list itself is OMP's — phases and item texts come from the model, so they
 * are content, not copy. Only the status marks are ours: an empty box, a
 * spinner while the item is being worked on, and a ticked box once it is done.
 */

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { TodoItem, TodoState } from '@/lib/agent/events';
import { cn } from '@/lib/utils';

const STATUS_ICON = {
    pending: 'checkbox-blank',
    in_progress: 'loader',
    done: 'checkbox-circle',
} satisfies Record<TodoItem['status'], IconName>;

const STATUS_TONE = {
    pending: 'text-muted-foreground',
    in_progress: 'text-primary',
    done: 'text-muted-foreground',
} satisfies Record<TodoItem['status'], string>;

export function TodoChecklist({ todo }: { todo: TodoState }) {
    return (
        <div className="space-y-1">
            {todo.items.map((item, index) => {
                const startsPhase = index === 0 || todo.items[index - 1]?.phase !== item.phase;
                return (
                    <div key={`${item.phase}:${item.text}`} className="space-y-0.5">
                        {startsPhase && item.phase ? (
                            <div className="px-1 typography-meta font-medium text-muted-foreground">{item.phase}</div>
                        ) : null}
                        <div className="flex min-w-0 items-start gap-2 px-1">
                            <Icon
                                name={STATUS_ICON[item.status]}
                                className={cn('mt-0.5 size-3.5 shrink-0', STATUS_TONE[item.status])}
                            />
                            <span
                                className={cn(
                                    'min-w-0 flex-1 typography-meta',
                                    item.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground',
                                )}
                            >
                                {item.text}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
