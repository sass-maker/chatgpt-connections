import { hostedRoute, openAiChallengeSecret } from "./hosted.js";
import {
  authorizeOAuthRequest,
  handleOAuthMetadataRequest,
  type HostedWorkerEnv,
} from "./oauth.js";
import { handleHostedRequest, productToken } from "./worker.js";

function authorizationUnavailable(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "OAuth authorization is temporarily unavailable." },
      id: null,
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "Retry-After": "30",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function openAiChallenge(request: Request, env: HostedWorkerEnv): Response | undefined {
  const url = new URL(request.url);
  if (url.pathname !== "/.well-known/openai-apps-challenge" || request.method !== "GET") {
    return undefined;
  }
  const secret = openAiChallengeSecret(url.hostname);
  const token = secret ? env[secret] : undefined;
  if (!token || token.length > 4_096 || /[\r\n\0]/u.test(token)) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(token, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: HostedWorkerEnv): Promise<Response> {
    const fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
    const challenge = openAiChallenge(request, env);
    if (challenge) return challenge;
    const metadata = await handleOAuthMetadataRequest(request, env, fetchImpl);
    if (metadata) return metadata;

    const url = new URL(request.url);
    const route = hostedRoute(url.pathname, url.hostname);
    if (!route || route.audience === "public") return handleHostedRequest(request, fetchImpl);

    const authorization = await authorizeOAuthRequest(request, route, env);
    if (authorization.status === "unavailable" || authorization.status === "misconfigured") {
      return authorizationUnavailable();
    }
    if (authorization.status !== "authorized") return handleHostedRequest(request, fetchImpl);

    return handleHostedRequest(request, fetchImpl, {
      grant: authorization.grant,
      upstreamToken: route.authMode === "federated"
        ? authorization.accessToken
        : productToken(env, route),
    });
  },
} satisfies ExportedHandler<HostedWorkerEnv>;
