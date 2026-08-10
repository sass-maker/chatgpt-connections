import { MAX_RESPONSE_BYTES } from "./contracts.js";
import { ConnectionError, asConnectionError, errorFromStatus } from "./errors.js";

export interface ReadOperation<Args extends Record<string, unknown>> {
  path: (args: Args) => string;
  auth?: boolean;
  baseUrl?: string;
  fallback?: {
    baseUrl: string;
    path: (args: Args) => string;
    mode: string;
  };
}

export interface ReadResponse {
  payload: unknown;
  sourceUrl: string;
  retrievalMode?: string;
  freshness?: string;
}

export interface ReadClientOptions {
  baseUrl: string;
  token?: string;
  tokenPrefix?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function validatedBaseUrl(value: string): URL {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new ConnectionError("invalid_input", "Application base URL must use HTTPS or local HTTP.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ConnectionError("invalid_upstream_response", "Application response exceeded the read bound.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ConnectionError(
        "invalid_upstream_response",
        "Application response exceeded the read bound.",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export class ReadClient<Operations extends Record<string, ReadOperation<Record<string, unknown>>>> {
  readonly #baseUrl: URL;
  readonly #operations: Operations;
  readonly #token?: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(operations: Operations, options: ReadClientOptions) {
    this.#operations = operations;
    this.#baseUrl = validatedBaseUrl(options.baseUrl);
    this.#timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10_000, 1_000), 30_000);
    this.#fetch = options.fetchImpl ?? fetch;
    if (options.token !== undefined) {
      if (options.tokenPrefix && !options.token.startsWith(options.tokenPrefix)) {
        throw new ConnectionError("invalid_input", "Read credential has the wrong application prefix.");
      }
      this.#token = options.token;
    }
  }

  async #read(
    operation: ReadOperation<Record<string, unknown>>,
    url: URL,
  ): Promise<{ payload: unknown; freshness?: string }> {
    let lastError: ConnectionError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const headers = new Headers({ Accept: "application/json" });
        if (operation.auth && this.#token) headers.set("Authorization", `Bearer ${this.#token}`);
        const response = await this.#fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(this.#timeoutMs),
          redirect: "error",
        });
        if (!response.ok) {
          const mapped = errorFromStatus(response.status);
          if (mapped.retryable && attempt === 0) {
            lastError = mapped;
            continue;
          }
          throw mapped;
        }
        const text = await boundedResponseText(response);
        try {
          const payload = JSON.parse(text) as unknown;
          const lastModified = response.headers.get("last-modified")?.trim();
          return {
            payload,
            ...(lastModified ? { freshness: lastModified } : {}),
          };
        } catch {
          throw new ConnectionError("invalid_upstream_response", "Application returned invalid JSON.");
        }
      } catch (error) {
        const mapped = asConnectionError(error);
        if (mapped.retryable && attempt === 0) {
          lastError = mapped;
          continue;
        }
        throw mapped;
      }
    }
    throw lastError ?? new ConnectionError("upstream_unavailable", "Application read failed.", true);
  }

  async callWithMetadata(
    name: keyof Operations,
    args: Record<string, unknown>,
  ): Promise<ReadResponse> {
    const operation = this.#operations[name];
    if (!operation) throw new ConnectionError("invalid_input", "Unknown read operation.");
    if (operation.auth && !this.#token) {
      throw new ConnectionError("unauthorized", "This connection needs a dedicated read credential.");
    }

    const path = operation.path(args);
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new ConnectionError("invalid_input", "Read operation produced an invalid fixed path.");
    }
    const operationBase = operation.baseUrl ? validatedBaseUrl(operation.baseUrl) : this.#baseUrl;
    const url = new URL(path, operationBase);
    if (url.origin !== operationBase.origin) {
      throw new ConnectionError("invalid_input", "Cross-origin reads are not permitted.");
    }

    try {
      return { ...(await this.#read(operation, url)), sourceUrl: url.toString() };
    } catch (error) {
      const mapped = asConnectionError(error);
      if (!operation.fallback || !mapped.retryable) throw mapped;
      const fallbackBase = validatedBaseUrl(operation.fallback.baseUrl);
      const fallbackPath = operation.fallback.path(args);
      if (!fallbackPath.startsWith("/") || fallbackPath.startsWith("//")) {
        throw new ConnectionError("invalid_input", "Fallback produced an invalid fixed path.");
      }
      const fallbackUrl = new URL(fallbackPath, fallbackBase);
      if (fallbackUrl.origin !== fallbackBase.origin) {
        throw new ConnectionError("invalid_input", "Cross-origin fallback reads are not permitted.");
      }
      return {
        ...(await this.#read({ path: operation.fallback.path }, fallbackUrl)),
        sourceUrl: fallbackUrl.toString(),
        retrievalMode: operation.fallback.mode,
      };
    }
  }

  async call(name: keyof Operations, args: Record<string, unknown>): Promise<unknown> {
    return (await this.callWithMetadata(name, args)).payload;
  }
}
