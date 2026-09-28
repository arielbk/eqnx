import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DOC_POINTER_SUFFIX, serializeDocPointer } from "./doc-pointer.ts";
import { openTraceStore, resolveTaskDocsDir } from "./index.ts";
import { handleTraceApiRequest } from "./api-handler.ts";

let dir: string;
let databasePath: string;
let projectRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-doc-promotion-"));
  databasePath = join(dir, "store", "trace.sqlite");
  projectRoot = join(dir, "repo");
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedTask(docs: Record<string, string> = { "checkout.prd.md": "# Checkout PRD\n" }) {
  const store = openTraceStore(databasePath);
  const task = store.createTask("checkout", projectRoot);
  const docsDir = resolveTaskDocsDir(databasePath, task.slug);
  mkdirSync(docsDir, { recursive: true });
  for (const [name, content] of Object.entries(docs)) {
    writeFileSync(join(docsDir, name), content);
  }
  return { store, task, docsDir };
}

test("promoteTaskDoc moves the doc into the repo and the task lists it from there", () => {
  const { store, task, docsDir } = seedTask();
  const source = join(docsDir, "checkout.prd.md");
  const registered = store.addTaskDoc(task.id, source, {
    title: "Checkout PRD",
    description: "What we are building",
  });

  try {
    const promoted = store.promoteTaskDoc(task.slug, source);
    const target = join(projectRoot, "docs", "checkout.prd.md");
    const pointerPath = `${source}${DOC_POINTER_SUFFIX}`;

    expect(promoted).toEqual({
      taskId: task.id,
      path: target,
      createdAt: registered.createdAt,
      title: "Checkout PRD",
      description: "What we are building",
      promoted: { repoPath: "docs/checkout.prd.md", pointerPath, missing: false },
    });
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("# Checkout PRD\n");
    // One source of truth: the task lists the repo file, exactly once.
    expect(store.listDocsForTask(task.id)).toEqual([promoted]);
  } finally {
    store.close();
  }
});

test("a promoted doc that was never registered keeps its original date", () => {
  const { store, task, docsDir } = seedTask();
  const source = join(docsDir, "checkout.prd.md");
  const past = new Date("2026-02-03T04:05:06.000Z");
  utimesSync(source, past, past);

  try {
    const promoted = store.promoteTaskDoc(task.id, source, { to: "specs/" });
    expect(promoted.path).toBe(join(projectRoot, "specs", "checkout.prd.md"));
    expect(promoted.createdAt).toBe(past.toISOString());
    expect(promoted.title).toBeUndefined();
  } finally {
    store.close();
  }
});

test("promoteTaskDoc accepts a doc path relative to the task's docs dir", () => {
  const { store, task } = seedTask();
  try {
    expect(store.promoteTaskDoc(task.id, "checkout.prd.md").promoted?.repoPath).toBe(
      "docs/checkout.prd.md",
    );
  } finally {
    store.close();
  }
});

test("promoteTaskDoc refuses a task without a project root", () => {
  const store = openTraceStore(databasePath);
  const task = store.createTask("loose");
  const docsDir = resolveTaskDocsDir(databasePath, task.slug);
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "notes.md"), "# Notes\n");
  try {
    expect(() => store.promoteTaskDoc(task.id, join(docsDir, "notes.md"))).toThrow(
      /no project root/,
    );
  } finally {
    store.close();
  }
});

test("a promoted doc whose repo file is missing still lists, flagged missing", () => {
  const { store, task, docsDir } = seedTask();
  try {
    const promoted = store.promoteTaskDoc(task.id, join(docsDir, "checkout.prd.md"));
    unlinkSync(promoted.path);

    const [listed] = store.listDocsForTask(task.id);
    expect(listed?.path).toBe(promoted.path);
    expect(listed?.promoted?.missing).toBe(true);

    const timeline = store.getTaskTimeline(task.id);
    const docItem = timeline?.items.find((item) => item.type === "doc");
    expect(docItem).toMatchObject({ sizeBytes: null });
  } finally {
    store.close();
  }
});

test("a pointer that arrived by sync resolves against this machine's project root", () => {
  // The pointer is the only thing that syncs; the repo file comes with the
  // checkout. Simulate a pulled pointer beside a checkout that has the file.
  const { store, task, docsDir } = seedTask({});
  writeFileSync(
    join(docsDir, `plan.md${DOC_POINTER_SUFFIX}`),
    serializeDocPointer({ repoPath: "docs/plan.md" }),
  );
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(join(projectRoot, "docs", "plan.md"), "# The plan\n");

  try {
    expect(store.listDocsForTask(task.id)).toEqual([
      expect.objectContaining({
        path: join(projectRoot, "docs", "plan.md"),
        promoted: {
          repoPath: "docs/plan.md",
          pointerPath: join(docsDir, `plan.md${DOC_POINTER_SUFFIX}`),
          missing: false,
        },
      }),
    ]);
  } finally {
    store.close();
  }
});

test("title and description edits after promotion land on the pointer", () => {
  const { store, task, docsDir } = seedTask();
  try {
    const promoted = store.promoteTaskDoc(task.id, join(docsDir, "checkout.prd.md"));
    // Callers address the doc by what the listing shows: the repo path.
    store.updateTaskDoc(task.id, promoted.path, { description: "Now in the repo" });

    expect(store.listDocsForTask(task.id)).toEqual([
      expect.objectContaining({ path: promoted.path, description: "Now in the repo" }),
    ]);
  } finally {
    store.close();
  }
});

test("the re-entry manifest indexes a promoted doc by its repo file", () => {
  const { store, task, docsDir } = seedTask();
  try {
    const promoted = store.promoteTaskDoc(task.id, join(docsDir, "checkout.prd.md"));
    expect(store.getReEntryManifest(task.id)?.docs).toEqual([
      {
        title: "Checkout PRD",
        path: promoted.path,
        promoted: { repoPath: "docs/checkout.prd.md", missing: false },
      },
    ]);
  } finally {
    store.close();
  }
});

test("the board API serves a promoted doc from the repo, and nothing else outside the docs dir", () => {
  const { store, task, docsDir } = seedTask();
  const promoted = store.promoteTaskDoc(task.id, join(docsDir, "checkout.prd.md"));
  const outsider = join(projectRoot, "secret.md");
  writeFileSync(outsider, "# Secret\n");
  store.close();

  const read = (path: string) =>
    handleTraceApiRequest(
      databasePath,
      "GET",
      `/api/tasks/${task.slug}/docs?path=${encodeURIComponent(path)}`,
    )!;

  const ok = read(promoted.path);
  expect(ok.status).toBe(200);
  expect(String(ok.body)).toContain("Checkout PRD");

  expect(read(outsider).status).toBe(400);

  unlinkSync(promoted.path);
  expect(read(promoted.path).status).toBe(404);
});
