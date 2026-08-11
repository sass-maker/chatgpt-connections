import { APP_DEFINITIONS, type AppDefinition } from "./apps.js";

export type HostedAudience = "personal" | "public";

interface HostedRouteBase {
  id: string;
  audience: HostedAudience;
  hosts: readonly string[];
  authMode?: "federated" | "owner-token";
  scope?: string;
  tokenSecret?: PrivateTokenSecret;
}

export type PrivateTokenSecret = "SETLINE_MCP_TOKEN";

export interface AdapterHostedRouteDefinition extends HostedRouteBase {
  kind: "adapter";
  app: AppDefinition;
}

export interface NativeHostedRouteDefinition extends HostedRouteBase {
  kind: "native";
  audience: "personal";
  authMode: "federated";
  scope: string;
  serverName: string;
  upstreamUrl: string;
}

export type HostedRouteDefinition =
  | AdapterHostedRouteDefinition
  | NativeHostedRouteDefinition;

const researchPapers = APP_DEFINITIONS["research-papers"];

const hostedResearchPapers: AppDefinition = {
  ...researchPapers,
  serverName: "fleet-research-papers-public-readonly",
  baseUrl: "https://papers.highsignal.app",
  instructions:
    "Read-only approved public Research Papers exports. Local corpus search, detail, similarity, paid-answer/RAG, ingest, enrichment, raw databases, PDFs, and operator controls are unavailable.",
  operations: {
    hot: {
      baseUrl: "https://papers.highsignal.app",
      path: () => "/data/hot.json",
      mode: "public-static",
    },
    sleepers: {
      baseUrl: "https://papers.highsignal.app",
      path: () => "/data/sleepers.json",
      mode: "public-static",
    },
    path: {
      baseUrl: "https://papers.highsignal.app",
      path: () => "/paths.json",
      mode: "public-static",
    },
  },
  tools: {
    list_hot_papers: {
      ...researchPapers.tools.list_hot_papers!,
      description: "Retrieve bounded current hot-paper signals from the approved public export.",
      mode: "public-static",
    },
    list_sleepers: {
      ...researchPapers.tools.list_sleepers!,
      description:
        "Retrieve bounded high-quality under-recognized papers from the approved public export.",
      mode: "public-static",
    },
    get_reading_path: {
      ...researchPapers.tools.get_reading_path!,
      mode: "public-static",
    },
  },
};

export const HOSTED_ROUTES: Readonly<Record<string, HostedRouteDefinition>> = Object.freeze({
  "/reader/mcp": {
    id: "reader",
    kind: "adapter",
    audience: "personal",
    hosts: ["mcp.significanthobbies.com"],
    authMode: "federated",
    scope: "reader.read",
    app: APP_DEFINITIONS.reader,
  },
  "/calorie/mcp": {
    id: "calorie",
    kind: "adapter",
    audience: "personal",
    hosts: ["mcp.significanthobbies.com"],
    authMode: "federated",
    scope: "calorie.read",
    app: APP_DEFINITIONS.calorie,
  },
  "/setline/mcp": {
    id: "setline",
    kind: "adapter",
    audience: "personal",
    hosts: ["mcp.significanthobbies.com"],
    authMode: "owner-token",
    scope: "setline.read",
    tokenSecret: "SETLINE_MCP_TOKEN",
    app: APP_DEFINITIONS.setline,
  },
  "/anime-list/mcp": {
    id: "anime-list",
    kind: "native",
    audience: "personal",
    hosts: ["mcp.significanthobbies.com"],
    authMode: "federated",
    scope: "anime-list.read",
    serverName: "anime-list-by-significant-hobbies",
    upstreamUrl: "https://anime.significanthobbies.com/api/mcp",
  },
  "/starboard/mcp": {
    id: "starboard",
    kind: "adapter",
    audience: "public",
    hosts: ["mcp.codevetter.com"],
    app: APP_DEFINITIONS.starboard,
  },
  "/high-signal/mcp": {
    id: "high-signal",
    kind: "adapter",
    audience: "public",
    hosts: ["mcp.highsignal.app"],
    app: APP_DEFINITIONS["high-signal"],
  },
  "/significant-hobbies/mcp": {
    id: "significant-hobbies",
    kind: "adapter",
    audience: "public",
    hosts: ["mcp.significanthobbies.com"],
    app: APP_DEFINITIONS["significant-hobbies"],
  },
  "/research-papers/mcp": {
    id: "research-papers",
    kind: "adapter",
    audience: "public",
    hosts: ["mcp.highsignal.app"],
    app: hostedResearchPapers,
  },
});

export const PRIVATE_HOSTED_PATHS = Object.freeze(
  Object.entries(HOSTED_ROUTES)
    .filter(([, route]) => route.audience === "personal")
    .map(([path]) => path),
);

export const PRIVATE_HOSTED_SCOPES = Object.freeze(
  Object.values(HOSTED_ROUTES)
    .filter((route) => route.audience === "personal")
    .map((route) => route.scope!),
);

function compatibilityHost(hostname: string): boolean {
  return hostname === "mcp.example" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".workers.dev");
}

export function hostedRoute(
  pathname: string,
  hostname?: string,
): HostedRouteDefinition | undefined {
  const route = HOSTED_ROUTES[pathname];
  if (!route || !hostname || compatibilityHost(hostname) || route.hosts.includes(hostname)) return route;
  return undefined;
}
