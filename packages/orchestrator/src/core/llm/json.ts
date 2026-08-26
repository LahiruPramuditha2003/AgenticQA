/**
 * Pulling JSON back out of a chat completion.
 *
 * ⚠️ **Reasoning models answer in prose first.** Some emit `<think>…</think>`, which is easy to strip —
 * but others (NVIDIA's Nemotron among them) just start talking: *"We need to output a JSON test plan for
 * the user request…"*, walk through an inline example or two, and only then produce the real object. A
 * naive `indexOf("{") … lastIndexOf("}")` slice therefore starts inside the *reasoning* and yields
 * unparseable text. On demo-web's prompt 14 that turned a 5663-character, perfectly usable response into
 * `RAG: LLM output invalid`, silently downgrading the run to the page-grounded fallback.
 *
 * So: scan for *balanced, string-aware* candidates and let the caller pick. Brace counting must ignore
 * braces inside string literals (`"{"` is common in a plan's own example text) and honour backslash
 * escapes, or the count drifts and every candidate after it is garbage.
 */

/**
 * Every balanced `{…}` region in `text`, in order of appearance.
 *
 * String-aware: braces inside double-quoted strings don't affect nesting. Unterminated regions are
 * skipped rather than throwing — a truncated response should degrade, not explode.
 */
export function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) {break;}

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = start; j < text.length; j++) {
      const c = text[j];

      if (inString) {
        if (escaped) {escaped = false;}
        else if (c === "\\") {escaped = true;}
        else if (c === '"') {inString = false;}
        continue;
      }

      if (c === '"') {inString = true;}
      else if (c === "{") {depth++;}
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end === -1) {break;} // unterminated — nothing usable from here on
    out.push(text.slice(start, end + 1));
    i = end + 1;
  }

  return out;
}

/**
 * The first balanced JSON object in `text`.
 *
 * Kept for callers that expect exactly one object and want a throw on absence. Prefer
 * `extractJsonObjects` when the response may contain reasoning: the first object is often an inline
 * example, not the answer.
 */
export function extractFirstJsonObject(text: string): string {
  const [first] = extractJsonObjects(text);
  if (!first) {
    throw new Error(
      text.includes("{")
        ? "Unmatched braces in LLM response"
        : "No JSON object found in LLM response"
    );
  }
  return first;
}
