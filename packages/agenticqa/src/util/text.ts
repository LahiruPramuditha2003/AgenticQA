/**
 * Pure text helpers used to interpret what the user typed.
 *
 * Extracted from `extension.ts` in G5.2 for one reason: **`extension.ts` imports `vscode`, so anything
 * living in it can only be tested by downloading and launching a VS Code instance.** That cost is why the
 * extension's entire test suite was a stub asserting `[1,2,3].indexOf(5) === -1` while a 1,600-line file
 * shipped untested. Nothing in this module imports `vscode`, so it runs under plain `node:test`.
 */

/** Trim the punctuation a URL collects when it is written inside a sentence. */
export function sanitizeUrl(u: string): string {
  return u
    .replace(/[),.]+$/g, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

/**
 * The URL the user mentioned, if any — so a request like "test the login page on localhost:5173" can run
 * without a `.agenticqa.json`.
 *
 * A bare `host:port` is accepted and given an `http://` scheme, because that is how people actually write
 * a dev server.
 */
export function extractUrlFromText(text: string): string | undefined {
  const httpMatch = String(text ?? "").match(/https?:\/\/[^\s)]+/i);
  if (httpMatch?.[0]) {return sanitizeUrl(httpMatch[0]);}
  const localMatch = String(text ?? "").match(/(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s)]*)?/i);
  if (localMatch?.[0]) {return sanitizeUrl("http://" + localMatch[0]);}
  return undefined;
}

/**
 * Does this read as a question rather than a test request?
 *
 * ⚠️ Only a hint. The orchestrator's `ReceptionistAgent` is the real intent classifier; this exists so the
 * extension can pick a sensible placeholder and progress message before the orchestrator has answered.
 * Being wrong here costs a slightly odd label, never a wrong run.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = String(text ?? "").toLowerCase().trim();
  return (
    t.endsWith("?") ||
    t.startsWith("what ") ||
    t.startsWith("what's ") ||
    t.startsWith("how ") ||
    t.startsWith("why ") ||
    t.startsWith("when ") ||
    t.startsWith("where ") ||
    t.startsWith("who ") ||
    t.startsWith("tell me") ||
    t.startsWith("explain")
  );
}
