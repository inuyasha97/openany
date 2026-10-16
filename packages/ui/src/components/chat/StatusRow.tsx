import React from "react";
import { useSessionUIStore } from '@/sync/session-ui-store';
import { Icon } from "@/components/icon/Icon";
import { useTodoStore } from '@/stores/useTodoStore';
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";

// The floating assistant-status chip that hovers above the composer while the
// agent works ("Claude is working…"). ONLY that. The composer's
// own bar — pending changes, todos dropdown — is ComposerStatusBar: they used
// to share this component, and every restyle of this chip (glass, placement)
// silently dragged the composer bar and its dropdown along with it.

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

interface StatusRowProps {
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  abortActive,
  retryInfo,
  agentName,
  modelName,
  providerId,
}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

  // The session's todo list, plus a read on open: the stream only carries a
  // list when the model touches it, so a session opened later would otherwise
  // show nothing until the next `todo` call.
  const todo = useTodoStore((state) => (currentSessionId ? state.bySession.get(currentSessionId) : undefined));
  React.useEffect(() => {
    if (currentSessionId) void useTodoStore.getState().load(currentSessionId);
  }, [currentSessionId]);

  const todoDone = todo?.items.filter((item) => item.status === 'done').length ?? 0;
  const todoCurrent = todo?.items.find((item) => item.status === 'in_progress')
    ?? todo?.items.find((item) => item.status === 'pending');

  const shouldRenderPlaceholder = !abortActive;
  const hasContent = isWorking;

  if (!hasContent) {
    return null;
  }

  return (
    <div
      // The row renders inside the composer-anchored overlay, which owns the
      // distance to the input and the horizontal column (the same ones the
      // scroll-to-bottom pill uses).
      style={STATUS_ROW_CONTAINER_STYLE}
    >
      {/* h-8 matches the turn footer's real row height: its h-8 action
          buttons define the footer line, with the meta text centered in it. */}
      {/* The glass chip lives here, not on the container: the root above is
          an inline-size query container, whose width ignores its children —
          a shrink-to-fit wrapper around it always collapsed to zero. */}
      <div className="oc-glass-popover inline-flex w-max max-w-full items-center gap-2 h-8 whitespace-nowrap rounded-full [corner-shape:round] px-3">
        <div className="flex items-center min-w-0 gap-2 overflow-x-hidden">
          {shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
              modelName={modelName}
              providerId={providerId}
            />
          ) : null}
        </div>
        {todo && todo.items.length > 0 ? (
          <>
            <span className="text-muted-foreground/50" aria-hidden>·</span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Icon name="checkbox-multiple" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {/* The model's own list: a ratio and the item it is on, so the chip
                  needs no copy of its own. */}
              <span className="tabular-nums text-muted-foreground">{todoDone}/{todo.items.length}</span>
              {todoCurrent ? (
                <span className="min-w-0 max-w-[24ch] truncate text-muted-foreground/80">{todoCurrent.text}</span>
              ) : null}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
};
