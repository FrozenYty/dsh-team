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
 * No `@deepseek-ai/*` import: a profile-linked bundle cannot resolve those packages (ADR 0002).
 */

import { join } from 'node:path'

import {
  PHASE,
  adoptMember,
  findByTarget,
  findRetired,
  hasLiveTarget,
  liveStateOf,
  planMember,
  readRoster,
  targetOf,
  updateRoster,
  withMember,
  writeRoster,
} from './roster.js'
import { restoreSessionArtifact, sessionRootFromSibling, trashMemberSession } from './trash.js'

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
        if (typeof ratio === 'number') row.usage_ratio = ratio
      } catch (error) {
        row.note = 'Context pressure is not measurable for this member yet.'
      }
    }
  }
  return row
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
 * Adopt every member this agent controls but the roster does not know yet: what the shipped team roster
 * created, and every child spawned with the shipped `subagent` / `subagent_fork` tools. Idempotent: a
 * child is adopted at most once, matched by its child Session id, and a retired record keeps its
 * tombstone so the surviving catalog entry cannot bring the member back.
 *
 * @returns the roster, including any newly adopted members.
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
  for (const member of ctx.agentTeams.listMembers(caller)) {
    if (member.role !== 'teammate') continue
    add({ id: member.id, name: member.name, description: member.description, status: member.status })
  }
  for (const row of await descendantsOf(ctx, caller.session.id)) {
    if (row.kind !== 'child') continue
    const label = typeof row.label === 'string' && row.label.length > 0 ? row.label : `Subagent ${row.id}`
    add({ id: row.id, name: label, description: label, status: 'active' })
  }
  if (candidates.length === 0) return roster
  let next = roster
  for (const row of candidates) {
    const adopted = adoptMember(next, row)
    if (adopted !== undefined) next = withMember(next, adopted)
  }
  return await writeRoster(table, leadSessionId, next)
}

/**
 * List one Lead's roster.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined}} request
 * @returns {Promise<{members: object[]}>} the tool's result object, unchanged.
 */
export async function listMembers({ ctx, table, leadSessionId, leadAgent }) {
  const caller = requireLiveLead('list_members', leadSessionId, leadAgent)
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  return { members: roster.members.map((member) => memberRow(ctx, member)) }
}

/**
 * Reserve the next generation of a base name and start it as a continuable child.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   name: string, label: string, prompt: string, signal?: AbortSignal}} request
 * @returns {Promise<object>} the member row the tool returns.
 */
export async function spawnMember({ ctx, table, leadSessionId, leadAgent, name, label, prompt, signal }) {
  const caller = requireLiveLead('spawn_member', leadSessionId, leadAgent)
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const planned = planMember(roster, name, label)
  // Persist the reservation before starting anything: a crash must leave a visible member,
  // never an invisible child.
  await writeRoster(table, leadSessionId, withMember(roster, planned))
  let started
  try {
    started = await ctx.subagents.startActivation({
      delivery: 'parent',
      childId: planned.childId,
      provider: 'spawn',
      label,
      request: { prompt: [{ type: 'text', text: prompt }], parent: caller },
      signal,
    })
  } catch (error) {
    const failed = {
      ...planned,
      phase: PHASE.failed,
      note: error instanceof Error ? error.message : String(error),
    }
    await updateRoster(table, leadSessionId, (roster) => withMember(roster, failed))
    throw error
  }
  const active = { ...planned, childId: started.childId ?? planned.childId, phase: PHASE.active }
  await updateRoster(table, leadSessionId, (roster) => withMember(roster, active))
  return memberRow(ctx, active)
}

/**
 * Retire one member: drain, move its persisted Session aside, tombstone the record, refresh host effects.
 *
 * Without a live Lead Agent there is nothing to drain through, so the operation refuses with a reason
 * instead of throwing. The tool path always runs in the Lead's own Agent context; the guard exists so a
 * caller that does not hold the Agent gets a sentence rather than a `TypeError`.
 *
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   dataDir: string, hooks: {filter: {invalidate: Function}, slots: {refresh: Function}},
 *   target: string, reason?: string}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function retireMember({ ctx, table, leadSessionId, leadAgent, dataDir, hooks, target, reason }) {
  if (leadAgent === undefined || leadAgent === null) {
    return {
      target,
      retired: false,
      message: `The Lead Session ${leadSessionId} is not live in this Harness process, so its member cannot be drained. Open that Session again and retry.`,
    }
  }
  const roster = await ensureAdopted(ctx, leadAgent, table, leadSessionId)
  const member = findByTarget(roster, target)
  if (member === undefined) throw new Error(`retire_member: no live member named "${target}"`)

  let drained = false
  try {
    await ctx.subagents.drainChildren(leadAgent, [member.childId])
    drained = true
  } catch (error) {
    // A child that never published, or already settled, has nothing to drain. Retirement is a
    // lifecycle fact owned by the record, so it proceeds.
  }

  // Move the persisted artifact out of the live store. This is what makes the member disappear from
  // the host's own discovery, because session-query drops an artifact that is no longer there.
  // Failure is reported and never fatal: the record is the lifecycle authority.
  const trash = await trashMemberSession(ctx, {
    leadSessionId,
    memberId: member.childId,
    dataDir,
  })

  let archived = false
  if (!trash.moved) {
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

  const retired = { ...member, phase: PHASE.retired, retiredAt: new Date().toISOString() }
  if (typeof reason === 'string' && reason.length > 0) retired.retireReason = reason
  if (trash.moved && typeof trash.trashPath === 'string') {
    retired.trashPath = trash.trashPath
    retired.trashKind = trash.kind === 'file' ? 'file' : 'directory'
    if (typeof trash.originalPath === 'string') retired.originalPath = trash.originalPath
  }
  await updateRoster(table, leadSessionId, (roster) => withMember(roster, retired))

  // Both host effects read tombstones through short caches; refresh now so the member leaves the
  // projections every client renders and the freed slot is available to the next spawn.
  hooks.filter.invalidate()
  void hooks.slots.refresh()

  const value = {
    target: targetOf(member),
    retired: true,
    drained,
    archived,
    trashed: trash.moved,
    message: trash.moved
      ? 'Member retired: drained, its session moved to the trash directory, and tombstoned.'
      : `Member retired and tombstoned; the session artifact was not moved (${trash.reason ?? 'unknown'}).`,
  }
  if (trash.moved && typeof trash.trashPath === 'string') value.trash_path = trash.trashPath
  return value
}

/**
 * Move a retired member's Session back and return the record to active. This one needs no live Lead:
 * it is a filesystem move plus a record write, so it can recover a team whose Lead Session is closed.
 * @param {{ctx: object, table: object, leadSessionId: string, target: string,
 *   hooks: {filter: {invalidate: Function}, slots: {refresh: Function}}}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function restoreMember({ ctx, table, leadSessionId, target, hooks }) {
  const roster = readRoster(table, leadSessionId)
  const member = findRetired(roster, target)
  if (member === undefined) throw new Error(`restore_member: no retired member named "${target}"`)
  if (hasLiveTarget(roster, target)) {
    throw new Error(`restore_member: a live member already uses "${target}"; retire it first`)
  }

  let restoredPath
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
    if (!outcome.restored) {
      return {
        target: targetOf(member),
        restored: false,
        message: `Nothing was moved back: ${outcome.reason}. The record stays retired.`,
      }
    }
    restoredPath = outcome.path
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
    } catch (error) {
      return {
        target: targetOf(member),
        restored: false,
        message: `The workspace refused to unhide the session (${error instanceof Error ? error.message : String(error)}). The record stays retired.`,
      }
    }
  }

  const revived = { ...member, phase: PHASE.active }
  delete revived.retiredAt
  delete revived.retireReason
  delete revived.trashPath
  delete revived.trashKind
  delete revived.originalPath
  await updateRoster(table, leadSessionId, (current) => withMember(current, revived))
  hooks.filter.invalidate()
  void hooks.slots.refresh()

  const value = {
    target: targetOf(member),
    restored: true,
    message: 'Member restored and active again. A restored session may take one client refresh to reappear.',
  }
  if (typeof restoredPath === 'string') value.path = restoredPath
  return value
}

/**
 * Deliver one message to a live member.
 * @param {{ctx: object, table: object, leadSessionId: string, leadAgent: object|undefined,
 *   target: string, message: string, signal?: AbortSignal}} request
 * @returns {Promise<object>} the tool's result object, unchanged.
 */
export async function messageMember({ ctx, table, leadSessionId, leadAgent, target, message, signal }) {
  const caller = requireLiveLead('message_member', leadSessionId, leadAgent)
  const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
  const member = findByTarget(roster, target)
  if (member === undefined) throw new Error(`message_member: no live member named "${target}"`)
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
  if (member === undefined) throw new Error(`stop_member: no live member named "${target}"`)
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
