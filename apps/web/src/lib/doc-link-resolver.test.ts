import { describe, expect, test } from "vitest";
import { resolveTaskDocLink } from "./doc-link-resolver.ts";

const docs = [
  "/home/u/.trace/tasks/demo/docs/plan.md",
  "/home/u/.trace/tasks/demo/docs/notes/next.md",
  "/home/u/.trace/tasks/demo/docs/research/context.md",
  "/home/u/.trace/tasks/demo/docs/root.md",
  "/home/u/.trace/tasks/demo/docs/encoded name.md",
  "/home/u/.trace/tasks/demo/docs/data.json",
];

function resolve(href: string, baseDocPath = docs[0] ?? "") {
  return resolveTaskDocLink({
    href,
    baseDocPath,
    knownDocPaths: docs,
    taskRef: "demo task",
  });
}

function route(docPath: string) {
  return `/task/${encodeURIComponent("demo task")}/docs/${encodeURIComponent(docPath)}`;
}

describe("resolveTaskDocLink", () => {
  test("resolves same-directory markdown links", () => {
    expect(resolve("next.md", docs[1])).toBe(route(docs[1] ?? ""));
  });

  test("resolves nested relative markdown links", () => {
    expect(resolve("research/context.md")).toBe(route(docs[2] ?? ""));
  });

  test("resolves parent-directory links that stay inside known task docs", () => {
    expect(resolve("../root.md", docs[1])).toBe(route(docs[3] ?? ""));
  });

  test("resolves root-relative links from the task docs root", () => {
    expect(resolve("/root.md", docs[1])).toBe(route(docs[3] ?? ""));
  });

  test("resolves relative links from a relative base doc path at the task docs root", () => {
    expect(resolve("root.md", "state.md")).toBe(route(docs[3] ?? ""));
  });

  test("matches encoded markdown hrefs against known task docs", () => {
    expect(resolve("encoded%20name.md")).toBe(route(docs[4] ?? ""));
  });

  test("does not capture unknown markdown files", () => {
    expect(resolve("missing.md")).toBeNull();
  });

  test("does not capture non-markdown files", () => {
    expect(resolve("data.json")).toBeNull();
  });

  test("does not capture fragment-only links", () => {
    expect(resolve("#section")).toBeNull();
  });

  test("does not capture external http or https links", () => {
    expect(resolve("https://example.com/plan.md")).toBeNull();
    expect(resolve("http://example.com/plan.md")).toBeNull();
  });

  test("does not capture unsafe protocols", () => {
    expect(resolve("javascript:alert(1)")).toBeNull();
    expect(resolve("file:///etc/passwd.md")).toBeNull();
  });
});

describe("resolveTaskDocLink with a promoted doc", () => {
  // The board lists pointer paths first: they sit in the task docs dir, so
  // they anchor the docs root even when the repo file also has a /docs/ path.
  const known = [
    "/home/u/.trace/tasks/demo/docs/plan.md.eqnx-pointer.json",
    "/repo/docs/plan.md",
    "/home/u/.trace/tasks/demo/docs/spec.md",
  ];
  const fromState = (href: string) =>
    resolveTaskDocLink({ href, baseDocPath: "state.md", knownDocPaths: known, taskRef: "demo task" });

  test("state.md footer links still resolve against the task docs dir", () => {
    expect(fromState("spec.md")).toBe(route("/home/u/.trace/tasks/demo/docs/spec.md"));
  });

  test("a footer link to the promoted doc's repo file resolves to it", () => {
    expect(fromState("../../../../../../repo/docs/plan.md")).toBe(route("/repo/docs/plan.md"));
  });
});
