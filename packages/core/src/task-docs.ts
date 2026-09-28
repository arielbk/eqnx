import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  isDocPointerPath,
  parseDocPointer,
  resolveDocPointerTarget,
} from "./doc-pointer.ts";
import type { TaskDoc } from "./types.ts";

// `ref` is the on-disk directory key for a task — the slug for tasks created
// since slugs landed, or a UUID for legacy directories. It is purely a path
// segment; resolution of slug-vs-uuid happens at the call site.
export function resolveTaskDocsDir(databasePath: string, ref: string): string {
  return join(dirname(resolve(databasePath)), "tasks", ref, "docs");
}

// List trace-native docs for a task from its slug directory. Returned docs
// carry the canonical task id. A doc pointer (left behind by promotion) lists
// as the repo file it points at, resolved against `projectRoots` in order.
export function listNativeTaskDocs(
  databasePath: string,
  taskId: string,
  slug: string,
  projectRoots: readonly string[] = [],
): TaskDoc[] {
  return readNativeTaskDocs(databasePath, taskId, slug, projectRoots);
}

function readNativeTaskDocs(
  databasePath: string,
  taskId: string,
  ref: string,
  projectRoots: readonly string[],
): TaskDoc[] {
  const docsDir = resolveTaskDocsDir(databasePath, ref);

  try {
    return readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(docsDir, entry.name);
        const doc: TaskDoc = {
          taskId,
          path,
          createdAt: statSync(path).mtime.toISOString(),
        };
        return isDocPointerPath(path)
          ? followPointer(doc, projectRoots)
          : doc;
      });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
}

// Turn a pointer file into the promoted doc it stands for. A pointer this
// version cannot read stays listed as the plain file it is, rather than
// vanishing from the task.
function followPointer(doc: TaskDoc, projectRoots: readonly string[]): TaskDoc {
  let raw: string;
  try {
    raw = readFileSync(doc.path, "utf8");
  } catch {
    return doc;
  }
  const pointer = parseDocPointer(raw);
  if (!pointer) return doc;
  const target = resolveDocPointerTarget(pointer.repoPath, projectRoots);
  return {
    ...doc,
    path: target.path,
    promoted: {
      repoPath: pointer.repoPath,
      pointerPath: doc.path,
      missing: target.missing,
      ...(target.otherCheckout ? { otherCheckout: target.otherCheckout } : {}),
    },
  };
}

export function mergeTaskDocs(
  registered: TaskDoc[],
  native: TaskDoc[],
  docsDir?: string,
): TaskDoc[] {
  const nativePaths = new Set(native.map((doc) => doc.path));
  const docsByPath = new Map<string, TaskDoc>();
  // A promoted doc is known by two paths: its pointer (where its metadata row
  // lives) and its repo file (what it lists as). Either spelling in a
  // registered row folds onto the one promoted entry.
  const promotedByPath = new Map<string, TaskDoc>();
  for (const doc of native) {
    if (!doc.promoted) continue;
    promotedByPath.set(doc.promoted.pointerPath, doc);
    promotedByPath.set(doc.path, doc);
  }

  for (const doc of registered) {
    const promoted = promotedByPath.get(
      docsDir && !isAbsolute(doc.path) ? resolve(docsDir, doc.path) : doc.path,
    );
    if (promoted) {
      const existing = docsByPath.get(promoted.path);
      docsByPath.set(promoted.path, {
        ...promoted,
        createdAt: existing?.createdAt ?? doc.createdAt,
        ...(existing?.title ?? doc.title
          ? { title: existing?.title ?? doc.title }
          : {}),
        ...(existing?.description ?? doc.description
          ? { description: existing?.description ?? doc.description }
          : {}),
      });
      continue;
    }
    // Rows registered before the CLI canonicalized paths may carry a bare
    // relative path. When that path resolves onto a file the scan found in
    // the docs dir, it is the same doc under a second spelling — fold it in
    // rather than listing it twice. A relative path that resolves elsewhere
    // is left untouched: its original base is unknowable.
    if (docsDir && !isAbsolute(doc.path)) {
      const resolved = resolve(docsDir, doc.path);
      if (nativePaths.has(resolved)) {
        docsByPath.set(resolved, { ...doc, path: resolved });
        continue;
      }
    }
    docsByPath.set(doc.path, doc);
  }

  for (const doc of native) {
    if (!docsByPath.has(doc.path)) {
      docsByPath.set(doc.path, doc);
    }
  }

  return [...docsByPath.values()].sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.path.localeCompare(right.path);
  });
}
