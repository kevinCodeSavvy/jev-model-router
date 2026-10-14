/**
 * jev-model-router — the `/jev-dashboard` page.
 *
 * Pure: takes what the router keeps in `$.store` and returns one
 * self-contained HTML file (inline CSS, no scripts, no network), laid out in
 * the order a prompt moves through the router:
 *
 *   1 prompts rated by Jev  ->  2 escalated to Opus  ->  3 shadow checks
 *   ->  4 Opus agrees or not  ->  5 the floor, tuned or not
 *
 * It shows counts and generated sentences only, never a prompt.
 */
import { countByConfidence, SHADOW_CAP } from './shadow.ts'
import type { ShadowRecord } from './shadow.ts'
import { formatContext, summarizeSwitches } from './switchlog.ts'
import type { SwitchRecord } from './switchlog.ts'
import { DAY, dayKey, describeEntry, effectiveFloor } from './tune.ts'
import type { AuditEntry, Stats, TuneState } from './tune.ts'

export interface DashboardInput {
  now: number
  /** `unsureBelow` as configured. */
  configured: number
  autoTune: boolean
  state: TuneState
  trail: readonly AuditEntry[]
  stats: Stats
  log: readonly ShadowRecord[]
  /** Main-loop switch decisions, oldest first. */
  switches?: readonly SwitchRecord[]
}

export interface DayRow {
  /** `YYYY-MM-DD`, UTC. */
  date: string
  prompts: number
  /** Mean tier confidence of the day's counted prompts, or null when none was kept. */
  avgConfidence: number | null
  /** Prompts that went to Opus as unsure. */
  escalated: number
  shadow: number
  agree: number
  disagree: number
  noTier: number
  /** The day's floor moves, e.g. `raise 0.30 → 0.35`. */
  moves: string[]
}

export const DASHBOARD_DAYS = 14
/** Switch decisions listed on the page. */
export const SWITCH_ROWS = 15

/** Text made safe to place inside HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** One row per day, newest first, from the counters, the shadow log and the audit trail. */
export function dayRows(input: DashboardInput, days: number = DASHBOARD_DAYS): DayRow[] {
  const today = Math.floor(input.now / DAY)
  const rows: DayRow[] = []
  for (let back = 0; back < days; back++) {
    const day = today - back
    const key = String(day)
    const counted = input.stats[key]
    const row: DayRow = {
      date: new Date(day * DAY).toISOString().slice(0, 10),
      prompts: counted?.prompts ?? 0,
      avgConfidence:
        counted?.confSum !== undefined && counted.confN ? counted.confSum / counted.confN : null,
      escalated: counted?.unsure ?? 0,
      shadow: 0,
      agree: 0,
      disagree: 0,
      noTier: 0,
      moves: [],
    }
    for (const record of input.log) {
      if (dayKey(record.at) !== key) continue
      row.shadow += 1
      if (record.agree === null) row.noTier += 1
      else if (record.agree) row.agree += 1
      else row.disagree += 1
    }
    for (const entry of input.trail) {
      if (dayKey(entry.at) !== key) continue
      row.moves.push(
        entry.action === 'rollback'
          ? `rollback ${entry.from.toFixed(2)} → ${entry.to.toFixed(2)}`
          : `${entry.action} ${entry.from.toFixed(2)} → ${entry.to.toFixed(2)}`,
      )
    }
    rows.push(row)
  }
  return rows
}

const share = (part: number, whole: number): string =>
  whole === 0 ? '–' : `${Math.round((100 * part) / whole)}%`

const CSS = `
:root{--bg:#fafaf7;--card:#fff;--ink:#1d1d1b;--dim:#6b6b66;--line:#e3e2dc;--blue:#2a6fdb;--amber:#b7791f;--bar:#cfe0fb}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#ecebe6;--dim:#9a9990;--line:#33332f;--blue:#6ea4f5;--amber:#e0a84a;--bar:#27406b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px}
.sub{color:var(--dim);font-size:13px;margin:0}
.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:20px}
.step{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.step.off{border-style:dashed;border-color:var(--amber)}
.n{font-size:12px;color:var(--dim)}.big{font-size:26px;font-weight:600;line-height:1.2}
.lbl{font-size:13px;margin-top:2px}.note{font-size:12px;color:var(--dim);margin-top:4px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
th,td{padding:6px 8px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-weight:600;color:var(--dim);font-size:12px}th:first-child,td:first-child{text-align:left}
tr:last-child td{border-bottom:0}td.z{color:var(--dim)}td.moves{text-align:left;white-space:normal;color:var(--amber)}td.kept{color:var(--amber);font-weight:600}td.ok{color:var(--blue)}
.bar{display:inline-block;height:8px;background:var(--bar);border-radius:3px;vertical-align:middle;margin-left:6px}
.wrap{overflow-x:auto}
ul{margin:6px 0;padding-left:20px;font-size:13px}li{margin:3px 0}
@media (max-width:760px){.flow{grid-template-columns:1fr 1fr}}
`

function cell(value: number, max: number, bar = false): string {
  const width = bar && max > 0 ? Math.round((60 * value) / max) : 0
  const inner = bar && value > 0 ? `${value}<span class="bar" style="width:${width}px"></span>` : String(value)
  return `<td${value === 0 ? ' class="z"' : ''}>${inner}</td>`
}

/** The whole page. */
export function buildDashboard(input: DashboardInput): string {
  const rows = dayRows(input)
  const today = rows[0] as DayRow
  const floor = effectiveFloor(input.configured, input.state, input.autoTune)
  const frozen = input.now < input.state.frozenUntil
  const tuned = input.autoTune && input.configured > 0 && input.state.value !== null

  const floorNote = !input.autoTune
    ? 'auto-tune off'
    : input.configured <= 0
      ? 'floor off, nothing to tune'
      : frozen
        ? `frozen until ${new Date(input.state.frozenUntil).toISOString().slice(0, 10)}`
        : tuned
          ? `tuned; configured ${input.configured.toFixed(2)}`
          : 'as configured, not tuned'

  const maxPrompts = Math.max(0, ...rows.map((r) => r.prompts))
  const maxShadow = Math.max(0, ...rows.map((r) => r.shadow))

  const dayTable = rows
    .map(
      (r) => `<tr><td>${r.date}</td>${cell(r.prompts, maxPrompts, true)}<td>${
        r.avgConfidence === null ? '–' : r.avgConfidence.toFixed(2)
      }</td>${cell(r.escalated, 0)}<td>${share(r.escalated, r.prompts)}</td>${cell(r.shadow, maxShadow, true)}${cell(
        r.agree,
        0,
      )}${cell(r.disagree, 0)}${cell(r.noTier, 0)}<td>${share(r.disagree, r.agree + r.disagree)}</td><td class="moves">${escapeHtml(
        r.moves.join(', '),
      )}</td></tr>`,
    )
    .join('\n')

  const buckets = countByConfidence(input.log)
    .filter((b) => b.agree + b.disagree + b.noTier > 0)
    .map(
      (b) =>
        `<tr><td>${escapeHtml(b.bucket)}</td><td>${b.agree}</td><td>${b.disagree}</td><td>${b.noTier}</td><td>${share(
          b.disagree,
          b.agree + b.disagree,
        )}</td></tr>`,
    )
    .join('\n')

  const trail = input.trail.slice(-10).reverse()
  const trailList =
    trail.length === 0
      ? '<li>No tuning changes yet.</li>'
      : trail.map((entry) => `<li>${escapeHtml(describeEntry(entry))}</li>`).join('\n')

  const switches = input.switches ?? []
  const counts = summarizeSwitches(switches)
  const switchRows = switches
    .slice(-SWITCH_ROWS)
    .reverse()
    .map(
      (r) =>
        `<tr><td>${new Date(r.at).toISOString().slice(5, 16).replace('T', ' ')}</td><td>${r.from} → ${r.to}</td><td>${formatContext(
          r.context,
        )}</td><td class="${r.allowed ? 'ok' : 'kept'}">${r.allowed ? 'switched' : 'kept ' + r.from}</td><td class="moves">${escapeHtml(
          r.reason || 'cache check off',
        )}</td></tr>`,
    )
    .join('\n')

  const generated = new Date(input.now).toISOString().slice(0, 16).replace('T', ' ')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev Router Stats</title><style>${CSS}</style></head>
<body><main>
<h1>Jev router: daily stats</h1>
<p class="sub">Snapshot at ${generated} UTC. Type /jev-dashboard again to refresh. Days are UTC.</p>

<div class="flow">
<div class="step"><div class="n">1 · Jev rates the prompt</div><div class="big">${today.prompts}</div><div class="lbl">prompts today</div><div class="note">avg confidence ${
    today.avgConfidence === null ? '–' : today.avgConfidence.toFixed(2)
  }</div></div>
<div class="step"><div class="n">2 · Router decides</div><div class="big">${today.escalated}</div><div class="lbl">sent to Opus as unsure</div><div class="note">${share(
    today.escalated,
    today.prompts,
  )} of today's prompts</div></div>
<div class="step"><div class="n">3 · Shadow check</div><div class="big">${today.shadow}</div><div class="lbl">asked Opus today</div><div class="note">unsure ones plus a sample</div></div>
<div class="step"><div class="n">4 · Opus vs Jev</div><div class="big">${today.agree} / ${today.disagree}</div><div class="lbl">agree / disagree today</div><div class="note">${today.noTier} with no Opus tier</div></div>
<div class="step off"><div class="n">5 · Auto-tune</div><div class="big">${floor.toFixed(2)}</div><div class="lbl">unsure floor now</div><div class="note">${escapeHtml(floorNote)}</div></div>
</div>

<h2>Last ${DASHBOARD_DAYS} days</h2>
<div class="wrap"><table>
<tr><th>Day</th><th>1 Prompts</th><th>Avg conf</th><th>2 To Opus</th><th>Share</th><th>3 Shadow</th><th>4 Agree</th><th>Disagree</th><th>No tier</th><th>Disagree %</th><th>5 Floor moves</th></tr>
${dayTable}
</table></div>

<h2>Agreement by Jev confidence, whole shadow log</h2>
<div class="wrap"><table>
<tr><th>Jev confidence</th><th>Agree</th><th>Disagree</th><th>No tier</th><th>Disagree %</th></tr>
${buckets || '<tr><td colspan="5">No shadow records yet.</td></tr>'}
</table></div>

<h2>Main-loop switch decisions</h2>
<p class="sub">${switches.length === 0 ? 'None recorded yet.' : `${counts.allowed} switched, ${counts.kept} kept on the current model, newest ${Math.min(SWITCH_ROWS, switches.length)} shown. Times UTC.`}</p>
<div class="wrap"><table>
<tr><th>When</th><th>Move</th><th>Context</th><th>Result</th><th>Why</th></tr>
${switchRows || '<tr><td colspan="5">No main-loop switch has been judged yet.</td></tr>'}
</table></div>

<h2>Auto-tune audit trail</h2>
<ul>
${trailList}
</ul>

<h2>Reading this</h2>
<ul>
<li>Counts for step 1 and 2 start when version 0.6.0 is running, and only cover prompts where Jev reported a confidence.</li>
<li>Steps 3 and 4 come from the shadow log, which keeps the newest ${SHADOW_CAP} records, so older days can be partial. Opus is asked about every unsure prompt (up to the hourly cap) and a sample of the rest.</li>
<li>Switch decisions are recorded from version 0.8.1; "kept" means the cache check judged the cheaper model dearer once its cold cache was counted.</li>
<li>Opus's answer is a second opinion, not proof a cheaper model would have failed.</li>
</ul>
</main></body></html>
`
}
