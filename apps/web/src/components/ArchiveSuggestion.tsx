import { X } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { ArchiveIcon } from "./icons.tsx";

/**
 * The board's half of the archive suggestion: EQNX thinks a task looks done
 * (its state says so and nothing has happened since) and offers to archive
 * it. Nothing archives until the user clicks; dismissing hides the offer until
 * the task's state is rewritten.
 */

/** Compact inline chip for a task row. */
export function ArchiveSuggestionChip({
  taskLabel,
  onArchive,
  onDismiss,
  className,
}: {
  taskLabel: string;
  onArchive: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "archive-suggestion inline-flex flex-shrink-0 items-stretch rounded border border-border bg-accent-soft text-accent font-mono text-chip whitespace-nowrap",
        className,
      )}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 border-0 bg-transparent px-1.5 py-px text-inherit cursor-pointer rounded-l hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        aria-label={`Archive ${taskLabel} (looks done)`}
        title="This task's state says it is done. Archive it?"
        onClick={onArchive}
      >
        <ArchiveIcon size={11} />
        <span>Looks done</span>
        <span className="text-text-muted" aria-hidden="true">
          · archive?
        </span>
      </button>
      <button
        type="button"
        className="inline-flex items-center border-0 border-l border-border bg-transparent px-1 text-text-muted cursor-pointer rounded-r hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        aria-label={`Dismiss archive suggestion for ${taskLabel}`}
        title="Not done — stop suggesting"
        onClick={onDismiss}
      >
        <X size={11} aria-hidden="true" />
      </button>
    </span>
  );
}

/** A one-line callout for the task page header. */
export function ArchiveSuggestionCallout({
  onArchive,
  onDismiss,
}: {
  onArchive: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="archive-suggestion"
      className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-accent-soft px-3 py-2 text-sm text-text"
    >
      <span className="inline-flex text-accent" aria-hidden="true">
        <ArchiveIcon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">Looks done</strong>
        <span className="text-text-muted">
          {" "}
          — the state says this task is finished. Archive it?
        </span>
      </span>
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center rounded-control border border-border bg-surface px-2.5 py-1 text-crumb font-semibold text-text cursor-pointer hover:border-border-strong hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Archive task (looks done)"
          onClick={onArchive}
        >
          Archive
        </button>
        <button
          type="button"
          className="inline-flex items-center rounded-control border-0 bg-transparent px-2 py-1 text-crumb font-semibold text-text-muted cursor-pointer hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Dismiss archive suggestion"
          onClick={onDismiss}
        >
          Not now
        </button>
      </span>
    </div>
  );
}
