import { APP_DEFINITIONS, type AppId } from "./apps.js";

const requested = process.argv[2] as AppId | undefined;
if (!requested || !(requested in APP_DEFINITIONS)) {
  process.stderr.write(
    `Choose one connection: ${Object.keys(APP_DEFINITIONS).join(", ")}\n`,
  );
  process.exitCode = 2;
} else {
  const app = APP_DEFINITIONS[requested];
  const configuredBase = process.env[app.baseUrlEnv]?.trim() || app.baseUrl;
  let baseUrlValid = false;
  let baseUrlHost = "invalid";
  try {
    const url = new URL(configuredBase);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    baseUrlValid = url.protocol === "https:" || (local && url.protocol === "http:");
    baseUrlHost = url.host;
  } catch {
    baseUrlValid = false;
  }
  const token = app.tokenEnv ? process.env[app.tokenEnv]?.trim() : undefined;
  const credential = !app.tokenEnv
    ? "not-required"
    : token && (!app.tokenPrefix || token.startsWith(app.tokenPrefix))
      ? "present"
      : "missing-or-invalid";
  const ready = baseUrlValid && credential !== "missing-or-invalid";
  process.stdout.write(
    `${JSON.stringify({
      app: app.id,
      serverName: app.serverName,
      baseUrlHost,
      baseUrlValid,
      credential,
      toolCount: Object.keys(app.tools).length,
      ready,
    })}\n`,
  );
  if (!ready) process.exitCode = 1;
}
