# ChatGPT Connections agent instructions

- Preserve the read-only MCP boundary. Do not add mutations, administrative
  tools, private-field exposure, or shared application credentials.
- Do not touch secrets, environment files, Cloudflare configuration, Auth0
  configuration, or production resources unless explicitly requested.
- Production deploys are manual and must use `pnpm run deploy` from a clean,
  synced `main` with green CI at the exact revision.
- Keep public routes anonymous and private routes audience-bound, user-scoped,
  and independently verified by the owning product.
- Run `pnpm check` after source, auth, route, listing, or monitoring changes.
- Track operational work in this repository's GitHub Issues and keep
  `PROJECT_STATUS.md` current when durable product truth changes.
