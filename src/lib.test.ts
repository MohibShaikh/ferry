// Minimal assert-based checks for the money/parse paths. Run: npm test
import assert from "node:assert/strict";
import { parseJudge, reqCost, type Run } from "./lib.ts";

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

console.log("lib.test.ts: all assertions passed");
