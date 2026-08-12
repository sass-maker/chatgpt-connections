# OpenAI plugin listing packages

`plugins.json` is the source-of-truth worksheet for the thirteen MCP-only
plugin submissions. It contains the portal copy, branded endpoint, existing
product logo, starter prompts, five positive tests, three negative tests, legal
URLs, support URL, availability, release notes, and the per-host challenge
binding name.

The JSON is not an OpenAI upload format. Copy each record into a separate
**With MCP → Universal** draft in the OpenAI Platform. Never put reviewer
credentials or challenge token values in this repository. Private reviewer
credentials belong only in the portal; challenge tokens belong only in the
matching Cloudflare Worker secret.

Each plugin has a unique hostname because OpenAI requires one exact plaintext
token at `/.well-known/openai-apps-challenge` for each MCP submission. The
gateway returns 404 until the matching `OPENAI_CHALLENGE_*` binding exists.

The first seven entries describe the live initial release. The six expansion
entries are code-complete listing packages but must not be represented as live
until their branded routes are deployed and verified.

Setline and local CodeVetter are intentionally absent. Setline remains deferred;
CodeVetter's local repository MCP stays Codex-only. See
[`../non-ios-eligibility.md`](../non-ios-eligibility.md) for the reviewed status
of every maintained non-iOS product.
