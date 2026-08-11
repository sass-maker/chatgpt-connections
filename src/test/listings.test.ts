import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { HOSTED_ROUTES } from "../hosted.js";

interface Listing {
  id: string;
  logo: string;
  mcpUrl: string;
  oauthResource?: string;
  challengeSecret: string;
  starterPrompts: string[];
  reviewFixture?: string;
  tests: {
    positive: Array<{ expectedResult?: string; expectedTool?: string; prompt?: string }>;
    negative: Array<{ expectedBehavior?: string; prompt?: string; reason?: string }>;
  };
  website: string;
  support: string;
  privacy: string;
  terms: string;
}

test("all seven public listing packages are complete and independently verifiable", async () => {
  const path = new URL("../../docs/listings/plugins.json", import.meta.url);
  const manifest = JSON.parse(await readFile(path, "utf8")) as { plugins: Listing[] };
  assert.equal(manifest.plugins.length, 7);

  const ids = new Set<string>();
  const hosts = new Set<string>();
  const challenges = new Set<string>();
  for (const listing of manifest.plugins) {
    assert.equal(ids.has(listing.id), false);
    ids.add(listing.id);
    assert.ok(listing.starterPrompts.length >= 3);
    assert.equal(listing.tests.positive.length, 5);
    assert.equal(listing.tests.negative.length, 3);
    for (const evaluation of listing.tests.positive) {
      assert.ok(evaluation.prompt?.trim());
      assert.ok(evaluation.expectedTool?.trim());
      assert.ok(evaluation.expectedResult?.trim());
    }
    for (const evaluation of listing.tests.negative) {
      assert.ok(evaluation.prompt?.trim());
      assert.ok(evaluation.expectedBehavior?.trim());
      assert.ok(evaluation.reason?.trim());
    }
    assert.match(listing.logo, /^assets\/[a-z0-9-]+\.png$/u);
    const logo = await readFile(new URL(`../../docs/listings/${listing.logo}`, import.meta.url));
    assert.ok(logo.byteLength > 0);
    for (const value of [listing.website, listing.support, listing.privacy, listing.terms]) {
      assert.equal(new URL(value).protocol, "https:");
    }

    const url = new URL(listing.mcpUrl);
    assert.equal(hosts.has(url.hostname), false);
    hosts.add(url.hostname);
    assert.equal(challenges.has(listing.challengeSecret), false);
    challenges.add(listing.challengeSecret);

    const route = HOSTED_ROUTES[url.pathname];
    assert.ok(route);
    assert.equal(route.id, listing.id);
    assert.deepEqual(route.hosts, [url.hostname]);
    assert.equal(route.challengeSecret, listing.challengeSecret);
    assert.equal(route.oauthAudience, listing.oauthResource);
    if (route.audience === "personal") assert.ok(listing.reviewFixture?.trim());
  }
});
