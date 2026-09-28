import { describe, expect, test } from "vitest";
import { declaresDone, suggestsArchive } from "./archive-suggestion.ts";

function stateWithNextStep(nextStep: string): string {
  return `# Where things stand

## Current state

The work is in place.

## Next step

${nextStep}

---

<!-- trace:docs-manifest:start -->
*Other docs in this task: [plan.md](plan.md)*
<!-- trace:docs-manifest:end -->
`;
}

describe("declaresDone", () => {
  test.each([
    ["Done."],
    ["Done — the reminder now points at `task update-doc`."],
    ["**Done.** Optional polish is listed in decisions.md."],
    ["Complete."],
    ["Finished!"],
    ["Shipped."],
    ["Nothing required — the task is shipped."],
    ["Nothing left to do."],
    ["Nothing remaining. The QA doc lists one optional GUI check."],
    ["Nothing blocks this task; it is done. Two loose ends are in decisions.md."],
    ["The task is done."],
    ["This task is complete; see the QA plan for the record."],
  ])("an explicit done declaration counts: %s", (nextStep) => {
    expect(declaresDone(stateWithNextStep(nextStep))).toBe(true);
  });

  test.each([
    // Real next actions that merely start with a done-ish word.
    ["Complete the cross-surface rollout by wiring the icon."],
    ["Done with slice 1; start slice 2."],
    ["Finish the QA walkthrough, then merge."],
    // Something else is done, not the task.
    ["Live e2e is done. What remains is merge + publish."],
    // Conditional or pending completion is not done yet.
    ["Get PR #58 merged; after merge the task can be archived."],
    ["Done once PR #12 merges."],
    ["Done — pending review of PR #12."],
    ["Optionally confirm from a live pane; otherwise the task is done."],
    ["The task is done when the release is cut."],
    ["PR #29 is open and green — awaiting merge. Nothing else outstanding."],
    ["Nothing else unblocking. Only the polish below remains."],
    // No declaration at all.
    ["Run the QA plan."],
    ["None"],
  ])("anything short of an explicit declaration does not: %s", (nextStep) => {
    expect(declaresDone(stateWithNextStep(nextStep))).toBe(false);
  });

  test("only the Next step counts, not the summary or current state", () => {
    const state = `# Done

## Current state

Done. Everything shipped.

## Next step

Cut the release.
`;
    expect(declaresDone(state)).toBe(false);
  });

  test("only the first block of the Next step counts", () => {
    expect(
      declaresDone(stateWithNextStep("Merge PR #12.\n\nDone after that.")),
    ).toBe(false);
  });

  test("a declaration wrapped across lines still counts", () => {
    expect(
      declaresDone(
        stateWithNextStep("Nothing required — the task\nis shipped."),
      ),
    ).toBe(true);
  });

  test("a state file with no Next step does not declare done", () => {
    expect(declaresDone("# Shipped\n\n## Current state\n\nAll merged.\n")).toBe(
      false,
    );
    expect(declaresDone("")).toBe(false);
  });
});

describe("suggestsArchive", () => {
  const done = stateWithNextStep("Done.");
  const base = {
    archivedAt: null,
    stateText: done,
    stateWrittenAt: "2026-09-01T10:00:00.000Z",
    lastWorkAt: "2026-09-01T09:00:00.000Z",
    dismissedAt: null,
  };

  test("suggests archiving an active task whose state declares it done", () => {
    expect(suggestsArchive(base)).toBe(true);
  });

  test("never suggests for an archived task", () => {
    expect(
      suggestsArchive({ ...base, archivedAt: "2026-09-02T00:00:00.000Z" }),
    ).toBe(false);
  });

  test("never suggests without a state file or a declaration", () => {
    expect(suggestsArchive({ ...base, stateText: undefined })).toBe(false);
    expect(
      suggestsArchive({ ...base, stateText: stateWithNextStep("Run QA.") }),
    ).toBe(false);
  });

  test("never suggests when it cannot tell when the state was written", () => {
    expect(suggestsArchive({ ...base, stateWrittenAt: undefined })).toBe(false);
  });

  test("work that started after the declaration withdraws the suggestion", () => {
    expect(
      suggestsArchive({ ...base, lastWorkAt: "2026-09-01T11:00:00.000Z" }),
    ).toBe(false);
  });

  test("a task with no other work on record can still be suggested", () => {
    expect(suggestsArchive({ ...base, lastWorkAt: undefined })).toBe(true);
  });

  test("a dismissal sticks for the state it was made against", () => {
    expect(
      suggestsArchive({ ...base, dismissedAt: "2026-09-03T00:00:00.000Z" }),
    ).toBe(false);
  });

  test("a later state that declares done again brings the suggestion back", () => {
    expect(
      suggestsArchive({
        ...base,
        dismissedAt: "2026-09-01T09:30:00.000Z",
      }),
    ).toBe(true);
  });
});
