import { readNextStepText } from "./state-parser.ts";

/**
 * Archive suggestion — "this task looks done; archive it?"
 *
 * EQNX only ever *suggests* archiving. Nothing here, or anywhere downstream,
 * archives a task: the board offers a one-click archive the user may take or
 * dismiss, and the re-entry manifest tells the agent it may offer the same.
 *
 * The rule is deliberately conservative — a suggestion on live work is worse
 * than a missed one — so it rests on an explicit signal, never on inactivity:
 *
 * 1. The task's `state.md` **declares itself done** in its Next step (see
 *    {@link declaresDone}); the `trace-state` skill writes `Done.` there when
 *    the work is finished.
 * 2. **No work started after that declaration** — no session registered and no
 *    doc added since the prose was written. New work means it wasn't done.
 * 3. The user has **not dismissed** the suggestion since that prose was
 *    written. A dismissal sticks until the state is rewritten; a fresh
 *    declaration may suggest again.
 */
export type ArchiveSuggestionInput = {
  archivedAt: string | null;
  /** The raw `state.md` contents, or undefined when the task has none. */
  stateText?: string;
  /** When the state prose was written (the prose stamp, else registration). */
  stateWrittenAt?: string;
  /** The newest session start or doc registration on the task, state excluded. */
  lastWorkAt?: string;
  /** When the user last dismissed this task's suggestion, if ever. */
  dismissedAt?: string | null;
};

export function suggestsArchive(input: ArchiveSuggestionInput): boolean {
  if (input.archivedAt !== null) return false;
  if (!input.stateText || !input.stateWrittenAt) return false;
  if (!declaresDone(input.stateText)) return false;
  if (input.lastWorkAt && input.lastWorkAt > input.stateWrittenAt) return false;
  if (input.dismissedAt && input.dismissedAt >= input.stateWrittenAt) {
    return false;
  }
  return true;
}

// Sentence-initial declarations. Each must end the clause — "Done." or
// "Done —", never "Done with slice 1" or "Complete the rollout".
const DONE_OPENER =
  /^(?:done|complete|completed|finished|shipped|nothing (?:else )?(?:left(?: to do)?|remaining|required|outstanding|to do|needed))(?=\s*(?:$|[.!:;,—–-]))/i;

// A declaration anywhere in the first sentence, naming the task itself as done.
const TASK_IS_DONE =
  /\b(?:it|this task|the task|the work|this work) is (?:now )?(?:done|complete|completed|finished|shipped)\b/i;

// Completion that hangs on something still to happen is not completion yet.
const HEDGE =
  /\b(?:after|once|until|unless|otherwise|optionally|when|before|pending|awaiting|if)\b/i;

/**
 * Whether `state.md`'s Next step explicitly says the task is done. Only the
 * first sentence of the Next step's first block is read: the declaration has
 * to lead, and any hedge in that sentence ("after merge", "once", "pending")
 * vetoes it.
 */
export function declaresDone(stateText: string): boolean {
  const nextStep = readNextStepText(stateText);
  if (!nextStep) return false;
  const sentence = firstSentence(plainText(nextStep));
  if (!sentence || HEDGE.test(sentence)) return false;
  return DONE_OPENER.test(sentence) || TASK_IS_DONE.test(sentence);
}

function plainText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/gm, "")
    .replace(/(\*\*|__|\*|_)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text: string): string {
  const end = /[.!?](?=\s|$)/.exec(text);
  return (end ? text.slice(0, end.index + 1) : text).trim();
}
