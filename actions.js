/**
 * The roster operations, called by the model-facing tools in `index.js`.
 *
 * `index.js` validates arguments, checks that the model caller is a Team Lead, and returns the result
 * unchanged. The bodies live here so the six lifecycle operations read as one file rather than as tool
 * closures; the plugin has no second, browser-facing caller (ADR 0008).
 *
 * `leadAgent` is explicit rather than read from the caller: only a live Lead yields
 * `ctx.agents.get(leadSessionId)`, and `drainChildren`, `interrupt` and `startActivation` all need that
 * Agent. When it is absent the operation says so instead of throwing a `TypeError` from a missing
 * `session` field.
 *
 * `sweepEphemeral` is the one operation here that is not a tool of its own: it retires finished
 * ephemeral members and runs only at the start of `list_members` and `spawn_member` (ADR 0013).
 *
 * No `@deepseek-ai/*` import: a profile-linked bundle cannot resolve those packages (ADR 0002).
 */

import { join } from 'node:path'

import {
  PHASE,
  TRASH_STATE,
  adoptMember,
  checkAssignment,
  findByTarget,
  findAnyTarget,
  hasLiveTarget,
  liveStateOf,
  planMember,
  readRoster,
  targetOf,
  updateRoster,
  withMember,
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

/** Project one stored member into the row the model renders. */
export function memberRow(ctx, member) {
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
  // A member that will leave on its own once its work is over is worth seeing before relying on it.
  if (member.ephemeral === true) row.ephemeral = true
  return row
}

/**
 * Compose the short, self-contained prompt a cold successor starts from.
 *
 * The successor has no transcript of the predecessor and must not be handed one: it needs to know what
 * the work is, that it is the successor, and that the predecessor is gone. The work itself stays on the
 * shared team task board, which this plugin does not own, so the brief points at the board by the
 * predecessor's name instead of copying it.
 * @param {{successor: string, predecessor: object, prompt: string}} request
 * @returns {string} the prompt handed to `startActivation`.
 */
export function handoffPrompt({ successor, predecessor, prompt }) {
  const target = targetOf(predecessor)
  const doing = typeof predecessor.assignment === 'string' && predecessor.assignment.length > 0
    ? predecessor.assignment
    : 'not recorded; take it from the shared team task board'
  return [
    `You are ${successor}, the successor of ${target}. ${target} has been retired and is gone; it cannot be messaged.`,
    `Its role was: ${predecessor.label}.`,
    `What it was doing: ${doing}`,
    `Its unfinished work is still on the shared team task board under the name "${target}": take those tasks over instead of redoing finished work, and ask the Lead for their ids if you cannot read the board.`,
    `Your task: ${prompt}`,
  ].join('\n')
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
 * The lazy sweep: retire every ephemeral member whose work is over, at the start of the two roster
 * operations the model calls anyway.
 *
 * The Harness has no completion event — an active child that finishes its turn produces no durable
 * change (§4.3 of `docs/architecture-en.md`) — so the sweep requires evidence this plugin recorded
 * itself: the member is `active` and `ephemeral`, carries `startedAt` (written when its activation
 * resolved, so a reservation that never published has none), and is no longer resident in the local live
 * registry. A member that never started is never swept, and neither is a running one. The installed
 * subagent seam reports a descendant row's `activity` as only `running | inactive`, and `inactive` also
 * describes a child that never started, so the local registry is what decides (ADR 0013).
 *
 * Retirement is the existing protocol, not a second implementation: every candidate goes through
 * `retireMember`, with `retireReason: 'ephemeral member: its turn ended'` on the tombstone.
 *
 * It calls no model and no clock, and returns no fields at all when nothing was retired, so a profile
 * that never sets the flag sees results exactly as they were before this feature.
 *
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   trashLimit?: number}} request
 * @returns {Promise<{swept?: number, swept_targets?: string[]}>} the report fields, or `{}`.
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
  const finished = readRoster(table, leadSessionId).members.filter((member) => member.phase === PHASE.active
    && member.ephemeral === true
    && typeof member.startedAt === 'string'
    && liveStateOf(ctx, member).resident === false)
  if (finished.length === 0) return {}
  const swept = []
  for (const member of finished) {
    const outcome = await retireMember({
      ctx,
      table,
      leadSessionId,
      leadAgent,
      dataDir,
      hooks,
      target: targetOf(member),
      reason: 'ephemeral member: its turn ended',
      trashLimit,
    })
    // A member another caller retired in between answers `already-retired`; it is not this sweep's doing.
    if (outcome.retired === true && outcome.reason !== 'already-retired') swept.push(targetOf(member))
  }
  return swept.length === 0 ? {} : { swept: swept.length, swept_targets: swept }
}

/**
 * List one Lead's roster.
 *
 * This read is one of the two sweep triggers (ADR 0013): it first retires every ephemeral member whose
 * turn has ended, so the rows it returns already show those members as `retired` and the result reports
 * `swept` and `swept_targets` when the sweep retired anyone.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   trashLimit?: number}} request
 * @returns {Promise<{members: object[]}>} the tool's result object, unchanged.
 */
export async function listMembers({ ctx, table, leadSessionId, leadAgent, dataDir, hooks, trashLimit = DEFAULT_TRASH_LIMIT }) {
  const caller = requireLiveLead('list_members', leadSessionId, leadAgent)
  const swept = await sweepEphemeral({ ctx, table, leadSessionId, leadAgent: caller, dataDir, hooks, trashLimit })
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  return { members: roster.members.map((member) => memberRow(ctx, member)), ...swept }
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
 * This is the second sweep trigger (ADR 0013): the call first retires every finished ephemeral member, so
 * the fan-out that follows sees the slots those members were holding.
 *
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   name?: string, label: string, prompt: string, assignment?: string, replace?: string,
 *   ephemeral?: boolean, signal?: AbortSignal, trashLimit?: number}} request - `trashLimit` is the
 *   effective cap from the plugin config; the retirement half of a replacement enforces it, and it
 *   defaults to `DEFAULT_TRASH_LIMIT` for callers that pass none. `ephemeral` records the member as
 *   one-shot (§4.3.1).
 * @returns {Promise<object>} the member row the tool returns.
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
  ephemeral = false,
  signal,
  trashLimit = DEFAULT_TRASH_LIMIT,
}) {
  const caller = requireLiveLead('spawn_member', leadSessionId, leadAgent)
  const swept = await sweepEphemeral({ ctx, table, leadSessionId, leadAgent: caller, dataDir, hooks, trashLimit })
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const predecessor = replace === undefined
    ? undefined
    : roster.members.find((member) => targetOf(member) === replace)
  if (replace !== undefined && predecessor === undefined) {
    throw new Error(`spawn_member: no member named "${replace}" in the roster, live or retired`)
  }
  const baseName = typeof name === 'string' && name.length > 0 ? name : predecessor?.name
  if (baseName === undefined) throw new Error('spawn_member: name is required unless replace is given')
  const recorded = assignment === undefined ? undefined : checkAssignment(assignment, 'spawn_member')
  // A successor continues the predecessor's work, so it inherits the recorded assignment unless the
  // model records a different one. Without this, a brief would thin out one generation at a time.
  const planned = planMember(roster, baseName, label, recorded ?? predecessor?.assignment, ephemeral === true)
  if (predecessor !== undefined) planned.predecessor = predecessor.memberId
  const successorTarget = targetOf(planned)
  const text = predecessor === undefined
    ? prompt
    : handoffPrompt({ successor: successorTarget, predecessor, prompt })
  // Persist the reservation before starting anything: a crash must leave a visible member,
  // never an invisible child.
  await updateRoster(table, leadSessionId, (current) => withMember(current, planned))
  let started
  try {
    started = await ctx.subagents.startActivation({
      delivery: 'parent',
      childId: planned.childId,
      provider: 'spawn',
      label,
      request: { prompt: [{ type: 'text', text }], parent: caller },
      signal,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const failed = { ...planned, phase: PHASE.failed, note: reason }
    await updateRoster(table, leadSessionId, (current) => {
      const existing = current.members.find((member) => member.memberId === planned.memberId)
      // Retired while this spawn was in flight: the tombstone wins over the failed reservation.
      if (existing !== undefined && existing.phase === PHASE.retired) return current
      return withMember(current, failed)
    })
    if (predecessor === undefined) throw error
    throw new Error(
      `spawn_member: the successor could not start (${reason}); the predecessor "${replace}" was NOT retired and is still live. Its failed reservation is recorded as "${successorTarget}".`,
    )
  }
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
  const successor = memberRow(ctx, settled)
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
      ...predecessor === undefined ? {} : { replaced: replace, predecessor_retired: false },
      message: `The member was retired while its spawn was in flight; the record stays retired and the child it published was drained.${predecessor === undefined ? '' : ` The predecessor "${replace}" was NOT retired.`}`,
    }
  }
  if (predecessor === undefined) return { ...successor, ...swept }

  if (predecessor.phase === PHASE.retired) {
    return {
      ...successor,
      ...swept,
      replaced: replace,
      predecessor_retired: true,
      message: `Successor ${successorTarget} started from the tombstone's handoff brief; "${replace}" was already retired.`,
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
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ...successor,
      ...swept,
      replaced: replace,
      predecessor_retired: false,
      message: `Successor ${successorTarget} is active, but the predecessor "${replace}" could NOT be retired (${reason}). It is still live; retire it with retire_member.`,
    }
  }
  if (retirement.retired !== true) {
    return {
      ...successor,
      ...swept,
      replaced: replace,
      predecessor_retired: false,
      message: `Successor ${successorTarget} is active, but the predecessor "${replace}" was not retired: ${retirement.message ?? 'no reason reported'}. Retire it with retire_member.`,
    }
  }
  return {
    ...successor,
    ...swept,
    replaced: replace,
    predecessor_retired: true,
    message: `Successor ${successorTarget} started from the handoff brief and the predecessor "${replace}" is retired. ${retirement.message}`,
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
 *   target: string, reason?: string, trashLimit?: number}} request - `trashLimit` is the effective cap
 *   from the plugin config; it defaults to `DEFAULT_TRASH_LIMIT` for callers that pass none.
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
  if (member.phase === PHASE.retired) {
    // The `retired` row of the state matrix: a repeat is a no-op, not a failure and not an unknown
    // target. Nothing is drained, nothing is moved, and the tombstone is left exactly as it is.
    return {
      target: targetOf(member),
      retired: true,
      drained: false,
      pruned: 0,
      reason: 'already-retired',
      message: `"${target}" is already retired; nothing was drained and no artifact was moved.`,
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

  // Step 1: the tombstone, with the trash path the move is about to use.
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
    message: moved
      ? 'Member retired: drained, its session moved to the trash directory, and tombstoned.'
      : `Member retired and tombstoned; the session artifact was not moved (${moveReason ?? 'unknown'}).`,
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
    return {
      target: targetOf(member),
      restored: false,
      reason: 'not-retired',
      message: `"${target}" is ${member.phase}, not retired; there is nothing to restore.`,
    }
  }
  if (hasLiveTarget(roster, target)) {
    throw new Error(`restore_member: a live member already uses "${target}"; retire it first`)
  }
  if (member.trashState === TRASH_STATE.pruned) {
    // The retention cap removed the artifact, so there is nothing to move back — and the workspace
    // must not be asked to unhide a session it never hid. The tombstone keeps its `trashPath`, which
    // is why this check comes before the trash-path branch below (ADR 0011).
    return {
      target: targetOf(member),
      restored: false,
      reason: 'pruned',
      message: `"${target}" was pruned by the trash retention cap: the artifact at ${String(member.trashPath)} is gone, so the record stays retired. Start a successor with spawn_member if the work must continue.`,
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
  return value
}

/**
 * The refusal one delivery-shaped operation answers for a target it cannot act on.
 *
 * The addressable set is `provisioning | active`; everything else is named by the state it is in, so a
 * message to a tombstone can never read like a message to a target that never existed. The operation,
 * not the caller, composes the sentence: the callers are the tools and a refusal is a result.
 * @param {object} roster - one Lead's roster.
 * @param {string} target - model-facing target.
 * @returns {{reason: 'retired'|'failed'|'missing', message: string, member?: object}}
 */
function refusalFor(roster, target) {
  const member = findAnyTarget(roster, target)
  if (member === undefined) {
    return { reason: 'missing', message: `No member named "${target}" is in this roster.` }
  }
  if (member.phase === PHASE.retired) {
    return {
      reason: 'retired',
      message: `"${target}" is retired and cannot be reached. A retired member keeps its tombstone; spawn_member with replace starts its successor.`,
    }
  }
  return {
    reason: 'failed',
    message: `"${target}" is failed and cannot be reached. Retire it with retire_member, or replace it with spawn_member.`,
  }
}

/**
 * Deliver one message to a live member, optionally replacing the assignment recorded for it.
 *
 * The assignment is the durable statement a successor is briefed with, and the moment the Lead tells a
 * member what to do is the moment that statement changes. It is stored only after the message is
 * accepted, so a refused delivery does not silently rewrite the record.
 *
 * Messaging an ephemeral member **clears the flag** in that same write: sending it work again is a
 * declaration that it is not one-shot after all, and this is the one case where a later sweep would
 * otherwise retire work the model intended to keep (§4.3.1, ADR 0013).
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   target: string, message: string, assignment?: string, signal?: AbortSignal}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function messageMember({ ctx, table, leadSessionId, leadAgent, target, message, assignment, signal }) {
  const caller = requireLiveLead('message_member', leadSessionId, leadAgent)
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const member = findByTarget(roster, target)
  if (member === undefined) {
    const refusal = refusalFor(roster, target)
    return { target, sent: false, reason: refusal.reason, message: refusal.message }
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
    message: 'Message accepted. A running member sees it at its next step; an unloaded one is resumed.',
  }
  if (typeof messageId === 'string') value.message_id = messageId
  const clearsEphemeral = member.ephemeral === true
  if (recorded !== undefined || clearsEphemeral) {
    // Rebuild from the record on disk, so a concurrent edit to another member survives and a tombstone
    // written while the message was in flight is not overwritten with a stale snapshot.
    await updateRoster(table, leadSessionId, (current) => {
      const existing = current.members.find((candidate) => candidate.memberId === member.memberId)
      const next = { ...(existing ?? member) }
      if (recorded !== undefined) next.assignment = recorded
      if (clearsEphemeral) delete next.ephemeral
      return withMember(current, next)
    })
    if (recorded !== undefined) value.assignment = recorded
    if (clearsEphemeral) value.ephemeral = false
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
    const refusal = refusalFor(roster, target)
    return { target, stopped: false, reason: refusal.reason, message: refusal.message }
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
