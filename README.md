# jev-model-router

Picks the model and the reasoning effort each task runs with, using [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's System One decision model: unstructured state in, a typed choice with a probability distribution out, no free-form text.

Two backends, chosen by whichever key is set:

| Backend | Endpoint | Model | Confidence |
|---|---|---|---|
| `typesafe` | `POST api.typesafe.ai/v1/systemone` | `jev-latest` | reported per answer |
| `gateway` | `POST ai-gateway.vercel.sh/v4/ai/evaluation-model` | `typesafe-ai/jev` | derived from an optional distribution |

TypeSafe's own API wins when both keys are set: it is the only one that reports a calibrated confidence, which is what the confidence bars below read. Set `provider` to force one, or to `builtin` to use neither. Each backend keeps its own URL and model option, so an override written for one is never sent to the other. A `provider` forced onto a backend whose key is missing degrades to the built-in classifier and says so once in the log.

Three switches, and they are not equally safe:

| Switch | What it sets | Default |
|---|---|---|
| `routeSubagentModel` | the model of each subagent, at `agent.spawn` | on |
| `routeMainEffort` | the reasoning effort of the main conversation, at `turn.step` | on |
| `routeMainModel` | the model of the main conversation, at `turn.step` | **off** |

A subagent starts with its own context, so routing its model costs nothing beyond the classification. Changing the main loop's *model* mid-session is the expensive one: it invalidates the prompt cache, and on a long context re-caching can cost more than the cheaper tier saves. Turn it on once you have measured your own sessions, not before.

The Agent tool has no effort parameter, so a subagent's effort is not this mod's to set.

**Both directions, both dimensions.** A task read as mechanical is routed down; one read as hard is routed up — model and effort alike.

The prompt is classified at `prompt.submit`, which runs before the turn starts, and the decision is applied to the turn's first model request and reused by the rest of that turn.

**With no key configured the mod still works**: it falls back to the engine's own `$.model.classify`, which answers the same question with the small fast model. That path reports no confidence, so the threshold does not apply to it.

## What it asks

One request, three questions evaluated in parallel:

- `tier` — a `choice` between three descriptions of the *work* (mechanical and local / ordinary engineering / hard or high-stakes). The decision model never sees a model name.
- `effort` — a `score` on a four-level rubric, for how much step-by-step reasoning the task needs.
- `risky` — whether the task touches production, money, credentials, or state that cannot be undone. A `noul` on TypeSafe's API, a `boolean` on the Gateway: the same question under two names.

## How it decides

TypeSafe's API reports a `confidence` per answer. The Gateway's answer shape carries **no `confidence` field**, so on that backend confidence is read as the highest probability in the distribution — and that distribution is itself optional in the schema, in which case confidence is absent and the threshold does not fire.

The two mistakes do not cost the same, so they do not clear the same bar:

- Spending **more** (a bigger model, more reasoning) needs `minUpgradeConfidence`, 0.3 by default. Being wrong costs money.
- Spending **less** needs `minDowngradeConfidence`, 0.6 by default. Being wrong means a task handled by too small a model or too little thought.
- A tier confidence under `unsureBelow`, 0.3 by default, means Jev does not know this task. It goes to the deep tier with `high` effort instead of staying where it was, past both bars, and never lowers an effort the session already has. `risky` takes precedence for the reason shown. A backend that reports no confidence is never "unsure". Set it to 0 to turn this off.
- `risky` above 0.7 takes the deep tier and real reasoning, past both bars. That one is not a confidence question.
- A backend that reports no confidence at all — the Gateway without a distribution, or the built-in classifier — may only move a request **up**. Spending less on an unmeasured hunch is the bad trade.
- A model id matching no tier, or a numeric effort (the caller's own scale), has no knowable direction: the model gets the gentler upgrade bar, and a numeric effort is left alone.

Every other failure — a non-2xx response, a timeout, a malformed body, a thrown error — leaves the request exactly as the engine built it. The router never blocks a turn.

A slash command with nothing after it (`/simplify`) is not classified: the decision model would see only the command's name, never what the command does. Its turn keeps the session's model and effort. With text after the name, the prompt is classified like any other.

## What you see in the transcript

With `logDecisions` on (the default), the router reports every step of its own
work, because nothing else in Claude Code shows it: the model and effort it
rewrites are parameters of each request, not the session's settings, so the
status line, the header and the effort box never move whatever it decides.

```
[jev-model-router] ready on typesafe (https://api.typesafe.ai/v1/systemone); routing subagent model, main effort
[jev-model-router] jev: tier fast (0.87) · effort 0.4 → low (0.71) · risky 0.02 · 249ms
[jev-model-router] main loop → effort low: fast (confidence 0.87)
[jev-model-router] jev: tier fast (0.41) · effort 0.4 → low (0.38) · risky 0.01 · 210ms
[jev-model-router] main loop: kept opus/medium, wanted haiku/low (confidence 0.41)
```

- The first line appears once per session, the first time a hook runs. It is
  the proof the module loaded and which backend answers it.
- A `jev:` line is what the decision model replied, before any policy is
  applied — the tier, the effort score and the risk, each with its confidence,
  and how long the call took.
- The line under it is what the policy then did. The last pair above is a
  working router declining to act: it wanted to spend less but did not clear
  `minDowngradeConfidence`.

It also keeps a one-line status on screen, replaced as it goes:

```
jev · fast 0.87 → haiku/low
jev · fast 0.41 · unchanged
```

`confidence n/d` means the backend reported no confidence, which the built-in
classifier never does and the Gateway does whenever its probability
distribution is absent; the `ready on` line says which one answered.

**No lines at all** has three causes, and only the last is the module failing
to load. Check them in this order:

1. **You ran `claude -p` (or the SDK).** A headless run has no transcript and
   no status row: every line still goes to the debug log,
   `~/.claude/debug/<session-id>.txt` (a `.txt`, not a `.log`; `latest` is a
   symlink to the newest), and an SDK host receives each one as `ui_log`. The
   router is working; look there.
2. **The plugin was never loaded.** Claude Code adopts a plugin from a
   project's `.claude/skills/` (where `--mod` writes it) only once the
   project is trusted: it is repository content, so an untrusted folder's
   `.claude/` is not read at all, and `claude -p` never asks. Open `claude`
   interactively in the folder and accept the trust prompt, or name the
   plugin explicitly with `--plugin-dir` (see Setup). `claude --debug`
   settles it: a loaded module prints
   `hooks module jev-model-router@skills-dir loaded (worker, …); events: prompt.submit,turn.step,agent.spawn`
   (`@inline` when loaded with `--plugin-dir`); `Found N plugins` without it
   means the plugin is not in the session.
3. **Claude Code is too old.** Mods are on by default from 2.1.287; on an
   older build the debug log says `installed plugins' hooks modules not
   loaded: rollout flag (tengu_plugin_hooks_modules) is off`. Update Claude
   Code.

A `ready on the built-in classifier, no key set` line when you did set a key
means the key sits under the wrong `pluginConfigs` entry: the key must match
the plugin's id, which depends on how it was loaded (see Options).

## Shadow log

With `shadowOpus` on (the default), every unsure prompt and a `shadowSampleRate` share (0.1) of the confident ones also get a background question to Opus: the same three tiers and the effort ladder, answered in two lines. Both answers are appended to the plugin's `$.store` under `shadow-log`, newest 300 kept, at most `shadowMaxPerHour` (6) calls an hour. It never changes a routing decision, never delays the turn, and every failure ends in a log line (`[jev-model-router] shadow: jev fast (0.21) vs opus deep → DISAGREE · unsure → deep`).

Each record holds a redacted 200-character summary of the prompt (credentials, long tokens and email addresses blanked), Jev's tier, confidence, effort and risk, Opus's tier and effort, whether the tiers agree, and whether the turn was escalated as unsure. The store is a JSON file for this plugin under the Claude Code configuration directory. It is evidence for tuning the thresholds later, not something the router reads back yet.

`/jev-shadow` prints the log as counts by Jev's tier confidence — how many records agree, disagree or got no tier from Opus in each bucket (`<0.30`, `0.30-0.49`, `0.50-0.69`, `0.70-0.89`, `>=0.90`, and `n/d` when the backend reported none), with the disagree share, then an `all` row. It reads the store only and calls no model.

## Dashboard

`/jev-dashboard` writes one self-contained HTML page (inline CSS, no scripts, no network, no prompt text) to `~/.claude/jev-model-router/dashboard.html` and opens it in the default browser (`open` on macOS, `xdg-open` on Linux). `/jev-dashboard no-open` only writes it. The page is a snapshot; run the command again to refresh.

The page opens with a short "What is this?" box, then a banner that answers "How is Jev doing?": Jev and Opus agree more often now, less often, about as often as before, or "too early to tell". It compares the older half of the checked prompts with the newer half (from 0.9.0) and needs 20 or more checked prompts and a 5-point change to call it. The wording is deliberate: more agreement is not proof that Jev learned anything, because Jev is TypeSafe's model and this router never trains it.

Below that, a line graph plots the share of checked prompts where Opus agreed with Jev for each day with checks, oldest on the left, so a rising line means Jev and Opus agree more often (from 0.9.1; it needs two days with checks, and hovering a point shows that day's counts).

Then, in order:

- "What happened today": plain sentences with the counts, and where the "not sure" line sits now.
- "Does Jev know when it is right?": checked prompts grouped by Jev's stated confidence, in bands such as "Under 30% sure" and "90% or more sure", each with the share Opus agreed with and a bar, and one sentence on whether "sure" means right.
- "Every day": the last 14 UTC days with prompts, those Jev was not sure about, those double-checked, the share Opus agreed with, and any change to the line. Days with no activity are hidden.
- "Does Jev learn from this?" (from 0.9.2): says plainly that it does not, that only the router's own "not sure" line adjusts itself, and what that line last did and why.
- A glossary, open by default. Collapsed: model switches (the newest 15), changes to the "not sure" line (the last ten) and a short small print.

Prompt counts come from per-day counters kept since 0.6.0 and cover prompts where Jev reported a confidence; the rest comes from the shadow log, which keeps the newest 300 records, so older days can be partial. "Opus agreed" is a second opinion, not proof that a cheaper model would have failed.

## Cache-aware switching

A model has its own prompt cache. A turn that moves to a model whose cache is cold re-sends the whole conversation as a cache write instead of a cache read, so a cheaper model can cost more for the turn it starts on. With `cacheAware` on (the default), a main-loop switch made to save money has to cost less than staying, over the next `cacheHorizonTurns` turns (3), with that rebuild counted. Otherwise the router keeps the current model, still sets the effort, and says why in the log: `kept balanced: switching to fast would cost $0.06 more over 3 turns (184k context, cache rebuild $0.15)`.

What it needs: the context size, read from the session's last response, and when each model last served a request, kept by the router. A cache counts as warm for `cacheTtlMinutes` (60) after its last use. Prices are in `hooks/cache.ts` (Haiku 5.5, Sonnet 5.5 and Opus 5.5, as published on 2026-10-06; Haiku's input price rises from $0.10 to $0.50 per million tokens above 100k tokens of prompt). A cache write costs 1.25 times the input price for a 5 minute cache and 2 times for a 1 hour one. Edit `PRICES` when the rates change.

Rules of thumb it follows: a context of `cacheSmallContext` tokens (20,000) or less always switches; an unknown size always switches; a move to a more capable model, such as an unsure turn sent to Opus, is made for quality and is not held back unless `cacheGateUpgrades` is on (the log notes what that turn costs extra); and with no cache warm anywhere, a switch to the cheaper write wins. Subagents are not affected, since they start with their own small context.

Every judged switch (the router wanted a different model than the session's) is recorded in `$.store` under `switch-log` (newest 100): when, the two tiers, the context size, whether it switched or kept the current model, and the sentence above. `/jev-dashboard` lists the newest 15 in its collapsed "Model switches" section. No prompt text is kept. Recorded from 0.8.1.

It is an estimate: output length is assumed (`cacheOutputTokens`, 1500), the horizon is a guess at how long a switch lasts, and the cache lifetime is assumed rather than read from the API.

## Auto-tune

With `autoTune` on (the default), the router may move `unsureBelow`, and only that, once per session at start. It reads the shadow log near the floor (0.15 either side), counting only records newer than its last move:

- **Raise by 0.05** when Opus rated more than 40% of at least 30 answers just *above* the floor at a higher tier than Jev did. Those turns stayed on a cheaper model and probably needed more. Raising wins if both rules fire.
- **Lower by 0.05** when Opus wanted the deep tier for under 30% of at least 30 answers just *below* the floor. Those turns were escalated to Opus for nothing.

Guards: the floor never leaves 0.15 to 0.50; moves are at least a day apart; a floor configured as 0 is never touched; a failing store keeps the configured floor. Every move is appended to `tune-audit` (newest 100) with the numbers behind it, and `/jev-shadow` prints the floor in force and the last five changes.

**Rollback.** The router counts, per UTC day, how many prompts it classified and how many escalated as unsure. If the escalation share over today and yesterday exceeds 1.5 times the share over the seven days before (with at least 20 recent prompts, 50 baseline and 5 escalations), and the floor was tuned in the last week, the tuned floor is dropped, the configured one returns, and tuning is frozen for seven days.

What this cannot do: the log does not record which model a turn ran on, so the upgrade and downgrade bars (`minUpgradeConfidence`, `minDowngradeConfidence`) are not tuned. Opus's rating is the only teacher, so it measures agreement with Opus, not whether a cheaper model would have done the job.

The shadow call only runs for main-loop prompts, and only while `routeMainEffort` or `routeMainModel` is on, because that is when the prompt is classified at all.

## Privacy

With a key set, the prompt text leaves the machine and goes to whichever backend the key belongs to. With `shadowOpus` on, the first 4000 characters of some prompts also go to Opus through the session's own client; turn it off to stop that. The main-loop path sends the prompt; the subagent path sends the subagent's prompt, its description and its agent type. Nothing else. With no key set, nothing leaves the machine.

## Options

```
  typesafeApiKey:         string  TypeSafe API key (preferred: it reports a confidence)
  gatewayApiKey:          string  Vercel AI Gateway key
  provider:               string  "auto" | "typesafe" | "gateway" | "builtin"
  typesafeBaseUrl:        string  empty uses https://api.typesafe.ai
  typesafeModel:          string  empty uses jev-latest
  gatewayBaseUrl:         string  empty uses https://ai-gateway.vercel.sh/v4/ai
  gatewayModel:           string  empty uses typesafe-ai/jev
  fastModel:              string  fast tier, alias or full id (default "haiku")
  balancedModel:          string  balanced tier, alias or full id (default "sonnet")
  deepModel:              string  deep tier, alias or full id (default "opus")
  minUpgradeConfidence:   number  bar to spend more (default 0.3)
  minDowngradeConfidence: number  bar to spend less (default 0.6)
  unsureBelow:            number  tier confidence under this goes deep (default 0.3, 0 = off)
  autoTune:               boolean let the router tune unsureBelow within guards (default true)
  cacheAware:             boolean keep the current model when a cheaper one would cost more once its cold cache is counted (default true)
  cacheSmallContext:      number  context tokens at or under which a switch is always allowed (default 20000)
  cacheHorizonTurns:      number  turns a switch must save money over (default 3)
  cacheTtlMinutes:        number  assumed cache lifetime after last use (default 60)
  cacheOutputTokens:      number  output tokens assumed per turn (default 1500)
  cacheGateUpgrades:      boolean also hold back moves to a more capable model (default false)
  shadowOpus:             boolean ask Opus in the background and log both answers (default true)
  shadowSampleRate:       number  share of confident prompts also shadowed (default 0.1)
  shadowMaxPerHour:       number  most shadow calls an hour (default 6)
  routeSubagentModel:     boolean model of each subagent (default true)
  routeMainEffort:        boolean effort of the main loop (default true)
  routeMainModel:         boolean model of the main loop (default false)
  timeoutMs:              number  latency budget per classification (default 800)
  logDecisions:           boolean log each decision (default true)
```

The three tiers take an alias (`haiku`, `sonnet`, `opus`) or a full model id.
A subagent is spawned with the name as given, the way the Agent tool takes it;
the main loop's request needs an id, so there an alias is resolved to the
family's current id (`haiku` → `claude-haiku-4-5-20251001`, `sonnet` →
`claude-sonnet-5`, `opus` → `claude-opus-5`). Set a full id to pin a
specific version. A decision for the tier the session already runs is not a
change, so a session on `claude-opus-5[1m]` keeps its 1M-context id.

Declared in `.claude-plugin/plugin.json` (`userConfig`). Set them in `/config`, in user settings (`~/.claude/settings.json`, not project settings), with `--settings <file>` or in managed settings:

```json
{ "pluginConfigs": { "jev-model-router@skills-dir": { "options": { "typesafeApiKey": "" } } } }
```

The entry's key is the plugin's id, and the id follows how the plugin was
loaded: `"jev-model-router@skills-dir"` when auto-loaded from `.claude/skills/`
(the `--mod` install), `"jev-model-router"` with `--plugin-dir`. Under the
wrong key every option stays at its default, and the `ready on` line reports
`no key set`.

## Setup

This copy ships in the [cockpit](../../README.md) marketplace together with Deck, which draws the router's decisions. From Claude Code:

```
/plugin marketplace add kevinCodeSavvy/cockpit
/plugin install jev-model-router@cockpit
```

Or install everything at once with `/plugin install cockpit@cockpit`.

1. Set the TypeSafe API key without printing it. Run this in your own terminal; the prompt hides what you paste:

   ```sh
   printf 'TypeSafe API key (hidden): '; read -rs K; echo
   printf '{"typesafeApiKey":"%s"}' "$K" | claude plugin configure jev-model-router@cockpit --values-stdin
   unset K
   ```

   The key is marked sensitive, so Claude Code keeps it out of `settings.json`. Never paste it into a chat or commit it. Without a key the mod falls back to the built-in classifier and no prompt leaves the machine; with one, the text of each prompt goes to `api.typesafe.ai`, so check that is acceptable before using it on work projects.

2. Optional: other options go in the same way, as one JSON object of single-line strings, for example `{"routeMainModel":"true"}`. `claude plugin configure jev-model-router@cockpit` lists every option and whether it is set.

   Until a key is set, the first session after install prints this command once in the transcript as a reminder (it never shows again, and not at all if you set a key or `provider` to `builtin`).

3. Quit and reopen Claude Code, start a new session, and look for `[jev-model-router] ready on typesafe` in the log. `/jev-shadow` and `/jev-dashboard` start empty and fill as you work.

To update later: `/plugin update jev-model-router@cockpit`, then restart.

## Tests

```sh
bun test cli-tool/components/mods/productivity/jev-model-router/tests
```

**Requirements.** Mods are on by default in Claude Code 2.1.287+. Typed against Anthropic's declarations: https://github.com/anthropics/claude-code/tree/main/mods

A mod runs without `node_modules`, so neither `@typesafe-ai/sdk` nor the AI SDK is available here: both backends are spoken to over HTTP through `$.http.fetch`. The TypeSafe wire shape was read from `@typesafe-ai/sdk` v0.6.0; the Gateway's, which is `experimental` in the AI SDK (`experimental_evaluate`, 7.0.105+) and not documented publicly, from `@ai-sdk/gateway` v4.0.86 and `@ai-sdk/provider` v4.0.17. Either may change.

## Credits

Started from the `jev-model-router` template in [davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) by Daniel (San) Ávila, used under its MIT license (see `LICENSE`, which keeps the original copyright notice). The unsure floor, Opus shadow log, `/jev-shadow` and `/jev-dashboard` commands, and guarded auto-tune were added on top by kevinCodeSavvy.
