import { MAX_TEXT_LENGTH } from "./contracts.js";

const SECRET_KEY = /(authorization|cookie|password|secret|token|api[_-]?key)/i;
const MAX_DEPTH = 7;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

export type Sanitized = null | boolean | number | string | Sanitized[] | { [key: string]: Sanitized };

export function sanitizationTruncated(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "number") return false;
  if (typeof value === "string") return value.length > MAX_TEXT_LENGTH;
  if (depth >= MAX_DEPTH) return true;
  if (Array.isArray(value)) {
    return (
      value.length > MAX_ARRAY_ITEMS ||
      value.slice(0, MAX_ARRAY_ITEMS).some((item) => sanitizationTruncated(item, depth + 1))
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return (
      entries.length > MAX_OBJECT_KEYS ||
      entries
        .filter(([key]) => !SECRET_KEY.test(key))
        .slice(0, MAX_OBJECT_KEYS)
        .some(([, item]) => sanitizationTruncated(item, depth + 1))
    );
  }
  return false;
}

export function sanitize(value: unknown, depth = 0): Sanitized {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH)}…`;
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, Sanitized> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      if (SECRET_KEY.test(key)) continue;
      output[key] = sanitize(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function asRecord(value: unknown): Record<string, Sanitized> {
  const sanitized = sanitize(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : { value: sanitized };
}
