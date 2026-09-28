import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isStateDocument } from "./state-document.ts";

/**
 * Doc promotion moves a task doc out of the task's docs directory and into the
 * project repo, leaving a **doc pointer** behind so the task still lists it.
 * The pointer is a small JSON file next to where the doc used to live, named
 * `<original filename>` + {@link DOC_POINTER_SUFFIX}. It lives in the docs
 * directory on purpose: that directory is what doc sync ships, so the pointer
 * (and the title/description keyed on its path) travels to every machine
 * without a schema change. The target is recorded repo-relative, since the
 * absolute checkout path is machine-local; each machine resolves it against
 * its own roots for the task's project, and reports it missing when the file
 * is not there (not pulled yet, a different branch, or no checkout at all).
 */
export const DOC_POINTER_SUFFIX = ".eqnx-pointer.json";

export type DocPointer = {
  /** Where the doc now lives, relative to the project root, POSIX-separated. */
  repoPath: string;
};

export function isDocPointerPath(path: string): boolean {
  return path.endsWith(DOC_POINTER_SUFFIX);
}

export function serializeDocPointer(pointer: DocPointer): string {
  return `${JSON.stringify({ eqnxDocPointer: 1, repoPath: pointer.repoPath }, null, 2)}\n`;
}

/**
 * Parse a pointer file's contents, or null when it is not a pointer this
 * version understands. A synced pointer is untrusted input, so the repo path
 * must stay inside whatever root it is later joined onto.
 */
export function parseDocPointer(raw: string): DocPointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { eqnxDocPointer, repoPath } = parsed as Record<string, unknown>;
  if (eqnxDocPointer !== 1 || typeof repoPath !== "string") return null;
  return isSafeRepoPath(repoPath) ? { repoPath } : null;
}

function isSafeRepoPath(repoPath: string): boolean {
  if (repoPath.length === 0 || repoPath.startsWith("/") || repoPath.includes("\\")) {
    return false;
  }
  return repoPath
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Resolve a pointer's repo path against candidate project roots (this task's
 * recorded root first, then any other root this machine knows for the
 * project). The task's own checkout is the first root that exists on this
 * machine — the recorded one may be another machine's path after a sync. A
 * file found only in some other checkout (a worktree on another branch, a
 * second clone) still resolves, but is flagged with `otherCheckout`: it may be
 * a different version, so callers must not write to it. When no root holds
 * the file, the target is reported missing at the task's own checkout so
 * callers still have a path to show.
 */
export function resolveDocPointerTarget(
  repoPath: string,
  roots: readonly string[],
): { path: string; missing: boolean; otherCheckout?: string } {
  const candidates = roots.filter((root) => root.trim().length > 0);
  const home = candidates.find(isExistingDirectory) ?? candidates[0];
  const at = (root: string) => join(root, ...repoPath.split("/"));

  if (home && isFile(at(home))) return { path: at(home), missing: false };
  for (const root of candidates) {
    if (root !== home && isFile(at(root))) {
      return { path: at(root), missing: false, otherCheckout: root };
    }
  }
  return { path: home ? at(home) : repoPath, missing: true };
}

export type PromoteDocFileInput = {
  docsDir: string;
  docPath: string;
  projectRoot: string;
  /**
   * Where to put the doc, relative to the project root (absolute paths inside
   * the root are accepted). A trailing slash means "into this directory".
   * Defaults to the repo's `docs/` directory, keeping the filename.
   */
  to?: string;
};

export type PromoteDocFileResult = {
  repoPath: string;
  targetPath: string;
  pointerPath: string;
};

/**
 * Move a task doc into the project repo and leave a pointer in its place.
 * Refuses rather than guesses: the doc must be a file in the task's docs
 * directory, the target must sit inside the project root (and not loop back
 * into the docs directory through a symlink), and an existing target is never
 * overwritten.
 */
export function promoteDocFile(input: PromoteDocFileInput): PromoteDocFileResult {
  const docsDir = resolve(input.docsDir);
  const docPath = resolve(docsDir, input.docPath);
  const projectRoot = resolve(input.projectRoot);

  if (!isInside(docsDir, docPath)) {
    throw new Error(`Doc is not in the task's docs directory: ${docPath}`);
  }
  if (isDocPointerPath(docPath)) {
    throw new Error(`Doc is already promoted: ${docPath}`);
  }
  if (isStateDocument(docPath)) {
    throw new Error("state.md is the task's State Document and cannot be promoted");
  }
  if (!isFile(docPath)) {
    const earlier = readPointer(`${docPath}${DOC_POINTER_SUFFIX}`);
    throw new Error(
      earlier
        ? `Doc is already promoted to ${earlier.repoPath}`
        : `Doc not found: ${docPath}`,
    );
  }

  const targetPath = resolveTarget(projectRoot, input.to, basename(docPath));
  if (!isInside(projectRoot, targetPath)) {
    throw new Error(`Promotion target must be inside the project root: ${targetPath}`);
  }
  if (isStateDocument(targetPath)) {
    throw new Error("A promoted doc cannot be named state.md");
  }
  if (isInside(realpathOrSelf(docsDir), realpathOfNearestAncestor(targetPath))) {
    throw new Error(
      `Promotion target resolves into the task's docs directory: ${targetPath}`,
    );
  }
  if (existsSync(targetPath)) {
    throw new Error(`Promotion target already exists: ${targetPath}`);
  }

  const pointerPath = `${docPath}${DOC_POINTER_SUFFIX}`;
  if (existsSync(pointerPath)) {
    throw new Error(`A pointer already exists for this doc: ${pointerPath}`);
  }

  const repoPath = relative(projectRoot, targetPath).split(sep).join("/");
  const { mtime } = statSync(docPath);

  mkdirSync(dirname(targetPath), { recursive: true });
  moveFileAcrossDevices(docPath, targetPath);
  try {
    writeFileSync(pointerPath, serializeDocPointer({ repoPath }), { flag: "wx" });
    // Keep the doc's original date on the pointer: it is what the listing
    // reports (and what sync stamps elsewhere), so the doc keeps its place in
    // the timeline instead of jumping to the promotion moment.
    utimesSync(pointerPath, mtime, mtime);
  } catch (error) {
    // Without a pointer the task would lose the doc; put it back.
    rmSync(pointerPath, { force: true });
    moveFileAcrossDevices(targetPath, docPath);
    throw error;
  }

  return { repoPath, targetPath, pointerPath };
}

/**
 * `rename`, falling back to copy + unlink when source and target sit on
 * different filesystems (the task store and a checkout often do). The target
 * must not exist; the copy refuses to overwrite one.
 */
export function moveFileAcrossDevices(
  source: string,
  target: string,
  fs: { rename?: (from: string, to: string) => void } = {},
): void {
  const rename = fs.rename ?? renameSync;
  try {
    rename(source, target);
    return;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EXDEV")) {
      throw error;
    }
  }
  const { atime, mtime } = statSync(source);
  copyFileSync(source, target, 1 /* COPYFILE_EXCL */);
  utimesSync(target, atime, mtime);
  unlinkSync(source);
}

function resolveTarget(projectRoot: string, to: string | undefined, fileName: string): string {
  if (to === undefined || to.trim().length === 0) {
    return join(projectRoot, "docs", fileName);
  }
  const trimmed = to.trim();
  const base = resolve(projectRoot, trimmed);
  const isDirectory =
    trimmed.endsWith("/") || trimmed.endsWith(sep) || isExistingDirectory(base);
  return isDirectory ? join(base, fileName) : base;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function readPointer(path: string): DocPointer | null {
  try {
    return parseDocPointer(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// The target does not exist yet, so resolve symlinks on the deepest ancestor
// that does and re-attach the rest.
function realpathOfNearestAncestor(path: string): string {
  let current = path;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathOrSelf(current), ...rest);
}
