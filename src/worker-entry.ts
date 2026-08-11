import OAuthProvider from "@cloudflare/workers-oauth-provider";

import {
  PRIVATE_HOSTED_PATHS,
  PRIVATE_HOSTED_SCOPES,
  hostedRoute,
} from "./hosted.js";
import {
  handleOAuthDefaultRequest,
  type HostedWorkerEnv,
  type OAuthGrantProps,
} from "./oauth.js";
import { handleHostedRequest, productToken } from "./worker.js";

const privateApiHandler = {
  async fetch(request: Request, env: HostedWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const route = hostedRoute(new URL(request.url).pathname);
    const grant = (ctx as ExecutionContext & { props?: OAuthGrantProps }).props;
    if (!route || route.audience !== "personal" || !grant) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "OAuth authorization is required." }, id: null },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return handleHostedRequest(request, fetch, {
      grant,
      productToken: productToken(env, route),
    });
  },
} satisfies ExportedHandler<HostedWorkerEnv>;

const defaultHandler = {
  async fetch(request: Request, env: HostedWorkerEnv): Promise<Response> {
    const oauth = await handleOAuthDefaultRequest(request, env);
    return oauth ?? handleHostedRequest(request);
  },
} satisfies ExportedHandler<HostedWorkerEnv>;

const oauthProvider = new OAuthProvider<HostedWorkerEnv>({
  apiRoute: [...PRIVATE_HOSTED_PATHS],
  apiHandler: privateApiHandler,
  defaultHandler,
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [...PRIVATE_HOSTED_SCOPES],
  resourceMetadata: {
    scopes_supported: [...PRIVATE_HOSTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Fleet read-only personal application data",
  },
  accessTokenTTL: 3_600,
  refreshTokenTTL: 2_592_000,
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  allowTokenExchangeGrant: false,
  onError(error) {
    console.warn(JSON.stringify({
      message: "oauth_provider_rejected_request",
      code: error.code,
      status: error.status,
      category: error.internal?.category,
    }));
  },
});

function routeForProtectedMetadata(pathname: string) {
  const prefix = "/.well-known/oauth-protected-resource/";
  if (!pathname.startsWith(prefix)) return undefined;
  const route = hostedRoute(`/${pathname.slice(prefix.length)}`);
  return route?.audience === "personal" ? route : undefined;
}

async function narrowProductScope(response: Response, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const route = hostedRoute(path) ?? routeForProtectedMetadata(path);
  if (!route || route.audience !== "personal" || !route.scope) return response;
  const headers = new Headers(response.headers);
  const challenge = headers.get("WWW-Authenticate");
  if (challenge) {
    headers.set(
      "WWW-Authenticate",
      /scope="[^"]*"/u.test(challenge)
        ? challenge.replace(/scope="[^"]*"/u, `scope="${route.scope}"`)
        : `${challenge}, scope="${route.scope}"`,
    );
  }
  if (!routeForProtectedMetadata(path) || !headers.get("content-type")?.includes("application/json")) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const payload = await response.json() as Record<string, unknown>;
  payload.scopes_supported = [route.scope];
  headers.delete("Content-Length");
  headers.set("Cache-Control", "no-store");
  return Response.json(payload, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: HostedWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return narrowProductScope(await oauthProvider.fetch(request, env, ctx), request);
  },
} satisfies ExportedHandler<HostedWorkerEnv>;
