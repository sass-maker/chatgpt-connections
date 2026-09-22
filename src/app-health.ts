import {
  createAppHealthClient,
  type AppHealthClient,
  type AppHealthClientOptions,
} from "@saas-maker/app-health";

import { hostedRoute, openAiChallengeSecret } from "./hosted.js";
import type { HostedWorkerEnv } from "./oauth.js";

const APP_HEALTH_INGEST_ENDPOINT = "https://ingest.sassmaker.com/v1/ingest";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const OPENAI_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

export type AppHealthClientFactory = (env: HostedWorkerEnv) => AppHealthClient | null;

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
  handle: () => Promise<Response>,
  makeClient: AppHealthClientFactory = createConnectionsAppHealthClient,
): Promise<Response> {
  const route = appHealthRoute(request);
  if (!route) return handle();

  const started = performance.now();
  let status = 500;
  try {
    const response = await handle();
    status = response.status;
    return response;
  } finally {
    try {
      const client = makeClient(env);
      if (client) {
        client.record({
          method: request.method,
          route,
          status_code: status,
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
        });
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
