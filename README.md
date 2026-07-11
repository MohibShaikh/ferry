# ferry

A CLI that generates a **model-migration report** so a team can safely switch
LLM providers/models. You get a deprecation notice or want to cut cost — ferry
runs your eval set across a *source* and a *target* model and reports the
**quality delta** and **cost delta** as a markdown file you can hand to your team.

![ferry demo — comparing two models and writing the report](https://raw.githubusercontent.com/MohibShaikh/ferry/master/assets/demo.gif)

## What ferry measures — and what it doesn't

Read this before you trust a run. Ferry reports two deltas, and they do **not**
have the same reach:

- **Cost delta — valid for any workload.** It's measured token spend (real
  input/output counts from the API `usage` object) extrapolated to your traffic.
  Trustworthy whether you run single prompts or full agents.
- **Quality delta — single-turn only.** Ferry scores one `prompt → response` per
  case with an LLM-as-judge. That measures **single-turn output quality**:
  classification, extraction, Q&A, summarization, rewriting — the tasks this tool
  is built for.

**Ferry does _not_ measure agentic, multi-step, or orchestration quality.** It
never runs a tool loop, never spans turns, never scores a trajectory. Two models
can post an *identical* quality delta here and still behave very differently as
agents — planning, delegating to sub-agents, recovering from errors, persisting
state over a long horizon. **A single-turn quality tie is not evidence of agent
parity.** If you're migrating an agent or workflow, you need a task-completion
eval (run the task to a graded outcome), not this tool. Ferry's *cost* delta
still applies to that workload; its *quality* delta does not.

## Install

```bash
npm i -g @mohibzz/ferry
```

Then set your API key. **macOS / Linux (bash/zsh):**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Windows (PowerShell):**

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

**Windows (cmd.exe):**

```bat
set ANTHROPIC_API_KEY=sk-ant-...
```

Or skip the global install and run on demand with `npx @mohibzz/ferry …`. The
`ferry compare …` command itself is identical on every OS — only the way you set
the environment variable above differs by shell.

## Run

Compare any number of models — the first is the **baseline** everything else is
measured against:

```bash
ferry compare --models claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 --evals your-evals.json --traffic 500000
```

The classic two-model form still works: `ferry compare --from A --to B --evals …`.
Writes `ferry-report.md` (a cost/quality/**latency** leaderboard) in the current
directory. A 3-case sample ships in the repo at [`fixtures/sample.json`](fixtures/sample.json).

### Providers — Claude, OpenAI, and open-source frontier models

Reference a model as `provider:model`. A bare id (no provider) means Anthropic,
so `claude-sonnet-5` == `anthropic:claude-sonnet-5`. Each provider reads its own
API key from an env var (see [`ferry.config.json`](ferry.config.json) → `providers`):

```bash
ferry compare --models anthropic:claude-opus-4-8,openai:gpt-5.5,deepseek:deepseek-chat,zhipu:glm-4.6 --evals evals.json
# needs ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, ZHIPU_API_KEY
```

Under the hood there are just two adapters: **Anthropic-native**, and
**OpenAI-compatible** (any `baseURL`). That second one covers OpenAI, DeepSeek,
Zhipu/GLM, Moonshot/Kimi, Qwen/DashScope, OpenRouter, Together, Groq, Fireworks,
and local **Ollama/vLLM** — add or edit providers in the config to point at any
endpoint that speaks the OpenAI Chat Completions format.

> ⚠️ Only the `anthropic:*` prices in the config are authoritative. **Every
> non-Anthropic price is a best-effort placeholder and will be stale — verify it
> against the provider before trusting a cost number.**

### Flags

| flag | default | meaning |
| --- | --- | --- |
| `--models` | — | comma-separated model ids, 2+ (first = baseline). Supersedes `--from`/`--to` |
| `--from` / `--to` | — | two-model sugar for `--models A,B` |
| `--evals` | — | path to an eval JSON **file, or a directory** of them (a suite) |
| `--traffic` | `1000000` | requests/month, for the monthly cost projection |
| `--concurrency` | `4` | cases evaluated in parallel |
| `--judge` | `anthropic:claude-opus-4-8` | LLM-as-judge model (any provider) |
| `--json` | off | also write `ferry-report.json` (machine-readable, for CI) |
| `--baseline <file>` | — | fail if a model regresses vs a prior `ferry-report.json` |
| `--max-quality-drop` | `0.05` | allowed quality drop vs baseline before failing |
| `--max-cost-increase` | `0.25` | allowed monthly-cost increase (fraction) vs baseline |

### Eval suites (a directory, not one file)

Point `--evals` at a directory and ferry runs every `*.json` in it as one suite,
namespacing case ids by file (`billing/refund`, `chat/greet`). Teams don't have
one eval file — they have "billing prompts," "extraction prompts," "chat prompts."

### Gate a migration in CI

`--json` emits raw numbers, and `--baseline` fails the build on regression:

```yaml
# .github/workflows/model-check.yml
name: model-migration check
on: [pull_request]
jobs:
  ferry:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      # save ferry-report.json once as ferry-baseline.json; commit it. Then:
      - run: npx @mohibzz/ferry compare --models claude-opus-4-8,claude-haiku-4-5 --evals evals/ --json --baseline ferry-baseline.json --max-quality-drop 0.05
        env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }
```

A non-zero exit (quality dropped or cost rose past the thresholds) fails the job.

## Eval file schema

A JSON array of cases. Dead simple:

```json
[
  { "id": "capital", "prompt": "Capital of Australia? One word.", "expected": "Canberra", "match": "contains" },
  { "id": "route",   "prompt": "Classify as billing/tech: ...",   "expected": "^billing$", "match": "regex" },
  { "id": "rewrite", "prompt": "Rewrite this politely: ..." }
]
```

| field      | required | meaning                                                        |
| ---------- | -------- | -------------------------------------------------------------- |
| `id`       | yes      | short label, used in the report                                |
| `prompt`   | yes      | the user message sent to every model                           |
| `expected` | no       | reference answer. If present, ferry scores each model against it. If absent, outputs are dumped for an eyeball diff. |
| `match`    | no       | how to score against `expected` (default `judge`): `judge` (LLM-as-judge, semantic), `exact`, `contains`, or `regex`. The non-`judge` matchers are **deterministic and free** — no API call — so use them for classification, extraction, and anything with a checkable answer. |

A 3-case sample lives in [`fixtures/sample.json`](fixtures/sample.json) so it runs immediately.

## How it works

For each case, ferry calls **every model** once (in parallel, across providers),
capturing the output text plus the input/output token counts and wall-clock
latency. Anthropic goes through the native SDK; everything else through an
OpenAI-compatible adapter.

### Judging (quality)

- If a case has `expected`, ferry makes an **LLM-as-judge** call (`claude-opus-4-8`)
  for *each* model's output, asking for `{ "score": 0-1, "reason": "..." }`.
  Scoring is semantic (equivalent answers score 1 even if worded differently).
- Judge parsing is defensive: fenced code blocks are stripped, the first `{...}`
  is extracted, `score` is clamped to `[0,1]`, and any failure yields a `NaN`
  score with the reason recorded rather than crashing the run.
- **Per-case quality delta** = `toScore − fromScore`. **Aggregate score change**
  = mean(toScore) − mean(fromScore) over scored cases (NaN scores are dropped
  from the average).
- Cases with no `expected` are not scored — both outputs are dumped side by side
  in the report for you to compare.

### Cost

Prices live in [`ferry.config.json`](ferry.config.json) as **USD per 1,000,000
tokens** — edit them to match your contract. If you compare a model with no
price row, ferry stops and tells you to add one.

```
cost(request)   = inputTokens/1e6 * price.input  +  outputTokens/1e6 * price.output
cost(per model) = average cost(request) across the eval set
monthly(model)  = cost(per model) * --traffic
cost delta      = monthly(to) − monthly(from)
```

### Read the cost delta carefully (representativeness)

The monthly figure is `mean per-request cost × --traffic`. **It is only as good as
your eval set.** Eval prompts skew short and clean; production skews long — system
prompts, tool calls, retries, large contexts. So a small eval set can make the
monthly delta confidently wrong by a large multiple, and it prints as a slick
dollar figure that *looks* authoritative. For a report whose job is to justify a
switch, that's the failure mode that burns you.

Ferry therefore **shows its work**: the cost table prints the input/output token
`min/mean/max` it extrapolated from, and the report carries an inline warning to
sanity-check that spread against real traffic. Before you hand the report to
anyone, look at the token ranges — if they don't resemble your production
distribution, widen the eval set until they do. The dollar delta is a hypothesis
to validate, not a quote.

## The deliverable

`ferry-report.md` contains: a summary table (quality + cost delta), per-case
quality deltas, eyeball diffs for unscored cases, the full cost table, and the
judge's reasoning notes. That markdown is the thing you sell.

## Robustness

A migration report is worthless if one flaky API call throws it away. Ferry
isolates failures per case:

- **A failed model call never crashes the run.** It's recorded as a hole and
  listed under a "Run health" section; the report still generates from the cases
  that succeeded. Failed calls are excluded from cost and quality stats (they show
  `n/a`, not a misleading `$0` or `0.0`).
- **Truncation is surfaced.** If a model hits the `max_tokens` cap, that case is
  flagged — its output was cut off, so its quality score and token/cost numbers
  understate reality.
- **Quality shows its denominator.** The summary says "averaged over N/M cases",
  so a run where half the judge calls failed can't masquerade as a confident score.

## Tests

```bash
npm test        # asserts money, judge-parse, scoring, percentile, redaction paths
npm run typecheck
```

The pure, report-corrupting logic (`parseJudge`, `reqCost`, `scoreMatch`,
`percentile`, `redactSecrets`) lives in `src/lib.ts` so it's covered without
hitting any API. Providers live in `src/providers.ts`, orchestration in `src/ferry.ts`.

## Security

The report is attacker-influenceable: an eval `prompt` steers what the compared
models emit, and that output flows into both the judge and the markdown. Ferry
was reviewed and hardened against that trust boundary.

**Fixed:**

- **Judge prompt injection** — model output is fenced in `<model_output>` tags and
  the judge is told to grade it as data, not obey instructions inside it. Stops a
  crafted prompt from inflating its own score in the report you sell.
- **Markdown/table injection** — case ids and judge reasons are escaped (`|`,
  newlines) before landing in tables and list items, so output can't forge or
  break rows.
- **Code-fence breakout** — eyeball-diff fences are sized longer than any backtick
  run in the output, so model text containing ` ``` ` can't escape its code block.
- **Defensive judge parsing** — fences stripped, first `{...}` extracted, score
  clamped, failures degrade to a recorded `NaN` instead of crashing.
- **Secret redaction (v0.3)** — API errors flow into the report/JSON, so any key
  or `Authorization: Bearer` token in an SDK error string is scrubbed (known key
  literal + `sk-…`/bearer shapes) before it can be written anywhere.
- **ReDoS bound (v0.3)** — `match: regex` runs a user regex against model output;
  the matched string is length-capped (100 KB) so a crafted output can't hang the
  run.

**Accepted risks / trust boundaries:**

- **Keys are sent to each provider's `baseURL`.** A provider's API key is
  transmitted only to the `baseURL` in its config entry — but a **tampered config**
  (supply-chain, or a careless "add this proxy") could redirect a key to a hostile
  host. Only add providers/base URLs you trust; the config is as sensitive as the
  keys it routes.
- **API keys** are read only from env vars, never written to the report or logs.
  Don't pass them on the command line (they land in shell history / process list).
  If a key is ever exposed, rotate it.
- **`--evals` reads an arbitrary path/dir** by design: ferry runs as you, on your
  own files. No sandboxing.
- **Wallet DoS scales with `cases × models`.** N models multiplies spend; there's a
  `--concurrency` throttle but no hard cost cap. Size eval sets and model lists to
  your budget.
- **Rendering the report** — treat `ferry-report.md` as untrusted content.
  Escaping covers tables/lists/fences; render it as plain markdown (no raw-HTML
  pass-through) if you publish it to a dashboard.

## Scope

v0.3. **Quality axis is single-turn only** (see the top of this README) —
multi-step/agentic quality is out of scope by construction. Cost is an
average-based monthly projection with no prompt-caching model. Providers: Anthropic
native + any OpenAI-compatible endpoint. Non-Anthropic prices are placeholders to
verify.
