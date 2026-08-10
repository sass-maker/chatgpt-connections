import { z } from "zod";

export const MAX_COLLECTION_LIMIT = 50;
export const DEFAULT_COLLECTION_LIMIT = 10;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_RESPONSE_BYTES = 1_000_000;

export const errorCodeSchema = z.enum([
  "invalid_input",
  "unauthorized",
  "not_found",
  "rate_limited",
  "timeout",
  "upstream_unavailable",
  "unsupported_in_current_mode",
  "invalid_upstream_response",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const provenanceSchema = z.object({
  label: z.string(),
  url: z.string().url(),
});

export const toolResultSchema = z.object({
  schemaVersion: z.literal("1"),
  ok: z.boolean(),
  app: z.string(),
  tool: z.string(),
  generatedAt: z.string(),
  freshness: z.string().optional(),
  retrievalMode: z.string(),
  items: z.array(z.record(z.string(), z.unknown())).optional(),
  item: z.record(z.string(), z.unknown()).optional(),
  total: z.number().int().nonnegative().optional(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
  hasMore: z.boolean(),
  truncated: z.boolean(),
  provenance: z.array(provenanceSchema),
  error: z
    .object({
      code: errorCodeSchema,
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;

export const commonLimitInput = z.number().int().min(1).max(MAX_COLLECTION_LIMIT).default(10);
export const commonOffsetInput = z.number().int().min(0).max(1_000_000).default(0);

export function outputShape() {
  return toolResultSchema;
}
