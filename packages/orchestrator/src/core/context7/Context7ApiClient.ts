export interface Context7Library {
  id: string;
  title: string;
  description: string;
  branch: string;
  lastUpdateDate: string;
  state: string;
  totalTokens: number;
  totalSnippets: number;
  stars: number;
  trustScore: number;
  benchmarkScore: number;
  versions: string[];
}

export interface Context7SearchResult {
  libraries: Context7Library[];
  query: string;
}

export class Context7ApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = "Context7ApiError";
  }
}

export class Context7ApiClient {
  private apiKey: string;
  private baseUrl = "https://context7.com/api/v2";

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.CONTEXT7_API_KEY || "";
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private extractLibraryName(question: string): string {
    const knownLibraries = [
      "next.js",
      "nextjs",
      "react",
      "reactjs",
      "react.dev",
      "vue",
      "vuejs",
      "vue3",
      "angular",
      "svelte",
      "node.js",
      "nodejs",
      "express",
      "expressjs",
      "django",
      "flask",
      "fastapi",
      "spring",
      "spring boot",
      "rails",
      "ruby on rails",
      "laravel",
      "php",
      "flutter",
      "react native",
      "swift",
      "swiftui",
      "kotlin",
      "android",
      "java",
      "python",
      "go",
      "golang",
      "rust",
      "typescript",
      "javascript",
      "mongodb",
      "postgresql",
      "postgres",
      "mysql",
      "redis",
      "docker",
      "kubernetes",
      "k8s",
      "aws",
      "azure",
      "gcp",
      "graphql",
      "rest api",
      "rest",
      "tailwind",
      "tailwindcss",
      "bootstrap",
      "material ui",
      "prisma",
      "redux",
      "zustand",
      "git",
      "github",
      "playwright",
      "selenium",
      "cypress",
      "jest",
      "vite",
      "webpack",
      "esbuild",
      "babel",
      "eslint",
      "prettier",
      "solidjs",
      "qwik",
      "remix",
      "astro",
      "nuxt",
      "nuxtjs",
    ];

    const lowerQuestion = question.toLowerCase();

    for (const lib of knownLibraries) {
      if (lowerQuestion.includes(lib)) {
        if (lib === "nextjs") return "next.js";
        if (lib === "reactjs") return "react";
        if (lib === "vuejs") return "vue";
        if (lib === "expressjs") return "express";
        if (lib === "nodejs") return "node.js";
        if (lib === "golang") return "go";
        if (lib === "postgres") return "postgresql";
        if (lib === "k8s") return "kubernetes";
        return lib;
      }
    }

    return question;
  }

  async searchLibraries(question: string): Promise<Context7SearchResult> {
    const libraryName = this.extractLibraryName(question);
    const query = question;

    const url = new URL(`${this.baseUrl}/libs/search`);
    url.searchParams.set("libraryName", libraryName);
    url.searchParams.set("query", query);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Context7ApiError(
          `Context7 search failed: ${response.status} ${errorText}`,
          response.status
        );
      }

      const data = await response.json();

      const libraries: Context7Library[] = (data.results || []).map(
        (lib: any) => ({
          id: lib.id || "",
          title: lib.title || lib.id?.split("/")[1] || "Unknown",
          description: lib.description || "",
          branch: lib.branch || "main",
          lastUpdateDate: lib.lastUpdateDate || "",
          state: lib.state || "unknown",
          totalTokens: lib.totalTokens || 0,
          totalSnippets: lib.totalSnippets || 0,
          stars: lib.stars || 0,
          trustScore: lib.trustScore || 0,
          benchmarkScore: lib.benchmarkScore || 0,
          versions: lib.versions || [],
        })
      );

      return { libraries, query };
    } catch (error: any) {
      if (error instanceof Context7ApiError) throw error;
      throw new Context7ApiError(
        `Context7 search failed: ${error?.message}`,
        undefined
      );
    }
  }

  async getContext(
    libraryId: string,
    query: string,
    format: "txt" | "json" = "txt"
  ): Promise<string> {
    const url = new URL(`${this.baseUrl}/context`);
    url.searchParams.set("libraryId", libraryId);
    url.searchParams.set("query", query);
    url.searchParams.set("type", format);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Context7ApiError(
          `Context7 context failed: ${response.status} ${errorText}`,
          response.status
        );
      }

      if (format === "json") {
        const data = await response.json();
        return JSON.stringify(data, null, 2);
      }

      return await response.text();
    } catch (error: any) {
      if (error instanceof Context7ApiError) throw error;
      throw new Context7ApiError(
        `Context7 context failed: ${error?.message}`,
        undefined
      );
    }
  }
}