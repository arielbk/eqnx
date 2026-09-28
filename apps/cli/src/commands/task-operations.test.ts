import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTraceStore, resolveTaskDocsDir } from "@trace/core";
import { expect, test, vi } from "vitest";
import {
  taskAddDocOperation,
  taskCaptureOperation,
  taskCreateOperation,
  taskListOperation,
  taskPromoteDocOperation,
  taskShowOperation,
  taskUpdateDocOperation,
  taskUpdateOperation,
} from "./task-operations.ts";
import type { Env } from "./seam.ts";

function withTempContext(run: (ctx: { env: Env; cwd: string; stdin: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-task-ops-"));
  const env: Env = { ...process.env, TRACE_DB: join(dir, "trace.sqlite") };

  try {
    run({ env, cwd: dir, stdin: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("task create and show round-trip through direct operations", () => {
  withTempContext((ctx) => {
    const created = taskCreateOperation(
      ["Checkout flow", "--description", "Tighten the cart path"],
      ctx,
    );
    expect(created).toMatchObject({ exitCode: 0, stdout: "checkout-flow\n" });
    expect(created.stderr).toContain("created new project");

    const shown = taskShowOperation(["checkout-flow"], ctx);

    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("slug: checkout-flow\n");
    expect(shown.stdout).toContain("title: Checkout flow\n");
    expect(shown.stdout).toContain("description: Tighten the cart path\n");
  });
});

test("task update changes the persisted description", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();

    const updated = taskUpdateOperation(
      [slug, "--description", "Second pass"],
      ctx,
    );

    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("description: Second pass\n");

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      expect(store.getTaskByRef(slug)?.description).toBe("Second pass");
    } finally {
      store.close();
    }
  });
});

test("task update changes the title and keeps the slug", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();

    const updated = taskUpdateOperation([slug, "--title", "Cart wizard"], ctx);

    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("title: Cart wizard\n");
    expect(updated.stdout).toContain("slug: checkout-flow\n");

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      expect(store.getTaskByRef(slug)?.title).toBe("Cart wizard");
    } finally {
      store.close();
    }
  });
});

test("task list prints task summaries, most recently active first", () => {
  withTempContext((ctx) => {
    taskCreateOperation(["Checkout"], ctx);
    taskCreateOperation(["Review"], ctx);

    expect(taskListOperation([], ctx)).toEqual({
      exitCode: 0,
      stdout: "review\tReview\ncheckout\tCheckout\n",
      stderr: "",
    });
  });
});

test("task capture defaults the doc title to the task title", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(["Captured task", "--doc", docPath], ctx);
    expect(result.exitCode).toBe(0);
    const taskId = result.stdout.trim();

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const [doc] = store.listDocsForTask(taskId);
      expect(doc?.title).toBe("Captured task");
    } finally {
      store.close();
    }
  });
});

test("task capture triggers sync after writing its document", () => {
  withTempContext((ctx) => {
    const triggerSync = vi.fn();
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "captured body\n");

    const result = taskCaptureOperation(
      ["Captured task", "--doc", docPath],
      { ...ctx, triggerSync },
    );

    expect(result.exitCode).toBe(0);
    expect(triggerSync).toHaveBeenCalledOnce();
  });
});

test("task add-doc triggers sync after registering a document (handoff path)", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Handoff task"], ctx).stdout.trim();
    const docPath = join(ctx.cwd, "state.md");
    writeFileSync(docPath, "# state\n");
    const triggerSync = vi.fn();

    const result = taskAddDocOperation([slug, docPath], { ...ctx, triggerSync });

    expect(result.exitCode).toBe(0);
    expect(triggerSync).toHaveBeenCalledOnce();
  });
});

test("task add-doc does not trigger sync when the task is not found", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "state.md");
    writeFileSync(docPath, "# state\n");
    const triggerSync = vi.fn();

    const result = taskAddDocOperation(["no-such-task", docPath], {
      ...ctx,
      triggerSync,
    });

    expect(result.exitCode).toBe(1);
    expect(triggerSync).not.toHaveBeenCalled();
  });
});

test("task update-doc triggers sync after updating a document (handoff path)", () => {
  withTempContext((ctx) => {
    const slug = taskCreateOperation(["Handoff task"], ctx).stdout.trim();
    const docPath = join(ctx.cwd, "state.md");
    writeFileSync(docPath, "# state\n");
    taskAddDocOperation([slug, docPath], ctx);
    const triggerSync = vi.fn();

    const result = taskUpdateDocOperation(
      [slug, docPath, "--description", "Handoff state"],
      { ...ctx, triggerSync },
    );

    expect(result.exitCode).toBe(0);
    expect(triggerSync).toHaveBeenCalledOnce();
  });
});

test("task capture --title and --description persist on the doc", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(
      [
        "Captured task",
        "--doc",
        docPath,
        "--title",
        "Spec sketch",
        "--description",
        "First cut",
      ],
      ctx,
    );
    expect(result.exitCode).toBe(0);
    const taskId = result.stdout.trim();

    const store = openTraceStore(ctx.env.TRACE_DB as string);
    try {
      const [doc] = store.listDocsForTask(taskId);
      expect(doc?.title).toBe("Spec sketch");
      expect(doc?.description).toBe("First cut");
    } finally {
      store.close();
    }
  });
});

test("task capture without --description still exits 0 but prints a reminder", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(["Captured task", "--doc", docPath], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--description");
    // The reminder must point at `update-doc`: `add-doc` no-ops on the doc
    // capture just created (existing (task_id, path) row returns early).
    expect(result.stderr).toContain("task update-doc");
    expect(result.stderr).not.toContain("task add-doc");

    const taskId = result.stdout.trim();
    expect(taskId.length).toBeGreaterThan(0);
  });
});

test("task capture with --description stays quiet", () => {
  withTempContext((ctx) => {
    const docPath = join(ctx.cwd, "notes.md");
    writeFileSync(docPath, "some captured body\n");

    const result = taskCaptureOperation(
      ["Captured task", "--doc", docPath, "--description", "All set"],
      ctx,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("created new project");
    expect(result.stderr).not.toContain("Reminder:");
  });
});

test("task show reports a missing ref with exit code 1", () => {
  withTempContext((ctx) => {
    expect(taskShowOperation(["missing"], ctx)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Task not found: missing\n",
    });
  });
});

function seedPromotable(ctx: { env: Env; cwd: string; stdin: string }) {
  const slug = taskCreateOperation(["Checkout flow"], ctx).stdout.trim();
  const docsDir = resolveTaskDocsDir(ctx.env.TRACE_DB as string, slug);
  mkdirSync(docsDir, { recursive: true });
  const docPath = join(docsDir, "checkout.prd.md");
  writeFileSync(docPath, "# Checkout PRD\n");
  return { slug, docsDir, docPath };
}

test("task promote-doc moves a doc into the repo's docs dir and keeps it listed", () => {
  withTempContext((ctx) => {
    const { slug, docPath } = seedPromotable(ctx);
    const triggerSync = vi.fn();

    const result = taskPromoteDocOperation([slug, docPath], { ...ctx, triggerSync });

    const target = join(ctx.cwd, "docs", "checkout.prd.md");
    expect(result).toMatchObject({ exitCode: 0, stdout: `${slug}\t${target}\n` });
    expect(result.stderr).toContain("docs/checkout.prd.md");
    expect(readFileSync(target, "utf8")).toBe("# Checkout PRD\n");
    expect(existsSync(docPath)).toBe(false);
    expect(triggerSync).toHaveBeenCalledOnce();

    // The state.md footer indexes the doc at its new home.
    const shown = taskShowOperation([slug], ctx);
    expect(shown.stdout).toContain(target);
  });
});

test("task promote-doc takes the doc by its name in the docs dir and a --to path", () => {
  withTempContext((ctx) => {
    const { slug } = seedPromotable(ctx);

    const result = taskPromoteDocOperation(
      [slug, "checkout.prd.md", "--to", "specs/checkout.md"],
      { ...ctx, triggerSync: vi.fn() },
    );

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(ctx.cwd, "specs", "checkout.md"), "utf8")).toBe(
      "# Checkout PRD\n",
    );
  });
});

test("task promote-doc refuses to overwrite an existing repo file", () => {
  withTempContext((ctx) => {
    const { slug, docPath } = seedPromotable(ctx);
    mkdirSync(join(ctx.cwd, "docs"));
    writeFileSync(join(ctx.cwd, "docs", "checkout.prd.md"), "# Theirs\n");
    const triggerSync = vi.fn();

    const result = taskPromoteDocOperation([slug, docPath], { ...ctx, triggerSync });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(existsSync(docPath)).toBe(true);
    expect(triggerSync).not.toHaveBeenCalled();
  });
});

test("task promote-doc explains its usage", () => {
  withTempContext((ctx) => {
    expect(taskPromoteDocOperation([], ctx)).toMatchObject({ exitCode: 2 });
    expect(taskPromoteDocOperation(["--help"], ctx).stdout).toContain(
      "eqnx task promote-doc <ref> <path> [--to <repo-path>]",
    );
    const { slug, docPath } = seedPromotable(ctx);
    expect(taskPromoteDocOperation([slug, docPath, "--bogus"], ctx).stderr).toContain(
      "Unknown option: --bogus",
    );
  });
});
