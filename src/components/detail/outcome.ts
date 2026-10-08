export type Outcome = { ok: boolean; message: string };

/**
 * What an action reports when it finishes: a sentence (treated as success), an explicit outcome when
 * it can half-fail, or null for the two-step actions whose first step only reads and has nothing to
 * say yet.
 */
export type ActionResult = string | Outcome | null;

/**
 * Turns a finished action into the notice to show and whether to refetch, or null to stay quiet.
 *
 * Staying quiet is what makes the two-step actions work: the first call only reads, so the panel
 * shows the plan it returned and an outcome notice there would claim something had been changed.
 */
export function resolveAction(
  result: ActionResult,
  refetch: boolean
): { outcome: Outcome; refetch: boolean } | null {
  if (result === null) return null;
  return {
    outcome: typeof result === "string" ? { ok: true, message: result } : result,
    refetch
  };
}

/**
 * Turns whatever an action threw into something worth reading.
 *
 * Not every rejection is an Error: a dropped socket can throw a string, and reading `.message` off
 * one of those gives undefined, which renders as an empty red box that says nothing at all.
 */
export function failureOutcome(err: unknown): Outcome {
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}
