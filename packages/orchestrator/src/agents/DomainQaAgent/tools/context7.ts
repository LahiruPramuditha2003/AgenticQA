/**
 * Context7 Document Search and Retrieval Tools
 * 
 * Provides tools to search and fetch documentation from Context7.com
 * Uses Context7's search API and document fetching capabilities.
 */

/**
 * Helper: Fetch with timeout
 */
function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...init,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

export interface Context7Document {
  id: string;
  title: string;
  url: string;
  description?: string;
  library?: string;
  score?: number;
}

export interface SearchResult {
  documents: Context7Document[];
  query: string;
  totalResults: number;
}

/**
 * Search Context7 for relevant documentation
 * Uses the Context7 search API to find documents matching a query
 */
export async function searchContext7(
  query: string,
  opts?: { limit?: number; apiKey?: string }
): Promise<SearchResult> {
  const limit = opts?.limit ?? 10;
  const apiKey = opts?.apiKey;

  // Context7 provides a search endpoint via their API
  const searchUrl = "https://api.context7.com/mcp/search";
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "AgenticQA/1.0 (Documentation QA Agent)",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetchWithTimeout(searchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        limit,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(
          "Context7 API requires authentication. Get an API key from context7.com"
        );
      }
      if (response.status === 404) {
        // API endpoint not found - fall back to web scraping
        return await searchContext7Fallback(query, limit);
      }
      throw new Error(
        `Context7 search failed: ${response.status} ${response.statusText}`
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError: any) {
      throw new Error(`Failed to parse Context7 response: ${parseError?.message}`);
    }
    
    return {
      documents: (data.results || data.documents || []).map((doc: any) => ({
        id: doc.id || doc.url || `doc-${Date.now()}-${Math.random()}`,
        title: doc.title || "Untitled Document",
        url: doc.url || doc.link || "",
        description: doc.description || doc.summary || "",
        library: doc.library || doc.source || "",
        score: doc.score || data.scores?.[0] || 0,
      })),
      query,
      totalResults: data.total || data.totalResults || data.results?.length || 0,
    };
  } catch (error: any) {
    // Fall back to web scraping if API fails
    // Error handled gracefully - return fallback results
    return await searchContext7Fallback(query, limit);
  }
}

/**
 * Fallback search using web scraping when API is unavailable
 * Uses multiple strategies to find relevant Context7 documentation
 */
async function searchContext7Fallback(
  query: string,
  limit: number
): Promise<SearchResult> {
  const documents: Context7Document[] = [];
  
  // Strategy 1: Try the docs index page which lists all documentation sections
  try {
    const docsIndexUrl = "https://context7.com/docs";
    const response = await fetchWithTimeout(docsIndexUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AgenticQA/1.0; documentation-search)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (response.ok) {
      const html = await response.text();
      const indexDocs = parseContext7DocsIndex(html, query, limit);
      documents.push(...indexDocs);
    }
  } catch (error: any) {
    // Index fetch failed, continue to next strategy
    // Error is handled gracefully by trying fallback strategies
  }

  // Strategy 2: If we have documents from index, filter by query relevance
  if (documents.length > 0) {
    // Score documents based on keyword matching
    const queryKeywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    
    for (const doc of documents) {
      const searchText = `${doc.title} ${doc.description}`.toLowerCase();
      let matchCount = 0;
      for (const keyword of queryKeywords) {
        if (searchText.includes(keyword)) matchCount++;
      }
      doc.score = matchCount / queryKeywords.length;
    }

    // Sort by relevance score and limit
    documents.sort((a, b) => (b.score || 0) - (a.score || 0));
    
    if (documents.length > limit) {
      documents.length = limit;
    }

    return {
      documents,
      query,
      totalResults: documents.length,
    };
  }

  // Strategy 3: Try search endpoint as last resort
  try {
    const searchUrl = `https://context7.com/search?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AgenticQA/1.0; documentation-search)",
        Accept: "text/html,application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Search page fetch failed: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        const data = await response.json();
        return {
          documents: (data.results || []).map((doc: any) => ({
            id: doc.id || doc.url || `doc-${Date.now()}`,
            title: doc.title || "Untitled",
            url: doc.url || doc.link || "",
            description: doc.description || "",
            library: doc.library || "",
            score: doc.score || 0,
          })),
          query,
          totalResults: data.total || data.results?.length || 0,
        };
      } catch (parseError: any) {
        // JSON parsing failed, fall through to HTML parsing
      }
    }

    // HTML response - parse search results from page
    const html = await response.text();
    const searchDocs = parseContext7SearchResults(html, query, limit);
    return {
      documents: searchDocs,
      query,
      totalResults: searchDocs.length,
    };
  } catch (error: any) {
    // Search endpoint failed, will return curated list
  }

  // Strategy 4: Return curated list of common documentation pages
  const commonDocs = [
    {
      id: "context7-intro",
      title: "Introduction to Context7",
      url: "https://context7.com/docs/intro",
      description: "Learn what Context7 is and how it provides up-to-date documentation to AI assistants",
      library: "Context7",
      score: 0.5,
    },
    {
      id: "context7-installation",
      title: "Installation Guide",
      url: "https://context7.com/docs/installation",
      description: "How to install and set up Context7 MCP server",
      library: "Context7",
      score: 0.5,
    },
    {
      id: "context7-how-to-authentication",
      title: "Authentication",
      url: "https://context7.com/docs/how-to/authentication",
      description: "How to authenticate with Context7 API",
      library: "Context7",
      score: 0.5,
    },
    {
      id: "context7-api-guide",
      title: "API Guide",
      url: "https://context7.com/docs/api-guide",
      description: "Complete API reference for Context7",
      library: "Context7",
      score: 0.5,
    },
    {
      id: "context7-best-practices",
      title: "Best Practices",
      url: "https://context7.com/docs/best-practices",
      description: "Best practices for using Context7",
      library: "Context7",
      score: 0.5,
    },
  ];

  return {
    documents: commonDocs.slice(0, limit),
    query,
    totalResults: commonDocs.length,
  };
}

/**
 * Parse search results from Context7 HTML page
 */
function parseContext7SearchResults(
  html: string,
  query: string,
  limit: number
): Context7Document[] {
  const documents: Context7Document[] = [];
  
  // Try to extract document links and titles from HTML
  // Context7 uses a structured format for search results
  
  // Extract potential document URLs
  const urlRegex = /href=["'](https?:\/\/context7\.com\/[^\s"']+)["']/gi;
  const urls = new Set<string>();
  let match;
  while ((match = urlRegex.exec(html)) !== null) {
    const url = match[1];
    // Filter to only documentation pages
    if (url.includes("/docs") || url.includes("/library")) {
      urls.add(url);
    }
  }

  // Extract titles (simplified - looks for text near URLs)
  const titleRegex = /<[^>]*>([^<]{10,200})<\/[^>]*>/g;
  const titles: string[] = [];
  while ((match = titleRegex.exec(html)) !== null) {
    const text = match[1].trim();
    // Filter meaningful titles
    if (
      text.length > 5 &&
      text.length < 150 &&
      !text.startsWith("<") &&
      !text.match(/^(nav|menu|footer|header|link|script)/i)
    ) {
      titles.push(text);
    }
  }

  // Pair URLs with titles
  const urlArray = Array.from(urls);
  for (let i = 0; i < Math.min(urlArray.length, limit); i++) {
    documents.push({
      id: `doc-${i}-${Date.now()}`,
      title: titles[i] || `Document ${i + 1}`,
      url: urlArray[i],
      description: `Documentation page from Context7`,
      library: "Context7",
      score: 1.0 - i * 0.1, // Decreasing score
    });
  }

  return documents;
}

/**
 * Parse Context7 docs index page to extract available documentation sections
 * This is more reliable than search for finding all available docs
 */
function parseContext7DocsIndex(
  html: string,
  query: string,
  limit: number
): Context7Document[] {
  const documents: Context7Document[] = [];
  const queryKeywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
  
  // Extract all documentation links from the index page
  // Context7 docs index typically has a sidebar or grid with doc links
  
  // Pattern 1: Extract links from navigation/sidebar
  const navLinkPattern = /<a[^>]*href=["'](https?:\/\/context7\.com\/docs\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  
  const seenUrls = new Set<string>();
  
  while ((match = navLinkPattern.exec(html)) !== null) {
    const url = match[1];
    const linkHtml = match[2];
    
    // Skip if already seen
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    
    // Skip certain patterns (anchors, fragments)
    if (url.includes('#') && !url.includes('/docs/')) continue;
    
    // Extract title from link text
    const titleText = linkHtml.replace(/<[^>]+>/g, ' ').trim();
    
    if (titleText && titleText.length > 2 && titleText.length < 100) {
      // Check if this doc might be relevant to the query
      const titleLower = titleText.toLowerCase();
      let relevanceScore = 0.3; // Base score for being in docs index
      
      // Boost score if title matches query keywords
      for (const keyword of queryKeywords) {
        if (titleLower.includes(keyword)) {
          relevanceScore += 0.3;
        }
      }
      
      documents.push({
        id: `doc-${documents.length}-${Date.now()}`,
        title: titleText,
        url: url,
        description: `Documentation: ${titleText}`,
        library: "Context7",
        score: relevanceScore,
      });
    }
  }
  
  // Pattern 2: Extract from structured data if available (JSON-LD)
  const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = jsonLdPattern.exec(html)) !== null) {
    try {
      const jsonData = JSON.parse(match[1]);
      
      // Handle different schema types
      if (jsonData['@type'] === 'TechArticle' || jsonData['@type'] === 'Article') {
        const doc = {
          id: `jsonld-${documents.length}`,
          title: jsonData.headline || jsonData.name || 'Untitled',
          url: jsonData['@id'] || jsonData.url || '',
          description: jsonData.description || '',
          library: "Context7",
          score: 0.5,
        };
        
        if (doc.url && !seenUrls.has(doc.url)) {
          documents.push(doc);
          seenUrls.add(doc.url);
        }
      }
    } catch (e) {
      // Invalid JSON, skip
    }
  }

  // If we found documents, sort by relevance and limit
  if (documents.length > 0) {
    documents.sort((a, b) => (b.score || 0) - (a.score || 0));
    if (documents.length > limit) {
      documents.length = limit;
    }
    return documents;
  }
  
  // Fallback: if no structured docs found, return the main docs URL
  return [
    {
      id: "context7-docs-main",
      title: "Context7 Documentation",
      url: "https://context7.com/docs",
      description: "Main documentation index",
      library: "Context7",
      score: 0.5,
    },
  ];
}

/**
 * Fetch full content from a Context7 document URL
 * Handles both API and web-based fetching
 */
export async function fetchContext7Document(
  url: string,
  opts?: { apiKey?: string }
): Promise<{ content: string; title: string; url: string; fetchedAt: string }> {
  const apiKey = opts?.apiKey;

  // Try Context7 API first
  if (apiKey) {
    try {
      const apiUrl = "https://api.context7.com/mcp/context";
      const response = await fetchWithTimeout(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          url,
          includeMetadata: true,
        }),
      });

      if (response.ok) {
        try {
          const data = await response.json();
          return {
            content: data.content || data.text || "",
            title: data.title || data.metadata?.title || "Untitled Document",
            url: data.url || url,
            fetchedAt: new Date().toISOString(),
          };
        } catch (parseError: any) {
          // API response parsing failed, fall back to web
        }
      }
    } catch (error: any) {
      // API fetch failed, will try web fetch
    }
  }

  // Fallback to web fetch
  return await fetchContext7Web(url);
}

/**
 * Fetch document content from Context7 web pages
 * Handles JavaScript-rendered content by extracting structured data
 */
async function fetchContext7Web(
  url: string
): Promise<{ content: string; title: string; url: string; fetchedAt: string }> {
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; AgenticQA/1.0; documentation-reader)",
      Accept: "text/html,application/xhtml+xml,application/json",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  
  if (contentType.includes("application/json")) {
    try {
      const data = await response.json();
      return {
        content: data.content || data.text || JSON.stringify(data),
        title: data.title || data.metadata?.title || "Document",
        url: data.url || url,
        fetchedAt: new Date().toISOString(),
      };
    } catch (parseError: any) {
      // JSON parsing failed, treat as HTML
    }
  }

  const html = await response.text();
  const extracted = extractContext7Content(html, url);

  return {
    content: extracted.content,
    title: extracted.title,
    url: url,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Extract structured content from Context7 HTML pages
 * Optimized for Context7's documentation structure
 */
function extractContext7Content(
  html: string,
  url: string
): { content: string; title: string } {
  let content = "";
  let title = "Untitled Document";

  // Extract title from multiple possible locations
  const titlePatterns = [
    /<title[^>]*>([^<]+)<\/title>/i,
    /<h1[^>]*>([^<]+)<\/h1>/i,
    /"og:title"[^>]+content=["']([^"']+)["']/i,
    /"name":"og:title"[^>]+"content":["']([^"']+)["']/i,
  ];

  for (const pattern of titlePatterns) {
    const match = html.match(pattern);
    if (match?.[1]?.trim()) {
      title = match[1].trim();
      break;
    }
  }

  // Remove script, style, and other non-content tags
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ");

  // Extract main content sections (Context7 uses semantic HTML)
  const mainContentPatterns = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id=["']content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let mainContent = "";
  for (const pattern of mainContentPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      mainContent = match[1];
      break;
    }
  }

  // If main content found, use it; otherwise use full text
  if (mainContent) {
    text = mainContent;
  }

  // Strip HTML tags
  text = text.replace(/<[^>]+>/g, "\n");

  // Decode HTML entities
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

  // Extract and preserve headings for structure
  const headingPatterns = [
    /<h1[^>]*>([^<]+)<\/h1>/gi,
    /<h2[^>]*>([^<]+)<\/h2>/gi,
    /<h3[^>]*>([^<]+)<\/h3>/gi,
  ];

  const headings: string[] = [];
  for (const pattern of headingPatterns) {
    let hMatch;
    while ((hMatch = pattern.exec(html)) !== null) {
      if (hMatch[1]?.trim()) {
        headings.push(hMatch[1].trim());
      }
    }
  }

  // Clean whitespace
  text = text.replace(/\n\s*\n/g, "\n\n").trim();

  // Build structured content
  const sections: string[] = [];
  sections.push(`Document: ${title}`);
  sections.push(`Source: ${url}`);
  
  if (headings.length > 0) {
    sections.push(`\nTable of Contents:`);
    headings.forEach((h, i) => {
      sections.push(`  ${i + 1}. ${h}`);
    });
  }

  if (text.length > 0) {
    sections.push(`\nContent:\n${text}`);
  }

  content = sections.join("\n\n");

  // Fallback if content is too short
  if (content.length < 100) {
    // Try to extract any meaningful text
    const allText = html.replace(/<[^>]+>/g, " ");
    const cleaned = allText.replace(/\s+/g, " ").trim();
    if (cleaned.length > 100) {
      content = `Document: ${title}\n\nSource: ${url}\n\n${cleaned}`;
    }
  }

  return { content, title };
}

/**
 * Chunk text for embedding and retrieval
 * Optimized for documentation content with section awareness
 */
export function chunkText(
  text: string,
  opts?: {
    chunkSize?: number;
    overlap?: number;
    maxChunks?: number;
    preserveSections?: boolean;
  }
): string[] {
  const chunkSize = opts?.chunkSize ?? 1000;
  const overlap = opts?.overlap ?? 150;
  const maxChunks = opts?.maxChunks ?? 50;
  const preserveSections = opts?.preserveSections ?? true;

  if (!preserveSections) {
    // Simple chunking without section awareness
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length && chunks.length < maxChunks) {
      const end = Math.min(start + chunkSize, text.length);
      const chunk = text.slice(start, end).trim();

      if (chunk.length > 50) {
        chunks.push(chunk);
      }

      start += chunkSize - overlap;
    }

    return chunks;
  }

  // Section-aware chunking
  const sections = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const section of sections) {
    const trimmedSection = section.trim();
    if (!trimmedSection || trimmedSection.length < 20) continue;

    if (currentChunk.length + trimmedSection.length <= chunkSize) {
      currentChunk += (currentChunk ? "\n\n" : "") + trimmedSection;
    } else {
      if (currentChunk.length > 50) {
        chunks.push(currentChunk);
      }
      
      // If section itself is larger than chunkSize, split it
      if (trimmedSection.length > chunkSize) {
        const subChunks = splitLargeSection(trimmedSection, chunkSize, overlap);
        chunks.push(...subChunks);
        currentChunk = "";
      } else {
        currentChunk = trimmedSection;
      }
    }
  }

  if (currentChunk.length > 50 && chunks.length < maxChunks) {
    chunks.push(currentChunk);
  }

  return chunks.slice(0, maxChunks);
}

/**
 * Split a large section into smaller chunks at natural boundaries
 */
function splitLargeSection(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    
    // Try to split at sentence boundary
    let splitPoint = end;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const bestSplit = Math.max(lastPeriod, lastNewline);
      if (bestSplit > start + chunkSize / 2) {
        splitPoint = bestSplit + 1;
      }
    }

    const chunk = text.slice(start, splitPoint).trim();
    if (chunk.length > 50) {
      chunks.push(chunk);
    }

    start = splitPoint - overlap;
    if (start <= 0) start = chunkSize; // Avoid infinite loop
  }

  return chunks;
}
