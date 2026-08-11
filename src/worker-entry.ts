import { hostedRoute } from "./hosted.js";
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

export default {
  async fetch(request: Request, env: HostedWorkerEnv): Promise<Response> {
    const fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
    const metadata = await handleOAuthMetadataRequest(request, env, fetchImpl);
    if (metadata) return metadata;

    const route = hostedRoute(new URL(request.url).pathname);
    if (!route || route.audience === "public") return handleHostedRequest(request, fetchImpl);

    const authorization = await authorizeOAuthRequest(request, route, env);
    if (authorization.status === "unavailable" || authorization.status === "misconfigured") {
      return authorizationUnavailable();
    }
    if (authorization.status !== "authorized") return handleHostedRequest(request);

    return handleHostedRequest(request, fetchImpl, {
      grant: authorization.grant,
      productToken: productToken(env, route),
    });
  },
} satisfies ExportedHandler<HostedWorkerEnv>;
