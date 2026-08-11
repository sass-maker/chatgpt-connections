import { writeFile } from "node:fs/promises";

import { runPublicSubmissionEvaluations } from "./submission-evals.js";

function outputPath(argv: string[]): string | undefined {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.length === 0) return undefined;
  if (normalized.length !== 2 || normalized[0] !== "--output" || !normalized[1]) {
    throw new Error("arguments_invalid");
  }
  return normalized[1];
}

try {
  const path = outputPath(process.argv.slice(2));
  const receipt = await runPublicSubmissionEvaluations();
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (path) await writeFile(path, serialized, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(serialized);
  if (!receipt.ok) process.exitCode = 1;
} catch (error) {
  const code = error instanceof Error && error.message === "arguments_invalid"
    ? "arguments_invalid"
    : "submission_evaluations_failed";
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = code === "arguments_invalid" ? 2 : 1;
}
