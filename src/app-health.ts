import {
  createAppHealthClient,
  type AppHealthClient,
  type AppHealthClientOptions,
} from "@saas-maker/app-health";

import { HOSTED_ROUTES, hostedRoute, openAiChallengeSecret } from "./hosted.js";
import type { HostedWorkerEnv } from "./oauth.js";

const APP_HEALTH_INGEST_ENDPOINT = "https://ingest.sassmaker.com/v1/ingest";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const OPENAI_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

export type AppHealthClientFactory = (env: HostedWorkerEnv) => AppHealthClient | null;

export interface RequestStageTiming {
  auth_ms?: number;
  upstream_ms?: number;
}

let firstRequest = true;

function boundedDuration(ms: number): number {
  return Math.min(600_000, Math.max(0, Math.round(ms)));
}

export function appHealthRoute(request: Request): string | undefined {
  const url = new URL(request.url);
  if (url.pathname === "/health") return "/health";
  if (url.pathname === AUTHORIZATION_SERVER_METADATA_PATH) {
    return AUTHORIZATION_SERVER_METADATA_PATH;
  }
  if (url.pathname === OPENAI_CHALLENGE_PATH && openAiChallengeSecret(url.hostname)) {
    return OPENAI_CHALLENGE_PATH;
  }

  const directRoute = hostedRoute(url.pathname, url.hostname);
  if (directRoute) return url.pathname;

  if (!url.pathname.startsWith(`${PROTECTED_RESOURCE_METADATA_PREFIX}/`)) return undefined;
  const hostedPath = url.pathname.slice(PROTECTED_RESOURCE_METADATA_PREFIX.length);
  const protectedRoute = hostedRoute(hostedPath, url.hostname);
  if (protectedRoute?.audience !== "personal") return undefined;
  return `${PROTECTED_RESOURCE_METADATA_PREFIX}${hostedPath}`;
}

export function createConnectionsAppHealthClient(
  env: HostedWorkerEnv,
  fetchOverride?: AppHealthClientOptions["fetch"],
): AppHealthClient | null {
  const key = env.APP_HEALTH_INGEST_KEY?.trim();
  if (!key) return null;
  const environment = env.APP_HEALTH_ENVIRONMENT?.trim();
  const release = env.APP_HEALTH_RELEASE?.trim();

  return createAppHealthClient({
    key,
    endpoint: APP_HEALTH_INGEST_ENDPOINT,
    runtime: "worker",
    disableTimer: true,
    maxQueueSize: 1,
    maxRetries: 1,
    requestTimeoutMs: 1_500,
    ...(environment ? { environment } : {}),
    ...(release ? { release } : {}),
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
}

export async function monitorAppHealthRequest(
  request: Request,
  env: HostedWorkerEnv,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  handle: (stages: RequestStageTiming) => Promise<Response>,
  makeClient: AppHealthClientFactory = createConnectionsAppHealthClient,
): Promise<Response> {
  const cold = firstRequest ? 1 : 0;
  firstRequest = false;
  const stages: RequestStageTiming = {};
  const route = appHealthRoute(request);
  if (!route) return handle(stages);
  const url = new URL(request.url);
  const isMcp = Object.hasOwn(HOSTED_ROUTES, url.pathname) && Boolean(hostedRoute(url.pathname, url.hostname));

  const started = performance.now();
  let status = 500;
  let totalMs: number | undefined;
  try {
    const response = await handle(stages);
    status = response.status;
    totalMs = boundedDuration(performance.now() - started);
    if (isMcp) {
      try {
        const timings = [`total;dur=${totalMs}`];
        for (const [name, ms] of [["auth", stages.auth_ms], ["upstream", stages.upstream_ms]] as const) {
          if (ms !== undefined) timings.push(`${name};dur=${boundedDuration(ms)}`);
        }
        const headers = new Headers(response.headers);
        headers.set("Server-Timing", timings.join(", "));
        return new Response(response.body, {
          status: response.status, statusText: response.statusText, headers,
        });
      } catch {
        // Header instrumentation must never change gateway behavior on failure.
      }
    }
    return response;
  } finally {
    try {
      const client = makeClient(env);
      if (client) {
        client.record({
          method: request.method,
          route,
          status_code: status,
          duration_ms: totalMs ?? boundedDuration(performance.now() - started),
        });
        if (isMcp) {
          try {
            const configuredRate = env.APP_HEALTH_STAGE_SAMPLE_RATE?.trim();
            const parsedRate = configuredRate ? Number(configuredRate) : NaN;
            const rate = Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate <= 1
              ? parsedRate : 0.1;
            if (Math.random() < rate) {
              const colo = request.cf?.colo;
              const release = env.APP_HEALTH_RELEASE;
              client.log("api.stage_timing", {
                level: "debug",
                props: {
                  route,
                  status,
                  total_ms: totalMs ?? boundedDuration(performance.now() - started),
                  edge_cache: "NONE",
                  inner_cache: "NONE",
                  colo: typeof colo === "string" && /^[A-Za-z0-9]{1,8}$/.test(colo) ? colo : "unknown",
                  cold,
                  ...(release && /^[A-Za-z0-9._-]{1,64}$/.test(release) ? { release } : {}),
                  ...(stages.auth_ms !== undefined ? { auth_ms: boundedDuration(stages.auth_ms) } : {}),
                  ...(stages.upstream_ms !== undefined ? { upstream_ms: boundedDuration(stages.upstream_ms) } : {}),
                },
              });
            }
          } catch {
            // Stage logging is fail-open, including sampling and client errors.
          }
        }
        const delivery = client.flush().catch(() => {
          // App Health is fail-open; transport diagnostics stay inside the client.
        });
        if (ctx) ctx.waitUntil(delivery);
        else void delivery;
      }
    } catch {
      // Monitoring must never change gateway behavior.
    }
  }
}
