// Pure, side-effect-free helpers — the money, parse, and scoring paths that
// must not silently corrupt the report. Kept separate from ferry.ts (which runs
// on import) so they can be unit-tested without hitting any API.

export type Price = { input: number; output: number };
export type Judged = { score: number; reason: string };
export type Run = {
  output: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean; // hit max_tokens — output and token counts are unreliable
  latencyMs?: number; // wall-clock for the call; absent on hand-built test runs
  error?: string; // API call failed; this run is a hole, not a data point
};

// Strip ```fences``` and pull the first JSON object out of judge output.
// Any failure yields a NaN score with the reason recorded — never throws.
export function parseJudge(raw: string): Judged {
  try {
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : cleaned);
    const score = Math.max(0, Math.min(1, Number(obj.score)));
    if (!Number.isFinite(score)) throw new Error("no numeric score");
    return { score, reason: String(obj.reason ?? "") };
  } catch (e) {
    return { score: NaN, reason: `judge parse failed: ${(e as Error).message}` };
  }
}

// Cost of one request in USD. Prices are per 1,000,000 tokens.
export function reqCost(run: Run, p: Price): number {
  return (run.inputTokens / 1e6) * p.input + (run.outputTokens / 1e6) * p.output;
}

// ── deterministic scoring ────────────────────────────────────────────────────
// Cases can opt out of the (paid, non-deterministic) LLM judge when there's a
// checkable answer. `exact`/`contains`/`regex` score 1 or 0 with no API call.
export type MatchType = "judge" | "exact" | "contains" | "regex";

// Bound the string we match against. The model output is attacker-influenceable,
// so a crafted output + a catastrophic-backtracking user regex could hang the
// run; clamping the length caps that work. (The regex itself comes from the
// user's own eval file — running as them — so this is defense-in-depth.)
export const MAX_MATCH_LEN = 100_000;

export function scoreMatch(match: MatchType, expected: string, output: string): Judged {
  const o = (output.length > MAX_MATCH_LEN ? output.slice(0, MAX_MATCH_LEN) : output).trim();
  const exp = expected.trim();
  switch (match) {
    case "exact":
      return o === exp
        ? { score: 1, reason: "exact match" }
        : { score: 0, reason: "no exact match" };
    case "contains":
      return o.includes(exp)
        ? { score: 1, reason: "output contains expected" }
        : { score: 0, reason: "expected substring not found" };
    case "regex":
      try {
        return new RegExp(exp).test(o)
          ? { score: 1, reason: "regex matched" }
          : { score: 0, reason: "regex did not match" };
      } catch (e) {
        return { score: NaN, reason: `invalid regex in eval: ${(e as Error).message}` };
      }
    default:
      // "judge" is handled by the LLM path in providers.ts, never here.
      return { score: NaN, reason: "judge scoring is handled by the model, not scoreMatch" };
  }
}

// Scrub API keys out of a string before it can land in the report/JSON/logs.
// Belt-and-suspenders for the one path where a secret could leak: an SDK error
// message. Replaces any known secret literal, plus common key/bearer shapes.
export function redactSecrets(s: string, secrets: string[] = []): string {
  let out = s;
  for (const sec of secrets) {
    if (sec && sec.length >= 8) out = out.split(sec).join("***");
  }
  return out
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, "sk-***")
    .replace(/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1***");
}

// Percentile of a numeric sample (nearest-rank on a sorted copy). Returns NaN
// for an empty sample so callers render "n/a" instead of a bogus 0.
export function percentile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}
