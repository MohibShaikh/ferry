// Pure, side-effect-free helpers — the money and parse paths that must not
// silently corrupt the report. Kept separate from ferry.ts (which runs on
// import) so they can be unit-tested.

export type Price = { input: number; output: number };
export type Judged = { score: number; reason: string };
export type Run = {
  output: string;
  inputTokens: number;
  outputTokens: number;
  truncated: boolean; // hit max_tokens — output and token counts are unreliable
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
