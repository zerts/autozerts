/**
 * Shift+number jump shortcuts for ordered lists: items 1–9 map to Shift+1…9
 * and the 10th item to Shift+0. Shared by the dashboard loop list and the loop
 * page's quick links so both number the same way. We match on `KeyboardEvent.code`
 * ("Digit1"…"Digit0") because holding Shift turns the digit row into symbols
 * ("!", "@", …) in `KeyboardEvent.key`. Plain Cmd/Ctrl+number is avoided because
 * browsers reserve it for tab switching.
 */

/** The key label shown for the item at `index` (0-based), or null past the 10th. */
export function digitForIndex(index: number): string | null {
  if (index < 0 || index > 9) return null;
  return index === 9 ? "0" : String(index + 1);
}

/** The 0-based item index a pressed `e.code` selects, or -1 if it isn't a jump key. */
export function indexForCode(code: string): number {
  if (code === "Digit0") return 9;
  const m = /^Digit([1-9])$/.exec(code);
  return m ? Number(m[1]) - 1 : -1;
}

/**
 * Letter-row jump shortcuts (Shift+Q, Shift+W, …), following the QWERTY top row.
 * Used by the dashboard's repo quick links so they don't collide with the loop
 * list's Shift+number shortcuts. We match on `KeyboardEvent.code` ("KeyQ"…) since
 * it's layout-stable and unaffected by the Shift modifier.
 */
const LETTER_ROW = "QWERTYUIOP";

/** The letter label shown for the item at `index` (0-based), or null past the 10th. */
export function letterForIndex(index: number): string | null {
  if (index < 0 || index >= LETTER_ROW.length) return null;
  return LETTER_ROW[index];
}

/** The 0-based item index a pressed `e.code` selects from the letter row, or -1. */
export function indexForLetterCode(code: string): number {
  const m = /^Key([A-Z])$/.exec(code);
  return m ? LETTER_ROW.indexOf(m[1]) : -1;
}

/** True when a keydown originated in a text field, where digits should type normally. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}
