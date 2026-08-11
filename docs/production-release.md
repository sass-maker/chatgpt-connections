# Production release receipt

Date: 2026-08-12

## Released revisions

| Surface | Git revision | Release evidence |
| --- | --- | --- |
| Reader | `fc2c3bbd4b257f9c6b6269cb08827c76541cbdd9` | Main deployment workflow `31520305026` passed |
| Calorie | `27979c99d836add2d434526b5e0befa5b23e8fe8` | Worker version `d6dafac8-2f2e-4acd-af69-f46ff60ab919` |
| Anime List | `22a8ecf02539fa1f509fa98e640d29cdb959aed6` | Worker version `42b0967a-168e-4cfe-b9db-c42c30e2ec38` |
| ChatGPT Connections | `1a9bf04f2d80a4f8d1e2af931078153c1dc2bb58` | Worker version `ea6406e6-489e-4614-a387-76046559134e` at 100% traffic; main CI `31526125176` passed |

Every Worker release above was made from a clean, synced `main`. The tagged
gateway revision serves the seven MCP URLs recorded in
[`listings/plugins.json`](listings/plugins.json). Setline was not attached to a
public custom domain.

## Live acceptance

- Seven of seven branded `/health` probes returned HTTP 200.
- Four of four anonymous plugins initialized, listed only read-only tools, and
  completed one representative bounded tool call.
- The executable public submission preflight passed all 32 listing cases: five
  positive and three negative protocol cases for each anonymous plugin. The
  redacted receipt retained only case/tool/result-shape metadata.
- Three of three personal plugins returned isolated HTTP 401 OAuth challenges;
  all protected-resource documents advertised the exact canonical audience,
  single read scope, and Auth0 issuer.
- The branded verifier passed Auth0 discovery, RS256 JWKS, gateway discovery,
  and every published private protected-resource document.
- Wrong-host routing returned 404; credentials on a public route returned 401;
  and an invented mutation tool failed as unknown.
- Seven of seven OpenAI challenge URLs fail closed with 404 before portal
  challenge values are issued.

## Publication boundary

The deployable MCPs and portal worksheets are complete. Directory publication
is not automatic: OpenAI must create each draft and challenge value, receive
reviewer credentials for the three OAuth plugins, review each submission, and
approve it before the publisher can make it public. Challenge values and demo
credentials must remain in Cloudflare/OpenAI, never in git.

The 32-case protocol pass does not replace ChatGPT prompt-level testing or the
three authenticated private suites. Those remain explicit manual gates until a
browser-controlled owner session and a dedicated non-owner Google reviewer
account are available.
