import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openTraceStore, resolveTaskDocsDir } from "./index.ts";
import { renderProseMarker } from "./prose-fingerprint.ts";
import type { TaskStore } from "./types.ts";

// The prose stamp far in the future keeps every session and doc these tests
// create "before" the declaration; one far in the past puts them after it.
const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function writeState(
  databasePath: string,
  slug: string,
  nextStep: string,
  writtenAt: string,
): void {
  const docsDir = resolveTaskDocsDir(databasePath, slug);
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, "state.md"),
    `# Where it stands\n\n## Next step\n\n${nextStep}\n\n${renderProseMarker({
      fingerprint: "abc123",
      writtenAt,
    })}\n`,
  );
}

describe("archive suggestion in the store", () => {
  let dir: string;
  let databasePath: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-archive-suggestion-"));
    databasePath = join(dir, "trace.sqlite");
    store = openTraceStore(databasePath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a task whose state declares it done is suggested on every surface", () => {
    const task = store.createTask("checkout");
    writeState(databasePath, task.slug, "Done.", FUTURE);

    expect(store.listTaskSummaries()[0]?.archiveSuggested).toBe(true);
    expect(store.getTaskTimeline(task.id)?.archiveSuggested).toBe(true);
    expect(store.getReEntryManifest(task.id)?.archiveSuggested).toBe(true);
  });

  test("a task still in progress carries no suggestion key at all", () => {
    const task = store.createTask("checkout");
    writeState(databasePath, task.slug, "Run the QA plan.", FUTURE);

    expect(store.listTaskSummaries()[0]).not.toHaveProperty("archiveSuggested");
    expect(store.getTaskTimeline(task.id)).not.toHaveProperty(
      "archiveSuggested",
    );
    expect(store.getReEntryManifest(task.id)).not.toHaveProperty(
      "archiveSuggested",
    );
  });

  test("an archived task is never suggested", () => {
    const task = store.createTask("checkout");
    writeState(databasePath, task.slug, "Done.", FUTURE);
    store.archiveTask(task.id);

    expect(store.listTaskSummaries()[0]?.archiveSuggested).toBeUndefined();
    expect(store.getTaskTimeline(task.id)?.archiveSuggested).toBeUndefined();
  });

  test("a session started after the declaration withdraws the suggestion", () => {
    const task = store.createTask("checkout");
    writeState(databasePath, task.slug, "Done.", PAST);
    const session = store.registerSession({
      id: "later-session",
      transcriptPath: "/tmp/later.jsonl",
      tool: "claude",
    });
    store.assignSession(session.id, task.id);

    expect(store.listTaskSummaries()[0]?.archiveSuggested).toBeUndefined();
    expect(store.getTaskTimeline(task.id)?.archiveSuggested).toBeUndefined();
  });

  test("a doc added after the declaration withdraws the suggestion", () => {
    const task = store.createTask("checkout");
    writeState(databasePath, task.slug, "Done.", PAST);
    const docPath = join(resolveTaskDocsDir(databasePath, task.slug), "qa.md");
    writeFileSync(docPath, "# QA\n");
    store.addTaskDoc(task.id, docPath);

    expect(store.listTaskSummaries()[0]?.archiveSuggested).toBeUndefined();
  });

  test("dismissing sticks until the state is rewritten, and never archives", () => {
    const task = store.createTask("checkout");
    writeState(databasePath, task.slug, "Done.", PAST);

    const dismissed = store.dismissArchiveSuggestion(task.slug);
    expect(dismissed.archivedAt).toBeNull();
    expect(store.listTaskSummaries()[0]?.archiveSuggested).toBeUndefined();
    expect(store.getTaskTimeline(task.id)?.archiveSuggested).toBeUndefined();
    expect(store.getReEntryManifest(task.id)?.archiveSuggested).toBeUndefined();

    // A later prose pass that still says done may suggest again.
    writeState(databasePath, task.slug, "Done.", FUTURE);
    expect(store.listTaskSummaries()[0]?.archiveSuggested).toBe(true);
  });

  test("dismissing an unknown task throws the usual not-found error", () => {
    expect(() => store.dismissArchiveSuggestion("nope")).toThrow(
      "Task not found: nope",
    );
  });

  test("dismissal is machine-local: it does not move the sync clock", () => {
    const task = store.createTask("checkout");
    const before = store.syncSnapshot().tasks[0]?.updatedAt;
    store.dismissArchiveSuggestion(task.id);
    expect(store.syncSnapshot().tasks[0]?.updatedAt).toBe(before);
  });
});
