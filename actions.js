/**
 * The roster operations, called by the model-facing tools in `index.js`.
 *
 * `index.js` validates arguments, checks that the model caller is a Team Lead, and returns the result
 * unchanged. The bodies live here so the roster's operations read as one file rather than as tool
 * closures; the plugin has no second, browser-facing caller (ADR 0008).
 *
 * `leadAgent` is explicit rather than read from the caller: only a live Lead yields
 * `ctx.agents.get(leadSessionId)`, and `drainChildren`, `interrupt` and `startActivation` all need that
 * Agent. When it is absent the operation says so instead of throwing a `TypeError` from a missing
 * `session` field.
 *
 * `sweepEphemeral` is the one operation here that is not a tool of its own: it retires finished
 * one-shot members and runs only at the start of `list_members` and `spawn_member` (ADR 0013, ADR 0026).
 *
 * No `@deepseek-ai/*` import: a profile-linked bundle cannot resolve those packages (ADR 0002).
 */

import { join } from 'node:path'

import { loadDefinition, loadTeamTemplate } from './definitions.js'
import {
  HANDOFF_BRIEF_MAX,
  LIFETIME,
  PHASE,
  RETASK_MIN,
  ROUTE_SELECT_REASON,
  ROUTE_SOURCE,
  TASK_BODY_MAX,
  TASK_STATUS,
  TASK_TITLE_MAX,
  TRASH_STATE,
  adoptMember,
  checkAssignment,
  checkHandoffTemplate,
  checkTaskBody,
  currentHolderOf,
  declaredLifetime,
  findByTarget,
  findAnyTarget,
  findTask,
  handoffTemplateProblem,
  hasLiveTarget,
  lifetimeOf,
  liveStateOf,
  openTasksOf,
  planMember,
  planTask,
  readRoster,
  reownerTasks,
  staleRouteOf,
  targetOf,
  tasksOf,
  updateRoster,
  usableHandoffTemplate,
  withMember,
  withRoute,
  withTask,
} from './roster.js'
import {
  DEFAULT_TRASH_LIMIT,
  applyMemberTrash,
  pathExists,
  planMemberTrash,
  pruneLeadTrash,
  restoreSessionArtifact,
  sessionRootFromSibling,
} from './trash.js'

/**
 * Fail with one sentence when an operation needs the live Lead Agent and this process does not hold it.
 * @param {string} operation - tool identity, so the message names what was refused.
 * @param {string} leadSessionId - the Lead Session whose roster is being changed.
 * @param {object|undefined} leadAgent - `ctx.agents.get(leadSessionId)`.
 * @returns the live Agent.
 */
function requireLiveLead(operation, leadSessionId, leadAgent) {
  if (leadAgent === undefined || leadAgent === null) {
    throw new Error(
      `${operation}: the Lead Session ${leadSessionId} is not live in this Harness process`,
    )
  }
  return leadAgent
}

/** Read live context pressure for one resident member. */
export function pressureOf(ctx, agent) {
  const { pressureTokens, contextWindow } = ctx.tokenMeter.contextPressure(agent.session)
  const ratio = contextWindow > 0 ? pressureTokens / contextWindow : undefined
  return { pressureTokens, contextWindow, ratio }
}

/**
 * The sentence a row carries when its member is still on a route its Lead has left.
 *
 * It has to say three things the fields cannot: that the member is billing the old API, that nothing is
 * going to fix it by itself, and the one call that does. The remedy is the replacement this plugin
 * already has (ADR 0009, ADR 0017), so the tool adds no second way to do it (ADR 0024).
 * @param {string} target - the member's model-facing target.
 * @param {object} route - the member's recorded route.
 * @param {{provider: string, model: string}} leadRoute - the Lead's current route.
 * @returns {string} the sentence.
 */
function staleRouteNote(target, route, leadRoute) {
  return `This member started on ${route.provider}/${route.model} and is still billed there, while this Lead now runs on ${leadRoute.provider}/${leadRoute.model}. Nothing re-routes a live member, so the way to clear it is one call: spawn_member { replace: "${target}", label, prompt } starts a successor on the current route and hands over its open work.`
}

/**
 * What a member's own counters prove about how often it was handed work, as short phrases.
 *
 * The evidence is counted rather than inferred, because `assignment` keeps only the last value and a
 * message leaves no other trace. `RETASK_MIN` is the threshold for both signals: one follow-up is not
 * evidence that a role is being used again (ADR 0026).
 * @param {object} member - one stored member record.
 * @returns {string[]} the signals that reached the threshold, empty when none did.
 */
function retaskSignals(member) {
  const signals = []
  if ((member.messageCount ?? 0) >= RETASK_MIN) signals.push(`${member.messageCount} messages`)
  if ((member.assignmentCount ?? 0) >= RETASK_MIN) signals.push(`${member.assignmentCount} assignment changes`)
  return signals
}

/**
 * The sentence `list_members` puts on a one-shot member that has been re-tasked, or undefined.
 *
 * A lifetime declaration is the person's prior consent, so the plugin never converts a member by itself:
 * it reports the evidence — accepted messages and assignment changes written after the spawn — and names
 * the one call that declares the other lifetime (ADR 0026). A member the Lead nudged once is not
 * evidence, which is why the threshold is two of either signal. The advice itself stays one-shot-only,
 * because "this is probably a standing role" is only a correction for a member declared one-shot; the
 * retirement gate reads the same counters for every member (see `carriedBy`).
 * @param {object} member - one stored member record.
 * @returns {string|undefined} the note, or undefined when the member is not a re-tasked one-shot.
 */
function retaskAdvice(member) {
  if (member.ephemeral !== true) return undefined
  const signals = retaskSignals(member)
  if (signals.length === 0) return undefined
  return `This member was declared one-shot, but it has been re-tasked since: ${signals.join(' and ')}. A one-shot handed work again and again is evidence of a standing role, so it is probably not one — nothing converts it automatically, and it still retires on the next sweep once it has stopped and owns no open task. To keep it, declare that at the next spawn: spawn_member { replace: "${targetOf(member)}", label, prompt, lifetime: "standing" }.`
}

/**
 * Project one stored member into the row the model renders.
 *
 * `leadRoute` is what makes a straggler visible: the row is a read, so the comparison runs here rather
 * than being stored, and the member's own route is reported whichever way the comparison goes. Omitting
 * it is a row with no comparison — a spawn answer describes the member it just started, not the roster
 * (ADR 0024).
 * @param ctx - plugin context.
 * @param {object} member - one stored member record.
 * @param {{provider: string, model: string}|undefined} leadRoute - the Lead's current route, when the
 *   caller has it.
 * @returns {object} the row the model renders.
 */
export function memberRow(ctx, member, leadRoute) {
  const live = liveStateOf(ctx, member)
  const compactor = ctx.get('compaction') !== undefined
  const row = {
    target: targetOf(member),
    // The child Session id is the member's durable identity and what the host's own listings show.
    // Every record this plugin writes carries one, so the model can name the exact child.
    child_id: member.childId,
    phase: member.phase,
    generation: member.generation,
    label: member.label,
    status: live.status,
    resident: live.resident,
    compactable: compactor && live.status === 'idle',
  }
  if (live.resident) {
    const agent = ctx.agents.get(member.childId)
    if (agent !== undefined) {
      try {
        const { pressureTokens, contextWindow, ratio } = pressureOf(ctx, agent)
        // A child that has not issued a model request yet has no measurable window. Assigning
        // `undefined` would make the tool result non-lossless JSON, which the registry rejects.
        if (Number.isFinite(pressureTokens)) row.pressure_tokens = pressureTokens
        if (Number.isFinite(contextWindow)) row.context_window = contextWindow
        if (Number.isFinite(ratio)) row.usage_ratio = ratio
      } catch (error) {
        row.note = 'Context pressure is not measurable for this member yet.'
      }
    }
  }
  // What the model recorded about the work, so the Lead can see it before replacing the member.
  if (typeof member.assignment === 'string') row.assignment = member.assignment
  // The lifetime the spawn call declared, in the vocabulary the call uses (ADR 0026). It is on every row
  // on purpose: "standing" is the default and the answer to "may this member retire itself?".
  row.lifetime = lifetimeOf(member)
  // The record's own field, reported beside `lifetime` because every stored record already carries it and
  // ADR 0013 named it. A message no longer clears it (ADR 0026).
  if (member.ephemeral === true) row.ephemeral = true
  // Advice, never a conversion: a one-shot that keeps being handed work is evidence of a standing role,
  // and the Lead is the one who declares that at the next spawn (ADR 0026).
  const retasked = retaskAdvice(member)
  if (retasked !== undefined) {
    row.retasked = true
    row.retasked_note = retasked
  }
  // The route it started on, and whether this Lead is still on it. A member with no recorded route says
  // nothing, which is honest: the plugin does not know what it started on (ADR 0024).
  if (member.route !== undefined) {
    row.route = member.route
    if (staleRouteOf(member, leadRoute)) {
      row.route_stale = true
      row.route_note = staleRouteNote(row.target, member.route, leadRoute)
    }
  }
  return row
}

/**
 * What a brief says about the work when the predecessor's record carries no assignment.
 *
 * It points at the board this plugin owns, not at the shipped one the sentence originally named: since
 * P2-09 the work lives on the Lead's own board (ADR 0017), and since v0.20.0 the member can read its own
 * rows there with `list_my_tasks`. The fallback is still one short sentence; it is simply true now.
 */
const UNRECORDED_ASSIGNMENT = 'not recorded; take it from this Lead\'s task board with list_my_tasks'

/**
 * The pointer a successor follows to the work it inherited: this Lead's own task board under the
 * predecessor's name. The board is not copied and not duplicated, because the rows may already have changed
 * and the child pays for every word. The open rows a replacement hands over are named in full, bounded, by
 * `inheritedTasksLine`; this sentence is what remains for the rest.
 *
 * It names the tool the member reads with, so the successor no longer has to ask the Lead for ids: the rows
 * it owns are what `list_my_tasks` returns (ADR 0022). It deliberately carries no final period, because a
 * stored template commonly writes `{task_board}.` and the built-in shape places it inside a sentence;
 * ending here as well would produce the doubled period a live brief showed.
 * @param {string} target - the predecessor's model-facing target.
 * @returns {string} the sentence the brief points with.
 */
function boardPointer(target) {
  return `this Lead's own task board under the name "${target}"; read it with list_my_tasks and take those tasks over instead of redoing finished work`
}

/**
 * How many inherited tasks a brief names, and how many characters that line may take.
 *
 * A member starting with a 200-line backlog is worse off than one starting with five ids: the list exists
 * to save the successor a round-trip on the work that is actually in flight, and the pointer sentence
 * remains for everything past it. 5 rows is roughly what one agent can hold as a starting backlog, and
 * 600 characters is five maximal titles (200 each, `TASK_TITLE_MAX`) with room for the ids — so the line
 * is dropped in the one case where it would stop being a brief, which degrades to exactly the sentence
 * the release before this one sent.
 */
const HANDOFF_TASK_MAX = 5
const HANDOFF_TASK_LINE_MAX = 600

/**
 * The line a brief carries when the predecessor owned open tasks, or undefined when it owns none or the
 * list would not stay short.
 *
 * Ids and titles both, because either alone is unusable: an id the successor cannot look up is a
 * reference it must ask about, and a title alone cannot be marked done. **Nothing else is carried — the
 * body in particular, which is bounded for the board (`TASK_BODY_MAX`, 2000) and not for a cold child's
 * prompt (ADR 0020).** One maximal body per row would blow the 600-character bound this line exists to
 * stay inside, so the successor reads the bodies from the board itself — with `list_my_tasks` as a member, or
 * `task_board` as the Lead: the brief names the work, the board describes it. The board pointer sentence
 * stays in the brief's shape, so this line is an addition to it rather than a replacement — which is also
 * what keeps a Lead with no tasks byte-identical to the release before this one.
 * @param {object[]} tasks - the predecessor's open tasks, oldest first.
 * @returns {string|undefined} the line, or undefined.
 */
function inheritedTasksLine(tasks) {
  const shown = tasks.slice(0, HANDOFF_TASK_MAX)
  const rest = tasks.length - shown.length
  const items = shown.map((task) => `${task.id} "${task.title}"`).join(', ')
  const line = rest > 0
    ? `Open tasks it still owned: ${items} (and ${rest} more on this Lead's task board, readable with list_my_tasks).`
    : `Open tasks it still owned: ${items}`
  if (line.length > HANDOFF_TASK_LINE_MAX) return undefined
  return line
}

/**
 * The built-in brief shape, in the vocabulary a stored template uses.
 *
 * Expressing it as a template is what makes one renderer serve both paths, and therefore what makes a
 * profile that stores no template produce byte-identical briefs to the release before P4-02. The fifth
 * line — the successor's own task — is not part of the shape: it is appended after it, so no template
 * can drop the task it was started for.
 */
const BUILT_IN_HANDOFF = [
  'You are {successor}, the successor of {predecessor}. {predecessor} has been retired and is gone; it cannot be messaged.',
  'Its role was: {label}.',
  'What it was doing: {assignment}',
  'Its unfinished work is still on {task_board}',
].join('\n')

/**
 * Compose the short, self-contained prompt a cold successor starts from.
 *
 * The successor has no transcript of the predecessor and must not be handed one: it needs to know what
 * the work is, that it is the successor, and that the predecessor is gone. The work itself is stored as
 * task rows on this Lead's roster (P2-09, ADR 0017), and the open ones are named here by id and title —
 * never by body, which is what `task_board` answers for (ADR 0020) — bounded, so the successor does not
 * have to ask for them; the pointer sentence stays for everything past that bound.
 *
 * A Lead may store a template that fixes this shape (`handoff_template`, ADR 0015). The built-in shape
 * is the default, and both go through the same interpolation, so "no template stored" is byte-identical
 * to the earlier release. The placeholders are validated when the template is stored; the stored value
 * is also re-checked by the read form, and `spawnMember` only passes a usable one here, so a token can
 * never be handed to a child as literal text.
 *
 * @param {{successor: string, predecessor: object, prompt: string, template?: string, tasks?: object[]}} request
 *   `template` is an already-checked stored template, or undefined for the built-in. `tasks` is the
 *   predecessor's open tasks; omitting it is exactly the same as passing none, so every caller written
 *   before P2-09 composes the brief it always did.
 * @returns {string} the prompt handed to `startActivation`.
 * @throws when a stored template renders past `HANDOFF_BRIEF_MAX` — refused, never truncated.
 */
export function handoffPrompt({ successor, predecessor, prompt, template, tasks }) {
  const target = targetOf(predecessor)
  const values = {
    successor,
    predecessor: target,
    label: predecessor.label,
    assignment: typeof predecessor.assignment === 'string' && predecessor.assignment.length > 0
      ? predecessor.assignment
      : UNRECORDED_ASSIGNMENT,
    task_board: boardPointer(target),
  }
  const usingTemplate = typeof template === 'string' && template.length > 0
  const shape = usingTemplate ? template : BUILT_IN_HANDOFF
  const rendered = shape.replace(/\{([a-z][a-z0-9_]*)\}/g, (token, name) => (
    Object.hasOwn(values, name) ? values[name] : token
  ))
  if (usingTemplate && rendered.length > HANDOFF_BRIEF_MAX) {
    throw new Error(
      `handoff template: the rendered brief is ${rendered.length} characters; the cap is ${HANDOFF_BRIEF_MAX}. Shorten the stored template or the predecessor's assignment.`,
    )
  }
  const line = Array.isArray(tasks) && tasks.length > 0 ? inheritedTasksLine(tasks) : undefined
  const body = line === undefined ? rendered : `${rendered}\n${line}`
  return `${body}\nYour task: ${prompt}`
}

/** The file problem as one sentence for the read answer, with its line when the parser had one. */
function fileProblemText(file) {
  if (file?.problem === undefined) return undefined
  const { problem: text, line } = file.problem
  return line === undefined ? text : `line ${line}: ${text}`
}

/**
 * Why a store write is refused while the team file exists.
 *
 * The file wins over the stored template, so a write would be accepted and then have no effect — the
 * failure this refusal exists to prevent. The sentence names the file and the edit that does change the
 * brief, and it is the same for setting and clearing.
 * @param {{path: string}} file - the team file that exists.
 * @returns {string} the refusal message.
 */
function teamFileWriteRefusal(file) {
  return `handoff_template: the team file ${JSON.stringify(file.path)} is in effect, so a stored template would be shadowed and this write would change nothing. Edit that file to change the brief, or remove it to use handoff_template again.`
}

/**
 * Resolve the template a replacement will actually compose from: the team file, then the stored
 * template, then the built-in shape.
 *
 * The file is read through the definition layer's directory resolution, so there is one path story for
 * `team/` and one parser for its frontmatter. An unreadable or invalid file is reported by the read
 * form, but it cannot be the effective template: its replacement is the stored template when that one
 * is usable, and the built-in shape otherwise. That is the same fallback a stored value that no longer
 * validates already gets, and it is what keeps a typo in a file from reaching a child as literal text.
 * @param {{ctx?: object, leadAgent?: object, stored?: unknown, signal?: AbortSignal}} request
 * @returns {Promise<{source: 'file'|'stored'|'builtin', template?: string, file: object, stored: unknown}>}
 */
async function resolveHandoffTemplate({ ctx, leadAgent, stored, signal }) {
  const file = ctx === undefined
    ? { found: false }
    : await loadTeamTemplate({ ctx, agent: leadAgent, signal })
  if (file.found === true && typeof file.template === 'string') {
    return { source: 'file', template: file.template, file, stored }
  }
  const usable = usableHandoffTemplate(stored)
  if (usable !== undefined) return { source: 'stored', template: usable, file, stored }
  return { source: 'builtin', template: undefined, file, stored }
}

/** Project one resolved handoff template into the tool's result. */
function describeHandoffTemplate({ source, template, file, stored }) {
  const problem = handoffTemplateProblem(stored)
  const fileProblem = fileProblemText(file)
  const value = {
    // The effective template: the file's body, the stored one, or the built-in shape's empty answer.
    template: typeof template === 'string' ? template : (typeof stored === 'string' ? stored : ''),
    // `stored` and `valid` keep their old meaning: a value on this Lead's roster record, and whether
    // that value passes the content rules. `source` says which of the three sources is in effect.
    stored: typeof stored === 'string',
    valid: stored === undefined || problem === undefined,
    source,
  }
  if (!value.valid) value.problem = problem
  if (file?.found === true) {
    value.file = file.path
    if (fileProblem !== undefined) value.file_problem = fileProblem
  }
  value.message = source === 'file'
    ? `The team file ${JSON.stringify(file.path)} is in effect: replacements compose the brief from its body, and the stored template is shadowed. handoff_template refuses a write while this file exists; edit it instead.`
    : source === 'stored'
      ? fileProblem === undefined
        ? 'This Lead\'s replacements compose their brief from the stored template.'
        : `This Lead's replacements compose their brief from the stored template. The team file ${JSON.stringify(file.path)} is not usable (${fileProblem}), so it does not shadow the stored template; edit it or remove it to make it the source.`
      : fileProblem === undefined
        ? !value.stored
          ? 'No handoff template is stored; spawn_member with replace composes the built-in brief.'
          : 'The stored template does not pass validation, so replacements use the built-in brief. Store a corrected template, or pass an empty string to clear it.'
        : `No usable handoff template is in effect: replacements compose the built-in brief. The team file ${JSON.stringify(file.path)} is not usable (${fileProblem}). Edit that file to change the brief.`
  return value
}

/**
 * Read, store or clear one Lead's handoff-brief template.
 *
 * The effective template has three sources, in this order: the team-scope file `team/team.md` in the
 * Lead's project, the stored template on this Lead's roster record, and the built-in brief. The read
 * form reports the source it used. A store write is refused while the file exists — a silent no-op is
 * the failure to prevent, because the model would believe the brief had changed while the file still
 * won — and clearing follows the same rule.
 *
 * The stored value is re-checked on read. The storage facility validates every record when a domain
 * opens, so only its type can be checked there without risking the whole roster; the content rules are
 * reported here (`valid`, `problem`) instead of being thrown away, and the composition falls back to the
 * built-in rather than writing the offending token into a child's prompt. The file's content goes
 * through the same `handoffTemplateProblem` check where it is parsed.
 *
 * @param {{ctx?: object, table: object, leadSessionId: string, leadAgent?: object, signal?: AbortSignal, template?: string}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function handoffTemplate({ ctx, table, leadSessionId, leadAgent, signal, template }) {
  const roster = readRoster(table, leadSessionId)
  if (template === undefined) {
    return describeHandoffTemplate(await resolveHandoffTemplate({
      ctx,
      leadAgent,
      stored: roster.handoffTemplate,
      signal,
    }))
  }
  if (typeof template !== 'string') throw new Error('handoff_template: template must be a string')
  const file = ctx === undefined
    ? { found: false }
    : await loadTeamTemplate({ ctx, agent: leadAgent, signal })
  if (file.found === true) throw new Error(teamFileWriteRefusal(file))
  if (template.trim().length === 0) {
    await updateRoster(table, leadSessionId, (current) => {
      const next = { ...current }
      delete next.handoffTemplate
      return next
    })
    return {
      ...describeHandoffTemplate({ source: 'builtin', template: undefined, file, stored: undefined }),
      message: 'The handoff template was cleared; replacements use the built-in brief again.',
    }
  }
  const checked = checkHandoffTemplate(template, 'handoff_template')
  await updateRoster(table, leadSessionId, (current) => ({ ...current, handoffTemplate: checked }))
  return {
    ...describeHandoffTemplate({ source: 'stored', template: checked, file, stored: checked }),
    message: 'Handoff template stored. spawn_member with replace composes the successor brief from it; read it back by omitting template, and clear it with an empty string.',
  }
}

/**
 * Every subagent descendant of one agent, read from the installed subagent registry.
 *
 * The seam's `listDescendants(rootSessionId, signal)` walks the parent-owned catalogs and answers one
 * row per reachable child (`{ id, mode, label?, kind: 'child', parentId, depth, activity, hasChildren }`)
 * plus `kind: 'diagnostic'` rows for branches it could not read. Discovery is best-effort: a profile
 * without the session-query or session service still lists the members the shipped roster reports.
 *
 * @param ctx - plugin context, with `subagents` injected.
 * @param rootSessionId - the calling agent's Session, whose catalogs start the traversal.
 * @returns child rows, or an empty list when the registry cannot answer.
 */
async function descendantsOf(ctx, rootSessionId) {
  try {
    return await ctx.subagents.listDescendants(rootSessionId)
  } catch {
    return []
  }
}

/**
 * Every member the shipped team roster reports for one caller.
 *
 * The same rule as the subagent registry above: the shipped roster is a projection over the Lead's
 * append-only Team log, and a rejected transition leaves that projection in a permanent failure state
 * (`docs/architecture-en.md` §3). Discovery is best-effort, so a broken projection degrades to
 * "nothing new to adopt" instead of failing every roster tool — including the retirement that exists
 * to repair that team.
 *
 * @param ctx - plugin context, with `agentTeams` injected.
 * @param caller - the calling Lead Agent.
 * @returns shipped-roster rows, or an empty list when the projection cannot answer.
 */
function listedMembersOf(ctx, caller) {
  try {
    return ctx.agentTeams.listMembers(caller)
  } catch {
    return []
  }
}

/**
 * Adopt every member this agent controls but the roster does not know yet: what the shipped team roster
 * created, and every child spawned with the shipped `subagent` / `subagent_fork` tools. Idempotent: a
 * child is adopted at most once, matched by its child Session id, and a retired record keeps its
 * tombstone so the surviving catalog entry cannot bring the member back.
 *
 * The write is one mutation of the current record, not a rewrite of the snapshot this call read. A
 * discovery read can be slow (the subagent registry walks the catalogs), and a retirement committed
 * while it was suspended must survive: the mutation re-checks every candidate against the record as it
 * is now, so it can add a member but can never put a tombstone back to life.
 *
 * A `provisioning` record is a reservation made before its child was started. If the child never
 * published — the process died between the reservation and the activation, or the activation produced
 * no child — nothing will ever move that row to `active`, so the read reconciles it: a published child
 * becomes `active`, and a stranded reservation becomes `failed` (visible, and retirable, instead of a
 * phantom that stays provisioning forever). A spawn that is still in flight rewrites the row itself
 * when it publishes.
 *
 * @returns the roster, including any newly adopted or reconciled members.
 */
export async function ensureAdopted(ctx, caller, table, leadSessionId) {
  const roster = readRoster(table, leadSessionId)
  const seen = new Set(roster.members.map((member) => member.childId))
  const candidates = []
  const add = (row) => {
    if (typeof row.id !== 'string' || row.id.length === 0 || seen.has(row.id)) return
    seen.add(row.id)
    candidates.push(row)
  }
  for (const member of listedMembersOf(ctx, caller)) {
    if (member.role !== 'teammate') continue
    add({ id: member.id, name: member.name, description: member.description, status: member.status })
  }
  const descendants = await descendantsOf(ctx, caller.session.id)
  const published = new Set()
  for (const row of descendants) {
    if (row.kind !== 'child') continue
    published.add(row.id)
    const label = typeof row.label === 'string' && row.label.length > 0 ? row.label : `Subagent ${row.id}`
    add({ id: row.id, name: label, description: label, status: 'active' })
  }
  const current = readRoster(table, leadSessionId)
  const stranded = current.members.some((member) => member.phase === PHASE.provisioning)
  if (candidates.length === 0 && !stranded) return current
  return await updateRoster(table, leadSessionId, (latest) => {
    let next = latest
    for (const row of candidates) {
      if (next.members.some((member) => member.childId === row.id)) continue
      const adopted = adoptMember(next, row)
      if (adopted !== undefined) next = withMember(next, adopted)
    }
    for (const member of latest.members) {
      if (member.phase !== PHASE.provisioning) continue
      if (ctx.agents.get(member.childId) !== undefined || published.has(member.childId)) {
        next = withMember(next, { ...member, phase: PHASE.active })
      } else {
        next = withMember(next, {
          ...member,
          phase: PHASE.failed,
          note: 'The reservation never published a child; the record is reconciled as failed.',
        })
      }
    }
    return next
  })
}

/**
 * How many blocked rows the sweep's sentence names one call for, and the cap its list keeps.
 *
 * The machine list is `blocking_tasks` and is never cut; this bound is on the sentence only, and it
 * exists for the same reason the brief's task list is bounded: a member holding a whole backlog must not
 * turn one result into a wall of text. Past the bound the sentence says the same call clears each of the
 * remaining ids it just named.
 */
const BLOCKING_CALL_MAX = 5

/**
 * The sentence a blocked sweep answers with: which member the veto stopped, what it still owns, and the
 * one call that clears each row.
 *
 * It is part of the result, not a log line, because the alternative is a member that never leaves and
 * nothing that says why. The ids travel both here and in `blocking_tasks`, so a caller reads the machine
 * list and the person reads the sentence (ADR 0026).
 * @param {{target: string, tasks: object[]}[]} blocked - one entry per member the veto stopped.
 * @param {string[]} ids - the open task ids it owns, flattened.
 * @returns {string} the note.
 */
function blockingNote(blocked, ids) {
  const names = blocked.map((entry) => `"${entry.target}"`).join(' and ')
  const many = blocked.length > 1
  const rows = ids.length === 1 ? 'this open row' : `these ${ids.length} open rows`
  const calls = ids
    .slice(0, BLOCKING_CALL_MAX)
    .map((id) => `task_board { action: "update", task_id: "${id}", status: "done" }`)
  const rest = ids.length - calls.length
  const clearing = rest > 0
    ? `${calls.join('; ')} — and the same call for each of the ${rest} further ids in blocking_tasks`
    : calls.join('; ')
  return `${names} ran and stopped, but ${many ? 'they still own' : 'it still owns'} ${rows} on this board, so the sweep left ${many ? 'them' : 'it'} alone: retiring would leave the work unowned. Each row is cleared by one call — ${clearing}. Closing the work is what makes a one-shot member eligible to leave; it is never what proves the member finished.`
}

/**
 * The lazy sweep: retire every **one-shot** member whose work is over, at the start of the two roster
 * operations the model calls anyway.
 *
 * The Harness has no completion event — an active child that finishes its turn produces no durable
 * change (§1 of `docs/member-lifecycle-en.md`) — so the sweep requires evidence this plugin recorded
 * itself: the member is `active` and one-shot, carries `startedAt` (written when its activation
 * resolved, so a reservation that never published has none), and is no longer resident in the local live
 * registry. A member that never started is never swept, and neither is a running one. The installed
 * subagent seam reports a descendant row's `activity` as only `running | inactive`, and `inactive` also
 * describes a child that never started, so the local registry is what decides (ADR 0013).
 *
 * **A standing member is never swept, and the board is a veto rather than a trigger.** Three conditions,
 * all required, and the third is ADR 0026's: the member owns no `open` row on this Lead's board. A member
 * whose turn ended but which still owns work is *not eligible* — a sweep would leave that work unowned —
 * and an empty board is not by itself proof that anything finished, so it never triggers a retirement
 * either. When the veto does block a sweep, the result names the rows (`blocking_tasks`) and the one call
 * that clears each, because a forgotten row must not strand a member invisibly.
 *
 * **A message re-opens a one-shot member by invalidating the evidence, not by rewriting the
 * declaration.** `message_member` drops `startedAt`; a later read that observes the child resident again
 * re-stamps it, so "it ran and stopped" is only ever concluded from an observation made after the last
 * time the member was handed work (ADR 0026).
 *
 * Retirement is the existing protocol, not a second implementation: every candidate goes through
 * `retireMember`, with `retireReason: 'one-shot member: it ran and stopped and owned no open task'` on
 * the tombstone. `consentRequired` is left at its default of false here, because a one-shot member's
 * declaration already was the person's consent to it leaving on its own (ADR 0026).
 *
 * It calls no model and no clock, and returns no fields at all when there was nothing to retire or
 * report, so a profile that never declares a one-shot member sees results exactly as they were before
 * this feature.
 *
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   trashLimit?: number}} request
 * @returns {Promise<{swept?: number, swept_targets?: string[], unowned?: number, unowned_tasks?: string[],
 *   blocked?: number, blocking_tasks?: string[], blocking_note?: string}>} the report fields, or `{}`.
 */
export async function sweepEphemeral({
  ctx,
  table,
  leadSessionId,
  leadAgent,
  dataDir,
  hooks,
  trashLimit = DEFAULT_TRASH_LIMIT,
}) {
  const roster = readRoster(table, leadSessionId)
  const oneShot = roster.members.filter((member) => member.phase === PHASE.active && member.ephemeral === true)
  if (oneShot.length === 0) return {}
  // The invalidated evidence: a member messaged while it was unloaded carries no `startedAt`, and the
  // child being resident now is the positive fact that it has run since. Stamped once, then it is the
  // same evidence any other one-shot member carries.
  const revived = oneShot.filter((member) => typeof member.startedAt !== 'string' && liveStateOf(ctx, member).resident === true)
  let current = roster
  if (revived.length > 0) {
    const ids = new Set(revived.map((member) => member.memberId))
    const at = new Date().toISOString()
    current = await updateRoster(table, leadSessionId, (latest) => {
      let next = latest
      for (const member of latest.members) {
        if (!ids.has(member.memberId)) continue
        if (member.phase !== PHASE.active || member.ephemeral !== true || typeof member.startedAt === 'string') continue
        next = withMember(next, { ...member, startedAt: at })
      }
      return next
    })
  }
  const ready = current.members.filter((member) => member.phase === PHASE.active
    && member.ephemeral === true
    && typeof member.startedAt === 'string'
    && liveStateOf(ctx, member).resident === false)
  const finished = []
  const blocked = []
  for (const member of ready) {
    const owned = openTasksOf(current, targetOf(member))
    if (owned.length === 0) finished.push(member)
    else blocked.push({ target: targetOf(member), tasks: owned })
  }
  const swept = []
  const unowned = []
  for (const member of finished) {
    const outcome = await retireMember({
      ctx,
      table,
      leadSessionId,
      leadAgent,
      dataDir,
      hooks,
      target: targetOf(member),
      reason: 'one-shot member: it ran and stopped and owned no open task',
      trashLimit,
    })
    // A member another caller retired in between answers `already-retired`; it is not this sweep's doing.
    if (outcome.retired === true && outcome.reason !== 'already-retired') {
      swept.push(targetOf(member))
      // A swept member is a retirement with no successor, so its open work loses its owner. The veto above
      // makes this reachable only when a row was created for the member between that read and this
      // retirement; it is still reported rather than quietly orphaned (ADR 0017).
      if (Array.isArray(outcome.unowned_tasks)) unowned.push(...outcome.unowned_tasks)
    }
  }
  const value = {}
  if (swept.length > 0) {
    value.swept = swept.length
    value.swept_targets = swept
    if (unowned.length > 0) {
      value.unowned = unowned.length
      value.unowned_tasks = unowned
    }
  }
  if (blocked.length > 0) {
    const ids = blocked.flatMap((entry) => entry.tasks.map((task) => task.id))
    value.blocked = blocked.length
    value.blocking_tasks = ids
    value.blocking_note = blockingNote(blocked, ids)
  }
  return value
}

/**
 * List one Lead's roster.
 *
 * This read is one of the two sweep triggers (ADR 0013): it first retires every one-shot member whose
 * turn has ended and which owns no open task, so the rows it returns already show those members as
 * `retired` and the result reports `swept` and `swept_targets` when the sweep retired anyone.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   trashLimit?: number}} request
 * @returns {Promise<{members: object[]}>} the tool's result object, unchanged.
 */
export async function listMembers({ ctx, table, leadSessionId, leadAgent, dataDir, hooks, trashLimit = DEFAULT_TRASH_LIMIT }) {
  const caller = requireLiveLead('list_members', leadSessionId, leadAgent)
  const swept = await sweepEphemeral({ ctx, table, leadSessionId, leadAgent: caller, dataDir, hooks, trashLimit })
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  // The Lead's route is resolved once for the whole read and compared with each member's recorded one, so
  // a row can say whether that member is still billing an API this Session has left (ADR 0024). An
  // unreadable route leaves every row uncomparable, which is why it is not an error here either.
  const leadRoute = currentRouteOf(caller)
  return { members: roster.members.map((member) => memberRow(ctx, member, leadRoute)), ...swept }
}

/**
 * How long `wait_members` blocks by default, and the longest it may block.
 *
 * Bounded on purpose: the tool exists so a Lead can block inside one turn, never so it can block
 * forever. 30 seconds is the shipped `wait_agent` default and the ceiling is that tool's documented
 * maximum, so a model that knows one surface already knows this one.
 */
export const WAIT_TIMEOUT_DEFAULT = 30_000
export const WAIT_TIMEOUT_MAX = 3_600_000

/**
 * Resolve on the next live-status change of one of the watched agents, or on the timeout.
 *
 * This is the whole wait: one subscription on the Harness's own status event, one timer, and the
 * caller's own cancellation. The subscription is removed on every exit, so a finished wait leaves no
 * listener behind.
 * @param ctx - plugin context, which owns the subscription.
 * @param {Map<string, string>} watched - child Session id to member target, for the members in scope.
 * @param {number} timeoutMs - the bound, already validated by the caller.
 * @param {AbortSignal|undefined} signal - the tool call's cancellation.
 * @returns {Promise<{target: string, status: string}|{timedOut: true}|{aborted: true}>} the observation.
 */
function nextMemberStatus(ctx, watched, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    let off = () => {}
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      off()
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish({ aborted: true })
    off = ctx.on('agent/status', (payload) => {
      const target = watched.get(payload?.agent?.id)
      // The Lead's own transition and every unrelated agent are not this wait's business.
      if (target === undefined) return
      if (payload.status !== 'running' && payload.status !== 'idle') return
      finish({ target, status: payload.status })
    })
    if (typeof off !== 'function') off = () => {}
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
  })
}

/**
 * Wait for the next live-status change among one Lead's members.
 *
 * The event is the Harness's own `agent/status` (`idle` ⇄ `running` for one Agent). The plugin
 * subscribes from its own context and filters by the child Session ids on this Lead's roster, rather
 * than calling the shipped `agentTeams.waitForChange`: that service is notified from the same event,
 * but only for an agent its own membership test resolves, and `tryMembership` answers `undefined` for
 * a subagent its journal does not own (installed `dsh-experimental-agent-team`
 * `lib/types/roster.js:75-79`; its observer is `lib/index.js:1477-1480`). Every member this plugin
 * spawns is exactly such a child, so the shipped wait would never wake for it. An unscoped listener is
 * admitted to a scoped dispatch (`@deepseek-ai/dsh-scope` `lib/index.js:327-338`), so this plugin can
 * observe those transitions itself.
 *
 * A wait that could never end is refused before it starts: while the Lead is blocked, an idle member
 * has no turn to end and nothing can wake it, so a roster with no `running` member and no
 * `provisioning` reservation answers `no_progress` at once. It observes changes only after the call
 * starts, wakes nobody, and never waits for a task-board write, a delivered message to be processed,
 * a member's whole assignment, or a retired member's state.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   timeoutMs?: number, signal?: AbortSignal}} request
 * @returns {Promise<object>} the tool's result object.
 */
export async function waitMembers({
  ctx,
  table,
  leadSessionId,
  leadAgent,
  timeoutMs = WAIT_TIMEOUT_DEFAULT,
  signal,
}) {
  const caller = requireLiveLead('wait_members', leadSessionId, leadAgent)
  const startedAt = Date.now()
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const watched = new Map()
  let canChange = false
  for (const member of roster.members) {
    watched.set(member.childId, targetOf(member))
    if (member.phase === PHASE.provisioning || liveStateOf(ctx, member).status === 'running') canChange = true
  }
  if (!canChange) {
    return {
      timed_out: false,
      waited_ms: Date.now() - startedAt,
      no_progress: true,
      message: 'No member is running or provisioning, so no member can change state while this call blocks. Re-list with list_members, wake the member you need with message_member, then wait again.',
    }
  }
  const observed = await nextMemberStatus(ctx, watched, timeoutMs, signal)
  const waited_ms = Date.now() - startedAt
  if (observed.aborted) throw signal?.reason ?? new Error('wait_members: the wait was cancelled')
  if (observed.timedOut) {
    return {
      timed_out: true,
      waited_ms,
      message: `No member changed state within ${timeoutMs} ms. Re-list with list_members for the current roster.`,
    }
  }
  return {
    timed_out: false,
    waited_ms,
    target: observed.target,
    status: observed.status,
    message: `Member "${observed.target}" is now ${observed.status}. Re-list with list_members for the whole roster.`,
  }
}

/**
 * The route one Agent is currently issuing its model requests on, or undefined when it cannot be read.
 *
 * This is the Harness's own inheritance source and nothing else: the subagent seam resolves a child's
 * provider and model from `parent.session.requestHeader()?.config`, and falls back to the parent Agent's
 * creation options only while no request has been logged
 * (`@deepseek-ai/dsh-subagent/lib/types/child-agent.js:49-62`). The creation options are deliberately not
 * a second source here: they are a snapshot from before the Lead switched, and a route resolved from them
 * would be forwarded as current and be wrong. An Agent that has sent no request yet therefore resolves
 * nothing, and the spawn inherits exactly as it did before this release.
 *
 * The accessor is probed, never assumed: it is read off the caller's own Session behind a type check and
 * a `try`, because a spawn must not fail over a resolution step (§ "Never break a spawn to do it").
 * @param {object|undefined} agent - the Lead Agent whose route is wanted.
 * @returns {{provider: string, model: string}|undefined} the complete route, or undefined.
 */
function currentRouteOf(agent) {
  try {
    const requestHeader = agent?.session?.requestHeader
    if (typeof requestHeader !== 'function') return undefined
    const config = requestHeader.call(agent.session)?.config
    const provider = config?.provider
    const model = config?.model
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (typeof model !== 'string' || model.length === 0) return undefined
    return { provider, model }
  } catch (error) {
    return undefined
  }
}

/** The spawn provider this plugin starts every member on; its capability table is what gates `agentOptions`. */
const SPAWN_PROVIDER = 'spawn'

/**
 * Whether the provider a member starts on can apply `agentOptions` at all.
 *
 * Forwarding a resolved route to a provider that does not advertise the capability is not a no-op: the
 * seam rejects the start with `UNSUPPORTED_CAPABILITY` (`@deepseek-ai/dsh-subagent/lib/index.js:3325-3343`),
 * so the member would fail to start because of a step the caller never asked for. An absent provider table
 * or an absent provider is the same answer — the plugin cannot prove the capability, so it does not use it.
 * @param ctx - plugin context.
 * @returns {boolean} true only when the provider advertises `agentOptions`.
 */
function spawnProviderAppliesAgentOptions(ctx) {
  const provider = ctx.subagents?.getProvider?.(SPAWN_PROVIDER)
  return provider?.capabilities?.agentOptions === true
}

/**
 * Resolve what the spawn request should carry for the member's route, and the record that goes with it.
 *
 * **The caller's explicit route wins, and the result says so.** When the call (or the definition it
 * named) supplied `provider` or `model`, that is what is forwarded, and the two fields it did not supply
 * are completed from the Lead's current route so that the route recorded on the member is the whole route
 * the child actually runs on — `source: 'caller'`.
 *
 * **Otherwise the plugin forwards the Lead's current route explicitly** (`source: 'plugin'`), which is
 * what makes a member use the API of the Session that started it even when the Harness's own resolution
 * would have been enough: the same two fields the seam would read, from the same place, resolved at spawn
 * time. **`reasoningEffort` is never added.** The seam drops the parent's effort only when the route it
 * resolves differs from the parent's (`:88-90`), and forwarding the resolved route is exactly the case
 * where it does not differ, so the Lead's effort survives the merge on its own; a caller-unknown effort
 * would instead have to be right about a model this function never asked about. The shipped tool's
 * preflight is not on this path either (`@deepseek-ai/dsh-tool-subagent/lib/index.js:437-450`).
 *
 * **Every failure is a fallback, never a failure.** No route to read, or a provider that cannot apply one,
 * forwards nothing, records `source: 'inherited'` with the reason it fell back, and lets the Harness
 * inherit exactly as it did before this release (ADR 0024).
 * @param {{ctx: object, leadAgent: object|undefined, agentOptions?: object}} request - the calling Lead
 *   Agent, the context, and the effective `agent_options` the call resolved to (a definition's fields are
 *   already merged into it).
 * @returns {{requestField: object, recorded: object}} the `agentOptions` to add to the activation
 *   request (empty when nothing is forwarded) and the `route` to record on the member.
 */
function resolveSpawnRoute({ ctx, leadAgent, agentOptions }) {
  const suppliedProvider = typeof agentOptions?.provider === 'string' && agentOptions.provider.length > 0
    ? agentOptions.provider
    : undefined
  const suppliedModel = typeof agentOptions?.model === 'string' && agentOptions.model.length > 0
    ? agentOptions.model
    : undefined
  const explicit = suppliedProvider !== undefined || suppliedModel !== undefined
  const leadRoute = currentRouteOf(leadAgent)
  if (explicit) {
    const provider = suppliedProvider ?? leadRoute?.provider
    const model = suppliedModel ?? leadRoute?.model
    const recorded = {
      source: ROUTE_SOURCE.caller,
      ...provider === undefined ? {} : { provider },
      ...model === undefined ? {} : { model },
    }
    return { requestField: {}, recorded }
  }
  if (leadRoute === undefined) {
    return {
      requestField: {},
      recorded: { source: ROUTE_SOURCE.inherited, select_reason: ROUTE_SELECT_REASON.noSessionRoute },
    }
  }
  if (!spawnProviderAppliesAgentOptions(ctx)) {
    return {
      requestField: {},
      recorded: {
        source: ROUTE_SOURCE.inherited,
        provider: leadRoute.provider,
        model: leadRoute.model,
        select_reason: ROUTE_SELECT_REASON.capabilityAbsent,
      },
    }
  }
  return {
    requestField: { provider: leadRoute.provider, model: leadRoute.model },
    recorded: { source: ROUTE_SOURCE.plugin, provider: leadRoute.provider, model: leadRoute.model },
  }
}

/**
 * The optional part of the Harness activation request, built from the tool's `spawn_options`.
 *
 * The plugin interprets none of these values. `cwd` is forwarded exactly as the model wrote it: the
 * Harness resolves a relative path against the Lead's working directory and keeps the Lead's permission
 * roots, so resolving or normalising it here would disagree with the Host. The tool's snake_case
 * vocabulary is mapped to the request's own field names here and nowhere else, so the composition, the
 * refusal and the reported `started_with` cannot drift apart.
 * @param {{cwd?: string, agentOptions?: object, agentPreset?: string}} options - the tool's fields.
 * @returns {object} the request fields to add; empty when the caller omitted all of them.
 */
function activationOptions({ cwd, agentOptions, agentPreset }) {
  const request = {}
  if (cwd !== undefined) request.cwd = cwd
  if (agentOptions !== undefined) {
    const mapped = {}
    if (agentOptions.provider !== undefined) mapped.provider = agentOptions.provider
    if (agentOptions.model !== undefined) mapped.model = agentOptions.model
    if (agentOptions.reasoning_effort !== undefined) mapped.reasoningEffort = agentOptions.reasoning_effort
    if (agentOptions.max_tokens !== undefined) mapped.maxTokens = agentOptions.max_tokens
    request.agentOptions = mapped
  }
  if (agentPreset !== undefined) request.agentPreset = agentPreset
  return request
}

/**
 * What to report about the start: the options the member was started with, in the tool's own vocabulary,
 * and only the ones the caller supplied — plus one field the plugin may have supplied itself.
 *
 * A silently applied model is how a cost surprise happens, so the caller sees what it asked for. Only
 * the supplied fields are echoed, which is what keeps a spawn that passes none of them producing the
 * result shape it produced before ADR 0016. `route_source` is the one addition: `caller` when the route
 * was the call's own, `plugin` when the plugin resolved and forwarded the Lead's current route, and
 * `inherited` when nothing was forwarded and the Harness inherited it. It is present on every spawn,
 * because "which path ran" is the fact a roll-out like this one has to be able to read back (ADR 0024).
 * @param {{cwd?: string, agentOptions?: object, agentPreset?: string}} options - the tool's fields.
 * @param {object} route - the route record `resolveSpawnRoute` built.
 * @returns {object} `{cwd?, agent_options?, agent_preset?, route_source}`, or `{route_source}`.
 */
function startedWith({ cwd, agentOptions, agentPreset }, route) {
  const value = {}
  if (cwd !== undefined) value.cwd = cwd
  if (agentOptions !== undefined) value.agent_options = agentOptions
  if (agentPreset !== undefined) value.agent_preset = agentPreset
  value.route_source = route.source
  return value
}

/**
 * Apply one member definition to a spawn call, field by field, and say where each part came from.
 *
 * **The call wins.** Every field the model passed explicitly is used, and the definition's value for it
 * is reported in `overridden` — a model that replaced the file's label but not its model sees exactly
 * that. `prompt` is the one field the call cannot replace: the body is the member's standing prompt and
 * the call's `prompt` is the task for this spawn, so the two are composed and the report's `prompt` says
 * which happened. Nothing of the definition is dropped silently, which is the failure this report
 * exists to prevent.
 *
 * **`assignment` has one more source, and it outranks the file on a replace.** A successor continues the
 * predecessor's work, so the assignment recorded on the predecessor is what it inherits (ADR 0009), and
 * a definition file — whose `assignment` is the role's standing sentence — must not defeat that. The
 * order is: the call's assignment, then the predecessor's recorded one, then the file's, which applies
 * only when there is nothing to inherit. The report's `assignment` names which of the three won, so the
 * merge is visible rather than inferred (ADR 0019).
 *
 * The report is computed here, next to the merge, so the fields it claims cannot drift from the values
 * the request is actually composed with. What the merge does **not** carry is the member's lifetime: a
 * definition cannot declare one, because a role file that did would hand it to every successor of a
 * replacement, and a `replace` would then move the work and self-retire (ADR 0026).
 * @param {object} definition - one parsed definition: `{name, path, prompt, fields}`.
 * @param {object} call - the model's arguments, as `spawnMember` received them.
 * @param {object|undefined} predecessor - the member a `replace` names, when there is one; its recorded
 *   assignment is the only value a successor inherits from it.
 * @returns {{name?: string, label?: string, prompt: string, assignment?: string,
 *   cwd?: string, agentOptions?: object, agentPreset?: string, report: object}} the values to start
 *   with, and the report the tool returns.
 */
function applyDefinition(definition, call, predecessor) {
  const file = definition.fields
  const fromFile = []
  const overridden = []
  const take = (key, supplied, value) => {
    if (supplied) {
      if (file[key] !== undefined) overridden.push(key)
      return value
    }
    if (file[key] === undefined) return undefined
    fromFile.push(key)
    return file[key]
  }
  const name = take('name', call.name !== undefined, call.name)
  const label = take('label', call.label !== undefined, call.label)
  // A stored assignment is a non-empty string; an older or hand-edited record that holds an empty one
  // has nothing to inherit, exactly as `planMember` already treats it.
  const inherited = typeof predecessor?.assignment === 'string' && predecessor.assignment.length > 0
    ? predecessor.assignment
    : undefined
  let assignment
  let assignmentSource
  if (call.assignment !== undefined) {
    assignment = call.assignment
    assignmentSource = 'call'
    if (file.assignment !== undefined) overridden.push('assignment')
  } else if (inherited !== undefined) {
    assignment = inherited
    assignmentSource = 'predecessor'
  } else if (file.assignment !== undefined) {
    assignment = file.assignment
    assignmentSource = 'file'
    fromFile.push('assignment')
  }
  const cwd = take('cwd', call.cwd !== undefined, call.cwd)
  const agentPreset = take('agent_preset', call.agentPreset !== undefined, call.agentPreset)
  const agentOptions = {}
  for (const key of ['provider', 'model', 'reasoning_effort', 'max_tokens']) {
    const supplied = call.agentOptions?.[key]
    const value = take(key, supplied !== undefined, supplied)
    if (value !== undefined) agentOptions[key] = value
  }
  // The body always leads: a definition that supplied the role is never thrown away by a task string.
  fromFile.push('prompt')
  const report = {
    name: definition.name,
    path: definition.path,
    prompt: call.prompt === undefined ? 'file' : 'file+call',
    from_file: fromFile,
    overridden,
  }
  // Absent when no assignment applies at all: there is then no winner to name.
  if (assignmentSource !== undefined) report.assignment = assignmentSource
  return {
    name,
    label,
    prompt: call.prompt === undefined ? definition.prompt : `${definition.prompt}\n\n${call.prompt}`,
    assignment,
    cwd,
    agentOptions: Object.keys(agentOptions).length === 0 ? undefined : agentOptions,
    agentPreset,
    report,
  }
}

/**
 * Translate a Harness refusal of one start into the plugin's typed-refusal style.
 *
 * Routed on `error.code`, the seam's stable machine-routable failure class, never on the message. The
 * capability codes are the ones a caller can act on, and each answer names the way out: omit the field
 * to inherit the Lead's value, because there is no per-call tool allow/deny and no way to name a preset
 * other than a declared id. An unrecognised code is a start failure like any other and keeps the
 * existing thrown error.
 * @param {unknown} error - what `startActivation` rejected with.
 * @param {{agentOptions?: object, agentPreset?: string}} options - what was requested, so the sentence
 *   can name the field to omit. `cwd` has no capability gate and is not needed here.
 * @returns {{reason: string, message: string}|undefined} the typed refusal, or undefined.
 */
function spawnRefusal(error, { agentOptions, agentPreset }) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  const details = error !== null && typeof error === 'object' ? error.details : undefined
  const wantedPreset = typeof details?.agentPreset === 'string' ? details.agentPreset : agentPreset
  if (code === 'UNSUPPORTED_CAPABILITY') {
    const asked = [
      agentOptions === undefined ? undefined : 'model options',
      agentPreset === undefined ? undefined : 'an agent preset',
    ].filter((field) => field !== undefined)
    const omit = [
      agentOptions === undefined ? undefined : 'agent_options',
      agentPreset === undefined ? undefined : 'agent_preset',
    ].filter((field) => field !== undefined)
    const subject = asked.length === 0 ? 'the requested start options' : asked.join(' and ')
    const fields = omit.length === 0 ? 'those options' : omit.join(' and ')
    return {
      reason: 'unsupported-capability',
      message: `This profile's spawn provider cannot apply ${subject} to a member, so the member did not start. Start it again without ${fields} to inherit the Lead's values.`,
    }
  }
  if (code === 'PRESET_UNAVAILABLE') {
    return {
      reason: 'preset-unavailable',
      message: 'No agent-presets service is mounted in this profile, so a member cannot select its own preset. Start it again without agent_preset to inherit the Lead\'s preset and tool set.',
    }
  }
  if (code === 'agent-preset/not-found') {
    const available = Array.isArray(details?.available)
      ? details.available.filter((id) => typeof id === 'string')
      : []
    const declared = available.length === 0
      ? 'this profile declares none'
      : `the declared ids are ${available.map((id) => `"${id}"`).join(', ')}`
    return {
      reason: 'preset-not-found',
      message: `No agent preset with the id "${String(wantedPreset)}" is declared in this profile; ${declared}. Preset ids come from the profile's bundle patches, and a preset directory is not scanned, so use a declared id or omit agent_preset to inherit the Lead's preset.`,
    }
  }
  if (code === 'agent-preset/invalid') {
    const problem = typeof details?.reason === 'string' ? details.reason : 'it failed to activate'
    return {
      reason: 'preset-invalid',
      message: `The agent preset "${String(wantedPreset)}" is declared but cannot be used: ${problem}. Use another declared id, or omit agent_preset to inherit the Lead's preset.`,
    }
  }
  if (code === 'UNAUTHORIZED') {
    return {
      reason: 'unauthorized',
      message: 'The Lead Session is not the exact live agent this Harness process holds, so the child could not be started. Open that Session again and retry.',
    }
  }
  return undefined
}

/**
 * Reserve the next generation of a base name and start it as a continuable child, optionally retiring
 * the member it replaces in the same call.
 *
 * **Ordering: the successor starts first, the predecessor is retired second.** The other order — retire
 * then spawn — loses the predecessor when the spawn fails: it is in the trash, its work is briefed to
 * nobody, and the only way back is `restore_member`. With this order a failed start changes nothing
 * (the predecessor is untouched and still live, and the failed reservation is recorded) and a failed
 * retirement leaves two live members, which is recoverable by one more call. Whichever half fails, the
 * answer says which half it was (`predecessor_retired: false`, or a thrown error that names the live
 * predecessor) instead of reporting success.
 *
 * A start the Harness refuses for a capability reason is the one failure answered as a typed result
 * rather than a thrown error (`started: false` and a `reason`): the reservation is already recorded as
 * `failed`, no child exists, and the model can act on the sentence by omitting the field.
 *
 * This is the second sweep trigger (ADR 0013): the call first retires every finished one-shot member, so
 * the fan-out that follows sees the slots those members were holding.
 *
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   name?: string, label?: string, prompt?: string, assignment?: string, replace?: string,
 *   lifetime?: string, ephemeral?: boolean, definition?: string, cwd?: string, agentOptions?: object,
 *   agentPreset?: string,
 *   signal?: AbortSignal, trashLimit?: number}} request - `trashLimit` is the
 *   effective cap from the plugin config; the retirement half of a replacement enforces it, and it
 *   defaults to `DEFAULT_TRASH_LIMIT` for callers that pass none. `lifetime` declares how long the member
 *   lives — `standing` (the default) or `one-shot` — and `ephemeral: true` is the pre-v0.25 spelling of
 *   `one-shot` (§2 of `docs/member-lifecycle-en.md`, ADR 0026). It is never inherited: not from a predecessor on a `replace`, and not
 *   from a definition file, which cannot declare one at all. `cwd`, `agentOptions` and `agentPreset` are
 *   the tool's `spawn_options` fields;
 *   each one omitted means the member inherits the Lead's value (ADR 0016). `definition` names a member
 *   definition under `team/` in the Lead's working directory: its fields fill whatever the call omitted,
 *   its `assignment` yields to the predecessor's recorded one on a `replace` (the call's assignment
 *   still wins over both), and a definition that cannot be read is a typed refusal, not a throw
 *   (ADR 0018, ADR 0019).
 * @returns {Promise<object>} the member row the tool returns, or the definition refusal.
 */
export async function spawnMember({
  ctx,
  table,
  leadSessionId,
  leadAgent,
  dataDir,
  hooks,
  name,
  label,
  prompt,
  assignment,
  replace,
  lifetime,
  ephemeral,
  definition,
  cwd,
  agentOptions,
  agentPreset,
  signal,
  trashLimit = DEFAULT_TRASH_LIMIT,
}) {
  const caller = requireLiveLead('spawn_member', leadSessionId, leadAgent)
  // What this call declares about how long the member lives, resolved before anything is read or
  // reserved: the two spellings are checked against each other here, and the result is the member's
  // lifetime — never the predecessor's, never the file's (ADR 0026).
  const declared = declaredLifetime({ lifetime, ephemeral }, 'spawn_member')
  // The definition layer comes first, before the sweep and before any reservation: a call that names a
  // file it cannot read must change nothing, and must not retire a finished member as a side effect of
  // failing. A refusal is the tool's typed answer, not a thrown host error (ADR 0018, ADR 0016). Loading
  // is the pure half — resolving the directory and reading the file — and the merge runs below, after
  // the predecessor is known, because what a successor inherits lives on that record (ADR 0019).
  let loaded
  if (definition !== undefined) {
    loaded = await loadDefinition({ ctx, agent: caller, name: definition, signal })
    if (loaded.refusal !== undefined) return { started: false, ...loaded.refusal }
  }
  const swept = await sweepEphemeral({ ctx, table, leadSessionId, leadAgent: caller, dataDir, hooks, trashLimit })
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const predecessor = replace === undefined
    ? undefined
    : roster.members.find((member) => targetOf(member) === replace)
  if (replace !== undefined && predecessor === undefined) {
    throw new Error(`spawn_member: no member named "${replace}" in the roster, live or retired`)
  }
  let defined
  if (loaded !== undefined) {
    const applied = applyDefinition(
      loaded.definition,
      { name, label, prompt, assignment, cwd, agentOptions, agentPreset },
      predecessor,
    )
    name = applied.name
    label = applied.label
    prompt = applied.prompt
    assignment = applied.assignment
    cwd = applied.cwd
    agentOptions = applied.agentOptions
    agentPreset = applied.agentPreset
    // A broken file elsewhere in `team/` does not stop this spawn, and is still reported: that is the
    // "one bad file never hides the others" rule (ADR 0018).
    defined = { definition: loaded.problems.length === 0 ? applied.report : { ...applied.report, problems: loaded.problems } }
  }
  const baseName = typeof name === 'string' && name.length > 0 ? name : predecessor?.name
  if (baseName === undefined) throw new Error('spawn_member: name is required unless replace or definition supplies one')
  const recorded = assignment === undefined ? undefined : checkAssignment(assignment, 'spawn_member')
  // What route the member starts on, resolved after the definition merge (a file may name the route) and
  // before the reservation, so the record and the request carry one answer (ADR 0024). It never throws:
  // a route the plugin cannot resolve is a reason to inherit, not a reason to break a spawn.
  const route = resolveSpawnRoute({ ctx, leadAgent: caller, agentOptions })
  // A successor continues the predecessor's work, so it inherits the recorded assignment unless the
  // model records a different one. Without this, a brief would thin out one generation at a time. A
  // definition's own `assignment` has already lost here when the predecessor had one to inherit (ADR
  // 0019), so this fallback only serves the inline path. Its lifetime is this call's declaration alone:
  // a replacement does not hand over one-shot-ness, because the work it just moved would be orphaned by
  // the next sweep (ADR 0026).
  const planned = withRoute(
    planMember(roster, baseName, label, recorded ?? predecessor?.assignment, declared === LIFETIME.oneShot),
    route.recorded,
  )
  if (predecessor !== undefined) planned.predecessor = predecessor.memberId
  const successorTarget = targetOf(planned)
  // The work this handover is about: what the predecessor still owns on its own board, plus what an
  // earlier retirement left unowned — work with no owner is exactly what a successor is for. The brief
  // names them and the start below hands the same ids over, so both halves quote one list (ADR 0017).
  const inherited = predecessor === undefined
    ? []
    : [...openTasksOf(roster, replace), ...unownedOpenTasks(roster)]
  // The team file wins over the stored template, and both go through the same renderer. The file is read
  // before the reservation and before the start, so a refusal it produces changes nothing.
  const handoff = predecessor === undefined
    ? undefined
    : await resolveHandoffTemplate({ ctx, leadAgent: caller, stored: roster.handoffTemplate, signal })
  const text = predecessor === undefined
    ? prompt
    : handoffPrompt({
      successor: successorTarget,
      predecessor,
      prompt,
      template: handoff?.template,
      // The board travels as ids and titles, bounded: an owned board is what makes the brief carry the
      // work instead of a pointer to someone else's (P2-09, ADR 0017).
      tasks: inherited,
    })
  // Persist the reservation before starting anything: a crash must leave a visible member,
  // never an invisible child.
  await updateRoster(table, leadSessionId, (current) => withMember(current, planned))
  const request = {
    prompt: [{ type: 'text', text }],
    parent: caller,
    ...activationOptions({ cwd, agentOptions, agentPreset }),
  }
  // The resolved route travels as the request's own `agentOptions.provider`/`model`, beside whatever the
  // caller's fields mapped to — never instead of them, and never with an effort added (ADR 0024).
  if (Object.keys(route.requestField).length > 0) {
    request.agentOptions = { ...request.agentOptions, ...route.requestField }
  }
  let started
  try {
    started = await ctx.subagents.startActivation({
      delivery: 'parent',
      childId: planned.childId,
      provider: 'spawn',
      label,
      request,
      signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const failed = { ...planned, phase: PHASE.failed, note: reason }
    const persisted = await updateRoster(table, leadSessionId, (current) => {
      const existing = current.members.find((member) => member.memberId === planned.memberId)
      // Retired while this spawn was in flight: the tombstone wins over the failed reservation.
      if (existing !== undefined && existing.phase === PHASE.retired) return current
      return withMember(current, failed)
    })
    // A capability refusal is an answer the model can act on, not a raw host error. The reservation is
    // already a visible `failed` record, so nothing is left `provisioning` and no child exists.
    const refusal = spawnRefusal(error, { agentOptions, agentPreset })
    if (refusal !== undefined) {
      const record = persisted.members.find((member) => member.memberId === planned.memberId) ?? failed
      const value = {
        ...memberRow(ctx, record),
        ...swept,
        ...defined,
        started: false,
        reason: refusal.reason,
        message: refusal.message,
      }
      if (predecessor !== undefined) {
        value.replaced = replace
        value.predecessor_retired = false
        value.message = `${refusal.message} The predecessor "${replace}" was NOT retired and is still live.`
      }
      return value
    }
    if (predecessor === undefined) throw error
    throw new Error(
      `spawn_member: the successor could not start (${reason}); the predecessor "${replace}" was NOT retired and is still live. Its failed reservation is recorded as "${successorTarget}".`,
    )
  }
  // What the member was started with, in the tool's vocabulary, only for the fields the caller supplied,
  // plus the route source: which of the two paths above actually ran (ADR 0024).
  const applied = startedWith({ cwd, agentOptions, agentPreset }, route.recorded)
  const reported = { started_with: applied }
  // `startedAt` is the evidence the lazy sweep requires: the child was started, so a later observation
  // that it is no longer resident means it ran and stopped (ADR 0013). A non-ephemeral record is
  // unchanged, which is why the field is written only here.
  const active = {
    ...planned,
    childId: started.childId ?? planned.childId,
    phase: PHASE.active,
    ...planned.ephemeral === true ? { startedAt: new Date().toISOString() } : {},
  }
  const persisted = await updateRoster(table, leadSessionId, (current) => {
    const existing = current.members.find((member) => member.memberId === planned.memberId)
    // Retired while the start was in flight: keep the tombstone (and its paths), but record the child
    // that did publish, so a restore moves the right Session and `list_members` shows the right id.
    if (existing !== undefined && existing.phase === PHASE.retired) {
      return withMember(current, { ...existing, childId: active.childId })
    }
    return withMember(current, active)
  })
  const settled = persisted.members.find((member) => member.memberId === planned.memberId) ?? active
  const successor = { ...memberRow(ctx, settled), ...defined }
  if (settled.phase === PHASE.retired) {
    // A retirement committed between the reservation and the activation. Draining happens here,
    // when the child finally publishes: the retire that ran earlier had no child to drain.
    try {
      await ctx.subagents.drainChildren(caller, [active.childId])
    } catch (error) {
      // Draining releases the slot; the record is already retired either way.
    }
    return {
      ...successor,
      ...swept,
      ...reported,
      ...predecessor === undefined ? {} : { replaced: replace, predecessor_retired: false },
      message: `The member was retired while its spawn was in flight; the record stays retired and the child it published was drained.${predecessor === undefined ? '' : ` The predecessor "${replace}" was NOT retired.`}`,
    }
  }
  if (predecessor === undefined) return { ...successor, ...swept, ...reported }

  // The handover, and it is deliberately the first write after the start, before the tombstone and before
  // anything touches the filesystem: the work changes hands once, in one mutation. Writing it first is what
  // makes a retirement whose tombstone write then fails a *partial* lifecycle rather than a silent loss —
  // the successor the caller started still carries the work it was started for, and one more retire_member
  // finishes the record. The reverse order would leave a tombstone whose open work points at nobody when
  // the handover write failed (P2-09, ADR 0017).
  const handover = await handOverTasks(table, leadSessionId, inherited.map((task) => task.id), successorTarget)

  if (predecessor.phase === PHASE.retired) {
    return {
      ...successor,
      ...swept,
      ...reported,
      replaced: replace,
      predecessor_retired: true,
      // What this call actually re-addressed: an earlier retirement left the work unowned, and the
      // replacement that finally arrives is what it was waiting for (P2-09, ADR 0017).
      ...(handover.length === 0 ? {} : { transferred: handover.length, transferred_tasks: handover }),
      message: `Successor ${successorTarget} started from the tombstone's handoff brief; "${replace}" was already retired.${
        handover.length === 0 ? '' : ` Its ${handover.length} open ${handover.length === 1 ? 'task was' : 'tasks were'} handed to ${successorTarget}.`
      }`,
    }
  }

  let retirement
  try {
    retirement = await retireMember({
      ctx,
      table,
      leadSessionId,
      leadAgent,
      dataDir,
      hooks,
      target: replace,
      reason: `Replaced by ${successorTarget}`,
      trashLimit,
      // No `successor`: the handover above already moved this member's open work, and passing it again
      // would report the same ids twice. The retirement is the record half only (P2-09, ADR 0017).
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ...successor,
      ...swept,
      ...reported,
      replaced: replace,
      predecessor_retired: false,
      message: `Successor ${successorTarget} is active, but the predecessor "${replace}" could NOT be retired (${reason}). It is still live; retire it with retire_member.`,
    }
  }
  if (retirement.retired !== true) {
    return {
      ...successor,
      ...swept,
      ...reported,
      replaced: replace,
      predecessor_retired: false,
      message: `Successor ${successorTarget} is active, but the predecessor "${replace}" was not retired: ${retirement.message ?? 'no reason reported'}. Retire it with retire_member.`,
    }
  }
  return {
    ...successor,
    ...swept,
    ...reported,
    replaced: replace,
    predecessor_retired: true,
    ...(handover.length === 0 ? {} : { transferred: handover.length, transferred_tasks: handover }),
    message: `Successor ${successorTarget} started from the handoff brief and the predecessor "${replace}" is retired.${
      handover.length === 0 ? '' : ` Its ${handover.length} open ${handover.length === 1 ? 'task moved' : 'tasks moved'} to ${successorTarget}.`
    } ${retirement.message}`,
  }
}

/**
 * Retire one member: drain, tombstone the record, move its persisted Session aside, confirm the record.
 *
 * The tombstone is written **before** the artifact moves, carrying the intended trash path and a
 * `trashState: 'pending'` marker. What a crash at each point now leaves behind:
 *
 *   1. after the tombstone, before the move — the member is retired in the roster while its artifact is
 *      still in the live store. `restore_member` sees the pending marker, finds no artifact in the
 *      trash, finds the original still where it was, and reactivates the record: there is nothing to
 *      move back.
 *   2. during the move — as (1), except the artifact may already be in the trash; restore looks there
 *      first, so it moves it back when it is there.
 *   3. before the confirming write — the record still says `pending` while the artifact is safe in the
 *      trash. `pending` reads as "the move may or may not have happened", which is exactly how
 *      `restore_member` treats it, so this window is no different from (1) except where the artifact is.
 *
 * The move failing at runtime is reported, never silent: the intended trash fields are dropped, the
 * workspace archive is the fallback that hides a session no artifact could be moved from, and the
 * record says which of the two actually happened (`trashState`, `archived`). `archived` is true only
 * when that fallback ran, so a tombstone never carries both a `trashPath` and `archived: true`.
 *
 * A retirement that actually moved an artifact in then enforces the per-Lead retention cap in the same
 * call (ADR 0011, ADR 0012), because that is the moment the trash grew. It removes the oldest entries
 * past the effective `trashLimit` — the value `apply` resolved from the plugin config, or the
 * documented default when the profile configures nothing — flips each removed tombstone to
 * `trashState: 'pruned'` while keeping its `trashPath`, and reports how many went in `pruned` and what
 * cap it applied. A retirement that moved nothing leaves the trash alone. The platform has no
 * Session-deletion API, so this is the only deletion on the path, and it touches only this plugin's own
 * trash copies.
 *
 * Without a live Lead Agent there is nothing to drain through, so the operation refuses with a reason
 * instead of throwing. The tool path always runs in the Lead's own Agent context; the guard exists so a
 * caller that does not hold the Agent gets a sentence rather than a `TypeError`.
 *
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   target: string, reason?: string, confirmed?: string, consentRequired?: boolean,
 *   trashLimit?: number}} request - `trashLimit` is the effective cap
 *   from the plugin config; it defaults to `DEFAULT_TRASH_LIMIT` for callers that pass none.
 *   `consentRequired` is true on the model's own retirement decision — the `retire_member` tool — and
 *   false on the two internal retirements that are not a decision to end a role: a replacement continues
 *   the role with a new person, and the sweep only ever acts on a member that has already consented to
 *   leaving by being declared one-shot. With it set, the gate protects the person's decision to end a
 *   *role*, not every act of housekeeping: it asks about a standing member only when that member still
 *   carries something, and a bare one is the Lead's to clear on a stated `reason`. A one-shot member and a
 *   record in `retired` or `failed` never reach it at all. `confirmed` is the person's answer, quoted
 *   verbatim (ADR 0026).
 *
 *   There is no `successor` parameter on purpose. A replacement hands its work over itself, through
 *   `handOverTasks`, because it is the only caller that knows the successor and it must be able to do so
 *   whether or not the predecessor's record is still live. What is left here is the un-owning half: a
 *   retirement nobody replaces leaves open work owned by nobody and says which (P2-09, ADR 0017).
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function retireMember({
  ctx,
  table,
  leadSessionId,
  leadAgent,
  dataDir,
  hooks,
  target,
  reason,
  confirmed,
  consentRequired = false,
  trashLimit = DEFAULT_TRASH_LIMIT,
}) {
  if (leadAgent === undefined || leadAgent === null) {
    return {
      target,
      retired: false,
      pruned: 0,
      message: `The Lead Session ${leadSessionId} is not live in this Harness process, so its member cannot be drained. Open that Session again and retry.`,
    }
  }
  const roster = await ensureAdopted(ctx, leadAgent, table, leadSessionId)
  const member = findAnyTarget(roster, target)
  if (member === undefined) {
    throw new Error(`retire_member: no member named "${target}" in the roster, live or retired`)
  }

  // The lifetime gate, before the handover write and before anything is drained or tombstoned: a refusal
  // leaves this retirement's own state untouched — the record, its open work and its artifact — so the
  // question can be answered and the call simply retried. (The adoption read above it is the reconciliation
  // every roster operation performs, not part of this retirement.) The gate protects the person's decision
  // to end a *role*, not every act of housekeeping, so it asks about a standing member only when that
  // member still carries something: a recorded assignment, open work, or evidence it was handed work again
  // and again (ADR 0026). Bare, idle residue is housekeeping — the Lead retires it in one call on a stated
  // `reason`, which the tombstone keeps. Three cases never reach the gate at all: a one-shot member, whose
  // declaration was already the person's consent, and the two phases that never became a role — `retired`
  // has no life left to end, and `failed` never started.
  const lifespan = lifetimeOf(member)
  const quoted = typeof confirmed === 'string' ? confirmed.trim() : ''
  const gaveReason = typeof reason === 'string' && reason.trim().length > 0
  const becameARole = member.phase !== PHASE.retired && member.phase !== PHASE.failed
  let housekeeping = false
  if (consentRequired && becameARole && lifespan === LIFETIME.standing) {
    const carried = carriedBy(roster, member)
    if (carried.carries.length > 0) {
      if (quoted.length === 0) return consentRefusal(member, carried)
    } else if (!gaveReason) {
      // Housekeeping is the Lead's to decide, but it still has to say why: the reason is what the
      // tombstone keeps, so a later reader can tell why the residue was removed.
      return reasonRefusal(member)
    } else {
      housekeeping = true
    }
  }

  // The handover, and it is deliberately the first write: the work loses its owner in one mutation, before
  // the tombstone and before anything touches the filesystem. Writing it first is what makes a retirement
  // whose tombstone write then fails a *partial* lifecycle rather than a silent loss — the work is already
  // unowned, and the one more retire_member that finishes the record has nothing left to move. The reverse
  // order would leave a tombstone whose open work still points at a member that is gone (P2-09, ADR 0017).
  let handover = []
  await updateRoster(table, leadSessionId, (current) => {
    const handed = reownerTasks(current, targetOf(member), undefined)
    handover = handed.moved
    return handed.roster
  })

  if (member.phase === PHASE.retired) {
    // The `retired` row of the state matrix: a repeat is a no-op, not a failure and not an unknown
    // target. Nothing is drained and nothing is moved; the write above is a no-op too, because an
    // already-retired member owns no open work for it to find (P2-09, ADR 0017).
    const { fields, notice } = retargetNotice(roster, target)
    return {
      target: targetOf(member),
      retired: true,
      drained: false,
      pruned: 0,
      lifetime: lifespan,
      reason: 'already-retired',
      message: `"${target}" is already retired; nothing was drained and no artifact was moved.${notice}`,
      ...fields,
    }
  }

  let drained = false
  try {
    await ctx.subagents.drainChildren(leadAgent, [member.childId])
    drained = true
  } catch (error) {
    // A child that never published, or already settled, has nothing to drain. Retirement is a
    // lifecycle fact owned by the record, so it proceeds.
  }

  const retireReason = typeof reason === 'string' && reason.length > 0 ? reason : undefined
  const retiredAt = new Date().toISOString()
  /** Build one tombstone from the record as it is now, plus the fields this call contributes. */
  const tombstoneOf = (existing, fields) => {
    const base = { ...(existing ?? member), phase: PHASE.retired, retiredAt, archived: false, ...fields }
    if (retireReason !== undefined) base.retireReason = retireReason
    return base
  }

  // Step 1: the tombstone, with the trash path the move is about to use. The member's open tasks were
  // already re-addressed to the successor (or left unowned) by the handover write above, so this record
  // only changes its own lifecycle fields.
  const plan = await planMemberTrash(ctx, { leadSessionId, memberId: member.childId, dataDir })
  await updateRoster(table, leadSessionId, (current) => {
    const existing = current.members.find((candidate) => candidate.memberId === member.memberId)
    const fields = plan.planned
      ? {
        trashPath: plan.trashPath,
        trashKind: plan.kind === 'file' ? 'file' : 'directory',
        originalPath: plan.originalPath,
        trashState: TRASH_STATE.pending,
      }
      : { trashState: TRASH_STATE.none }
    return withMember(current, tombstoneOf(existing, fields))
  })

  // Step 2: move the persisted artifact out of the live store. This is what makes the member disappear
  // from the host's own discovery, because session-query drops an artifact that is no longer there.
  let moved = false
  let moveReason = plan.planned ? undefined : plan.reason
  if (plan.planned) {
    const outcome = await applyMemberTrash(plan)
    moved = outcome.moved
    if (!outcome.moved) moveReason = outcome.reason
  }

  let archived = false
  if (!moved) {
    // The workspace archive is the fallback that hides a session whose artifact could not be moved.
    const workspace = ctx.get('workspaceRegistry')
    if (workspace !== undefined) {
      try {
        await workspace.archiveSession(member.childId, { stopActivity: true })
        archived = true
      } catch (error) {
        // Archiving is presentation only; it must never block retirement.
      }
    }
  }

  // Step 3: confirm what actually happened. A tombstone that still named a trash path the artifact
  // never reached would send `restore_member` to the wrong place.
  const persisted = await updateRoster(table, leadSessionId, (current) => {
    const existing = current.members.find((candidate) => candidate.memberId === member.memberId)
    const next = tombstoneOf(existing, {})
    next.archived = archived
    if (moved) {
      next.trashPath = plan.trashPath
      next.trashKind = plan.kind === 'file' ? 'file' : 'directory'
      next.originalPath = plan.originalPath
      next.trashState = TRASH_STATE.done
    } else {
      delete next.trashPath
      delete next.trashKind
      delete next.originalPath
      next.trashState = TRASH_STATE.none
    }
    return withMember(current, next)
  })
  const record = persisted.members.find((candidate) => candidate.memberId === member.memberId)

  // Step 4: bound this Lead's trash, and only here. The move above is the one moment a retirement
  // grows the trash, so it is the one moment the cap is enforced — no timer, no sweep on read. A
  // pruned tombstone keeps its `trashPath` (it still says where the artifact went) and is marked
  // `pruned`, which is what makes `restore_member` refuse with a typed reason instead of lying.
  let pruned = 0
  if (moved) {
    const outcome = await pruneLeadTrash({ trashRoot: plan.trashRoot, limit: trashLimit, members: persisted.members })
    pruned = outcome.pruned
    if (pruned > 0) {
      const removedIds = new Set(outcome.removed.map((entry) => entry.memberId))
      await updateRoster(table, leadSessionId, (current) => {
        let next = current
        for (const candidate of current.members) {
          if (removedIds.has(candidate.memberId)) {
            next = withMember(next, { ...candidate, trashState: TRASH_STATE.pruned })
          }
        }
        return next
      })
    }
  }

  // Both host effects read tombstones through short caches; refresh now so the member leaves the
  // projections every client renders and the freed slot is available to the next spawn.
  hooks.filter.invalidate()
  void hooks.slots.refresh()

  const value = {
    target: targetOf(member),
    retired: true,
    drained,
    archived,
    trashed: moved,
    pruned,
    lifetime: lifespan,
    // What this retirement did to the member's open work: left unowned, with its ids named, so a Lead
    // reading a retirement it did not pair with a replacement sees the work it now owes (P2-09,
    // ADR 0017). A member that owned nothing adds neither field, exactly as before.
    ...(handover.length === 0 ? {} : { unowned: handover.length, unowned_tasks: handover }),
    message: moved
      ? 'Member retired: drained, its session moved to the trash directory, and tombstoned.'
      : `Member retired and tombstoned; the session artifact was not moved (${moveReason ?? 'unknown'}).`,
  }
  if (quoted.length > 0) {
    // The consent is the person's sentence, so the answer quotes it back: the transcript then holds the
    // exact words this retirement was allowed on, which a boolean could never do (ADR 0026).
    value.message += ` It was retired on the person's words, quoted back here: "${quoted}".`
  }
  if (housekeeping) {
    // The narrow half of the gate, said out loud: the Lead acted alone here, and the result is where that
    // is visible rather than inferred from the absence of a question (ADR 0026).
    value.message += ' It carried nothing — no recorded assignment, no open task, no evidence it was re-tasked — so it was removed as housekeeping on the reason you stated, not as a decision about a role.'
  }
  if (handover.length > 0) {
    value.message += ` Its ${handover.length} open ${handover.length === 1 ? 'task is' : 'tasks are'} now unowned: nobody will carry ${handover.length === 1 ? 'it' : 'them'} until a successor starts or an owner is assigned.`
  }
  if (pruned > 0) {
    value.message += ` Retention removed ${pruned} older ${pruned === 1 ? 'artifact' : 'artifacts'} from this Lead's trash: it keeps at most ${trashLimit}, oldest first, because the platform offers no Session deletion of its own (ADR 0011, ADR 0012).`
  }
  if (typeof record?.trashPath === 'string') value.trash_path = record.trashPath
  return value
}

/**
 * Move a retired member's Session back and return the record to active. This one needs no live Lead:
 * it is a filesystem move plus a record write, so it can recover a team whose Lead Session is closed.
 *
 * The result names the branch that actually ran (`reason`), because three different things can be
 * undone and one of them is nothing:
 *
 *   - `moved-back` — the artifact was in the trash and moved to its recorded original path;
 *   - `never-moved` — a `trashState: 'pending'` tombstone whose artifact never reached the trash (the
 *     crash window of `retireMember`); the artifact is still where it belongs, so the record is simply
 *     reactivated;
 *   - `unarchived` — retirement used the workspace-archive fallback, so the session is unhidden;
 *   - `not-archived` — the tombstone records that neither a move nor the archive fallback ran, so
 *     reactivating the record is the whole recovery. No workspace call is made and no success is
 *     claimed for one.
 *
 * A tombstone whose `trashState` is `pruned` is a refusal, not a branch: the retention cap removed the
 * artifact, so the answer is `restored: false, reason: 'pruned'` and the workspace service is never
 * called (ADR 0011). Moving nothing and claiming a restore is the false-success defect this operation
 * has already been repaired for twice.
 *
 * A repeat (an already-active target) is the state matrix's no-op: `restored: true`, reason
 * `already-active`. A tombstone from a version that did not record `archived` is treated as the
 * archive fallback, which is the only branch that version could have taken without a trash path.
 *
 * @param {{ctx: object, table: object, leadSessionId: string, target: string,
 *   hooks: {filter: {invalidate: Function}, slots: {refresh: Function}}}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function restoreMember({ ctx, table, leadSessionId, target, hooks }) {
  const roster = readRoster(table, leadSessionId)
  const member = findAnyTarget(roster, target)
  if (member === undefined) {
    throw new Error(`restore_member: no member named "${target}" in the roster, live or retired`)
  }
  if (member.phase !== PHASE.retired) {
    if (member.phase === PHASE.active) {
      return {
        target: targetOf(member),
        restored: true,
        reason: 'already-active',
        message: `"${target}" is already active; there is no tombstone to restore.`,
      }
    }
    const { fields, notice } = retargetNotice(roster, target)
    return {
      target: targetOf(member),
      restored: false,
      reason: 'not-retired',
      message: `"${target}" is ${member.phase}, not retired; there is nothing to restore.${notice}`,
      ...fields,
    }
  }
  if (hasLiveTarget(roster, target)) {
    throw new Error(`restore_member: a live member already uses "${target}"; retire it first`)
  }
  if (member.trashState === TRASH_STATE.pruned) {
    // The retention cap removed the artifact, so there is nothing to move back — and the workspace
    // must not be asked to unhide a session it never hid. The tombstone keeps its `trashPath`, which
    // is why this check comes before the trash-path branch below (ADR 0011).
    const { fields, notice } = retargetNotice(roster, target)
    return {
      target: targetOf(member),
      restored: false,
      reason: 'pruned',
      message: `"${target}" was pruned by the trash retention cap: the artifact at ${String(member.trashPath)} is gone, so the record stays retired. Start a successor with spawn_member if the work must continue.${notice}`,
      ...fields,
    }
  }

  let restoredPath
  let branch
  if (typeof member.trashPath === 'string') {
    let originalPath = typeof member.originalPath === 'string' ? member.originalPath : undefined
    if (originalPath === undefined) {
      // A tombstone written before the original path was recorded. Derive the sessions root from a
      // sibling still on disk rather than guessing; say so plainly when there is none.
      const sessionsRoot = await sessionRootFromSibling(
        ctx.get('sessionPersistence'),
        roster.members.map((candidate) => candidate.childId),
        member.childId,
      )
      if (sessionsRoot === undefined) {
        return {
          target: targetOf(member),
          restored: false,
          message: 'The tombstone has a trash path but no recorded original path, and no sibling session is on disk to derive the sessions root from. Move the artifact back by hand and re-add the member.',
        }
      }
      originalPath = join(sessionsRoot, member.childId)
    }
    const outcome = await restoreSessionArtifact({
      trashPath: member.trashPath,
      originalPath,
      kind: member.trashKind === 'file' ? 'file' : 'directory',
    })
    if (outcome.restored) {
      branch = 'moved-back'
      restoredPath = outcome.path
    } else if (
      outcome.reason === 'trash-missing'
      && member.trashState === TRASH_STATE.pending
      && await pathExists(originalPath)
    ) {
      branch = 'never-moved'
      restoredPath = originalPath
    } else {
      return {
        target: targetOf(member),
        restored: false,
        message: `Nothing was moved back: ${outcome.reason}. The record stays retired.`,
      }
    }
  } else if (member.archived === false) {
    // Retirement recorded that neither the move nor the workspace archive ran. Reactivating the record
    // is the whole recovery; calling the workspace here would claim a branch that did nothing.
    branch = 'not-archived'
  } else {
    // Retired through the workspace-archive fallback, so unhide instead of moving files.
    const workspace = ctx.get('workspaceRegistry')
    if (workspace === undefined) {
      return {
        target: targetOf(member),
        restored: false,
        message: 'No session artifact was recorded for this member, and no workspace service is available to unhide it. The record stays retired.',
      }
    }
    try {
      await workspace.unarchiveSession(member.childId)
      branch = 'unarchived'
    } catch (error) {
      return {
        target: targetOf(member),
        restored: false,
        message: `The workspace refused to unhide the session (${error instanceof Error ? error.message : String(error)}). The record stays retired.`,
      }
    }
  }

  // Rebuild the record from the one on disk, so a concurrent change to another member survives.
  const persisted = await updateRoster(table, leadSessionId, (current) => {
    const existing = current.members.find((candidate) => candidate.memberId === member.memberId)
    if (existing === undefined || existing.phase !== PHASE.retired) return current
    const revived = { ...existing, phase: PHASE.active }
    delete revived.retiredAt
    delete revived.retireReason
    delete revived.trashPath
    delete revived.trashKind
    delete revived.originalPath
    delete revived.trashState
    delete revived.archived
    return withMember(current, revived)
  })
  const record = persisted.members.find((candidate) => candidate.memberId === member.memberId) ?? member
  hooks.filter.invalidate()
  void hooks.slots.refresh()

  const value = {
    target: targetOf(record),
    restored: true,
    reason: branch,
    message: 'Member restored and active again. A restored session may take one client refresh to reappear.',
  }
  if (typeof restoredPath === 'string') value.path = restoredPath
  // A restore is a lifecycle fact, not a work assignment. Whether the tasks the member used to own come
  // back depends on who took them over while it was gone, and the record cannot tell "the successor
  // carries this" from "nobody does" without guessing across a handover. So it changes no owner and says
  // how much unowned work is still waiting for one (P2-09, ADR 0017).
  const unowned = unownedOpenTasks(readRoster(table, leadSessionId))
  if (unowned.length > 0) {
    value.unowned = unowned.length
    value.unowned_tasks = unowned.map((task) => task.id)
    value.message += ` ${unowned.length} open ${unowned.length === 1 ? 'task is' : 'tasks are'} unowned; assign one with task_board if this member should carry it.`
  }
  return value
}

/**
 * What a refusal for a stale target adds when another generation of that name is live now.
 *
 * A target is namespaced by generation, so a caller holding the predecessor's target after a
 * replacement is refusing the *name*, not the member: naming the live holder is what lets it retarget
 * without re-reading the roster. The refusal itself is unchanged — only what it tells the caller.
 * @param {object} roster - one Lead's roster.
 * @param {string} target - the stale model-facing target.
 * @returns {{fields: object, notice: string}} the result field to merge, and the sentence to append;
 *   both empty when no other generation of the name is live.
 */
function retargetNotice(roster, target) {
  const holder = currentHolderOf(roster, target)
  if (holder === undefined) return { fields: {}, notice: '' }
  const stale = findAnyTarget(roster, target)
  const name = stale === undefined ? target : stale.name
  return {
    fields: { current_holder: holder },
    notice: ` The name "${name}" is now held by "${holder.target}" (generation ${holder.generation}); retarget to that member.`,
  }
}

/**
 * What one standing member still carries, which is what decides whether ending it is a role-level decision.
 *
 * Three facts, each read from the record or the board, and each one the answer to "is there anything here
 * a person would want a say in?": a recorded assignment (the durable statement of what the role was doing),
 * open work on this Lead's board, and the counters that show it was handed work at least `RETASK_MIN`
 * times. A member with none of the three is bare residue: a probe left behind, which the Lead may clear
 * without asking anybody (ADR 0026).
 * @param {object} roster - one Lead's roster.
 * @param {object} member - the standing member being considered.
 * @returns {{tasks: object[], retasked: string[], carries: string[]}} the evidence, and the phrases the
 *   refusal reports it with. `carries` is empty exactly when the member is bare.
 */
function carriedBy(roster, member) {
  const tasks = openTasksOf(roster, targetOf(member))
  const retasked = retaskSignals(member)
  const carries = []
  if (typeof member.assignment === 'string' && member.assignment.length > 0) carries.push('a recorded assignment')
  if (tasks.length > 0) carries.push(`${tasks.length} open ${tasks.length === 1 ? 'task' : 'tasks'}`)
  if (retasked.length > 0) carries.push(`being re-tasked (${retasked.join(' and ')})`)
  return { tasks, retasked, carries }
}

/**
 * The refusal a standing member's retirement answers with, when that member still carries something.
 *
 * The plugin has no human surface (ADR 0008), so a boolean the model sets about itself would be worth
 * nothing. The refusal therefore hands back what the question needs — who the member is, what it still
 * carries, and the sentence to put to the person — and the retirement happens on the next call, which must
 * carry the person's answer quoted. A `confirmed: true` could not be checked; a quoted sentence can,
 * because it stays in the transcript (ADR 0026).
 * @param {object} member - the standing member whose retirement is refused.
 * @param {{tasks: object[], carries: string[]}} carried - what it carries, already read.
 * @returns {object} the refusal result.
 */
function consentRefusal(member, carried) {
  const owns = carried.tasks
  const work = owns.length === 0
    ? 'owns no open task right now'
    : `still owns ${owns.length} open ${owns.length === 1 ? 'task' : 'tasks'} on this board (${owns.map((task) => `"${task.title}"`).join(', ')})`
  const recorded = typeof member.assignment === 'string' ? `, and its recorded assignment is "${member.assignment}"` : ''
  return {
    target: targetOf(member),
    retired: false,
    reason: 'needs-confirmation',
    lifetime: LIFETIME.standing,
    // The machine-readable form of the rule that stopped this call, beside the sentence that explains it:
    // a reader can tell a role with work behind it from bare residue without parsing prose.
    carries: carried.carries,
    question: `Retire the standing member "${targetOf(member)}" (${member.label})? It ${work}${recorded}. Retiring it moves its session to this Lead's trash and leaves any open work it owns unowned.`,
    ...(owns.length === 0 ? {} : { owns_tasks: owns.map((task) => task.id) }),
    ...(typeof member.assignment === 'string' ? { assignment: member.assignment } : {}),
    message: `Nothing was retired. This standing member still carries something — ${carried.carries.join(', ')} — so ending it is a decision about a role rather than housekeeping. Ask the person the question above, then call retire_member again with confirmed set to their answer, quoted verbatim — that sentence is what this plugin treats as the consent. A standing member that carries nothing needs no confirmation, only a stated reason.`,
  }
}

/**
 * The refusal a bare standing member's retirement answers with when the call states no reason.
 *
 * This is the narrow half of the gate, and it is deliberately not a consent refusal: nothing about this
 * member is a role-level decision, so there is nobody to ask. What the call owes is the reason, because the
 * reason is the one thing the tombstone keeps about a removal that leaves no other trace (ADR 0026).
 * @param {object} member - the bare standing member whose retirement is refused.
 * @returns {object} the refusal result.
 */
function reasonRefusal(member) {
  return {
    target: targetOf(member),
    retired: false,
    reason: 'needs-reason',
    lifetime: LIFETIME.standing,
    carries: [],
    message: `Nothing was retired. This standing member carries nothing — no recorded assignment, no open task, no evidence it was re-tasked — so removing it is housekeeping rather than a decision about a role, and this call needs no confirmation. State why with the reason parameter and it retires in one call; the reason is what the tombstone keeps, so a later reader can tell why the residue was cleared.`,
  }
}

/**
 * The refusal one delivery-shaped operation answers for a target it cannot act on.
 *
 * The addressable set is `provisioning | active`; everything else is named by the state it is in, so a
 * message to a tombstone can never read like a message to a target that never existed. The operation,
 * not the caller, composes the sentence: the callers are the tools and a refusal is a result. When the
 * name has moved on to another generation, the refusal also carries that holder (`current_holder`).
 * @param {object} roster - one Lead's roster.
 * @param {string} target - model-facing target.
 * @returns {{reason: 'retired'|'failed'|'missing', message: string, current_holder?: object}}
 */
function refusalFor(roster, target) {
  const member = findAnyTarget(roster, target)
  if (member === undefined) {
    return { reason: 'missing', message: `No member named "${target}" is in this roster.` }
  }
  const { fields, notice } = retargetNotice(roster, target)
  if (member.phase === PHASE.retired) {
    return {
      reason: 'retired',
      message: `"${target}" is retired and cannot be reached. A retired member keeps its tombstone; spawn_member with replace starts its successor.${notice}`,
      ...fields,
    }
  }
  return {
    reason: 'failed',
    message: `"${target}" is failed and cannot be reached. Retire it with retire_member, or replace it with spawn_member.${notice}`,
    ...fields,
  }
}

/**
 * Project one stored task into the row the model renders.
 *
 * A task whose stored content no longer passes the read rules is reported with `problem` rather than
 * dropped: the storage facility validates every record when the domain opens, so a content rule cannot be
 * enforced on load without letting one Lead's stale task hide every roster (ADR 0017). `updated_at` is
 * omitted until the task is written a second time, so a freshly created row shows one timestamp.
 * @param {object} task - the stored task.
 * @returns {object} the row.
 */
function taskRow(task) {
  const row = { id: task.id, title: task.title, status: task.status }
  if (typeof task.owner === 'string') row.owner = task.owner
  if (typeof task.body === 'string') row.body = task.body
  if (typeof task.created_at === 'string') row.created_at = task.created_at
  if (typeof task.updated_at === 'string') row.updated_at = task.updated_at
  const problems = [taskTitleProblem(task.title), taskBodyProblem(task.body)]
    .filter((problem) => problem !== undefined)
  if (problems.length > 0) row.problem = problems.join('; ')
  return row
}

/**
 * What is unusable about one stored task title, or undefined when it renders fine.
 * The write path refuses these (`checkTaskTitle`); this is the read path for a stored value that predates
 * the rule or was hand-edited, and it reports instead of throwing.
 * @param {unknown} title - the stored title.
 * @returns {string|undefined} the problem.
 */
function taskTitleProblem(title) {
  if (typeof title !== 'string' || title.trim().length === 0) return 'title is not a non-empty string'
  if (title.length > TASK_TITLE_MAX) return `title is ${title.length} characters; the cap is ${TASK_TITLE_MAX}`
  return undefined
}

/**
 * What is unusable about one stored task body, or undefined when it renders fine.
 *
 * The body follows the same split as the title (ADR 0020): the write path refuses these
 * (`checkTaskBody`), and the read path reports a stored value that predates the rule or was hand-edited.
 * A body past the cap is still served — it is the row's own text, and dropping it would lose the
 * acceptance criteria the field exists for — while the `problem` says why the row is over its bound.
 * @param {unknown} body - the stored body.
 * @returns {string|undefined} the problem.
 */
function taskBodyProblem(body) {
  if (body === undefined) return undefined
  if (typeof body !== 'string' || body.trim().length === 0) return 'body is not a non-empty string'
  if (body.length > TASK_BODY_MAX) return `body is ${body.length} characters; the cap is ${TASK_BODY_MAX}`
  return undefined
}

/**
 * The open task count one task operation reports beside its row.
 * @param {object} roster - the roster as persisted.
 * @returns {number} how many tasks are still open.
 */
function openTaskCount(roster) {
  return tasksOf(roster).filter((task) => task.status === TASK_STATUS.open).length
}

/**
 * The open tasks nobody owns: what a retirement without a successor leaves behind, and what a restore or
 * a `list` reports so the Lead can see the work waiting for an owner (P2-09, ADR 0017).
 * @param {object} roster - one Lead's roster.
 * @returns {object[]} open tasks with no owner.
 */
function unownedOpenTasks(roster) {
  return tasksOf(roster).filter((task) => task.status === TASK_STATUS.open && task.owner === undefined)
}

/**
 * The work one member owns, read by that member.
 *
 * The filter is the whole authority model: only rows whose `owner` is exactly this member's target are
 * returned, so another member's work and every unowned row are invisible here. The target is read from the
 * roster row the caller's Session matched, never from an argument, because a caller-supplied name would be
 * a second, unverified way to address someone else's work. A member that owns nothing gets an empty list and
 * a sentence, not an error: owning no work is a normal state, and an error would tell a member its tool is
 * broken. The rows are projected through the same `taskRow` the Lead's board uses, so the body, the status
 * and the read-time `problem` are the same facts the Lead sees.
 * @param {{roster: object, member: object}} scope - the roster that names this member, and its row.
 * @returns {object} the tool's result object.
 */
export function listMyTasks({ roster, member }) {
  const target = targetOf(member)
  const tasks = tasksOf(roster)
    .filter((task) => task.owner === target)
    .map((task) => taskRow(task))
  const open = tasks.filter((task) => task.status === TASK_STATUS.open).length
  const value = { target, tasks, open }
  value.message = tasks.length === 0
    ? 'You own no tasks on this Team\'s board. Only the Lead writes it; report finished work in your reply.'
    : `You own ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}: ${open} open and ${tasks.length - open} done. This read is the whole list; only the Lead can change it.`
  return value
}

/**
 * Give a set of task ids one owner, in one serialized write, and return the ids that actually changed.
 *
 * Ids rather than a target, because the caller has already decided *which* work moves: a replacement moves
 * what the predecessor owned plus what nobody owned, while a plain retirement moves nothing. Splitting
 * "which" from "to whom" is what keeps the two paths from needing two mutations of the same list.
 * @param {object} table - roster table.
 * @param {string} leadSessionId - the Lead whose roster changes.
 * @param {string[]} taskIds - ids to hand over.
 * @param {string} owner - the target that takes them.
 * @returns {Promise<string[]>} the ids that moved.
 */
async function handOverTasks(table, leadSessionId, taskIds, owner) {
  const wanted = new Set(taskIds)
  let moved = []
  await updateRoster(table, leadSessionId, (current) => {
    const tasks = tasksOf(current).map((task) => {
      if (!wanted.has(task.id) || task.status !== TASK_STATUS.open) return task
      moved.push(task.id)
      return { ...task, owner }
    })
    return { ...current, tasks }
  })
  return moved
}

/**
 * Read, create, update, release or delete tasks on this Lead's board.
 *
 * The board is one array on the Lead's roster record next to `handoffTemplate`, and it is what a
 * replacement hands over: the open tasks of the predecessor move to the successor in the same call that
 * retires it, and a retirement without a successor leaves them unowned and says so (ADR 0017).
 *
 * One tool with an action enum rather than five tools: the surface is already eight names, the five
 * operations share one row shape and one refusal vocabulary, and each action carries at most three extra
 * fields. The enum is the only thing that selects a behaviour, so the schema stays readable to the model:
 * one string enum, and optional fields whose descriptions say which action reads them.
 *
 * An `owner` of `null` is how a caller states "nobody owns this now"; omitting the field leaves ownership
 * untouched. A `body` of `null` is the same statement about the task's text. `release` is the named
 * shorthand for exactly that, on a task that stays open. `delete` removes the row in one call rather than
 * requiring `done` first, because a task nobody needs is not a lifecycle question.
 *
 * **Every id-addressed write is built from the record as stored, inside the serialized mutation.** The
 * read at the top of this function is a *snapshot used to state the premise*, never a row to write back:
 * a handover that lands between the read and the write must not be undone by this call, so `update`
 * applies only the fields it names to the row it finds, and `release`/`delete` — whose whole effect is to
 * take something away — answer `changed: false` when the row's `status`/`owner` is no longer the one the
 * call read. The re-read costs no schema change and asks the model to track no revision (ADR 0017 point 5,
 * ADR 0020).
 *
 * @param {{table: object, leadSessionId: string, action: string, task_id?: string, title?: string,
 *   owner?: string|null, status?: string, body?: string|null}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function taskBoard({ table, leadSessionId, action, task_id, title, owner, status, body }) {
  const roster = readRoster(table, leadSessionId)
  const source = `task_board: ${action}`
  /** The task an id-addressed action works on, or a refusal naming the id. */
  const requireTask = () => {
    if (typeof task_id !== 'string' || task_id.length === 0) {
      throw new Error(`${source}: task_id must be a non-empty string`)
    }
    const task = findTask(roster, task_id)
    if (task === undefined) throw new Error(`${source}: no task with the id "${task_id}"`)
    return task
  }
  /**
   * Resolve an owner handle to a stored target against the record the write will land on.
   * `current` is passed in because the member list is part of the same record as the task: resolving it
   * from the snapshot would let a member retired between the read and the write slip through.
   */
  const resolveOwner = (current) => {
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new Error(`${source}: owner must be a non-empty member target, or null to leave the task unowned`)
    }
    const member = findAnyTarget(current, owner)
    if (member === undefined) {
      throw new Error(`${source}: no member named "${owner}" in this roster; pass a target list_members reports, or null for no owner`)
    }
    return targetOf(member)
  }
  /** The row the mutation found, or a refusal naming the id — the same answer a vanished row gets. */
  const storedTask = (current, taskId) => {
    const task = findTask(current, taskId)
    if (task === undefined) throw new Error(`${source}: no task with the id "${taskId}"`)
    return task
  }

  // Status is a task fact every action reads, so it is validated once, before the branch that consumes it.
  if (status !== undefined && typeof TASK_STATUS[status] !== 'string') {
    throw new Error(`${source}: status must be "open" or "done"`)
  }

  if (action === 'list') {
    const tasks = tasksOf(roster).map((task) => taskRow(task))
    const waiting = tasks.filter((task) => task.status === TASK_STATUS.open && task.owner === undefined)
    const value = {
      action,
      tasks,
      open: tasks.filter((task) => task.status === TASK_STATUS.open).length,
    }
    if (tasks.length > 0) {
      value.message = `${tasks.length} task${tasks.length === 1 ? '' : 's'} on this Lead's board.`
    }
    if (waiting.length > 0) {
      value.unowned = waiting.length
      value.unowned_tasks = waiting.map((task) => task.id)
      value.message = `${value.message ?? ''} ${waiting.length} open ${waiting.length === 1 ? 'task is' : 'tasks are'} unowned: nobody carries ${waiting.length === 1 ? 'it' : 'them'} until a successor starts or an owner is assigned.`.trim()
    }
    return value
  }

  if (action === 'create') {
    if (owner === null) throw new Error(`${source}: owner must be a member target or omitted, not null`)
    if (body === null) throw new Error(`${source}: body must be a string or omitted, not null`)
    if (status !== undefined) throw new Error(`${source}: a new task is always open; set its status with update`)
    let task
    // The cap is checked against the record the write lands on, which is the only place both the current
    // list and the new entry are known (ADR 0017 point 6).
    const persisted = await updateRoster(table, leadSessionId, (current) => {
      const planned = planTask(current, { title, owner: undefined, body }, source)
      if (owner !== undefined) planned.owner = resolveOwner(current)
      task = planned
      return withTask(current, planned)
    })
    const value = {
      action,
      task: taskRow(findTask(persisted, task.id) ?? task),
      open: openTaskCount(persisted),
      message: 'Task created. A replacement hands its open tasks to the successor; a retirement without one leaves them unowned and reports their ids.',
    }
    if (task.body !== undefined) {
      value.message += ' The body travels with the row and the successor reads it from the board; a handover brief names the id and title only.'
    }
    return value
  }

  if (action === 'update') {
    const existing = requireTask()
    if (status === undefined && owner === undefined && body === undefined) {
      throw new Error(`${source}: nothing to change; pass status, owner or body`)
    }
    let outcome
    const persisted = await updateRoster(table, leadSessionId, (current) => {
      const stored = storedTask(current, existing.id)
      const next = { ...stored }
      if (status !== undefined) next.status = status
      if (owner !== undefined) {
        if (owner === null) delete next.owner
        else next.owner = resolveOwner(current)
      }
      if (body !== undefined) {
        if (body === null) delete next.body
        else next.body = checkTaskBody(body, source)
      }
      // Only the fields the call named are applied, so a row that moved on keeps everything it did not
      // ask about. `stored` is the row as it is now; `next` differs from it by exactly what was named.
      if (next.status === stored.status && next.owner === stored.owner && next.body === stored.body) {
        outcome = { changed: false, task: stored }
        return current
      }
      next.updated_at = new Date().toISOString()
      outcome = { changed: true, task: next }
      return withTask(current, next)
    })
    if (!outcome.changed) {
      return {
        action,
        task: taskRow(outcome.task),
        changed: false,
        message: `Task ${existing.id} already has that status, owner and body; nothing was written.`,
      }
    }
    const row = findTask(persisted, existing.id) ?? outcome.task
    return {
      action,
      task: taskRow(row),
      changed: true,
      open: openTaskCount(persisted),
      message: row.status === TASK_STATUS.done
        ? 'Task marked done: it no longer moves with a handover.'
        : 'Task updated.',
    }
  }

  if (action === 'release') {
    const existing = requireTask()
    if (existing.owner === undefined) {
      return {
        action,
        task: taskRow(existing),
        changed: false,
        message: `Task ${existing.id} is already unowned; nothing was written.`,
      }
    }
    let outcome
    const persisted = await updateRoster(table, leadSessionId, (current) => {
      const stored = storedTask(current, existing.id)
      if (stored.owner === undefined) {
        outcome = { changed: false, task: stored, taken: false }
        return current
      }
      // The release says "the owner this call read no longer carries it". Once somebody else has taken
      // the row over, writing the snapshot's owner away would undo the handover that gave it to them.
      if (stored.owner !== existing.owner) {
        outcome = { changed: false, task: stored, taken: true }
        return current
      }
      const next = { ...stored, updated_at: new Date().toISOString() }
      delete next.owner
      outcome = { changed: true, task: next }
      return withTask(current, next)
    })
    if (!outcome.changed) {
      const ownerNow = outcome.task.owner
      return {
        action,
        task: taskRow(outcome.task),
        changed: false,
        message: outcome.taken
          ? `Task ${existing.id} is now owned by "${ownerNow}", not the "${existing.owner}" this call read; nothing was written. Release it again to un-own it.`
          : `Task ${existing.id} is already unowned; nothing was written.`,
      }
    }
    return {
      action,
      task: taskRow(findTask(persisted, existing.id) ?? outcome.task),
      changed: true,
      message: 'Task released: it is still open and now unowned, ready for the next member that should carry it.',
    }
  }

  const existing = requireTask()
  let outcome
  const persisted = await updateRoster(table, leadSessionId, (current) => {
    const stored = storedTask(current, existing.id)
    if (stored.status !== existing.status || stored.owner !== existing.owner) {
      // A delete would remove the row a handover just claimed, or one somebody just finished. Its effect
      // is subtraction, so it acts only on the state it read and reports the one it found (ADR 0020).
      outcome = { changed: false, task: stored }
      return current
    }
    outcome = { changed: true }
    return { ...current, tasks: tasksOf(current).filter((candidate) => candidate.id !== existing.id) }
  })
  if (!outcome.changed) {
    const moved = []
    if (outcome.task.status !== existing.status) moved.push(`status is now "${outcome.task.status}"`)
    if (outcome.task.owner !== existing.owner) {
      moved.push(outcome.task.owner === undefined ? 'it is now unowned' : `owner is now "${outcome.task.owner}"`)
    }
    return {
      action,
      task: taskRow(outcome.task),
      changed: false,
      message: `Task ${existing.id} changed since this call read it: ${moved.join(', ')}; nothing was deleted. Delete it again to remove it.`,
    }
  }
  return {
    action,
    deleted: existing.id,
    changed: true,
    open: openTaskCount(persisted),
    message: 'Task deleted. A replacement can no longer hand it over; re-create it if the work is still owed.',
  }
}


/**
 * Deliver one message to a live member, optionally replacing the assignment recorded for it.
 *
 * The assignment is the durable statement a successor is briefed with, and the moment the Lead tells a
 * member what to do is the moment that statement changes. It is stored only after the message is
 * accepted, so a refused delivery does not silently rewrite the record.
 *
 * **A message re-opens a one-shot member; it does not re-declare it.** The lifetime is the declaration
 * the Lead made when the member was created and only a spawn can change it, so this write leaves
 * `ephemeral` alone and instead invalidates the "it ran and stopped" evidence by dropping `startedAt`;
 * the next read that observes the child alive again re-stamps it, and until then a sweep cannot conclude
 * anything about a member that was just handed work (§2 of `docs/member-lifecycle-en.md`, ADR 0026). It also counts what it wrote —
 * one message, and one assignment change when one was recorded — which is the evidence
 * `list_members` advises on, and it counts them only on a one-shot member, because they exist for that
 * advice.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   target: string, message: string, assignment?: string, signal?: AbortSignal}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function messageMember({ ctx, table, leadSessionId, leadAgent, target, message, assignment, signal }) {
  const caller = requireLiveLead('message_member', leadSessionId, leadAgent)
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const member = findByTarget(roster, target)
  if (member === undefined) {
    // The refusal carries its own fields, including the current holder of a name that moved on.
    return { target, sent: false, ...refusalFor(roster, target) }
  }
  const recorded = assignment === undefined ? undefined : checkAssignment(assignment, 'message_member')
  let messageId
  try {
    messageId = await ctx.subagents.sendMessage(
      caller,
      member.childId,
      [{ type: 'text', text: message }],
      { signal },
    )
  } catch (error) {
    throw new Error(`message_member: the subagent service rejected the message: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = {
    target: targetOf(member),
    sent: true,
    lifetime: lifetimeOf(member),
    message: 'Message accepted. A running member sees it at its next step; an unloaded one is resumed.',
  }
  if (typeof messageId === 'string') value.message_id = messageId
  const oneShot = member.ephemeral === true
  // Every accepted message writes the record, and counts itself on **every** member, not only a one-shot
  // one: the retirement gate reads `messageCount`/`assignmentCount` to tell a member handed work again and
  // again from bare residue, and a standing member never had those counters written before v0.25.1, so the
  // evidence for it would have been permanently empty (ADR 0026). `list_members` still shows the re-task
  // advice on one-shot members only, because that advice is a correction for a declaration.
  await updateRoster(table, leadSessionId, (current) => {
    // Rebuild from the record on disk, so a concurrent edit to another member survives and a tombstone
    // written while the message was in flight is not overwritten with a stale snapshot.
    const base = current.members.find((candidate) => candidate.memberId === member.memberId) ?? member
    const next = { ...base }
    if (recorded !== undefined) next.assignment = recorded
    next.messageCount = (base.messageCount ?? 0) + 1
    if (recorded !== undefined) next.assignmentCount = (base.assignmentCount ?? 0) + 1
    // Only a one-shot member has finished-evidence to invalidate; a standing member is never swept.
    if (next.ephemeral === true) delete next.startedAt
    return withMember(current, next)
  })
  if (recorded !== undefined) value.assignment = recorded
  if (oneShot) {
    value.reopened = true
    value.message += ' It is one-shot, and its lifetime is unchanged: the message re-opened it, so the next sweep leaves it alone until it has run and stopped again.'
  }
  return value
}

/**
 * Cancel one member's current turn, keeping its activation and inbox.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined, target: string}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function stopMember({ ctx, table, leadSessionId, leadAgent, target }) {
  const caller = requireLiveLead('stop_member', leadSessionId, leadAgent)
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const member = findByTarget(roster, target)
  if (member === undefined) {
    // The refusal carries its own fields, including the current holder of a name that moved on.
    return { target, stopped: false, ...refusalFor(roster, target) }
  }
  if (ctx.agents.get(member.childId) === undefined) {
    return {
      target: targetOf(member),
      stopped: true,
      resident: false,
      message: 'The member was not resident; nothing to stop.',
    }
  }
  ctx.subagents.interrupt(member.childId, { kind: 'ancestor', agent: caller })
  return {
    target: targetOf(member),
    stopped: true,
    resident: true,
    message: 'Its current turn was cancelled. The activation and its inbox are kept; message_member wakes it again.',
  }
}
