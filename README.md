# ferry

A CLI that generates a **model-migration report** so a team can safely switch
LLM providers/models. You get a deprecation notice or want to cut cost — ferry
runs your eval set across a *source* and a *target* model and reports the
**quality delta** and **cost delta** as a markdown file you can hand to your team.

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

Or skip the global install and run on demand with `npx @mohibzz/ferry …`.

## Run

```bash
ferry compare --from claude-sonnet-4-6 --to claude-haiku-4-5 \
  --evals your-evals.json --traffic 500000
```

(Or `npx @mohibzz/ferry compare …` if you didn't install globally.)

Writes `ferry-report.md` in the current directory. `--traffic` is requests per
month (default `1000000`). A ready-to-run 3-case sample ships in the repo at
[`fixtures/sample.json`](fixtures/sample.json).

## Eval file schema

A JSON array of cases. Dead simple:

```json
[
  { "id": "capital", "prompt": "What is the capital of Australia?", "expected": "Canberra" },
  { "id": "rewrite", "prompt": "Rewrite this politely: ..." }
]
```

| field      | required | meaning                                                        |
| ---------- | -------- | -------------------------------------------------------------- |
| `id`       | yes      | short label, used in the report                                |
| `prompt`   | yes      | the user message sent to both models                           |
| `expected` | no       | reference answer. If present, ferry scores each model against it via LLM-as-judge. If absent, ferry just captures both outputs for an eyeball diff. |

A 3-case sample lives in [`fixtures/sample.json`](fixtures/sample.json) so it runs immediately.

## How it works

For each case, ferry calls the Anthropic Messages API **twice** — once for the
`--from` model, once for the `--to` model — capturing the output text and the
input/output token counts from `usage`.

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
npm test        # asserts on the money + judge-parse paths (src/lib.test.ts)
npm run typecheck
```

The pure, report-corrupting logic (`parseJudge`, `reqCost`) lives in `src/lib.ts`
so it's covered without hitting the API.

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

**Accepted risks (v0):**

- **`ANTHROPIC_API_KEY`** is read only from the environment and never written to
  the report or logs. Don't pass it on the command line (it lands in shell
  history / process list) — export it. If a key is ever exposed, rotate it.
- **`--evals` reads an arbitrary path** by design: ferry runs as you, on your own
  files. No sandboxing is attempted.
- **Wallet DoS** — a large eval file = proportional API spend. There is no cap or
  concurrency limit; keep eval sets sized to your budget.
- **Rendering the report** — treat `ferry-report.md` as containing untrusted
  content. Escaping covers tables/lists/fences; render it as plain markdown (no
  raw-HTML pass-through) if you publish it to a dashboard.

## Scope

v0. Anthropic models only, single-turn prompts, average-based monthly cost
projection. No retries/concurrency limits, no caching, no non-Anthropic
providers.
