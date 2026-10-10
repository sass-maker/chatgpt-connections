import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  HOSTED_ROUTES,
  hostedRoute,
  oauthResource,
  type HostedRouteDefinition,
} from "./hosted.js";
import type { HostedWorkerEnv, OAuthGrantProps } from "./oauth.js";
import { footerAssetResponse } from "./footer-assets.js";
import { OG_IMAGE_BASE64 } from "./og-image.js";
import { buildServerForApp, type ToolSecurityScheme } from "./server.js";

const MAX_MCP_REQUEST_BYTES = 256_000;
const MAX_MCP_RESPONSE_BYTES = 1_000_000;
const MAX_PRODUCT_TOKEN_BYTES = 2_048;
const MAX_FEDERATED_TOKEN_BYTES = 20_000;
const NATIVE_TIMEOUT_MS = 10_000;
const ALLOWED_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

class RequestTooLargeError extends Error {}
class ResponseTooLargeError extends Error {}

interface HostedRequestAuthorization {
  grant: OAuthGrantProps;
  upstreamToken: string | undefined;
}

function jsonRpcError(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers: { "Content-Type": "application/json", ...headers } },
  );
}

function productUnavailable(): Response {
  return jsonRpcError(
    503,
    -32000,
    "This product connection is temporarily unavailable.",
    { "Retry-After": "300" },
  );
}

function allowedOrigin(request: Request): string | undefined {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return undefined;
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin) ? origin : undefined;
}

function withProtocolHeaders(
  response: Response,
  request: Request,
  route?: HostedRouteDefinition,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  const origin = allowedOrigin(request);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Mcp-Protocol-Version, Mcp-Session-Id, WWW-Authenticate");
    headers.append("Vary", "Origin");
  }
  if (route?.audience === "personal") {
    headers.set("Pragma", "no-cache");
    headers.set("Vary", [headers.get("Vary"), "Authorization"].filter(Boolean).join(", "));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(request: Request): Response {
  const origin = allowedOrigin(request);
  if (request.headers.has("origin") && !origin) {
    return jsonRpcError(403, -32000, "Origin is not allowed.");
  }
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Last-Event-ID, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
}

async function boundedRequest(request: Request): Promise<Request> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BYTES) {
    throw new RequestTooLargeError();
  }
  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MCP_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
  });
}

async function boundedResponse(response: Response): Promise<Response> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MCP_RESPONSE_BYTES) {
    throw new ResponseTooLargeError();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

function connectionAnchor(path: string): string {
  return `connection-${path.replace(/^\/+|\/+$/gu, "").replace(/[^a-z0-9]+/giu, "-")}`;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function ogImageResponse(): Response {
  return new Response(new Blob([base64ToBytes(OG_IMAGE_BASE64)], { type: "image/png" }), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

type BrowserTracker = { key: string };

// App Health project scope is the canonical production app UUID, not an independently configurable Worker value.
const APP_HEALTH_PROJECT_ID = "app-69c3e3a1-270b-49c0-a31f-9fc1c71ef97f";

const ROUTE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "/personal-apps/mcp": "Personal apps",
  "/anime-list/mcp": "Anime list",
  "/anime-list-public/mcp": "Public anime list",
};

interface LandingRow {
  path: string;
  name: string;
  description: string;
  endpoint: string;
  audience: "personal" | "public";
  status: "live" | "prepared";
}

function landingRows(): LandingRow[] {
  return Object.entries(HOSTED_ROUTES).map(([path, route]) => {
    const name = ROUTE_DISPLAY_NAMES[path] ?? (route.kind === "adapter" ? route.app.name : route.serverName);
    const description =
      route.kind === "adapter"
        ? route.app.instructions.split(/(?<=[.!?])\s/)[0] ?? route.app.instructions
        : `Read-only MCP connection proxied to ${new URL(route.upstreamUrl).hostname}.`;
    return {
      path,
      name,
      description,
      endpoint: `https://${route.hosts[0]}${path}`,
      audience: route.audience,
      status: route.productionStatus === "prepared" ? "prepared" : "live",
    };
  });
}

function landingRowHtml(row: LandingRow, index: number): string {
  const access = row.audience === "personal" ? "Owner sign-in" : "Public";
  const statusLabel = row.status === "prepared" ? "Prepared" : "Live";
  const number = String(index + 1).padStart(2, "0");
  return `      <li class="card" id="${connectionAnchor(row.path)}">
        <span class="row-num" aria-hidden="true"><i class="dot ${row.status}"></i>${number}</span>
        <div class="row-name"><h3>${escapeHtml(row.name)}</h3><p>${escapeHtml(row.description)}</p></div>
        <div class="row-meta">
          <code class="endpoint">${escapeHtml(row.endpoint)}</code>
          <span class="pills"><span class="badge ${row.audience}">${access}</span><span class="status ${row.status}">${statusLabel}</span></span>
        </div>
      </li>`;
}

function landingResponse(url: URL, browserTracker?: BrowserTracker): Response {
  const tracker = browserTracker?.key.trim()
    ? `<script defer src="https://health.sassmaker.com/tracker.js" data-key="${escapeHtml(browserTracker.key.trim())}" data-project="${APP_HEALTH_PROJECT_ID}" data-identity="session" data-endpoint="https://ingest.sassmaker.com/v1/browser" data-vitals></script>`
    : "";
  const rows = landingRows();
  const byStatus = (list: LandingRow[]) => [...list.filter((row) => row.status === "live"), ...list.filter((row) => row.status !== "live")];
  const publicRows = byStatus(rows.filter((row) => row.audience === "public"));
  const personalRows = byStatus(rows.filter((row) => row.audience === "personal"));
  const ordered = [...publicRows, ...personalRows];
  const publicCards = publicRows.map((row) => landingRowHtml(row, ordered.indexOf(row))).join("\n");
  const personalCards = personalRows.map((row) => landingRowHtml(row, ordered.indexOf(row))).join("\n");
  const liveCount = rows.filter((row) => row.status === "live").length;
  const diagramApps = rows
    .filter((row) => row.status === "live")
    .map((row) => `<li class="${row.audience}"><i class="dot live"></i>${escapeHtml(row.name)}</li>`)
    .join("");
  const footerLinks = rows
    .map((row) => `<li><a href="#${connectionAnchor(row.path)}">${escapeHtml(row.name)}</a></li>`)
    .join("\n      ");
  const fonts = `${url.origin}/fonts/fleet-footer-precise-v1`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT Connections — SaaS Maker MCP endpoints</title>
<meta name="description" content="Hosted read-only MCP connections for ChatGPT and other MCP clients: the list of active endpoints, their audiences, and status.">
<meta name="theme-color" content="#0c0f0d">
<link rel="canonical" href="${url.origin}/">
<link rel="icon" href="data:,">
<link rel="preload" href="${fonts}/geist.woff2" as="font" type="font/woff2" crossorigin>
<meta property="og:type" content="website">
<meta property="og:site_name" content="ChatGPT Connections">
<meta property="og:title" content="ChatGPT Connections — SaaS Maker MCP endpoints">
<meta property="og:description" content="Hosted read-only MCP connections for ChatGPT and other MCP clients.">
<meta property="og:url" content="${url.origin}/">
<meta property="og:image" content="${url.origin}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebSite","name":"ChatGPT Connections","url":"${url.origin}/","description":"Hosted read-only MCP connections for ChatGPT and other MCP clients."}
</script>
<style>
@font-face{font-family:"Geist";src:url("${fonts}/geist.woff2") format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url("${fonts}/geistmono.woff2") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:"Newsreader";src:url("${fonts}/newsreader.woff2") format("woff2");font-weight:200 800;font-style:normal;font-display:swap}
:root{--bg:#0c0f0d;--bg-2:#101512;--panel:#121915;--ink:#eef4ef;--muted:#9db3a5;--faint:#6f8577;--accent:#6bd29c;--accent-ink:#06130c;--line:rgba(157,179,165,.18);--line-strong:rgba(157,179,165,.32);--amber:#e0ad4c;--sans:"Geist",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--serif:"Newsreader",Georgia,serif;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;font-size:16px;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}
code{font-family:var(--mono)}
.wrap{width:min(1180px,calc(100% - 64px));margin-inline:auto}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:12px;background:var(--ink);color:var(--bg);padding:8px 12px;z-index:5}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
/* nav */
.topbar{border-bottom:1px solid var(--line)}
.topbar .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;gap:16px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:600;letter-spacing:-.01em;font-size:15px}
.brand svg{flex:none}
.nav{display:flex;gap:28px;font-size:14px;color:var(--muted)}
.nav a{text-decoration:none}.nav a:hover{color:var(--ink)}
/* hero */
.hero{position:relative;padding:88px 0 96px;border-bottom:1px solid var(--line);background:radial-gradient(60% 70% at 78% 40%,rgba(107,210,156,.09),transparent 70%)}
.hero .wrap{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,.92fr);gap:72px;align-items:center}
h1{font-size:clamp(2.75rem,6.2vw,5.4rem);line-height:.96;letter-spacing:-.045em;font-weight:620;margin:22px 0 26px;text-wrap:balance}
h1 em{font-family:var(--serif);font-style:italic;font-weight:400;letter-spacing:-.02em;color:var(--accent)}
.lede{color:var(--muted);font-size:clamp(1.05rem,1.4vw,1.2rem);line-height:1.6;max-width:34em;margin:0 0 36px}
.lede strong{color:var(--ink);font-weight:500}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:14px 26px}
.btn{display:inline-flex;align-items:center;gap:10px;min-height:48px;padding:0 22px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;font-size:15px;transition:transform .15s ease,background .15s ease}
.btn:hover{background:#86e0b0;transform:translateY(-1px)}
.textlink{font-size:15px;color:var(--ink);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:.35em}
.textlink:hover{text-decoration-color:var(--accent)}
.tally{display:flex;flex-wrap:wrap;gap:8px 22px;margin:40px 0 0;padding:18px 0 0;border-top:1px solid var(--line);font-family:var(--mono);font-size:12px;letter-spacing:.04em;color:var(--faint);list-style:none}
.tally b{color:var(--ink);font-weight:400}
/* diagram */
.figure{margin:0;position:relative}
.diagram{position:relative;border:1px solid var(--line);border-radius:22px;background:linear-gradient(180deg,#121a15,#0e1310);padding:26px;box-shadow:0 40px 80px -40px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.03)}
.node{position:relative;border:1px solid var(--line-strong);border-radius:14px;background:var(--bg-2);padding:16px 18px}
.node-label{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 10px;display:flex;justify-content:space-between;gap:12px}
.chat{display:flex;gap:12px;align-items:flex-start}
.chat .avatar{flex:none;width:30px;height:30px;border-radius:50%;background:var(--ink);color:var(--bg);display:grid;place-items:center;margin-top:4px}
.bubble{margin:0;background:#1a231e;border:1px solid var(--line);border-radius:14px 14px 14px 4px;padding:10px 14px;font-size:14.5px;line-height:1.45}
.wire{display:block;width:100%;height:46px}
.wire path{fill:none;stroke:var(--line-strong);stroke-width:1.5}
.wire .flow{stroke:var(--accent);stroke-dasharray:4 10;animation:flow 1.6s linear infinite;opacity:.85}
@keyframes flow{to{stroke-dashoffset:-28}}
.wire-row{position:relative}.amber{color:var(--amber)}
.wire-cap{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;color:var(--muted);background:#0f1511;padding:3px 10px;border:1px solid var(--line);border-radius:999px;white-space:nowrap}
.gate{border-color:rgba(107,210,156,.45);background:linear-gradient(180deg,rgba(107,210,156,.08),rgba(107,210,156,.02))}
.gate h4{margin:0;font-size:18px;letter-spacing:-.02em;font-weight:600}
.lanes{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.lane{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.4;color:var(--muted);background:rgba(12,15,13,.55)}
.lane b{display:block;color:var(--ink);font-weight:550;font-size:13px;margin-bottom:2px}
.never{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding:0;list-style:none}
.never .never-label{color:var(--faint);border:0;text-decoration:none;padding-left:0;text-transform:uppercase;letter-spacing:.14em}
.never li{font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;color:#c99a8f;border:1px dashed rgba(201,154,143,.4);border-radius:999px;padding:3px 9px;text-decoration:line-through;text-decoration-color:rgba(201,154,143,.6)}
.apps{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.apps li{display:inline-flex;align-items:center;gap:7px;font-size:13px;border:1px solid var(--line);border-radius:999px;padding:5px 11px 5px 9px;background:var(--bg)}
.apps li.personal{color:var(--muted)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
.dot.live{background:var(--accent);box-shadow:0 0 0 3px rgba(107,210,156,.14)}
.dot.prepared{background:var(--amber);box-shadow:0 0 0 3px rgba(224,173,76,.14)}
figcaption{font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:14px;letter-spacing:.03em}
/* steps */
.steps{border-bottom:1px solid var(--line)}
.steps ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr)}
.steps li{padding:44px 36px 48px 0;border-right:1px solid var(--line)}
.steps li+li{padding-left:36px}
.steps li:last-child{border-right:0}
.steps .n{font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.1em}
.steps h3{margin:14px 0 8px;font-size:22px;letter-spacing:-.025em;font-weight:600}
.steps p{margin:0;color:var(--muted);font-size:15px;max-width:30em}
/* directory */
.directory{padding:112px 0 40px}
.dir-head{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);gap:48px;align-items:end;margin-bottom:64px}
h2{font-size:clamp(2.3rem,4.8vw,4rem);line-height:1;letter-spacing:-.045em;font-weight:620;margin:18px 0 0;text-wrap:balance}
h2 em{font-family:var(--serif);font-style:italic;font-weight:400;letter-spacing:-.02em;color:var(--accent)}
.dir-head p{color:var(--muted);margin:0;font-size:16px;max-width:28em}
.group{margin-bottom:72px}
.group-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid var(--line-strong)}
.group-head h3{margin:0;font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:400;color:var(--ink)}
.group-head p{margin:0;font-size:14px;color:var(--faint)}
.rows{list-style:none;margin:0;padding:0}
.card{display:grid;grid-template-columns:76px minmax(0,1.15fr) minmax(0,1fr);gap:28px;align-items:start;padding:28px 0;border-bottom:1px solid var(--line);scroll-margin-top:24px;transition:background .2s ease}
.card:hover{background:linear-gradient(90deg,rgba(107,210,156,.045),transparent 70%)}
.card:target{background:linear-gradient(90deg,rgba(107,210,156,.09),transparent 80%)}
.row-num{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;color:var(--faint);padding-top:10px}
.row-name h3{margin:0;font-size:clamp(1.45rem,2.3vw,1.9rem);line-height:1.1;letter-spacing:-.035em;font-weight:560}
.row-name p{margin:8px 0 0;color:var(--muted);font-size:15px;max-width:34em}
.row-meta{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding-top:6px;min-width:0}
.endpoint{display:block;max-width:100%;font-size:12.5px;line-height:1.5;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 11px;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
.pills{display:flex;gap:8px;flex-wrap:wrap}
.badge,.status{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.badge.public{color:var(--accent);border-color:rgba(107,210,156,.4)}
.badge.personal{color:var(--muted)}
.status.live{color:var(--accent)}
.status.prepared{color:var(--amber);border-color:rgba(224,173,76,.4)}
/* boundary */
.boundary{padding:24px 0 120px}
.boundary .panel{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:48px;border:1px solid var(--line);border-radius:22px;padding:48px;background:linear-gradient(135deg,#111813,#0d110e)}
.boundary h2{font-size:clamp(1.9rem,3.4vw,2.8rem)}
.boundary ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:0 32px}
.boundary li{padding:16px 0;border-top:1px solid var(--line);font-size:15px;color:var(--muted)}
.boundary li b{display:block;color:var(--ink);font-weight:550;margin-bottom:2px}
.connections-footer-links{display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin:0;padding:0;list-style:none}
.connections-footer-links a{color:inherit;font-size:.8rem;text-underline-offset:.25em}
@media (max-width:980px){
  .hero .wrap{grid-template-columns:1fr;gap:56px}
  .dir-head,.boundary .panel{grid-template-columns:1fr;gap:20px}
  .card{grid-template-columns:56px minmax(0,1fr);gap:8px 20px}
  .row-meta{grid-column:2}
}
@media (max-width:720px){
  .wrap{width:calc(100% - 32px)}
  .nav a:not(:first-child){display:none}
  .hero{padding:56px 0 64px}
  h1{margin:18px 0 20px}
  .diagram{padding:16px;border-radius:18px}
  .lanes{grid-template-columns:1fr}
  .steps ol{grid-template-columns:1fr}
  .steps li,.steps li+li{padding:28px 0;border-right:0;border-bottom:1px solid var(--line)}
  .steps li:last-child{border-bottom:0}
  .directory{padding:72px 0 16px}
  .dir-head{margin-bottom:44px}
  .group{margin-bottom:52px}
  .group-head{flex-direction:column;gap:4px}
  .card{grid-template-columns:1fr;gap:10px;padding:24px 0}
  .row-num{padding-top:0}
  .row-meta{grid-column:1}
  .boundary{padding:8px 0 80px}
  .boundary .panel{padding:28px 22px;border-radius:18px}
  .boundary ul{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.wire .flow{animation:none}.btn{transition:none}}
</style>
</head>
<body>
<a class="skip" href="#directory">Skip to endpoints</a>
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="/" aria-label="ChatGPT Connections home">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="0.5" y="0.5" width="25" height="25" rx="7" fill="#121915" stroke="rgba(157,179,165,.32)"/><circle cx="8" cy="13" r="3" fill="#eef4ef"/><circle cx="18" cy="13" r="3" fill="#6bd29c"/><path d="M11 13h4" stroke="#6bd29c" stroke-width="1.6" stroke-linecap="round"/></svg>
      ChatGPT Connections
    </a>
    <nav class="nav" aria-label="Page">
      <a href="#directory">Endpoints</a>
      <a href="#how">How it works</a>
      <a href="#boundary">Boundary</a>
    </nav>
  </div>
</header>
<main>
  <section class="hero" aria-labelledby="hero-title">
    <div class="wrap">
      <div>
        <p class="eyebrow">Read-only MCP gateway · SaaS Maker</p>
        <h1 id="hero-title">Connect ChatGPT to your <em>Fleet apps.</em></h1>
        <p class="lede">Each endpoint below is a hosted MCP server for one Fleet product. Add its URL to ChatGPT and it can <strong>read</strong> from that product. It cannot save, edit or delete anything. <strong>Public</strong> endpoints need no account. <strong>Owner sign-in</strong> endpoints are the owner's personal connectors.</p>
        <div class="actions">
          <a class="btn" href="#directory">Browse the endpoints <span aria-hidden="true">↓</span></a>
          <a class="textlink" href="#how">How to connect one</a>
        </div>
        <ul class="tally" aria-label="Endpoint summary">
          <li><b>${rows.length}</b> endpoints</li>
          <li><b>${liveCount}</b> live</li>
          <li><b>${publicRows.length}</b> public</li>
          <li><b>${personalRows.length}</b> owner sign-in</li>
          <li><b>0</b> write tools</li>
        </ul>
      </div>
      <figure class="figure">
        <div class="diagram">
          <div class="node">
            <p class="node-label"><span>ChatGPT</span><span>example question</span></p>
            <div class="chat"><span class="avatar" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="4.6" r="2.6" fill="currentColor"/><path d="M1.8 13c.5-2.9 2.6-4.6 5.2-4.6s4.7 1.7 5.2 4.6" fill="currentColor"/></svg></span><p class="bubble">What did High Signal flag today?</p></div>
          </div>
          <div class="wire-row">
            <svg class="wire" viewBox="0 0 400 46" preserveAspectRatio="none" aria-hidden="true"><path d="M200 0V46"/><path class="flow" d="M200 0V46"/></svg>
            <span class="wire-cap">MCP · read-only tools</span>
          </div>
          <div class="node gate">
            <p class="node-label"><span>The gateway</span><span>Cloudflare Worker</span></p>
            <h4>ChatGPT Connections</h4>
            <div class="lanes">
              <div class="lane"><b>Public</b>Anonymous. Reads only approved public APIs or exports.</div>
              <div class="lane"><b>Owner sign-in</b>The owner's sign-in is verified before any product data is read.</div>
            </div>
            <ul class="never" aria-label="Never available"><li class="never-label">Never</li>
              <li>writes</li><li>admin tools</li><li>private fields</li><li>shared credentials</li>
            </ul>
          </div>
          <div class="wire-row">
            <svg class="wire" viewBox="0 0 400 46" preserveAspectRatio="none" aria-hidden="true"><path d="M200 0V18M200 18H60V46M200 18H340V46M200 18V46"/><path class="flow" d="M200 0V18M200 18H60V46M200 18H340V46M200 18V46"/></svg>
          </div>
          <div class="node">
            <p class="node-label"><span>Fleet products</span><span>${liveCount} live</span></p>
            <ul class="apps">${diagramApps}</ul>
          </div>
        </div>
        <figcaption>Diagram of the request path. The question is an example, not a recorded conversation.</figcaption>
      </figure>
    </div>
  </section>

  <section class="steps" id="how" aria-label="How to connect">
    <div class="wrap">
      <ol>
        <li><span class="n">01</span><h3>Copy an endpoint</h3><p>Pick a product from the directory and copy its full URL, ending in <code>/mcp</code>.</p></li>
        <li><span class="n">02</span><h3>Add it to ChatGPT</h3><p>Create a custom connector in ChatGPT, or in any MCP client, and paste the URL.</p></li>
        <li><span class="n">03</span><h3>Ask, and it reads</h3><p>Public endpoints answer right away. Owner sign-in endpoints ask the product to confirm it's the owner first.</p></li>
      </ol>
    </div>
  </section>

  <section class="directory" id="directory" aria-labelledby="directory-title">
    <div class="wrap">
      <div class="dir-head">
        <div>
          <p class="eyebrow">The directory</p>
          <h2 id="directory-title">${rows.length} endpoints. <em>One</em> read-only boundary.</h2>
        </div>
        <p>Every route is fixed in code: one product, one hostname, one approved read contract. <span class="amber">Prepared</span> routes exist in code but are not live yet.</p>
      </div>
      <div class="group">
        <div class="group-head"><h3>Public · no account</h3><p>${publicRows.length} endpoints anyone can add</p></div>
        <ul class="rows" id="connections">
${publicCards}
        </ul>
      </div>
      <div class="group">
        <div class="group-head"><h3>Owner sign-in · personal connectors</h3><p>${personalRows.length} endpoints for the owner's own accounts</p></div>
        <ul class="rows">
${personalCards}
        </ul>
      </div>
    </div>
  </section>

  <section class="boundary" id="boundary" aria-labelledby="boundary-title">
    <div class="wrap">
      <div class="panel">
        <div>
          <p class="eyebrow">The boundary</p>
          <h2 id="boundary-title">Built to read. <em>Nothing else.</em></h2>
        </div>
        <ul>
          <li><b>No writes</b>No tool can save, edit, share or delete product data.</li>
          <li><b>No admin surfaces</b>Operator controls and raw databases stay out of reach.</li>
          <li><b>No private fields</b>Responses are sanitized to each product's approved read contract.</li>
          <li><b>No shared credentials</b>ChatGPT never receives a product API key or a shared application token.</li>
        </ul>
      </div>
    </div>
  </section>
</main>
<fleet-footer-extension data-fleet-footer-project="chatgpt-connections" product-name="ChatGPT Connections" theme="dark" font-base="${url.origin}/fonts/fleet-footer-precise-v1/" art-src="${url.origin}/footer-art/chatgpt-connections.webp" art-alt="Two green-stone alcoves joined by a quiet central connection desk." art-width="2172" art-height="724" art-position="50% 50%" art-credit="Connections original artwork">
  <nav slot="navigation" data-fleet-footer-navigation aria-label="Browse connections"><ul class="connections-footer-links">
      ${footerLinks}
  </ul></nav>
</fleet-footer-extension>
<script src="https://sassmaker.com/project-strip.js?v=precise-b0adaa67" data-project="chatgpt-connections" data-host-only="true" theme="dark" defer></script>
<script src="https://sassmaker.com/ai-chat-footer.js?v=precise-b0adaa67" data-name="ChatGPT Connections" data-project="chatgpt-connections" data-host-only="true" theme="dark" data-capture="false" defer></script>
${tracker}
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; script-src https://sassmaker.com${tracker ? " https://health.sassmaker.com" : ""}; connect-src https://sassmaker.com https://api.sassmaker.com${tracker ? " https://ingest.sassmaker.com" : ""}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function healthResponse(): Response {
  return Response.json(
    {
      ok: true,
      service: "fleet-chatgpt-connections",
      routes: Object.entries(HOSTED_ROUTES).map(([path, route]) => ({
        path,
        auth: route.audience === "personal" ? "oauth2" : "noauth",
      })),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=60",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function securitySchemes(route: HostedRouteDefinition): readonly ToolSecurityScheme[] {
  return route.audience === "personal"
    ? [{ type: "oauth2", scopes: [route.scope!] }]
    : [{ type: "noauth" }];
}

async function advertiseSecuritySchemes(
  response: Response,
  route: HostedRouteDefinition,
): Promise<Response> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return response;
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return response;
  const result = (payload as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return response;
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return response;
  const schemes = securitySchemes(route);
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const definition = tool as Record<string, unknown>;
    definition.securitySchemes = schemes;
    const meta = definition._meta && typeof definition._meta === "object" && !Array.isArray(definition._meta)
      ? definition._meta as Record<string, unknown>
      : {};
    meta.securitySchemes = schemes;
    definition._meta = meta;
  }
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return Response.json(payload, { status: response.status, headers });
}

function exactResource(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}${url.pathname}`;
}

function authorizationMatches(
  request: Request,
  route: HostedRouteDefinition,
  authorization: HostedRequestAuthorization | undefined,
): authorization is HostedRequestAuthorization {
  if (!authorization || route.audience !== "personal" || !route.scope) return false;
  const { grant } = authorization;
  return grant.product === route.id &&
    grant.scope === route.scope &&
    grant.resource === oauthResource(route, exactResource(request)) &&
    typeof grant.subject === "string" && grant.subject.length > 0 && grant.subject.length <= 512;
}

function oauthChallenge(request: Request, route: HostedRouteDefinition): Response {
  const url = new URL(request.url);
  const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  const challenge = `Bearer resource_metadata="${metadata}", scope="${route.scope}", error="invalid_token", error_description="OAuth authorization is required"`;
  return jsonRpcError(401, -32000, "OAuth authorization is required.", {
    "WWW-Authenticate": challenge,
  });
}

function validUpstreamToken(route: HostedRouteDefinition, value: string | undefined): boolean {
  if (!value) return false;
  if (route.authMode === "federated") {
    return value.length <= MAX_FEDERATED_TOKEN_BYTES &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
  }
  if (route.kind !== "adapter") return false;
  if (value.length > MAX_PRODUCT_TOKEN_BYTES) return false;
  return !route.app.tokenPrefix || value.startsWith(route.app.tokenPrefix);
}

async function handleAdapter(
  request: Request,
  route: Extract<HostedRouteDefinition, { kind: "adapter" }>,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<Response> {
  const safeRequest = await boundedRequest(request);
  const server = buildServerForApp(route.app, {
    fetchImpl,
    readProcessEnvironment: false,
    securitySchemes: securitySchemes(route),
    validateTokenPrefix: route.authMode !== "federated",
    ...(token ? { token } : {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return advertiseSecuritySchemes(await transport.handleRequest(safeRequest), route);
}

async function handleNative(
  request: Request,
  route: Extract<HostedRouteDefinition, { kind: "native" }>,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<Response> {
  const safeRequest = await boundedRequest(request);
  const body = await safeRequest.arrayBuffer();
  let message: { id?: number | string; method?: string; params?: { name?: string } };
  try {
    message = JSON.parse(new TextDecoder().decode(body)) as typeof message;
  } catch {
    return jsonRpcError(400, -32700, "Invalid JSON-RPC payload.");
  }
  const allowlist = route.allowedTools ? new Set(route.allowedTools) : undefined;
  const allowedPublicNativeMethods = new Set([
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "tools/call",
  ]);
  if (allowlist && !allowedPublicNativeMethods.has(message.method ?? "")) {
    return jsonRpcError(200, -32601, "Method is not available on this connection.");
  }
  if (allowlist && message.method === "tools/call" && !allowlist.has(message.params?.name ?? "")) {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id ?? null,
      result: {
        isError: true,
        content: [{ type: "text", text: "Tool is not available on this connection." }],
      },
    });
  }
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  for (const name of ["Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"]) {
    const value = request.headers.get(name);
    if (value && value.length <= 256) headers.set(name, value);
  }
  const response = await fetchImpl(route.upstreamUrl, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(NATIVE_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return jsonRpcError(502, -32603, "Upstream MCP redirects are not allowed.");
  }
  let bounded = await boundedResponse(response);
  const responseIsJson = bounded.headers.get("content-type")?.toLowerCase().includes("application/json") === true;
  if (allowlist && !responseIsJson) {
    await bounded.body?.cancel();
    return jsonRpcError(502, -32603, "Upstream MCP response cannot be safely filtered.");
  }
  if (responseIsJson) {
    const payload = await bounded.clone().json() as Record<string, unknown>;
    const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
      ? payload.result as Record<string, unknown>
      : undefined;
    if (result && message.method === "initialize") {
      const serverInfo = result.serverInfo && typeof result.serverInfo === "object" && !Array.isArray(result.serverInfo)
        ? result.serverInfo as Record<string, unknown>
        : {};
      serverInfo.name = route.serverName;
      result.serverInfo = serverInfo;
    }
    if (result && allowlist && message.method === "tools/list" && Array.isArray(result.tools)) {
      result.tools = result.tools.filter((tool) =>
        tool && typeof tool === "object" && !Array.isArray(tool) &&
        allowlist.has(String((tool as Record<string, unknown>).name ?? ""))
      );
    }
    const responseHeaders = new Headers(bounded.headers);
    responseHeaders.delete("Content-Length");
    bounded = Response.json(payload, { status: bounded.status, headers: responseHeaders });
  }
  return advertiseSecuritySchemes(bounded, route);
}

export async function handleHostedRequest(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  authorization?: HostedRequestAuthorization,
  browserTracker?: BrowserTracker,
): Promise<Response> {
  const url = new URL(request.url);
  const footerAsset = footerAssetResponse(request);
  if (footerAsset) return footerAsset;
  if (url.pathname === "/health" && request.method === "GET") return healthResponse();
  if (url.pathname === "/og-image.png" && request.method === "GET") {
    return ogImageResponse();
  }
  if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    return landingResponse(url, browserTracker);
  }

  const route = hostedRoute(url.pathname, url.hostname);
  if (!route) return withProtocolHeaders(jsonRpcError(404, -32001, "Unknown MCP route."), request);
  if (request.headers.has("origin") && !allowedOrigin(request)) {
    return withProtocolHeaders(jsonRpcError(403, -32000, "Origin is not allowed."), request, route);
  }
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "POST") {
    return withProtocolHeaders(
      jsonRpcError(405, -32000, "Only POST and OPTIONS are supported."),
      request,
      route,
    );
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return withProtocolHeaders(
      jsonRpcError(415, -32000, "Content-Type must be application/json."),
      request,
      route,
    );
  }

  if (route.audience === "public") {
    if (request.headers.has("authorization")) {
      return withProtocolHeaders(
        jsonRpcError(401, -32000, "Public MCP routes do not accept credentials."),
        request,
        route,
      );
    }
  } else if (!authorizationMatches(request, route, authorization)) {
    return withProtocolHeaders(oauthChallenge(request, route), request, route);
  } else if (!validUpstreamToken(route, authorization.upstreamToken)) {
    return withProtocolHeaders(productUnavailable(), request, route);
  }

  try {
    const token = route.audience === "personal" ? authorization!.upstreamToken! : undefined;
    const response = route.kind === "native"
      ? await handleNative(request, route, fetchImpl, token)
      : await handleAdapter(request, route, fetchImpl, token);
    return withProtocolHeaders(response, request, route);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return withProtocolHeaders(
        jsonRpcError(413, -32000, "MCP request exceeded the size limit."),
        request,
        route,
      );
    }
    if (error instanceof ResponseTooLargeError) {
      return withProtocolHeaders(
        jsonRpcError(502, -32603, "Upstream MCP response exceeded the size limit."),
        request,
        route,
      );
    }
    console.error(JSON.stringify({
      message: "hosted_mcp_request_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      method: request.method,
      path: url.pathname,
    }));
    return withProtocolHeaders(
      jsonRpcError(500, -32603, "Internal MCP transport error."),
      request,
      route,
    );
  }
}

export function productToken(env: HostedWorkerEnv, route: HostedRouteDefinition): string | undefined {
  switch (route.tokenSecret) {
    case "SETLINE_MCP_TOKEN": return env.SETLINE_MCP_TOKEN;
    default: return "";
  }
}
