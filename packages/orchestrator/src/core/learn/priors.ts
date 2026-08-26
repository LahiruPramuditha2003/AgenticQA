/**
 * Turning recorded history into decisions (G4).
 *
 * Limitation **L4** was never that outcomes weren't stored — they were, faithfully, and then ignored.
 * This module is the reading half: pure functions from "what happened before" to "what to prefer now".
 * Pure on purpose, so every judgement below can be argued about offline with no database, no browser and
 * no LLM.
 *
 * ⚠️ **The governing rule is that no history means no opinion.** Every function here returns `null` (or
 * leaves order untouched) when the evidence is absent or too thin, and every caller treats that as "behave
 * exactly as you did before G4". A brand-new locator must not be *penalised* for being new — scoring it
 * zero would make it lose to anything with a single lucky pass, which is precisely backwards.
 */

/**
 * Wilson score lower bound at ~95% confidence.
 *
 * ⚠️ **Not a pass rate.** A raw `passes/attempts` says 1/1 = 100%, which would let one lucky run beat a
 * locator with 47 passes out of 50. Wilson asks the honest question — *given this evidence, how low could
 * the true rate plausibly be?* — so 1/1 scores ≈0.21 while 47/50 scores ≈0.82. Confidence grows with
 * evidence, which is the entire point of learning from history rather than from the last run.
 */
export function wilsonLowerBound(passes: number, attempts: number): number {
  if (!Number.isFinite(attempts) || attempts <= 0) {return 0;}
  const n = attempts;
  const p = Math.max(0, Math.min(1, passes / n));
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

/** Minimum attempts before a track record is allowed to override the resolver's own choice. */
export const MIN_EVIDENCE = 3;

export interface LocatorTrack {
  locator: string;
  attempts: number;
  passes: number;
}

/**
 * Choose between locators that all currently resolve, using their track records.
 *
 * Returns `null` — meaning *keep whatever you were going to do* — unless history is genuinely decisive:
 * the winner needs `MIN_EVIDENCE` attempts of its own, and it must beat the resolver's first choice by a
 * real margin, not a rounding difference.
 *
 * ⚠️ A candidate with **no** record is never demoted. It is unproven, not bad, and the resolver picked it
 * for reasons (role match, name match, page) that this function cannot see.
 */
export function preferReliableLocator(
  candidates: string[],
  stats: Map<string, LocatorTrack>,
  minEvidence = MIN_EVIDENCE
): string | null {
  if (candidates.length < 2) {return null;}

  const scored = candidates
    .map((locator) => {
      const st = stats.get(locator);
      return st && st.attempts >= minEvidence
        ? { locator, score: wilsonLowerBound(st.passes, st.attempts) }
        : null;
    })
    .filter((x): x is { locator: string; score: number } => x !== null);

  if (!scored.length) {return null;} // nothing proven → no opinion

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.locator === candidates[0]) {return null;} // already the resolver's pick

  // The resolver's first choice only loses to *proven* evidence. If it has no record of its own it is
  // unproven rather than bad, so overriding it needs the winner to be solidly reliable.
  const incumbent = stats.get(candidates[0]);
  const incumbentScore =
    incumbent && incumbent.attempts >= minEvidence
      ? wilsonLowerBound(incumbent.passes, incumbent.attempts)
      : null;

  if (incumbentScore === null) {return best.score >= 0.6 ? best.locator : null;}
  return best.score - incumbentScore >= 0.1 ? best.locator : null;
}

export interface HealTrack {
  newLocator: string;
  attempts: number;
  successes: number;
}

/**
 * Reorder heal candidates by what previously worked for this same step.
 *
 * A replacement that healed this step before and led to a **passing re-run** goes first; one that was
 * tried and never worked goes last. Candidates with no record keep their relative order in between —
 * again, unproven is not bad.
 *
 * ⚠️ Evidence here is `run_passed_after`, never "the patch was applied". The 2026-08-11 prompt-14 run
 * applied two patches and failed harder than before (D24); by the applied-patch measure that was a
 * success twice over.
 */
export function rankHealCandidates<T extends { locator: string }>(
  candidates: T[],
  feedback: Map<string, HealTrack>
): T[] {
  if (candidates.length < 2 || feedback.size === 0) {return candidates;}

  const rank = (c: T): number => {
    const f = feedback.get(c.locator);
    if (!f || f.attempts === 0) {return 0;} // unproven — keep the middle
    if (f.successes > 0) {return 1;} // known to have worked
    return -1; // tried, never worked
  };

  // Stable: equal ranks retain the caller's ordering, which encodes similarity we must not discard.
  return candidates
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.c);
}

/** Minimum runs before "sometimes passes, sometimes fails" is worth calling flaky rather than fixed. */
export const MIN_FLAKE_RUNS = 4;

/**
 * Is this spec flaky — mixed outcomes across recent runs, rather than consistently broken or fixed?
 *
 * ⚠️ Mixed is not enough on its own. A test that failed three times and now passes is **fixed**, not
 * flaky, and calling it flaky would train the reader to ignore a real signal. Flakiness means the outcome
 * keeps *changing*: at least two transitions in the recent window.
 *
 * `outcomes` is newest-first, as returned by `getRecentSpecOutcomes`.
 */
export function detectFlakiness(outcomes: boolean[], minRuns = MIN_FLAKE_RUNS): boolean {
  if (outcomes.length < minRuns) {return false;}
  const passes = outcomes.filter(Boolean).length;
  if (passes === 0 || passes === outcomes.length) {return false;} // consistently one thing
  let transitions = 0;
  for (let i = 1; i < outcomes.length; i++) {
    if (outcomes[i] !== outcomes[i - 1]) {transitions++;}
  }
  return transitions >= 2;
}

export interface FlowTrack {
  flowKey: string;
  attempts: number;
  passes: number;
}

/**
 * A multiplicative prior on a flow's retrieval score, from how often plans built on it actually passed.
 *
 * Bounded to a **narrow band** on purpose. Retrieval relevance is the primary signal and history is a
 * tie-breaker; a flow that is textually the obvious answer must not be displaced because it once failed
 * for an unrelated reason. Range is `[0.85, 1.15]`, and exactly `1` (no effect) until `MIN_EVIDENCE`
 * attempts exist.
 */
export function flowPrior(stat: FlowTrack | undefined, minEvidence = MIN_EVIDENCE): number {
  if (!stat || stat.attempts < minEvidence) {return 1;}
  const reliability = wilsonLowerBound(stat.passes, stat.attempts);
  // reliability 0 → 0.85, 1 → 1.15
  return 0.85 + 0.3 * reliability;
}
