import { ArrowRightLeft, FolderGit2, Folder } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useLayoutEffect, useRef, type MouseEvent, type RefObject } from "react";
import { truncatePath } from "../format.ts";
import {
  HttpError,
  type DocContents,
  useDocContents,
  useToggleCheckbox,
  useMoveDoc,
} from "../lib/api.ts";
import { resolveTaskDocLink } from "../lib/doc-link-resolver.ts";
import { useTraceDataSource } from "../lib/trace-data-source.ts";
import { CopyChip } from "./CopyChip.tsx";
import { Sheet } from "./ui/Sheet.tsx";

/**
 * The rendered contents of a task doc, in the board's right-side Sheet. Mounted
 * only while a doc is selected. AnimatePresence in the parent keeps it mounted
 * long enough for Motion to play the exit animation after close.
 */
export function DocViewerSheet({
  taskRef,
  docPath,
  knownDocPaths = [],
  onOpenChange,
  onNavigateDocRoute,
  triggerRef,
  promoted,
  canMoveToRepo = false,
  onMoved,
}: {
  canMoveToRepo?: boolean;
  onMoved?: (path: string) => void;
  taskRef: string;
  docPath: string;
  knownDocPaths?: readonly string[];
  onOpenChange: (open: boolean) => void;
  onNavigateDocRoute?: (route: string) => void;
  triggerRef: RefObject<HTMLElement | null>;
  /** Set when the doc was promoted into the project repo. */
  promoted?: { repoPath: string; missing: boolean; otherCheckout?: string };
}) {
  const query = useDocContents(taskRef, docPath);
  const toggleCheckbox = useToggleCheckbox();
  const moveDoc = useMoveDoc();
  const source = useTraceDataSource();
  const isStateDoc = docPath.split(/[\\/]/).pop()?.toLowerCase() === "state.md";
  const canMoveDoc =
    !isStateDoc &&
    !promoted?.missing &&
    !promoted?.otherCheckout &&
    source.capabilities.docEdits &&
    (Boolean(promoted) || canMoveToRepo);
  // A copy borrowed from another checkout may be another branch's version, so
  // it is read-only here just like a source with nowhere to write.
  const canEditDoc =
    source.capabilities.docEdits && !promoted?.otherCheckout;

  return (
    <Sheet
      onOpenChange={onOpenChange}
      title={<CopyChip value={docPath} display={truncatePath(docPath)} />}
      description={`Contents of ${docPath}`}
      returnFocusTo={triggerRef}
    >
      {promoted ? (
        <div
          data-testid="doc-viewer-promoted"
          className="mb-4 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm"
        >
          <div className="flex items-center gap-2 text-text">
            <FolderGit2
              size={15}
              className="shrink-0 text-text-muted"
              aria-hidden="true"
            />
            <span className="font-semibold">Repository file</span>
          </div>
          <p className="mt-1 mb-0 break-all font-mono text-crumb text-text-muted">
            {promoted.repoPath}
          </p>
          <p className="mt-1.5 mb-0 text-crumb text-text-muted leading-relaxed">
            {promoted.otherCheckout
              ? "Viewing a file from another checkout. Editing is disabled here."
              : promoted.missing
                ? "This file is stored in the project repository, but is unavailable on this machine."
                : "Stored in the project repository. Edits here update that file."}
          </p>
          {canMoveDoc ? (
            <button
              type="button"
              disabled={moveDoc.isPending}
              className="mt-3 inline-flex items-center gap-1.5 rounded-control border border-border px-2.5 py-1.5 text-crumb font-semibold text-text hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              onClick={() =>
                moveDoc.mutate(
                  { ref: taskRef, path: docPath, to: "task" },
                  {
                    onSuccess: (doc) => onMoved?.(doc.path),
                  },
                )
              }
            >
              <ArrowRightLeft size={13} aria-hidden="true" />
              {moveDoc.isPending ? "Moving…" : "Move to task storage"}
            </button>
          ) : null}
          {canMoveDoc ? (
            <p className="mt-1.5 mb-0 text-crumb text-text-muted">
              Moves the current file out of your checkout. Git will show a
              deletion if it was tracked.
            </p>
          ) : null}
          {promoted.otherCheckout ? (
            <p className="mt-1 mb-0 break-all font-mono text-crumb text-text-muted">
              {promoted.otherCheckout}
            </p>
          ) : null}
        </div>
      ) : canMoveDoc ? (
        <div className="mb-4 rounded-lg border border-border bg-surface px-3 py-2.5 text-sm">
          <div className="flex items-center gap-2 text-text">
            <Folder size={15} className="text-text-muted" aria-hidden="true" />
            <span className="font-semibold">Task storage</span>
          </div>
          <p className="mt-1.5 mb-0 text-crumb text-text-muted">
            Stored with this task, independently of repository branches.
          </p>
          <button
            type="button"
            disabled={moveDoc.isPending}
            className="mt-3 inline-flex items-center gap-1.5 rounded-control border border-border px-2.5 py-1.5 text-crumb font-semibold text-text hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            onClick={() =>
              moveDoc.mutate(
                { ref: taskRef, path: docPath, to: "repo" },
                {
                  onSuccess: (doc) => onMoved?.(doc.path),
                },
              )
            }
          >
            <ArrowRightLeft size={13} aria-hidden="true" />
            {moveDoc.isPending ? "Moving…" : "Move to repository"}
          </button>
          <p className="mt-1.5 mb-0 text-crumb text-text-muted">
            Moves to the repository’s docs directory and keeps it linked to this
            task.
          </p>
        </div>
      ) : null}
      {moveDoc.isError ? (
        <p role="alert" className="mb-4 text-sm text-text-muted">
          {moveDoc.error.message}
        </p>
      ) : null}
      <DocViewerBody
        query={query}
        promoted={promoted}
        onClick={(event) => {
          // First, so a code block nested in a task-list line copies instead of
          // toggling the line's checkbox.
          if (copyCodeFromClick(event)) return;

          const checkbox = checkboxToggleFromClick(event);
          if (checkbox) {
            const { input, index, checked } = checkbox;
            if (!canEditDoc) {
              // A read-only source has nowhere to persist the flip, so undo
              // it rather than show a phantom edit. Assigning `checked` back
              // outlasts the click's own toggle, so no preventDefault is
              // needed — and calling it would re-toggle instead of settle.
              input.checked = !checked;
              return;
            }
            // The native click already flipped the input optimistically;
            // persist that state and revert the input if the write fails.
            toggleCheckbox.mutate(
              { ref: taskRef, path: docPath, index, checked },
              { onError: () => (input.checked = !checked) },
            );
            return;
          }

          if (!onNavigateDocRoute) return;
          const route = docLinkRouteFromClick(event, {
            taskRef,
            docPath,
            knownDocPaths,
          });
          if (!route) return;

          event.preventDefault();
          onNavigateDocRoute(route);
        }}
      />
    </Sheet>
  );
}

function DocViewerBody({
  query,
  onClick,
  promoted,
}: {
  query: UseQueryResult<DocContents, Error>;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  promoted?: { repoPath: string; missing: boolean };
}) {
  const proseRef = useRef<HTMLDivElement>(null);
  const html = query.data?.contentType.startsWith("text/html")
    ? query.data.body
    : null;

  // The doc arrives as server-rendered HTML, so React can't own children inside
  // it. React can replace that HTML on a parent rerender even when the string
  // is unchanged, so restore the buttons after every render. The helper skips
  // buttons already present; clicks use the container's delegated handler.
  useLayoutEffect(() => {
    if (html !== null && proseRef.current) addCopyButtons(proseRef.current);
  });

  if (query.isPending) {
    return <p className="text-text-muted">Loading…</p>;
  }

  if (query.isError) {
    return (
      <p role="alert" className="text-text-muted">
        {docErrorMessage(query.error, promoted)}
      </p>
    );
  }

  if (html !== null) {
    return (
      <div
        ref={proseRef}
        className="doc-viewer-prose text-base text-text-muted leading-relaxed"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div>
      <p className="m-0 mb-3 text-xs font-bold uppercase tracking-wide text-text-muted">
        Showing raw contents
      </p>
      <pre className="m-0 overflow-x-auto rounded-md border border-border-subtle bg-surface p-4 text-sm font-mono whitespace-pre-wrap break-words text-text">
        {query.data.body}
      </pre>
    </div>
  );
}

function docLinkRouteFromClick(
  event: MouseEvent<HTMLDivElement>,
  {
    taskRef,
    docPath,
    knownDocPaths,
  }: {
    taskRef: string;
    docPath: string;
    knownDocPaths: readonly string[];
  },
): string | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }

  const target = event.target;
  if (!(target instanceof Element)) return null;

  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;

  return resolveTaskDocLink({
    href: anchor.getAttribute("href") ?? "",
    baseDocPath: docPath,
    knownDocPaths,
    taskRef,
  });
}

const COPY_LABEL = "Copy";
const COPIED_LABEL = "Copied";
const COPIED_RESET_MS = 1200;

function addCopyButtons(container: HTMLElement): void {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.querySelector(":scope > [data-copy-code]")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.copyCode = "";
    button.className = "doc-code-copy";
    button.setAttribute("aria-label", "Copy code");
    button.textContent = COPY_LABEL;
    pre.append(button);
  }
}

function copyCodeFromClick(event: MouseEvent<HTMLDivElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const button = target.closest("[data-copy-code]");
  if (!(button instanceof HTMLButtonElement)) return false;

  // Read the <code> rather than the <pre>, which also holds the button's label.
  const pre = button.closest("pre");
  const text = pre?.querySelector("code")?.textContent ?? "";
  // Clipboard may be unavailable (insecure context, denied permission); still
  // confirm, matching useClipboardCopy.
  navigator.clipboard?.writeText(text).catch(() => {});

  button.textContent = COPIED_LABEL;
  window.clearTimeout(Number(button.dataset.resetTimer));
  button.dataset.resetTimer = String(
    window.setTimeout(() => (button.textContent = COPY_LABEL), COPIED_RESET_MS),
  );
  return true;
}

function checkboxToggleFromClick(
  event: MouseEvent<HTMLDivElement>,
): { input: HTMLInputElement; index: number; checked: boolean } | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;

  // Direct click on the box — the browser has already flipped it.
  if (target instanceof HTMLInputElement && target.type === "checkbox") {
    return readCheckbox(target, target.checked);
  }

  // Click elsewhere on the task-list line toggles the line's box, like a native
  // <label>. Anchors keep their own navigation behaviour.
  if (target.closest("a[href]")) return null;
  const input = target
    .closest("li")
    ?.querySelector(":scope > input[type='checkbox']");
  if (!(input instanceof HTMLInputElement)) return null;
  // No native flip happened here, so toggle the input ourselves to keep the
  // optimistic UI in sync before persisting.
  const checked = !input.checked;
  input.checked = checked;
  return readCheckbox(input, checked);
}

function readCheckbox(
  input: HTMLInputElement,
  checked: boolean,
): { input: HTMLInputElement; index: number; checked: boolean } | null {
  const raw = input.getAttribute("data-checkbox-index");
  if (raw === null) return null;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) return null;
  return { input, index, checked };
}

function docErrorMessage(
  error: Error,
  promoted?: { repoPath: string },
): string {
  if (error instanceof HttpError) {
    if (error.status === 404 && promoted) {
      // The pointer synced but the repo file did not: it arrives with the
      // checkout (a pull, the right branch), not with EQNX.
      return `This document was promoted to ${promoted.repoPath} in the project repo, and that file is not on this machine.`;
    }
    if (error.status === 404) return "This document could not be found.";
    if (error.status === 400) {
      return "This document path is outside the task's docs directory.";
    }
    return error.message || "This document could not be read.";
  }
  return "This document could not be read.";
}
