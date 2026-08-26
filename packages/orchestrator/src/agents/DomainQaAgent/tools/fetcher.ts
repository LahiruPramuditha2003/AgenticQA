/**
 * Fetch a URL, extract readable text, and chunk it.
 */

export async function fetchAndExtract(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; AgenticQA/0.1; documentation-reader)",
      Accept: "text/html,application/xhtml+xml,text/plain",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return extractText(html);
}

function extractText(html: string): string {
  // Remove script and style tags (with content)
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Extract useful meta content (often has good summaries for SPAs)
  const metaDescriptions: string[] = [];
  const metaRegex =
    /<meta[^>]+(?:name|property)=["'](?:description|og:description|og:title|twitter:description)["'][^>]+content=["']([^"']+)["']/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    if (match[1]?.trim()) metaDescriptions.push(match[1].trim());
  }
  // Also try reversed attribute order: content before name
  const metaRegex2 =
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|og:title|twitter:description)["']/gi;
  while ((match = metaRegex2.exec(html)) !== null) {
    if (match[1]?.trim()) metaDescriptions.push(match[1].trim());
  }

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim();

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");

  // Clean excessive whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Prepend meta information (useful for SPAs with minimal body text)
  const prefix: string[] = [];
  if (title) prefix.push(`Page title: ${title}`);
  if (metaDescriptions.length > 0) {
    prefix.push(`Description: ${metaDescriptions.join(". ")}`);
  }

  const fullText = prefix.length > 0 ? prefix.join("\n") + "\n\n" + text : text;

  return fullText;
}

export function chunkText(
  text: string,
  opts?: { chunkSize?: number; overlap?: number; maxChunks?: number }
): string[] {
  const chunkSize = opts?.chunkSize ?? 800;
  const overlap = opts?.overlap ?? 100;
  const maxChunks = opts?.maxChunks ?? 30;

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length && chunks.length < maxChunks) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();

    // Skip chunks that are too short to be meaningful
    if (chunk.length > 30) {
      chunks.push(chunk);
    }

    start += chunkSize - overlap;
  }

  return chunks;
}