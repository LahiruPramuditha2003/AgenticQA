/**
 * Static credential extraction for the knowledge-pack generator (N2.1). Pure (operates on file contents).
 *
 * Credentials cannot be discovered by crawling — they live in seed/fixture/mock/demo-login source. We only
 * surface email+password pairs that ALREADY EXIST as literals in the code (never invent them); when none
 * are found the generator omits `credentials` (the planner falls back to page-grounded form filling).
 */

export interface ExtractedCredential {
  email: string;
  password: string;
  /** Detected from a nearby `role: "admin"` literal, when present. */
  role?: string;
}

function roleNear(content: string, idx: number): string | undefined {
  const window = content.slice(Math.max(0, idx - 140), idx + 140);
  const m = window.match(/role\s*[:=]\s*["'`](admin|customer|user|seller|manager|owner)["'`]/i);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Find email+password literal pairs (in either order, within ~120 chars of each other) across the given
 * sources. Distinct by (email, password). Picks up object literals like
 * `{ email: 'a@b.com', password: 'pw' }` and guard expressions like `password !== 'pw' && email !== 'a@b'`.
 */
export function extractCredentials(
  sources: Array<{ path: string; content: string }>
): ExtractedCredential[] {
  const out: ExtractedCredential[] = [];
  const seen = new Set<string>();
  // Dedupe by EMAIL (first pairing wins). The email-first pass runs before the password-first pass, so an
  // object literal `{ email, password }` is captured correctly before the password-first pass can mis-bridge
  // one object's password to the next object's email.
  const push = (email: string, password: string, role?: string) => {
    const key = email.toLowerCase();
    if (seen.has(key)) {return;}
    seen.add(key);
    out.push(role ? { email, password, role } : { email, password });
  };

  // Operator class allows `:` (object), `=` (assignment), and `==`/`===`/`!==` (guard expressions like
  // demo api.ts `password !== 'pw' && email !== 'a@b'`, which still reveal the valid demo credentials).
  const emailThenPw =
    /email\s*[:=!]{1,3}\s*["'`]([^"'`\s]+@[^"'`\s]+)["'`][\s\S]{0,120}?password\s*[:=!]{1,3}\s*["'`]([^"'`]+)["'`]/gi;
  const pwThenEmail =
    /password\s*[:=!]{1,3}\s*["'`]([^"'`]+)["'`][\s\S]{0,120}?email\s*[:=!]{1,3}\s*["'`]([^"'`\s]+@[^"'`\s]+)["'`]/gi;

  for (const s of sources ?? []) {
    const content = s.content ?? "";
    let m: RegExpExecArray | null;
    while ((m = emailThenPw.exec(content))) {push(m[1], m[2], roleNear(content, m.index));}
    while ((m = pwThenEmail.exec(content))) {push(m[2], m[1], roleNear(content, m.index));}
  }
  return out;
}
