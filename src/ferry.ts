#!/usr/bin/env node
/**
 * ferry compare --models <a,b,c,...> --evals <path|dir> [options]
 * ferry compare --from <a> --to <b> --evals <path|dir> [options]   (2-model sugar)
 *
 * Runs an eval set across N models (any provider) and writes a markdown report
 * (ferry-report.md) plus optional JSON: a cost/quality/latency leaderboard with
 * the first model as the baseline others are compared against.
 *
 * Options:
 *   --traffic <req/mo>      monthly request volume for the cost projection (default 1e6)
 *   --concurrency <n>       cases evaluated in parallel (default 4)
 *   --judge <provider:model>  LLM-as-judge model (default from config, or claude-opus-4-8)
 *   --json                  also write ferry-report.json (machine-readable, for CI)
 *   --baseline <file>       fail if a model regresses vs a prior ferry-report.json
 *   --max-quality-drop <d>  allowed quality drop vs baseline (default 0.05)
 *   --max-cost-increase <f> allowed monthly-cost increase fraction vs baseline (default 0.25)
 *
 * Keys are read from each provider's env var (see ferry.config.json → providers).
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseArgs } from "node:util";
import {
  reqCost,
  scoreMatch,
  percentile,
  type Price,
  type Run,
  type Judged,
  type MatchType,
} from "./lib.ts";
import { resolveRef, callModel, judge, type ProviderCfg, type ModelRef } from "./providers.ts";

const MAX_TOKENS = 1024;
const MATCH_TYPES: MatchType[] = ["judge", "exact", "contains", "regex"];

type EvalCase = { id: string; prompt: string; expected?: string; match?: MatchType; suite?: string };

// ── args ──────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    to: { type: "string" },
    models: { type: "string" }, // comma-separated, 2+ (supersedes --from/--to)
    evals: { type: "string" },
    traffic: { type: "string", default: "1000000" },
    concurrency: { type: "string", default: "4" },
    judge: { type: "string" },
    json: { type: "boolean", default: false },
    baseline: { type: "string" },
    "max-quality-drop": { type: "string", default: "0.05" },
    "max-cost-increase": { type: "string", default: "0.25" },
  },
});

const USAGE =
  "usage: ferry compare --models <a,b,c> --evals <path|dir> [--traffic <req/mo>] [--concurrency <n>] [--judge <p:m>] [--json] [--baseline <file>]\n" +
  "       ferry compare --from <a> --to <b> --evals <path|dir> [...]";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (process.argv[2] !== "compare" || !values.evals) die(USAGE);

// model list: --models wins; else --from/--to
const modelArgs = values.models
  ? values.models.split(",").map((s) => s.trim()).filter(Boolean)
  : values.from && values.to
    ? [values.from, values.to]
    : [];
if (modelArgs.length < 2) die("Need at least 2 models (via --models a,b,c or --from a --to b).\n" + USAGE);

const traffic = Number(values.traffic);
if (!Number.isFinite(traffic) || traffic <= 0) die(`--traffic must be a positive number, got: ${values.traffic}`);
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency <= 0) die(`--concurrency must be a positive integer, got: ${values.concurrency}`);
const maxQualityDrop = Number(values["max-quality-drop"]);
const maxCostIncrease = Number(values["max-cost-increase"]);
if (!Number.isFinite(maxQualityDrop) || !Number.isFinite(maxCostIncrease)) die("--max-quality-drop and --max-cost-increase must be numbers");

// Read + parse JSON, tolerating a UTF-8 BOM (Windows editors / PowerShell
// `Set-Content` prepend one, and JSON.parse rejects it).
const readJson = (p: string | URL) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));

// ── config (providers + price map) ───────────────────────────────────────────
const config = readJson(new URL("../ferry.config.json", import.meta.url));
const providers: Record<string, ProviderCfg> = config.providers ?? {
  anthropic: { kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
};
const prices: Record<string, Price> = config.prices ?? {};
const judgeArg = values.judge ?? config.judge ?? "anthropic:claude-opus-4-8";

let refs: ModelRef[];
let judgeRef: ModelRef;
try {
  refs = modelArgs.map((m) => resolveRef(m, providers));
  judgeRef = resolveRef(judgeArg, providers);
} catch (e) {
  die((e as Error).message);
}

// prices required for every compared model (judge cost isn't projected)
const missingPrices = refs.filter((r) => !prices[r.ref]).map((r) => r.ref);
if (missingPrices.length)
  die(
    `No price in ferry.config.json for: ${missingPrices.join(", ")}\n` +
      `Add an { "input": <n>, "output": <n> } row (USD per 1M tokens) keyed by "provider:model".`,
  );

// ── evals (single file or a directory suite) ─────────────────────────────────
function loadEvals(p: string): EvalCase[] {
  const st = statSync(p);
  if (st.isDirectory()) {
    const files = readdirSync(p).filter((f) => f.toLowerCase().endsWith(".json")).sort();
    if (!files.length) die(`No .json eval files in directory: ${p}`);
    const all: EvalCase[] = [];
    for (const f of files) {
      const arr = readJson(join(p, f));
      if (!Array.isArray(arr)) die(`${f}: eval file must be a JSON array`);
      const suite = basename(f, ".json");
      for (const c of arr) all.push({ ...c, id: `${suite}/${c.id}`, suite });
    }
    return all;
  }
  const arr = readJson(p);
  if (!Array.isArray(arr)) die("Eval file must be a JSON array of { id, prompt, expected?, match? }.");
  return arr;
}
const cases: EvalCase[] = loadEvals(values.evals);
if (cases.some((c) => !c.id || !c.prompt)) die("Every eval case needs a non-empty `id` and `prompt`.");
const badMatch = cases.find((c) => c.match !== undefined && !MATCH_TYPES.includes(c.match));
if (badMatch) die(`Case "${badMatch.id}" has invalid match "${badMatch.match}". Use one of: ${MATCH_TYPES.join(", ")}.`);

// ── required API keys (only for providers actually used) ─────────────────────
const usedProviders = new Set(refs.map((r) => r.provider));
const needJudge = cases.some((c) => c.expected !== undefined && (c.match ?? "judge") === "judge");
if (needJudge) usedProviders.add(judgeRef.provider);
const missingKeys = [...new Set([...usedProviders].map((p) => providers[p].keyEnv))].filter((env) => !process.env[env]);
if (missingKeys.length) die(`Missing API key env var(s): ${missingKeys.join(", ")}`);

// ── run the matrix ────────────────────────────────────────────────────────────
type CaseResult = { c: EvalCase; runs: Run[]; scores: (Judged | undefined)[] };

async function evalCase(c: EvalCase): Promise<CaseResult> {
  const runs = await Promise.all(refs.map((r) => callModel(r, c.prompt, MAX_TOKENS)));
  const scores: (Judged | undefined)[] = new Array(refs.length).fill(undefined);
  if (c.expected !== undefined) {
    const match = c.match ?? "judge";
    await Promise.all(
      refs.map(async (_r, m) => {
        if (runs[m].error) return; // scoring an errored (empty) run is meaningless
        scores[m] =
          match === "judge"
            ? await judge(judgeRef, c.prompt, c.expected!, runs[m].output)
            : scoreMatch(match, c.expected!, runs[m].output);
      }),
    );
  }
  process.stderr.write(`· ${c.id}\n`);
  return { c, runs, scores };
}

// Bounded worker pool so a large eval set × many models doesn't fire everything
// at once. Results placed back by index to preserve report order.
const results: CaseResult[] = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= cases.length) return;
      results[i] = await evalCase(cases[i]);
    }
  }),
);

// ── aggregate per model ───────────────────────────────────────────────────────
const avg = (ns: number[]) => ns.reduce((a, b) => a + b, 0) / ns.length;

const perModel = refs.map((r, m) => {
  const runs = results.map((res) => res.runs[m]);
  const ok = runs.filter((x) => !x.error); // errored runs are holes, excluded from stats
  const price = prices[r.ref];
  const avgCost = ok.length ? avg(ok.map((x) => reqCost(x, price))) : NaN;
  const monthly = avgCost * traffic;
  const scoreVals = results
    .map((res) => res.scores[m])
    .filter((s): s is Judged => !!s)
    .map((s) => s.score)
    .filter(Number.isFinite);
  const avgScore = scoreVals.length ? avg(scoreVals) : NaN;
  const lats = ok.map((x) => x.latencyMs ?? NaN).filter(Number.isFinite);
  return {
    r,
    price,
    avgCost,
    monthly,
    avgScore,
    scoredN: scoreVals.length,
    meanLat: lats.length ? avg(lats) : NaN,
    p50: percentile(lats, 0.5),
    p95: percentile(lats, 0.95),
    nFail: runs.filter((x) => x.error).length,
    nTrunc: runs.filter((x) => x.truncated).length,
    inTok: ok.map((x) => x.inputTokens),
    outTok: ok.map((x) => x.outputTokens),
  };
});
const base = perModel[0];

// ── formatting ────────────────────────────────────────────────────────────────
const n = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const money = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : "n/a");
const microMoney = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(6)}` : "n/a");
const ms = (x: number) => (Number.isFinite(x) ? `${x.toFixed(0)} ms` : "n/a");
const delta = (x: number) => (Number.isFinite(x) ? (x >= 0 ? `+${n(x)}` : n(x)) : "n/a");
const spread = (ns: number[]) => (ns.length ? `${Math.min(...ns)} / ${avg(ns).toFixed(0)} / ${Math.max(...ns)}` : "n/a");
// Neutralize markdown/table-breaking chars in attacker-influenced strings.
const cell = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim();

const scoredCases = results.filter((res) => res.scores.some((s) => s));
const eyeball = results.filter((res) => res.c.expected === undefined);
const allFailures = results.filter((res) => res.runs.some((x) => x.error));
const allTrunc = results.filter((res) => res.runs.some((x) => x.truncated));

// ── report (markdown) ─────────────────────────────────────────────────────────
let md = `# Ferry migration report

**Baseline:** \`${base.r.ref}\` · **Compared:** ${refs.slice(1).map((r) => `\`${r.ref}\``).join(", ")}
**Eval set:** \`${values.evals}\` (${cases.length} cases) · **Traffic:** ${traffic.toLocaleString()} req/mo
**Judge:** \`${judgeRef.ref}\` · Generated ${new Date().toISOString()}

## Leaderboard

Deltas are versus the baseline (\`${base.r.ref}\`). Quality is the mean judged/matched score (0–1); cost is projected to \`--traffic\`.

| Model | Avg quality | Δ quality | Cost / req | Monthly | Δ monthly | Mean latency |
| --- | --- | --- | --- | --- | --- | --- |
`;
for (const pm of perModel) {
  const isBase = pm === base;
  md += `| \`${cell(pm.r.ref)}\` | ${n(pm.avgScore)} | ${isBase ? "— (base)" : delta(pm.avgScore - base.avgScore)} | ${microMoney(pm.avgCost)} | ${money(pm.monthly)} | ${isBase ? "— (base)" : money(pm.monthly - base.monthly)} | ${ms(pm.meanLat)} |\n`;
}
md += `\nQuality averaged over each model's scored cases (need \`expected\`; \`match: judge\` uses the LLM judge, \`exact\`/\`contains\`/\`regex\` are deterministic). Cost/latency over successful calls only.\n`;

if (allFailures.length || allTrunc.length) {
  md += `\n## ⚠️ Run health\n\n`;
  for (const pm of perModel) {
    if (pm.nFail || pm.nTrunc) {
      const bits = [];
      if (pm.nFail) bits.push(`${pm.nFail} failed call(s)`);
      if (pm.nTrunc) bits.push(`${pm.nTrunc} truncated at ${MAX_TOKENS} tokens`);
      md += `- \`${pm.r.ref}\`: ${bits.join(", ")}\n`;
    }
  }
  md += `\nFailed calls are excluded from all stats; truncated outputs understate quality and cost.\n`;
}

if (scoredCases.length) {
  md += `\n## Per-case quality\n\n| Case | ${refs.map((r) => `\`${cell(r.ref)}\``).join(" | ")} |\n| --- | ${refs.map(() => "---").join(" | ")} |\n`;
  for (const res of scoredCases) {
    const row = res.scores.map((s) => (s ? n(s.score) : "n/a"));
    md += `| \`${cell(res.c.id)}\` | ${row.join(" | ")} |\n`;
  }
}

if (eyeball.length) {
  md += `\n## Eyeball diff (no \`expected\` — compare outputs by hand)\n\n`;
  const fenced = (s: string) => {
    const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((mm) => mm.length));
    const f = "`".repeat(Math.max(3, longest + 1));
    return `${f}\n${s}\n${f}`;
  };
  for (const res of eyeball) {
    md += `### \`${cell(res.c.id)}\`\n\n> ${cell(res.c.prompt)}\n\n`;
    refs.forEach((r, m) => {
      md += `**${r.ref}:**\n\n${fenced(res.runs[m].output)}\n\n`;
    });
  }
}

md += `## Cost & latency table

Per-1M-token prices from \`ferry.config.json\`. Per-request cost uses this eval set's measured token counts; monthly cost extrapolates the **mean** request to \`--traffic\`.

> ⚠️ **Sanity-check before trusting the monthly delta.** This projection assumes the
> ${cases.length}-case eval set is representative of production traffic. Eval prompts skew
> short and clean; production skews long (system prompts, tool calls, retries, big
> contexts). If the token ranges below don't match your real traffic, the monthly
> figure can be off by a large multiple. Widen the eval set to tighten it.
> Non-Anthropic prices in the config are placeholders — verify them against your contract.

| Model | $/1M in | $/1M out | In tok (min/mean/max) | Out tok (min/mean/max) | Latency p50/p95 | Cost / req | Monthly @ ${traffic.toLocaleString()} |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;
for (const pm of perModel) {
  md += `| \`${cell(pm.r.ref)}\` | ${pm.price.input} | ${pm.price.output} | ${spread(pm.inTok)} | ${spread(pm.outTok)} | ${ms(pm.p50)} / ${ms(pm.p95)} | ${microMoney(pm.avgCost)} | ${money(pm.monthly)} |\n`;
}

if (scoredCases.length) {
  md += `\n## Judge / match notes\n\n`;
  for (const res of scoredCases) {
    const parts = refs.map((r, m) => `${r.ref}: ${res.scores[m] ? cell(res.scores[m]!.reason) || "—" : "n/a"}`);
    md += `- \`${cell(res.c.id)}\` — ${parts.join(" · ")}\n`;
  }
}

writeFileSync("ferry-report.md", md);

// ── JSON twin (for CI / baselines) ────────────────────────────────────────────
const j = (x: number) => (Number.isFinite(x) ? x : null);
const report = {
  models: refs.map((r) => r.ref),
  baseline: base.r.ref,
  evals: values.evals,
  traffic,
  judge: judgeRef.ref,
  generated: new Date().toISOString(),
  summary: perModel.map((pm) => ({
    model: pm.r.ref,
    quality: j(pm.avgScore),
    scored: pm.scoredN,
    costPerRequest: j(pm.avgCost),
    monthly: j(pm.monthly),
    latencyMs: { mean: j(pm.meanLat), p50: j(pm.p50), p95: j(pm.p95) },
    failures: pm.nFail,
    truncations: pm.nTrunc,
  })),
  cases: results.map((res) => ({
    id: res.c.id,
    suite: res.c.suite ?? null,
    expected: res.c.expected ?? null,
    match: res.c.expected !== undefined ? (res.c.match ?? "judge") : null,
    models: refs.map((r, m) => ({
      model: r.ref,
      output: res.runs[m].output,
      inputTokens: res.runs[m].inputTokens,
      outputTokens: res.runs[m].outputTokens,
      latencyMs: j(res.runs[m].latencyMs ?? NaN),
      truncated: res.runs[m].truncated,
      error: res.runs[m].error ?? null,
      score: res.scores[m] ? j(res.scores[m]!.score) : null,
      reason: res.scores[m]?.reason ?? null,
    })),
  })),
};
if (values.json) writeFileSync("ferry-report.json", JSON.stringify(report, null, 2));

console.error(`\nWrote ferry-report.md${values.json ? " + ferry-report.json" : ""}`);
for (const pm of perModel) {
  console.error(`  ${pm.r.ref}  quality=${n(pm.avgScore)}  monthly=${money(pm.monthly)}  p50=${ms(pm.p50)}`);
}

// ── baseline gate ─────────────────────────────────────────────────────────────
if (values.baseline) {
  let prev: typeof report;
  try {
    prev = readJson(values.baseline);
  } catch (e) {
    die(`--baseline: cannot read ${values.baseline}: ${(e as Error).message}`);
  }
  const prevByModel = new Map((prev.summary ?? []).map((s: any) => [s.model, s]));
  const violations: string[] = [];
  for (const pm of perModel) {
    const p: any = prevByModel.get(pm.r.ref);
    if (!p) continue;
    if (Number.isFinite(pm.avgScore) && typeof p.quality === "number") {
      const drop = p.quality - pm.avgScore;
      if (drop > maxQualityDrop)
        violations.push(`${pm.r.ref}: quality ${p.quality.toFixed(3)} → ${pm.avgScore.toFixed(3)} (drop ${drop.toFixed(3)} > ${maxQualityDrop})`);
    }
    if (Number.isFinite(pm.monthly) && typeof p.monthly === "number" && p.monthly > 0) {
      const inc = (pm.monthly - p.monthly) / p.monthly;
      if (inc > maxCostIncrease)
        violations.push(`${pm.r.ref}: monthly $${p.monthly.toFixed(2)} → $${pm.monthly.toFixed(2)} (+${(inc * 100).toFixed(0)}% > ${(maxCostIncrease * 100).toFixed(0)}%)`);
    }
  }
  if (violations.length) {
    console.error(`\nbaseline check FAILED (vs ${values.baseline}):`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.error(`\nbaseline check passed (vs ${values.baseline}).`);
}
