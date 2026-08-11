import { ActivationVerificationError, verifyActivation } from "./activation.js";

function usage(): string {
  return "Usage: verify-activation --issuer https://tenant.us.auth0.com/ [--gateway https://mcp.example.com | --branded]";
}

function argumentsFrom(argv: string[]): {
  issuer: string;
  gatewayOrigin?: string;
  brandedOrigins?: boolean;
} {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized.includes("--help")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const values = new Map<string, string>();
  let brandedOrigins = false;
  for (let index = 0; index < normalized.length;) {
    const name = normalized[index];
    if (name === "--branded") {
      if (brandedOrigins) throw new ActivationVerificationError("arguments_invalid");
      brandedOrigins = true;
      index += 1;
      continue;
    }
    const value = normalized[index + 1];
    if ((name !== "--issuer" && name !== "--gateway") || !value || value.startsWith("--") || values.has(name)) {
      throw new ActivationVerificationError("arguments_invalid");
    }
    values.set(name, value);
    index += 2;
  }
  const issuer = values.get("--issuer");
  if (!issuer || (brandedOrigins && values.has("--gateway"))) {
    throw new ActivationVerificationError("arguments_invalid");
  }
  const gatewayOrigin = values.get("--gateway");
  return {
    issuer,
    ...(gatewayOrigin ? { gatewayOrigin } : {}),
    ...(brandedOrigins ? { brandedOrigins: true } : {}),
  };
}

try {
  const receipt = await verifyActivation(argumentsFrom(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  const code = error instanceof ActivationVerificationError ? error.code : "verification_failed";
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  if (code === "arguments_invalid") process.stderr.write(`${usage()}\n`);
  process.exitCode = code === "arguments_invalid" ? 2 : 1;
}
