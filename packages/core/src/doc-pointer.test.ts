import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  DOC_POINTER_SUFFIX,
  isDocPointerPath,
  moveFileAcrossDevices,
  parseDocPointer,
  promoteDocFile,
  resolveDocPointerTarget,
  serializeDocPointer,
} from "./doc-pointer.ts";

let dir: string;
let docsDir: string;
let projectRoot: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-doc-pointer-"));
  docsDir = join(dir, "tasks", "checkout", "docs");
  projectRoot = join(dir, "repo");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a pointer round-trips through its serialized form", () => {
  const raw = serializeDocPointer({ repoPath: "docs/checkout.prd.md" });
  expect(parseDocPointer(raw)).toEqual({ repoPath: "docs/checkout.prd.md" });
});

test("parseDocPointer rejects anything that is not a safe repo-relative path", () => {
  expect(parseDocPointer("not json")).toBeNull();
  expect(parseDocPointer(JSON.stringify({ eqnxDocPointer: 1 }))).toBeNull();
  for (const repoPath of ["/etc/passwd", "../outside.md", "docs/../../x.md", "", "docs\\x.md"]) {
    expect(parseDocPointer(JSON.stringify({ eqnxDocPointer: 1, repoPath }))).toBeNull();
  }
});

test("pointer files are recognized by their suffix", () => {
  expect(isDocPointerPath(`/d/spec.md${DOC_POINTER_SUFFIX}`)).toBe(true);
  expect(isDocPointerPath("/d/spec.md")).toBe(false);
});

test("resolveDocPointerTarget prefers the task's own checkout", () => {
  const otherRoot = join(dir, "other-checkout");
  for (const root of [projectRoot, otherRoot]) {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "spec.md"), "# Spec\n");
  }

  expect(resolveDocPointerTarget("docs/spec.md", [projectRoot, otherRoot])).toEqual({
    path: join(projectRoot, "docs", "spec.md"),
    missing: false,
  });
});

test("resolveDocPointerTarget flags a file found only in another checkout", () => {
  const otherRoot = join(dir, "other-checkout");
  mkdirSync(join(otherRoot, "docs"), { recursive: true });
  writeFileSync(join(otherRoot, "docs", "spec.md"), "# Spec\n");

  expect(resolveDocPointerTarget("docs/spec.md", [projectRoot, otherRoot])).toEqual({
    path: join(otherRoot, "docs", "spec.md"),
    missing: false,
    otherCheckout: otherRoot,
  });
});

test("resolveDocPointerTarget treats the first root on this machine as the task's own", () => {
  // A synced task keeps the root it was stamped with on another machine.
  const elsewhere = join(dir, "not-on-this-machine");
  mkdirSync(join(projectRoot, "docs"), { recursive: true });
  writeFileSync(join(projectRoot, "docs", "spec.md"), "# Spec\n");

  expect(resolveDocPointerTarget("docs/spec.md", [elsewhere, projectRoot])).toEqual({
    path: join(projectRoot, "docs", "spec.md"),
    missing: false,
  });
});

test("resolveDocPointerTarget reports a missing target at the first root", () => {
  expect(resolveDocPointerTarget("docs/spec.md", ["", projectRoot])).toEqual({
    path: join(projectRoot, "docs", "spec.md"),
    missing: true,
  });
});

test("resolveDocPointerTarget with no root at all keeps the repo-relative path", () => {
  expect(resolveDocPointerTarget("docs/spec.md", [])).toEqual({
    path: "docs/spec.md",
    missing: true,
  });
});

test("promoteDocFile moves the doc into the repo's docs dir and leaves a pointer", () => {
  const source = join(docsDir, "checkout.prd.md");
  writeFileSync(source, "# Checkout PRD\n");
  const past = new Date("2026-01-02T03:04:05.000Z");
  utimesSync(source, past, past);

  const result = promoteDocFile({ docsDir, docPath: source, projectRoot });

  expect(result).toEqual({
    repoPath: "docs/checkout.prd.md",
    targetPath: join(projectRoot, "docs", "checkout.prd.md"),
    pointerPath: `${source}${DOC_POINTER_SUFFIX}`,
  });
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(result.targetPath, "utf8")).toBe("# Checkout PRD\n");
  expect(parseDocPointer(readFileSync(result.pointerPath, "utf8"))).toEqual({
    repoPath: "docs/checkout.prd.md",
  });
  // The pointer carries the doc's original date, so the task timeline does
  // not re-date the doc to the moment it was promoted.
  expect(statSync(result.pointerPath).mtime.toISOString()).toBe(past.toISOString());
});

test("promoteDocFile honours --to relative to the project root", () => {
  const source = join(docsDir, "spec.md");
  writeFileSync(source, "# Spec\n");

  const result = promoteDocFile({
    docsDir,
    docPath: source,
    projectRoot,
    to: "design/checkout/spec.md",
  });

  expect(result.repoPath).toBe("design/checkout/spec.md");
  expect(readFileSync(join(projectRoot, "design/checkout/spec.md"), "utf8")).toBe("# Spec\n");
});

test("promoteDocFile treats a --to ending in a slash as a directory", () => {
  const source = join(docsDir, "spec.md");
  writeFileSync(source, "# Spec\n");

  const result = promoteDocFile({ docsDir, docPath: source, projectRoot, to: "adr/" });

  expect(result.repoPath).toBe("adr/spec.md");
});

test("promoteDocFile refuses to overwrite an existing target", () => {
  const source = join(docsDir, "spec.md");
  writeFileSync(source, "# Spec\n");
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(join(projectRoot, "docs", "spec.md"), "# Someone else's\n");

  expect(() => promoteDocFile({ docsDir, docPath: source, projectRoot })).toThrow(
    /already exists/,
  );
  expect(readFileSync(source, "utf8")).toBe("# Spec\n");
  expect(readFileSync(join(projectRoot, "docs", "spec.md"), "utf8")).toBe("# Someone else's\n");
  expect(existsSync(`${source}${DOC_POINTER_SUFFIX}`)).toBe(false);
});

test("promoteDocFile refuses a target outside the project root", () => {
  const source = join(docsDir, "spec.md");
  writeFileSync(source, "# Spec\n");

  expect(() =>
    promoteDocFile({ docsDir, docPath: source, projectRoot, to: "../escape.md" }),
  ).toThrow(/inside the project/);
  expect(existsSync(source)).toBe(true);
});

test("promoteDocFile refuses docs that are not in the task's docs dir", () => {
  const elsewhere = join(dir, "elsewhere.md");
  writeFileSync(elsewhere, "# Elsewhere\n");

  expect(() => promoteDocFile({ docsDir, docPath: elsewhere, projectRoot })).toThrow(
    /task's docs directory/,
  );
});

test("promoteDocFile refuses the State Document, a missing doc, and a pointer", () => {
  writeFileSync(join(docsDir, "state.md"), "# State\n");
  expect(() =>
    promoteDocFile({ docsDir, docPath: join(docsDir, "state.md"), projectRoot }),
  ).toThrow(/state\.md/);

  expect(() =>
    promoteDocFile({ docsDir, docPath: join(docsDir, "nope.md"), projectRoot }),
  ).toThrow(/not found/i);

  const pointer = join(docsDir, `spec.md${DOC_POINTER_SUFFIX}`);
  writeFileSync(pointer, serializeDocPointer({ repoPath: "docs/spec.md" }));
  expect(() => promoteDocFile({ docsDir, docPath: pointer, projectRoot })).toThrow(
    /already promoted/,
  );
});

test("promoteDocFile refuses a target that would read as a State Document", () => {
  const source = join(docsDir, "notes.md");
  writeFileSync(source, "# Notes\n");

  expect(() =>
    promoteDocFile({ docsDir, docPath: source, projectRoot, to: "docs/state.md" }),
  ).toThrow(/state\.md/);
});

test("moveFileAcrossDevices falls back to copy and unlink on EXDEV", () => {
  const source = join(docsDir, "spec.md");
  const target = join(projectRoot, "spec.md");
  writeFileSync(source, "# Spec\n");

  moveFileAcrossDevices(source, target, {
    rename: () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    },
  });

  expect(existsSync(source)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("# Spec\n");
});

test("moveFileAcrossDevices rethrows errors other than EXDEV", () => {
  const source = join(docsDir, "spec.md");
  writeFileSync(source, "# Spec\n");

  expect(() =>
    moveFileAcrossDevices(source, join(projectRoot, "spec.md"), {
      rename: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
  ).toThrow(/denied/);
  expect(existsSync(source)).toBe(true);
});

test("promoteDocFile refuses a target that resolves back into the task's docs dir", () => {
  const source = join(docsDir, "spec.md");
  writeFileSync(source, "# Spec\n");
  // `task capture --link` symlinks <repo>/docs/<slug> at the task docs dir.
  mkdirSync(join(projectRoot, "docs"));
  symlinkSync(docsDir, join(projectRoot, "docs", "checkout"));

  expect(() =>
    promoteDocFile({ docsDir, docPath: source, projectRoot, to: "docs/checkout/spec-copy.md" }),
  ).toThrow(/task's docs directory/);
  expect(existsSync(source)).toBe(true);
});

test("promoting the same doc twice says it is already promoted", () => {
  const source = join(docsDir, "spec.md");
  writeFileSync(source, "# Spec\n");
  promoteDocFile({ docsDir, docPath: source, projectRoot });

  expect(() => promoteDocFile({ docsDir, docPath: source, projectRoot })).toThrow(
    /already promoted to docs\/spec\.md/,
  );
});
