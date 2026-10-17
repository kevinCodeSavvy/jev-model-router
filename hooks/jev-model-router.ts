/**
 * jev-model-router — Claude Mod
 *
 * Picks the model each task runs on with TypeSafe's Jev, a System One
 * decision model: unstructured state in, a typed choice with a probability
 * distribution out.
 *
 * Jev is reached one of two ways, whichever key is configured: TypeSafe's
 * own API (`typesafeApiKey`), which reports a calibrated confidence per
 * answer, or the Vercel AI Gateway (`gatewayApiKey`), which does not. With
 * neither, the engine's own `$.model.classify` stands in, so the mod is
 * useful without any account.
 *
 * Three things it can set, each on its own switch:
 *   agent.spawn  — the model of each subagent (on by default)
 *   turn.step    — the reasoning effort of the main loop (on by default)
 *   turn.step    — the model of the main loop (off by default: switching
 *                  models mid-session invalidates the prompt cache, which can
 *                  cost more than the cheaper tier saves)
 *
 * Every one of them moves in both directions: a task the decision model reads
 * as mechanical is routed down, one it reads as hard is routed up. The two
 * mistakes do not cost the same, so they do not clear the same confidence bar
 * (see `minUpgradeConfidence` / `minDowngradeConfidence` in policy.ts).
 *
 * A decision whose tier confidence is under `unsureBelow` is treated as "does
 * not know this one": the task goes to the deep tier with real reasoning rather
 * than staying where it was.
 *
 * `/jev-dashboard` writes a local HTML page of the daily stats and opens it.
 * `/jev-shadow` prints the shadow log's agree/disagree counts by confidence,
 * then the floor in force and the last tuning changes.
 *
 * Auto-tune (`autoTune`): once per session the floor may move one 0.05 step,
 * inside 0.15-0.50, on 30+ fresh records near it and at most once a day; a
 * jump in how often turns escalate rolls it back and freezes it for a week.
 * Every change is kept in `tune-audit`. See tune.ts.
 *
 * Shadow log (`shadowOpus`): for every unsure prompt, and a sample of the
 * confident ones, Opus is asked the same tier question in the background and
 * both answers are kept in `$.store` under `shadow-log`. It changes no routing.
 * Only a redacted 200-character summary of the prompt is stored, but the prompt
 * itself (first 4000 characters) goes to Opus through the session's own client.
 *
 * The Agent tool has no effort parameter, so a subagent's effort is not ours
 * to set; only its model is.
 *
 * The prompt is classified at `prompt.submit`, which runs before the turn
 * starts, and the decision is applied at the turn's first request.
 *
 * Every failure path is fail-open: a classification that errors or runs past
 * the latency budget leaves the request exactly as the engine built it.
 *
 * The API key comes from the plugin's options (userConfig "typesafeApiKey"
 * or "gatewayApiKey"). Never hardcode it in this file.
 *
 * Needs Claude Code >= 2.1.287. Typed
 * against Anthropic's declarations: https://github.com/anthropics/claude-code/tree/main/mods
 *
 * Privacy: with a key set, the prompt text is sent to whichever backend the
 * key belongs to.
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  DEFAULT_BASE_URL,
  effortLevel,
  DEFAULT_MODEL,
  describeDecision,
  describeSetup,
  describeStatus,
  endpoint,
  isUnsure,
  pendingDecisions,
  readDecision,
  selectProvider,
  requestBody,
  requestHeaders,
  requestModelId,
  route,
  TIER_ORDER,
  bareCommand,
} from './policy.ts'
import type { Decision, Effort, PolicyConfig, Provider, Tier } from './policy.ts'
import {
  appendRecord,
  buildRecord,
  describeShadow,
  formatShadowReport,
  readLog,
  readShadowReply,
  SHADOW_KEY,
  shadowLimiter,
  shadowRequest,
  wantsShadow,
} from './shadow.ts'
import { DEFAULT_CACHE_SETTINGS, judgeSwitch, tierOfModel } from './cache.ts'
import type { LastUsed } from './cache.ts'
import { buildDashboard } from './dashboard.ts'
import { appendSwitch, readSwitches, SWITCH_KEY } from './switchlog.ts'
import { hintShown, KEY_HINT_KEY, keyHintText } from './keyhint.ts'
import {
  appendAudit,
  applyEntry,
  clampFloor,
  describeEntry,
  effectiveFloor,
  formatTuneReport,
  proposeMove,
  readAudit,
  readState,
  readStats,
  recordPrompt,
  shouldRollBack,
  TUNE_AUDIT_KEY,
  TUNE_STATE_KEY,
  TUNE_STATS_KEY,
} from './tune.ts'
import type { AuditEntry } from './tune.ts'

const DASHBOARD_FILE = 'jev-model-router/dashboard.html'

/** The program that opens a file in the default browser, by `uname`, or null. */
function openerFor(uname: string): string | null {
  const system = uname.trim().toLowerCase()
  return system === 'darwin' ? 'open' : system === 'linux' ? 'xdg-open' : null
}

// The floor to route on right now: the tuned one the commands module keeps
// in the store, or the configured one when tuning is off, unset, or the
// store cannot be read.
async function currentFloor(
  $: EngineInterface,
  configuredFloor: number,
  autoTune: boolean,
): Promise<number> {
  if (!autoTune) return configuredFloor
  try {
    return effectiveFloor(configuredFloor, readState(await $.store.get(TUNE_STATE_KEY)), true)
  } catch {
    return configuredFloor
  }
}

/**
 * Rolls tuning back if escalations spiked, else moves the floor one step if
 * the shadow log earns it, writing the state and the audit trail. Any
 * failure leaves the stored state as it was.
 */
async function tuneAtStart(
  $: EngineInterface,
  configuredFloor: number,
  autoTune: boolean,
  logDecisions: boolean,
): Promise<void> {
  if (!autoTune || configuredFloor <= 0) return
  try {
    const now = await $.clock.now()
    let state = readState(await $.store.get(TUNE_STATE_KEY))
    let trail = readAudit(await $.store.get(TUNE_AUDIT_KEY))
    const spike = shouldRollBack(readStats(await $.store.get(TUNE_STATS_KEY)), state, now)
    const entry: AuditEntry | null =
      spike !== null && state.value !== null
        ? { at: now, action: 'rollback', from: clampFloor(state.value), to: configuredFloor, reason: spike }
        : proposeMove(
            readLog(await $.store.get(SHADOW_KEY)),
            effectiveFloor(configuredFloor, state, true),
            state,
            now,
          )
    if (!entry) return
    state = applyEntry(state, entry)
    trail = appendAudit(trail, entry)
    await $.store.set(TUNE_STATE_KEY, state)
    await $.store.set(TUNE_AUDIT_KEY, trail)
    if (logDecisions) $.ui.log(`[jev-model-router] tune: ${describeEntry(entry)}`)
  } catch (error) {
    $.ui.log(`[jev-model-router] tune failed, keeping the configured floor: ${String(error)}`)
  }
}

/**
 * Writes the dashboard page under ~/.claude and opens it in the default
 * browser, unless `args` is `no-open`. Resolves the line the command prints.
 */
async function showDashboard(
  $: EngineInterface,
  configuredFloor: number,
  autoTune: boolean,
  args: string,
): Promise<string> {
  const html = buildDashboard({
    now: await $.clock.now(),
    configured: configuredFloor,
    autoTune,
    state: readState(await $.store.get(TUNE_STATE_KEY)),
    trail: readAudit(await $.store.get(TUNE_AUDIT_KEY)),
    stats: readStats(await $.store.get(TUNE_STATS_KEY)),
    log: readLog(await $.store.get(SHADOW_KEY)),
    switches: readSwitches(await $.store.get(SWITCH_KEY)),
  })

  const home = await $.process
    .run(['printenv', 'HOME'])
    .then((result) => result.stdout.trim())
    .catch(() => '')
  const path = `${home ? `${home}/.claude` : '/tmp'}/${DASHBOARD_FILE}`
  await $.fs.write(path, html)

  if (args.trim() === 'no-open') return `Dashboard written to ${path}`
  const system = await $.process
    .run(['uname'])
    .then((result) => result.stdout)
    .catch(() => '')
  const opener = openerFor(system)
  if (!opener) return `Dashboard written to ${path}. Open that file in a browser.`
  const opened = await $.process.run([opener, path]).catch(() => null)
  return opened && opened.exitCode === 0
    ? `Dashboard opened in your browser: ${path}`
    : `Dashboard written to ${path}, but the browser did not open. Open that file yourself.`
}

export const register: Register = (on, options) => {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback

  // TypeSafe's own API is preferred when both keys are set: it is the only
  // one that reports a calibrated confidence, which the policy's threshold
  // reads. `provider` forces one, including "builtin" to use neither.
  const typesafeKey = text('typesafeApiKey', '')
  const gatewayKey = text('gatewayApiKey', '')
  const forced = text('provider', 'auto')
  const active: Provider | null = selectProvider(forced, typesafeKey, gatewayKey)

  // Each backend keeps its own URL and model, so an override written for one
  // can never be sent to the other when `auto` picks differently than expected.
  const apiKey = active === 'typesafe' ? typesafeKey : active === 'gateway' ? gatewayKey : ''
  const modelId = !active
    ? ''
    : active === 'typesafe'
      ? text('typesafeModel', DEFAULT_MODEL.typesafe)
      : text('gatewayModel', DEFAULT_MODEL.gateway)
  const url = !active
    ? ''
    : active === 'typesafe'
      ? endpoint('typesafe', text('typesafeBaseUrl', DEFAULT_BASE_URL.typesafe))
      : endpoint('gateway', text('gatewayBaseUrl', DEFAULT_BASE_URL.gateway))

  // A backend named in the options but missing its key degrades to the
  // built-in classifier, which is silent; say so once, when a hook first runs.
  let unusableReported = forced === 'auto' || forced === 'builtin' || active !== null

  const timeoutMs = number('timeoutMs', 800)
  const routeSubagentModel = flag('routeSubagentModel', true)
  const routeMainEffort = flag('routeMainEffort', true)
  const routeMainModel = flag('routeMainModel', false)
  const routeMainLoop = routeMainEffort || routeMainModel
  const logDecisions = flag('logDecisions', true)

  const policy: PolicyConfig = {
    tiers: {
      fast: text('fastModel', 'haiku'),
      balanced: text('balancedModel', 'sonnet'),
      deep: text('deepModel', 'opus'),
    },
    minUpgradeConfidence: number('minUpgradeConfidence', 0.3),
    minDowngradeConfidence: number('minDowngradeConfidence', 0.6),
    unsureBelow: number('unsureBelow', 0.3),
  }

  const shadowOpus = flag('shadowOpus', true)
  const shadowSampleRate = number('shadowSampleRate', 0.1)
  // A few an hour: each one is a real Opus call on the user's own account.
  const shadowBudget = shadowLimiter(number('shadowMaxPerHour', 6), 60 * 60 * 1000)
  // The floor as configured, which tuning moves away from and a rollback
  // returns to. `policy.unsureBelow` is what runs, and tuning rewrites it.
  const configuredFloor = policy.unsureBelow ?? 0
  const autoTune = flag('autoTune', true)

  // Cache awareness: a main-loop switch made to save money has to cost less
  // than staying once the new model's cold cache is counted. See cache.ts.
  const cacheAware = flag('cacheAware', true)
  const cacheSettings = {
    smallContext: number('cacheSmallContext', DEFAULT_CACHE_SETTINGS.smallContext),
    horizonTurns: number('cacheHorizonTurns', DEFAULT_CACHE_SETTINGS.horizonTurns),
    ttlMinutes: number('cacheTtlMinutes', DEFAULT_CACHE_SETTINGS.ttlMinutes),
    outputTokens: number('cacheOutputTokens', DEFAULT_CACHE_SETTINGS.outputTokens),
    gateUpgrades: flag('cacheGateUpgrades', DEFAULT_CACHE_SETTINGS.gateUpgrades),
  }
  // Input tokens of the last response, and when each model last served one.
  let contextTokens: number | null = null
  const lastUsed: LastUsed = {}

  // Store writes go one at a time: two overlapping read-modify-writes of the
  // same key would drop one of them.
  let storeWrites: Promise<void> = Promise.resolve()
  const enqueue = (write: () => Promise<void>): Promise<void> => {
    // The caller sees this write's own failure; the chain carries on past it.
    const run = storeWrites.then(write)
    storeWrites = run.catch(() => undefined)
    return run
  }

  // The classification waiting for the turn that reads its prompt, and what
  // the current turn settled on. Both are single slots: main-loop turns run
  // one at a time, so nothing accumulates over a long session. `pending`
  // reports no decision when two prompts are waiting at once, rather than
  // routing a turn on a decision made for a different prompt.
  const pending = pendingDecisions()
  // Said once, the first time a hook runs. A router that loaded and one that
  // never loaded are otherwise told apart only by the absence of later lines,
  // and absence is not evidence: the policy leaves most turns alone anyway.
  let announced = false
  let appliedTurnId: string | undefined
  let applied: { model?: string; effort?: Effort } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev-shadow',
      description: 'Show how often Opus agreed with Jev, by Jev confidence',
    })
    await $.command.register({
      name: 'jev-dashboard',
      description: "Open a local page with the router's daily stats at each step",
    })
    await tuneAtStart($, configuredFloor, autoTune, logDecisions)
    // Once, and only for someone with no key: how to add one. Never blocks the session.
    if (!typesafeKey && !gatewayKey && forced !== 'builtin') {
      try {
        if (!hintShown(await $.store.get(KEY_HINT_KEY))) {
          await $.store.set(KEY_HINT_KEY, true)
          $.ui.log(keyHintText())
        }
      } catch {
        // a store that cannot be read or written: skip the hint rather than repeat it every session
      }
    }
    return next(e)
  })

  on('command.run', { command: 'jev-shadow' }, async ($) => {
    try {
      const report = formatShadowReport(readLog(await $.store.get(SHADOW_KEY)))
      const tuning = formatTuneReport(
        configuredFloor,
        readState(await $.store.get(TUNE_STATE_KEY)),
        readAudit(await $.store.get(TUNE_AUDIT_KEY)),
        autoTune,
        await $.clock.now(),
      )
      return { text: `${report}\n\n${tuning}` }
    } catch (error) {
      return { text: `jev-shadow: could not read the shadow log (${String(error)})` }
    }
  })

  on('command.run', { command: 'jev-dashboard' }, async ($, e) => {
    try {
      return { text: await showDashboard($, configuredFloor, autoTune, e.args) }
    } catch (error) {
      return { text: `jev-dashboard: could not build the page (${String(error)})` }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[jev-model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }
    if (!routeMainLoop) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[jev-model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    // A slash command alone gives the decision model only the command's name.
    // Its turn keeps the session's model and effort; the null put keeps a
    // previous prompt's decision from reaching it.
    if (bareCommand(e.text)) {
      if (logDecisions) $.ui.log('[jev-model-router] a command with nothing after it; leaving the turn alone')
      pending.put(null)
      return next(e)
    }

    policy.unsureBelow = await currentFloor($, configuredFloor, autoTune)
    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(active, { prompt: e.text }, modelId),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[jev-model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[jev-model-router] classification passed ${timeoutMs}ms; leaving the turn alone`)
      } catch (error) {
        $.ui.log(`[jev-model-router] classification failed: ${String(error)}`)
      }
    } else {
      // No backend: the engine's own small-model classifier answers the same
      // question, without the confidence the policy's threshold reads.
      try {
        const label = await $.model.classify(e.text, TIER_ORDER)
        if (label) {
          decision = {
            tier: label as Tier,
            confidence: null,
            risky: null,
            effort: null,
            effortConfidence: null,
          }
        }
      } catch (error) {
        $.ui.log(`[jev-model-router] built-in classifier failed: ${String(error)}`)
      }
    }

    // What the decision model actually answered, whatever the policy then
    // does with it. This is the line that proves the classification ran.
    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`[jev-model-router] jev: ${describeDecision(decision, ms)}`)
    }

    pending.put(decision)

    // In the background, after the turn is on its way: never awaited, never
    // able to change the decision, and every failure ends in a log line.
    const unsure = isUnsure(decision, policy)
    const at = await $.clock.now()

    // The share of prompts that escalate is what a rollback watches. Counted
    // only where a confidence was reported, since only those can be unsure.
    const confidence = decision?.confidence
    if (autoTune && typeof confidence === 'number') {
      void enqueue(async () => {
        const stats = readStats(await $.store.get(TUNE_STATS_KEY))
        await $.store.set(TUNE_STATS_KEY, recordPrompt(stats, at, unsure, confidence))
      }).catch((error) => {
        $.ui.log(`[jev-model-router] tune: could not count the prompt (${String(error)})`)
      })
    }

    if (shadowOpus && decision && wantsShadow(unsure, shadowSampleRate, Math.random())) {
      if (shadowBudget.tryTake(at)) {
        const asked = decision
        void (async () => {
          try {
            const reply = await $.model.complete(shadowRequest(e.text, policy.tiers.deep))
            if (!reply.isAnswered) {
              if (logDecisions) $.ui.log(`[jev-model-router] shadow: no answer (${reply.reason})`)
              return
            }
            const record = buildRecord(at, e.text, asked, readShadowReply(reply.text), unsure, effortLevel)
            await enqueue(async () => {
              const log = await $.store.get(SHADOW_KEY)
              await $.store.set(SHADOW_KEY, appendRecord(log, record))
            }).catch((error) => {
              $.ui.log(`[jev-model-router] shadow: could not save (${String(error)})`)
            })
            if (logDecisions) $.ui.log(`[jev-model-router] ${describeShadow(record)}`)
          } catch (error) {
            $.ui.log(`[jev-model-router] shadow failed: ${String(error)}`)
          }
        })()
      }
    }
    return next(e)
  })

  // How much conversation a model switch would have to re-send.
  on('session.measure', async ($, e, next) => {
    const tokens = e.context?.tokens
    if (typeof tokens === 'number') contextTokens = tokens
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!routeMainLoop || e.agentId) return yield* next(e)

    // Every request after the first reuses what the turn settled on, so
    // neither the model nor the effort changes under its own tool loop.
    if (e.index > 0 && e.turnId === appliedTurnId) {
      const ran = tierOfModel(applied?.model ?? e.model, policy.tiers)
      if (ran) lastUsed[ran] = await $.clock.now()
      return yield* next(applied ? { ...e, ...applied } : e)
    }

    const decision = pending.take()
    const routing = route(decision, { model: e.model, effort: e.effort }, policy)
    const change: { model?: string; effort?: Effort } = {}
    // The main loop's `model` is sent to the API as written, so an alias
    // becomes its id here; a subagent's (agent.spawn) may stay an alias.
    let cacheNote = ''
    if (routeMainModel && routing.model) {
      const now = await $.clock.now()
      const from = tierOfModel(e.model, policy.tiers)
      const to = tierOfModel(routing.model, policy.tiers)
      const verdict =
        cacheAware && from && to
          ? judgeSwitch({ from, to, contextTokens, lastUsed, now }, cacheSettings)
          : { allow: true, reason: '' }
      if (from && to && from !== to) {
        const record = { at: now, from, to, context: contextTokens, allowed: verdict.allow, reason: verdict.reason }
        void enqueue(async () => {
          await $.store.set(SWITCH_KEY, appendSwitch(await $.store.get(SWITCH_KEY), record))
        }).catch(() => undefined)
      }
      if (verdict.allow) change.model = requestModelId(routing.model)
      else cacheNote = ` · ${verdict.reason}`
      if (verdict.allow && verdict.reason && logDecisions) {
        $.ui.log(`[jev-model-router] cache: ${verdict.reason}`)
      }
    }
    if (routeMainEffort && routing.effort) change.effort = routing.effort

    appliedTurnId = e.turnId
    applied = Object.keys(change).length > 0 ? change : null
    const served = tierOfModel(change.model ?? e.model, policy.tiers)
    if (served) lastUsed[served] = await $.clock.now()
    // A row in the transcript scrolls away; this line stays on screen.
    if (logDecisions) $.ui.status(describeStatus(decision, applied, isUnsure(decision, policy)))

    if (!applied) {
      // A turn left alone is the common case, and it used to be silent, which
      // made a working mod look like one that never loaded. Say what happened.
      if (logDecisions) {
        const suppressed = routing.model && !routeMainModel ? ' (main-loop model routing off)' : ''
        $.ui.log(`[jev-model-router] main loop: ${routing.reason}${suppressed}${cacheNote}`)
      }
      return yield* next(e)
    }
    if (logDecisions) {
      const what = [change.model, change.effort && `effort ${change.effort}`]
        .filter(Boolean)
        .join(', ')
      $.ui.log(`[jev-model-router] main loop → ${what}: ${routing.reason}${cacheNote}`)
    }
    return yield* next({ ...e, ...change })
  })

  on('agent.spawn', async ($, e, next) => {
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[jev-model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }

    // A fork inherits its parent's model; `model` is ignored for it.
    if (!routeSubagentModel || e.fork) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[jev-model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    policy.unsureBelow = await currentFloor($, configuredFloor, autoTune)
    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(
              active,
              { prompt: e.prompt, description: e.description, agentType: e.subagentType },
              modelId,
            ),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[jev-model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[jev-model-router] classification passed ${timeoutMs}ms; leaving the subagent alone`)
      } catch (error) {
        $.ui.log(`[jev-model-router] classification failed: ${String(error)}`)
      }
    } else {
      try {
        const label = await $.model.classify(e.prompt, TIER_ORDER)
        if (label) {
          decision = {
            tier: label as Tier,
            confidence: null,
            risky: null,
            effort: null,
            effortConfidence: null,
          }
        }
      } catch (error) {
        $.ui.log(`[jev-model-router] built-in classifier failed: ${String(error)}`)
      }
    }

    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`[jev-model-router] jev (${e.subagentType}): ${describeDecision(decision, ms)}`)
    }

    // The subagent's own model wins when the caller named one; otherwise it
    // would inherit the parent's, so that is what a change is measured from.
    // The Agent tool takes no effort, so only the model is ours to set here.
    const current = e.model ?? e.parentModel
    const { model, reason } = route(decision, { model: current }, policy)
    if (!model) {
      if (logDecisions) $.ui.log(`[jev-model-router] ${e.subagentType}: ${reason}`)
      return next(e)
    }
    if (logDecisions) $.ui.log(`[jev-model-router] ${e.subagentType} → ${model}: ${reason}`)
    return next({ ...e, model })
  })
}
