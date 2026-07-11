// Minimal assert-based checks for the money/parse/scoring paths. Run: npm test
import assert from "node:assert/strict";
import { parseJudge, reqCost, scoreMatch, percentile, redactSecrets, type Run } from "./lib.ts";

// ── parseJudge ────────────────────────────────────────────────────────────
assert.equal(parseJudge('{"score": 1, "reason": "ok"}').score, 1);
assert.equal(parseJudge('```json\n{"score": 0.5, "reason": "x"}\n```').score, 0.5, "strips fences");
assert.equal(parseJudge('here you go: {"score":0,"reason":"no"} thanks').score, 0, "extracts embedded json");
assert.equal(parseJudge('{"score": 5}').score, 1, "clamps above 1");
assert.equal(parseJudge('{"score": -3}').score, 0, "clamps below 0");
assert.ok(Number.isNaN(parseJudge("not json at all").score), "garbage -> NaN, no throw");
assert.ok(Number.isNaN(parseJudge('{"reason":"missing score"}').score), "no score -> NaN");

// ── reqCost ───────────────────────────────────────────────────────────────
const run = (i: number, o: number): Run => ({ output: "", inputTokens: i, outputTokens: o, truncated: false });
// 1M in @ $3 + 1M out @ $15 = $18
assert.equal(reqCost(run(1_000_000, 1_000_000), { input: 3, output: 15 }), 18);
// 500 in @ $1/1M + 100 out @ $5/1M = 0.0005 + 0.0005 = 0.001
assert.equal(reqCost(run(500, 100), { input: 1, output: 5 }), 0.001);
assert.equal(reqCost(run(0, 0), { input: 5, output: 25 }), 0, "zero tokens -> zero cost");

// ── scoreMatch ──────────────────────────────────────────────────────────────
assert.equal(scoreMatch("exact", "Canberra", "  Canberra  ").score, 1, "exact trims both sides");
assert.equal(scoreMatch("exact", "Canberra", "Sydney").score, 0, "exact mismatch -> 0");
assert.equal(scoreMatch("contains", "13.20", "The total is 13.20 dollars").score, 1, "contains substring");
assert.equal(scoreMatch("contains", "13.20", "no number here").score, 0, "contains miss -> 0");
assert.equal(scoreMatch("regex", "^(billing|tech)$", "billing").score, 1, "regex match");
assert.equal(scoreMatch("regex", "^\\d+$", "12a").score, 0, "regex non-match -> 0");
assert.ok(Number.isNaN(scoreMatch("regex", "(", "x").score), "invalid regex -> NaN, no throw");
// attacker-influenceable output is length-bounded before matching (no hang)
assert.equal(scoreMatch("contains", "x", "y".repeat(500_000)).score, 0, "oversized output handled");

// ── redactSecrets ─────────────────────────────────────────────────────────────
assert.ok(!redactSecrets("401 invalid key sk-ant-api03-ABCDEFGHIJKLMNOP more").includes("ABCDEFGHIJKLMNOP"), "redacts sk- keys by shape");
assert.equal(redactSecrets("leaked MYSUPERSECRETVALUE here", ["MYSUPERSECRETVALUE"]), "leaked *** here", "redacts known secret literal");
assert.ok(!redactSecrets("Authorization: Bearer abcdef1234567890ghijk").includes("abcdef1234567890"), "redacts bearer tokens");
assert.equal(redactSecrets("plain error, no secrets"), "plain error, no secrets", "leaves clean strings intact");

// ── percentile ────────────────────────────────────────────────────────────────
assert.equal(percentile([10, 20, 30, 40], 0.5), 30, "p50 nearest-rank");
assert.equal(percentile([10, 20, 30, 40], 0.95), 40, "p95");
assert.ok(Number.isNaN(percentile([], 0.5)), "empty -> NaN");

console.log("lib.test.ts: all assertions passed");
