/**
 * What interaction does the request actually ask for? (G3.11)
 *
 * BM25 ranks a golden flow by the **words** it shares with the request. It has no idea whether the flow
 * can *do* the thing being asked. That gap is the whole remaining substantive shortfall on both apps,
 * measured 2026-08-11: 8 of 20 TaskFlow plans and 2 of 20 demo-web plans lack an interaction their prompt
 * spells out. The clearest case is TaskFlow prompt 18 — *"Sign in with … and click Sign in"* — which
 * retrieved `smoke-login`, **a page-load check**, while `form-login` sat in the same pack. Retrieval was
 * not confused about the topic; it simply never asked whether the flow submits anything.
 *
 * ⚠️ **This duplicates `scripts/auditSpecSubstance.js`'s `INTERACTION_SIGNALS` on purpose, and there is a
 * test that fails if the two ever disagree.** The auditor decides whether a generated spec did what was
 * asked; the planner decides what to try. They must read a prompt identically or the metric measures
 * something the engine was never aiming at — but sharing one function would mean a mistake in the rule is
 * invisible to both at once. Two independent implementations forced into agreement by
 * `test/requestedInteractions.test.js` keeps the measurement honest.
 *
 * Is this teaching to the test? No, and the reason is worth stating: the rule contains no app vocabulary,
 * no route, no benchmark phrasing — only the generic English verbs for "type here", "pick from a
 * dropdown", "tick this", "press that". A planner that tries to perform the verb the user wrote is not
 * gaming a metric; it is doing its job. The guard against gaming is that this file may never learn a
 * word that belongs to one application.
 */

/** Ordered so the returned list reads in the same order the auditor reports `expected`. */
const SIGNALS: Array<{ action: string; re: RegExp }> = [
  { action: "fill", re: /\b(fill(?:\s+in)?|enter|type|input)\b/i },
  {
    // Must clearly denote a <select>. Bare "select"/"choose" are excluded: they routinely mean "click a
    // menu item" ("click the user menu, select Logout"), which would demand a `select` step from a plan
    // that correctly clicks.
    action: "select",
    re: /\b(dropdown|sort by|select [\w\s"']+ from|set (?:the )?[\w\s]+ (?:dropdown )?to)\b/i,
  },
  { action: "check", re: /\b(tick|check(?:\s+the)?\s+\w*\s*(?:checkbox|box)|checkboxes?)\b/i },
  { action: "click", re: /\b(click|submit|send|press)\b/i },
];

/** The interaction kinds a request explicitly asks for, ordered and de-duped. */
export function requestedInteractions(prompt: string | undefined | null): string[] {
  const out: string[] = [];
  for (const s of SIGNALS) {
    if (s.re.test(String(prompt ?? "")) && !out.includes(s.action)) {out.push(s.action);}
  }
  return out;
}

/** Step actions that count as performing each requested kind. */
const SATISFIED_BY: Record<string, string[]> = {
  fill: ["fill"],
  select: ["select"],
  check: ["check", "uncheck"],
  click: ["click"],
};

/**
 * Fraction of the request's demanded interactions that a step list can actually perform — 1 when the
 * request demands nothing, so a flow is never penalised for a prompt that only asks to look at a page.
 */
export function interactionCoverage(steps: any[] | undefined, wanted: string[]): number {
  if (!wanted.length) {return 1;}
  const have = new Set((steps ?? []).map((s) => String(s?.action ?? "")));
  const met = wanted.filter((w) => (SATISFIED_BY[w] ?? [w]).some((a) => have.has(a))).length;
  return met / wanted.length;
}
