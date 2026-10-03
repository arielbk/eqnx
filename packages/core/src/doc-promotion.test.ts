import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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

test("moveTaskDoc moves the doc into the repo and the task lists it from there", () => {
  const { store, task, docsDir } = seedTask();
  const source = join(docsDir, "checkout.prd.md");
  const registered = store.addTaskDoc(task.id, source, {
    title: "Checkout PRD",
    description: "What we are building",
  });

  try {
    const promoted = store.moveTaskDoc(task.slug, source, { to: "repo" });
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
    const promoted = store.moveTaskDoc(task.id, source, {
      to: "repo",
      repoPath: "specs/",
    });
    expect(promoted.path).toBe(join(projectRoot, "specs", "checkout.prd.md"));
    expect(promoted.createdAt).toBe(past.toISOString());
    expect(promoted.title).toBeUndefined();
  } finally {
    store.close();
  }
});

test("moveTaskDoc accepts a doc path relative to the task's docs dir", () => {
  const { store, task } = seedTask();
  try {
    expect(
      store.moveTaskDoc(task.id, "checkout.prd.md", { to: "repo" }).promoted
        ?.repoPath,
    ).toBe("docs/checkout.prd.md");
  } finally {
    store.close();
  }
});

test("moveTaskDoc refuses a task without a project root", () => {
  const store = openTraceStore(databasePath);
  const task = store.createTask("loose");
  const docsDir = resolveTaskDocsDir(databasePath, task.slug);
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "notes.md"), "# Notes\n");
  try {
    expect(() =>
      store.moveTaskDoc(task.id, join(docsDir, "notes.md"), { to: "repo" }),
    ).toThrow(/no project root/);
  } finally {
    store.close();
  }
});

test("a promoted doc whose repo file is missing still lists, flagged missing", () => {
  const { store, task, docsDir } = seedTask();
  try {
    const promoted = store.moveTaskDoc(
      task.id,
      join(docsDir, "checkout.prd.md"),
      { to: "repo" },
    );
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
    const promoted = store.moveTaskDoc(
      task.id,
      join(docsDir, "checkout.prd.md"),
      { to: "repo" },
    );
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
    const promoted = store.moveTaskDoc(
      task.id,
      join(docsDir, "checkout.prd.md"),
      { to: "repo" },
    );
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
  const promoted = store.moveTaskDoc(
    task.id,
    join(docsDir, "checkout.prd.md"),
    { to: "repo" },
  );
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

test("a promoted doc found only in another checkout lists from there, and refuses writes", () => {
  // A second checkout of the project (a worktree on another branch) holds the
  // file; the task's own checkout does not. Reading it is fine, but it may be
  // a different version, so the board must not write into it.
  const { store, task, docsDir } = seedTask({});
  const otherCheckout = join(dir, "worktree");
  mkdirSync(join(otherCheckout, "docs"), { recursive: true });
  const otherFile = join(otherCheckout, "docs", "plan.md");
  writeFileSync(otherFile, "# The plan\n\n- [ ] ship it\n");
  writeFileSync(
    join(docsDir, `plan.md${DOC_POINTER_SUFFIX}`),
    serializeDocPointer({ repoPath: "docs/plan.md" }),
  );
  store.close();

  const sqlite = new DatabaseSync(databasePath);
  sqlite
    .prepare(
      "INSERT INTO project_roots (root_path, project_id, created_at) VALUES (?, ?, ?)",
    )
    .run(otherCheckout, task.projectId, new Date().toISOString());
  sqlite.close();

  const reopened = openTraceStore(databasePath);
  try {
    expect(reopened.listDocsForTask(task.id)).toEqual([
      expect.objectContaining({
        path: otherFile,
        promoted: expect.objectContaining({ missing: false, otherCheckout }),
      }),
    ]);
    expect(reopened.getReEntryManifest(task.id)?.docs).toEqual([
      expect.objectContaining({
        promoted: { repoPath: "docs/plan.md", missing: false, otherCheckout },
      }),
    ]);
  } finally {
    reopened.close();
  }

  const read = handleTraceApiRequest(
    databasePath,
    "GET",
    `/api/tasks/${task.slug}/docs?path=${encodeURIComponent(otherFile)}`,
  )!;
  expect(read.status).toBe(200);

  const write = handleTraceApiRequest(
    databasePath,
    "POST",
    `/api/tasks/${task.slug}/docs/checkbox`,
    JSON.stringify({ path: otherFile, index: 0, checked: true }),
  )!;
  const move = handleTraceApiRequest(
    databasePath,
    "POST",
    `/api/tasks/${task.slug}/docs/move`,
    JSON.stringify({ path: otherFile, to: "task" }),
  )!;
  expect(move.status).toBe(409);
  expect(move.body).toContain("another checkout");
  expect(write.status).toBe(409);
  expect(readFileSync(otherFile, "utf8")).toContain("- [ ] ship it");
});

test("moving back restores current repository contents and document metadata", () => {
  const { store, task, docsDir } = seedTask();
  const source = join(docsDir, "checkout.prd.md");
  const registered = store.addTaskDoc(task.id, source, {
    title: "Checkout PRD",
  });
  try {
    const repoDoc = store.moveTaskDoc(task.id, source, { to: "repo" });
    writeFileSync(repoDoc.path, "# Edited in the repository\n");
    const restored = store.moveTaskDoc(task.id, repoDoc.path, { to: "task" });
    expect(readFileSync(source, "utf8")).toBe("# Edited in the repository\n");
    expect(existsSync(repoDoc.path)).toBe(false);
    expect(existsSync(`${source}${DOC_POINTER_SUFFIX}`)).toBe(false);
    expect(restored).toMatchObject({
      path: source,
      title: registered.title,
      createdAt: registered.createdAt,
    });
    expect(restored.promoted).toBeUndefined();
    expect(store.listDocsForTask(task.id)).toEqual([restored]);
  } finally {
    store.close();
  }
});

test("moving back refuses a task-storage collision without changing either file", () => {
  const { store, task, docsDir } = seedTask();
  const source = join(docsDir, "checkout.prd.md");
  try {
    const repoDoc = store.moveTaskDoc(task.id, source, { to: "repo" });
    writeFileSync(source, "# Different task copy\n");
    expect(() =>
      store.moveTaskDoc(task.id, repoDoc.path, { to: "task" }),
    ).toThrow(/already exists/);
    expect(readFileSync(source, "utf8")).toBe("# Different task copy\n");
    expect(readFileSync(repoDoc.path, "utf8")).toBe("# Checkout PRD\n");
    expect(existsSync(repoDoc.promoted!.pointerPath)).toBe(true);
  } finally {
    store.close();
  }
});

test("the API moves a repository file back", () => {
  const { store, task, docsDir } = seedTask();
  const repoDoc = store.moveTaskDoc(task.id, join(docsDir, "checkout.prd.md"), {
    to: "repo",
  });
  store.close();
  const response = handleTraceApiRequest(
    databasePath,
    "POST",
    `/api/tasks/${task.slug}/docs/move`,
    JSON.stringify({ path: repoDoc.path, to: "task" }),
  )!;
  expect(response.status).toBe(200);
  expect(JSON.parse(response.body as string).path).toBe(
    join(docsDir, "checkout.prd.md"),
  );
});

test("a missing repository file cannot be moved back and keeps its pointer", () => {
  const { store, task, docsDir } = seedTask();
  try {
    const doc = store.moveTaskDoc(task.id, "checkout.prd.md", { to: "repo" });
    unlinkSync(doc.path);
    expect(() => store.moveTaskDoc(task.id, "checkout.prd.md", { to: "task" })).toThrow(/not found/);
    expect(existsSync(doc.promoted!.pointerPath)).toBe(true);
    expect(existsSync(join(docsDir, "checkout.prd.md"))).toBe(false);
  } finally { store.close(); }
});


test("moving a repository symlink back refuses without breaking the linked file", () => {
  const { store, task, docsDir } = seedTask();
  try {
    const doc = store.moveTaskDoc(task.id, "checkout.prd.md", { to: "repo" });
    const linkedFile = join(projectRoot, "docs", "linked.md");
    writeFileSync(linkedFile, "# Linked file\n");
    unlinkSync(doc.path);
    symlinkSync("linked.md", doc.path);
    expect(() => store.moveTaskDoc(task.id, "checkout.prd.md", { to: "task" })).toThrow(/symbolic link/);
    expect(readFileSync(linkedFile, "utf8")).toBe("# Linked file\n");
    expect(existsSync(doc.promoted!.pointerPath)).toBe(true);
    expect(existsSync(join(docsDir, "checkout.prd.md"))).toBe(false);
  } finally { store.close(); }
});
