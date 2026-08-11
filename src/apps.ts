import { z } from "zod";

import {
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
  commonLimitInput,
  commonOffsetInput,
  type ToolResult,
} from "./contracts.js";
import { asRecord, sanitize, sanitizationTruncated, type Sanitized } from "./sanitize.js";
import { ConnectionError } from "./errors.js";

export type AppId =
  | "reader"
  | "starboard"
  | "high-signal"
  | "calorie"
  | "significant-hobbies"
  | "research-papers"
  | "setline";

export interface ToolDefinition {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  operation: string;
  mode: string;
  collectionKeys?: readonly string[];
  detail?: boolean;
  localQuery?: boolean;
  detailCollectionKeys?: readonly string[];
  detailArgument?: string;
  detailFields?: readonly string[];
  localFilters?: Record<string, readonly string[]>;
}

export interface AppDefinition {
  id: AppId;
  name: string;
  serverName: string;
  baseUrl: string;
  baseUrlEnv: string;
  tokenEnv?: string;
  tokenPrefix?: string;
  instructions: string;
  tools: Record<string, ToolDefinition>;
  operations: Record<
    string,
    {
      path: (args: Record<string, unknown>) => string;
      auth?: boolean;
      baseUrl?: string;
      mode?: string;
      fallback?: {
        baseUrl: string;
        path: (args: Record<string, unknown>) => string;
        mode: string;
      };
    }
  >;
}

const boundedText = z.string().trim().min(1).max(200);
const optionalQuery = z.string().trim().max(200).optional();
const stableId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:@/-]+$/);
const slug = z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timezone = z.string().trim().min(1).max(100).default("UTC");

function queryPath(path: string, values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function readLimit(args: Record<string, unknown>): number {
  const value = typeof args.limit === "number" ? args.limit : DEFAULT_COLLECTION_LIMIT;
  return Math.min(Math.max(value, 1), MAX_COLLECTION_LIMIT);
}

function readOffset(args: Record<string, unknown>): number {
  return typeof args.offset === "number" && args.offset >= 0 ? args.offset : 0;
}

function objectValue(payload: unknown, key: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function findCollection(payload: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    const value = objectValue(payload, key);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function explicitTotal(payload: unknown): number | undefined {
  for (const key of ["total", "totalFiltered", "count", "totalCount"]) {
    const value = objectValue(payload, key);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  const page = objectValue(payload, "page");
  const nested = objectValue(page, "total");
  if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) {
    return Math.floor(nested);
  }
  return undefined;
}

function explicitPage(payload: unknown):
  | { total?: number; nextOffset?: number | null }
  | undefined {
  const page = objectValue(payload, "page");
  if (!page || typeof page !== "object" || Array.isArray(page)) return undefined;
  const totalValue = objectValue(page, "total");
  const nextValue = objectValue(page, "nextOffset");
  const total =
    typeof totalValue === "number" && Number.isFinite(totalValue) && totalValue >= 0
      ? Math.floor(totalValue)
      : undefined;
  const nextOffset =
    nextValue === null
      ? null
      : typeof nextValue === "number" && Number.isFinite(nextValue) && nextValue >= 0
        ? Math.floor(nextValue)
        : undefined;
  return { ...(total === undefined ? {} : { total }), ...(nextOffset === undefined ? {} : { nextOffset }) };
}

function explicitFreshness(payload: unknown): string | undefined {
  for (const key of ["freshness", "generatedAt", "updatedAt", "publishedAt", "asOf", "date"]) {
    const value = objectValue(payload, key);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      const timestamp = value < 10_000_000_000 ? value * 1000 : value;
      const date = new Date(timestamp);
      if (!Number.isNaN(date.valueOf())) return date.toISOString();
    }
  }
  return undefined;
}

function textMatches(item: unknown, query: string): boolean {
  return JSON.stringify(item).toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export function normalizeToolResult(options: {
  app: AppDefinition;
  toolName: string;
  tool: ToolDefinition;
  payload: unknown;
  args: Record<string, unknown>;
  sourceUrl: string;
  retrievalMode?: string;
  freshness?: string;
}): ToolResult {
  const { app, toolName, tool, payload, args, sourceUrl, retrievalMode, freshness } = options;
  const resolvedFreshness = freshness ?? explicitFreshness(payload);
  const base = {
    schemaVersion: "1" as const,
    ok: true,
    app: app.name,
    tool: toolName,
    generatedAt: new Date().toISOString(),
    ...(resolvedFreshness ? { freshness: resolvedFreshness } : {}),
    retrievalMode: retrievalMode ?? tool.mode,
    hasMore: false,
    truncated: false,
    provenance: [{ label: app.name, url: sourceUrl }],
  };

  if (tool.detail) {
    let candidate =
      objectValue(payload, "item") ??
      objectValue(payload, "paper") ??
      objectValue(payload, "data") ??
      payload;
    if (tool.detailCollectionKeys && tool.detailArgument && tool.detailFields) {
      const expected = String(args[tool.detailArgument]);
      candidate = findCollection(payload, tool.detailCollectionKeys).find((item) =>
        tool.detailFields!.some((field) => String(objectValue(item, field)) === expected),
      );
      if (candidate === undefined) {
        throw new ConnectionError("not_found", `${tool.title} was not found.`);
      }
    }
    return { ...base, item: asRecord(candidate), truncated: sanitizationTruncated(candidate) };
  }

  const offset = readOffset(args);
  const limit = readLimit(args);
  let source = findCollection(payload, tool.collectionKeys ?? ["items"]);
  const query = typeof args.q === "string" ? args.q.trim() : "";
  if (tool.localQuery && query) source = source.filter((item) => textMatches(item, query));
  for (const [argument, fields] of Object.entries(tool.localFilters ?? {})) {
    const expected = args[argument];
    if (expected === undefined || expected === null || expected === "") continue;
    source = source.filter((item) =>
      fields.some((field) => String(objectValue(item, field)) === String(expected)),
    );
  }

  const upstreamPage = explicitPage(payload);
  const upstreamTotal = upstreamPage ? upstreamPage.total : explicitTotal(payload);
  const alreadyPaginated = upstreamPage !== undefined || upstreamTotal !== undefined;
  const page = alreadyPaginated ? source.slice(0, limit) : source.slice(offset, offset + limit);
  const total = upstreamTotal ?? (alreadyPaginated ? undefined : source.length);
  const nextOffset =
    upstreamPage?.nextOffset ??
    (total === undefined ? null : offset + page.length < total ? offset + page.length : null);
  const items = sanitize(page) as Sanitized[];

  return {
    ...base,
    items: items.map((item) => asRecord(item)),
    ...(total === undefined ? {} : { total }),
    nextOffset,
    hasMore: nextOffset !== null,
    truncated:
      source.length > page.length ||
      nextOffset !== null ||
      page.some((item) => sanitizationTruncated(item)),
  };
}

const reader: AppDefinition = {
  id: "reader",
  name: "Reader",
  serverName: "fleet-reader-readonly",
  baseUrl: "https://read.significanthobbies.com",
  baseUrlEnv: "READER_API_URL",
  tokenEnv: "READER_MCP_TOKEN",
  tokenPrefix: "rdr_",
  instructions:
    "Read-only access to the owner's saved Reader library. Never save, edit, delete, share, download PDFs, or manage credentials.",
  operations: {
    search: {
      auth: true,
      path: (a) =>
        queryPath("/api/mcp/reading", {
          q: a.q,
          listId: a.listId,
          projectId: a.projectId,
          type: a.type,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    item: { auth: true, path: (a) => `/api/mcp/reading/${encodeURIComponent(String(a.id))}` },
    collections: {
      auth: true,
      path: (a) => queryPath("/api/mcp/collections", { limit: a.limit, offset: a.offset }),
    },
  },
  tools: {
    search_saved_reading: {
      title: "Search saved reading",
      description: "Search the owner's saved articles, links, and PDFs with bounded results.",
      inputSchema: {
        q: boundedText,
        listId: stableId.optional(),
        projectId: stableId.optional(),
        type: z.enum(["article", "link", "pdf"]).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "search",
      mode: "owner-api",
      collectionKeys: ["items", "articles"],
    },
    get_saved_item: {
      title: "Get saved item",
      description: "Retrieve one owned Reader item by an identifier returned from search.",
      inputSchema: { id: stableId },
      operation: "item",
      mode: "owner-api",
      detail: true,
    },
    list_reader_collections: {
      title: "List Reader collections",
      description: "List the owner's existing Reader lists for search context.",
      inputSchema: { limit: commonLimitInput, offset: commonOffsetInput },
      operation: "collections",
      mode: "owner-api",
      collectionKeys: ["items", "lists"],
    },
  },
};

const starboard: AppDefinition = {
  id: "starboard",
  name: "Starboard",
  serverName: "fleet-starboard-readonly",
  baseUrl: "https://starboard.codevetter.com",
  baseUrlEnv: "STARBOARD_API_URL",
  instructions:
    "Read-only public repository and tool intelligence. Never access private repositories, saved lists, discussions, jobs, or raw databases.",
  operations: {
    discover: {
      path: (a) =>
        queryPath("/api/discover", {
          q: a.q,
          language: a.language,
          tool: a.tool,
          sort: a.sort,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    repository: {
      path: (a) =>
        queryPath(`/api/repos/${encodeURIComponent(String(a.id))}`, { catalogOnly: 1 }),
    },
    preview: { path: (a) => queryPath("/api/project-preview", { repository: a.url }) },
    tools: {
      path: (a) =>
        queryPath("/api/tools", { q: a.q, category: a.category, limit: a.limit, offset: a.offset }),
    },
  },
  tools: {
    search_repositories: {
      title: "Search public repositories",
      description: "Search Starboard's public repository catalog with bounded filters.",
      inputSchema: {
        q: optionalQuery,
        language: z.string().trim().max(80).optional(),
        tool: z.string().trim().max(64).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
        sort: z.enum(["relevance", "stars", "updated", "name", "growth"]).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "discover",
      mode: "public-api",
      collectionKeys: ["repos", "items"],
    },
    get_repository: {
      title: "Get public repository",
      description: "Inspect a public catalog repository by stable Starboard identifier.",
      inputSchema: { id: z.number().int().positive() },
      operation: "repository",
      mode: "public-api",
      detail: true,
    },
    preview_project: {
      title: "Preview public project",
      description: "Preview a cataloged public GitHub project without saving it.",
      inputSchema: {
        url: z
          .string()
          .url()
          .max(300)
          .refine((value) => new URL(value).hostname === "github.com", "Use a github.com URL."),
      },
      operation: "preview",
      mode: "public-api",
      detail: true,
    },
    inspect_tool_adoption: {
      title: "Inspect tool adoption",
      description: "Inspect public, evidence-backed framework and tool adoption in Starboard.",
      inputSchema: {
        q: optionalQuery,
        category: z.string().trim().max(80).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "tools",
      mode: "public-api",
      collectionKeys: ["tools", "items"],
    },
  },
};

const highSignal: AppDefinition = {
  id: "high-signal",
  name: "High Signal",
  serverName: "fleet-high-signal-readonly",
  baseUrl: "https://highsignal.app",
  baseUrlEnv: "HIGH_SIGNAL_API_URL",
  instructions:
    "Read-only published High Signal data. Never access owner watchlists, delivery, review, admin, ingest, refresh, or provider operations.",
  operations: {
    signals: { path: () => "/signals.json" },
    signal: { path: () => "/signals.json" },
    brief: { path: (a) => queryPath("/brief/daily", { region: a.region }) },
    track: { path: () => "/data/hit-rate.json" },
  },
  tools: {
    search_signals: {
      title: "Search published signals",
      description: "Search bounded published High Signal records and evidence.",
      inputSchema: { q: optionalQuery, limit: commonLimitInput, offset: commonOffsetInput },
      operation: "signals",
      mode: "public-api",
      collectionKeys: ["signals", "items"],
      localQuery: true,
    },
    get_signal: {
      title: "Get published signal",
      description: "Retrieve one published signal by slug from the bounded public feed.",
      inputSchema: { slug },
      operation: "signal",
      mode: "public-api",
      detail: true,
      detailCollectionKeys: ["signals", "items"],
      detailArgument: "slug",
      detailFields: ["slug", "id"],
    },
    get_daily_brief: {
      title: "Get Daily Brief",
      description: "Retrieve the current public Daily Brief with freshness and evidence.",
      inputSchema: { region: z.string().trim().max(64).optional() },
      operation: "brief",
      mode: "public-api",
      detail: true,
    },
    get_track_record: {
      title: "Get public track record",
      description: "Retrieve bounded rows from High Signal's public hit-rate dataset.",
      inputSchema: { limit: commonLimitInput, offset: commonOffsetInput },
      operation: "track",
      mode: "public-api",
      collectionKeys: ["rows", "items"],
    },
  },
};

const calorie: AppDefinition = {
  id: "calorie",
  name: "Calorie",
  serverName: "fleet-calorie-readonly",
  baseUrl: "https://calorie.significanthobbies.com",
  baseUrlEnv: "CALORIE_API_URL",
  tokenEnv: "CALORIE_MCP_TOKEN",
  tokenPrefix: "calorie_read_",
  instructions:
    "Read-only owner nutrition data. Medication data and medical advice are excluded. Never log or alter food, water, weight, goals, or care state.",
  operations: {
    daily: {
      auth: true,
      path: (a) => queryPath("/api/mcp/daily", { date: a.date, timezone: a.timezone }),
    },
    history: {
      auth: true,
      path: (a) =>
        queryPath("/api/mcp/history", {
          start: a.start,
          end: a.end,
          timezone: a.timezone,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    foods: {
      auth: true,
      path: (a) =>
        queryPath("/api/mcp/foods", {
          q: a.q,
          status: a.status,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    cycles: {
      auth: true,
      path: (a) => queryPath("/api/mcp/cycles", { limit: a.limit, offset: a.offset }),
    },
  },
  tools: {
    get_daily_nutrition: {
      title: "Get daily nutrition",
      description: "Retrieve one owner's nutrition day without medication fields.",
      inputSchema: { date, timezone },
      operation: "daily",
      mode: "owner-api",
      detail: true,
    },
    get_nutrition_history: {
      title: "Get nutrition history",
      description: "Retrieve bounded owner nutrition history for an inclusive date range.",
      inputSchema: {
        start: date,
        end: date,
        timezone,
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "history",
      mode: "owner-api",
      collectionKeys: ["items", "days"],
    },
    search_saved_foods: {
      title: "Search saved foods",
      description: "Search the owner's saved foods with explicit nutrient units.",
      inputSchema: {
        q: optionalQuery,
        status: z.enum(["active", "archived"]).default("active"),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "foods",
      mode: "owner-api",
      collectionKeys: ["items", "foods"],
    },
    list_goal_cycles: {
      title: "List goal cycles",
      description: "List bounded historical Calorie goal-cycle context without changing targets.",
      inputSchema: { limit: commonLimitInput, offset: commonOffsetInput },
      operation: "cycles",
      mode: "owner-api",
      collectionKeys: ["items", "cycles"],
    },
  },
};

const significantHobbies: AppDefinition = {
  id: "significant-hobbies",
  name: "Significant Hobbies",
  serverName: "fleet-significant-hobbies-readonly",
  baseUrl: "https://significanthobbies.com",
  baseUrlEnv: "SIGNIFICANT_HOBBIES_API_URL",
  instructions:
    "Read-only public hobby, experience, and PUBLIC timeline data. Never access Daily, journals, habits, Trajectory, commitments, bucket lists, accounts, or device-local data.",
  operations: {
    hobbies: {
      path: (a) =>
        queryPath("/api/mcp/hobbies", {
          q: a.q,
          category: a.category,
          facet: a.facet,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    experiences: {
      path: (a) =>
        queryPath("/api/mcp/experiences", {
          q: a.q,
          category: a.category,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    experience: { path: (a) => `/api/mcp/experiences/${encodeURIComponent(String(a.slug))}` },
    timelines: {
      path: (a) => queryPath("/api/mcp/timelines", { q: a.q, limit: a.limit, offset: a.offset }),
    },
    timeline: { path: (a) => `/api/mcp/timelines/${encodeURIComponent(String(a.id))}` },
  },
  tools: {
    search_hobbies: {
      title: "Search public hobbies",
      description: "Search the public Significant Hobbies taxonomy and facets.",
      inputSchema: {
        q: optionalQuery,
        category: z.string().trim().max(80).optional(),
        facet: z.string().trim().max(80).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "hobbies",
      mode: "public-api",
      collectionKeys: ["items", "hobbies"],
    },
    search_experiences: {
      title: "Search public experiences",
      description: "Search public experience ideas with bounded results.",
      inputSchema: {
        q: optionalQuery,
        category: z.string().trim().max(80).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "experiences",
      mode: "public-api",
      collectionKeys: ["items", "experiences"],
    },
    get_experience: {
      title: "Get public experience",
      description: "Retrieve one public experience and its first steps by slug.",
      inputSchema: { slug },
      operation: "experience",
      mode: "public-api",
      detail: true,
    },
    search_public_timelines: {
      title: "Search public timelines",
      description: "Search only timelines explicitly published as PUBLIC.",
      inputSchema: { q: optionalQuery, limit: commonLimitInput, offset: commonOffsetInput },
      operation: "timelines",
      mode: "public-api",
      collectionKeys: ["items", "timelines"],
    },
    get_public_timeline: {
      title: "Get public timeline",
      description: "Retrieve one timeline only when its current visibility is PUBLIC.",
      inputSchema: { id: stableId },
      operation: "timeline",
      mode: "public-api",
      detail: true,
    },
  },
};

const researchPapers: AppDefinition = {
  id: "research-papers",
  name: "Research Papers",
  serverName: "fleet-research-papers-readonly",
  baseUrl: "http://127.0.0.1:8000",
  baseUrlEnv: "RESEARCH_PAPERS_API_URL",
  instructions:
    "Read-only paper corpus retrieval. Never call paid-answer/RAG, ingest, enrichment, raw ClickHouse, PDF redistribution, or operator controls.",
  operations: {
    search: {
      path: (a) =>
        queryPath("/search", {
          q: a.q,
          sources: a.source,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    paper: { path: (a) => `/papers/${encodeURIComponent(String(a.id))}` },
    similar: {
      path: (a) => queryPath(`/similar/${encodeURIComponent(String(a.id))}`, { limit: a.limit }),
    },
    hot: {
      path: (a) => queryPath("/hot", { source: a.source, limit: a.limit, offset: a.offset }),
      fallback: {
        baseUrl: "https://papers.highsignal.app",
        path: () => "/data/hot.json",
        mode: "public-static-fallback",
      },
    },
    sleepers: {
      path: (a) => queryPath("/sleepers", { source: a.source, limit: a.limit, offset: a.offset }),
      fallback: {
        baseUrl: "https://papers.highsignal.app",
        path: () => "/data/sleepers.json",
        mode: "public-static-fallback",
      },
    },
    path: {
      baseUrl: "https://papers.highsignal.app",
      path: () => "/paths.json",
    },
  },
  tools: {
    search_research_papers: {
      title: "Search research papers",
      description: "Search the operator-local paper corpus with bounded results.",
      inputSchema: {
        q: z.string().trim().min(2).max(200),
        source: z.enum(["arxiv", "openreview", "biorxiv", "medrxiv"]).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "search",
      mode: "local-corpus",
      collectionKeys: ["papers", "items", "results"],
    },
    get_research_paper: {
      title: "Get research paper",
      description: "Retrieve one corpus paper by stable source identifier.",
      inputSchema: { id: stableId },
      operation: "paper",
      mode: "local-corpus",
      detail: true,
    },
    find_similar_papers: {
      title: "Find similar papers",
      description: "Retrieve bounded similarity results from the local corpus.",
      inputSchema: { id: stableId, limit: commonLimitInput },
      operation: "similar",
      mode: "local-corpus",
      collectionKeys: ["papers", "items", "similar"],
    },
    list_hot_papers: {
      title: "List hot papers",
      description: "Retrieve bounded current hot-paper signals.",
      inputSchema: {
        source: z.enum(["arxiv", "openreview", "biorxiv", "medrxiv"]).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "hot",
      mode: "local-corpus",
      collectionKeys: ["papers", "items", "hot"],
      localFilters: { source: ["source"] },
    },
    list_sleepers: {
      title: "List sleeper papers",
      description: "Retrieve bounded high-quality under-recognized papers.",
      inputSchema: {
        source: z.enum(["arxiv", "openreview", "biorxiv", "medrxiv"]).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "sleepers",
      mode: "local-corpus",
      collectionKeys: ["papers", "items", "sleepers"],
      localFilters: { source: ["source"] },
    },
    get_reading_path: {
      title: "Get curated reading path",
      description: "Retrieve one public curated reading path and its ordered paper references.",
      inputSchema: { slug },
      operation: "path",
      mode: "public-static",
      detail: true,
      detailCollectionKeys: ["items"],
      detailArgument: "slug",
      detailFields: ["id", "slug"],
    },
  },
};

const setline: AppDefinition = {
  id: "setline",
  name: "Setline",
  serverName: "fleet-setline-readonly",
  baseUrl: "https://setline.significanthobbies.com",
  baseUrlEnv: "SETLINE_API_URL",
  tokenEnv: "SETLINE_MCP_TOKEN",
  tokenPrefix: "setline_read_",
  instructions:
    "Read-only owner workout plans, history, and recorded analytics. Never execute workouts, record sets, change programmes, accept recommendations, sync writes, import, or delete.",
  operations: {
    programme: { auth: true, path: (a) => queryPath("/api/mcp/programme", { kind: a.kind }) },
    templates: {
      auth: true,
      path: (a) => queryPath("/api/mcp/templates", { limit: a.limit, offset: a.offset }),
    },
    history: {
      auth: true,
      path: (a) =>
        queryPath("/api/mcp/history", {
          start: a.start,
          end: a.end,
          workout: a.workout,
          exercise: a.exercise,
          limit: a.limit,
          offset: a.offset,
        }),
    },
    session: { auth: true, path: (a) => `/api/mcp/history/${encodeURIComponent(String(a.id))}` },
    progress: {
      auth: true,
      path: (a) => queryPath("/api/mcp/progress", { exercise: a.exercise, workout: a.workout }),
    },
  },
  tools: {
    get_training_programme: {
      title: "Get training programme",
      description: "Retrieve the authored bundled or current custom programme without changing it.",
      inputSchema: { kind: z.enum(["current", "bundled", "custom"]).default("current") },
      operation: "programme",
      mode: "owner-api",
      detail: true,
    },
    list_workout_templates: {
      title: "List workout templates",
      description: "List bounded bundled and custom workout templates in authored order.",
      inputSchema: { limit: commonLimitInput, offset: commonOffsetInput },
      operation: "templates",
      mode: "owner-api",
      collectionKeys: ["items", "templates"],
    },
    list_workout_history: {
      title: "List workout history",
      description: "List bounded immutable workout-session history with optional filters.",
      inputSchema: {
        start: date.optional(),
        end: date.optional(),
        workout: z.string().trim().max(160).optional(),
        exercise: z.string().trim().max(160).optional(),
        limit: commonLimitInput,
        offset: commonOffsetInput,
      },
      operation: "history",
      mode: "owner-api",
      collectionKeys: ["items", "history"],
    },
    get_workout_session: {
      title: "Get workout session",
      description: "Retrieve one immutable historical workout session by identifier.",
      inputSchema: { id: stableId },
      operation: "session",
      mode: "owner-api",
      detail: true,
    },
    get_progress_summary: {
      title: "Get progress summary",
      description: "Retrieve existing recorded-history analytics without coaching or inferred records.",
      inputSchema: {
        exercise: z.string().trim().max(160).optional(),
        workout: z.string().trim().max(160).optional(),
      },
      operation: "progress",
      mode: "owner-api",
      detail: true,
    },
  },
};

export const APP_DEFINITIONS: Record<AppId, AppDefinition> = {
  reader,
  starboard,
  "high-signal": highSignal,
  calorie,
  "significant-hobbies": significantHobbies,
  "research-papers": researchPapers,
  setline,
};
