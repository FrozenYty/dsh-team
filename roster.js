/**
 * Durable roster storage and lifecycle helpers for dsh-team-control.
 *
 * No imports beyond `node:crypto`: a profile-linked bundle cannot resolve `@deepseek-ai/*` or `zod`
 * (ADR 0002). The domain spec below is therefore hand-built. That is safe because the storage facility
 * calls exactly one method on a value schema — `.parse` — when it opens a domain and when it decodes a
 * record; the canonical `defineDomain` constructor only adds load-time validation we cannot import.
 *
 * One roster record per Lead Session holds every member of that Lead's team. The record is the durable
 * lifecycle fact; live state (resident, running) is read from the Harness at call time and never stored,
 * so the two can never disagree.
 */

import { randomUUID } from 'node:crypto'

/** Domain name: /^[a-z][a-z0-9_]*$/ per the storage facility. */
const DOMAIN_NAME = 'team_control'

/** Lifecycle phases. `dormant` is deliberately absent: P4-01 adds it with the completion hook. */
export const PHASE = {
  provisioning: 'provisioning',
  active: 'active',
  retired: 'retired',
  failed: 'failed',
}

/** Model-facing name rules, mirroring what the Harness accepts for child names. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** A member is addressable only while it has not been retired. */
const ADDRESSABLE = new Set([PHASE.provisioning, PHASE.active, PHASE.failed])

/** Validate one roster record. Throws on anything the roster cannot represent. */
function parseRoster(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('roster must be an object')
  }
  if (typeof value.leadSessionId !== 'string' || value.leadSessionId.length === 0) {
    throw new Error('roster.leadSessionId must be a non-empty string')
  }
  if (!Array.isArray(value.members)) throw new Error('roster.members must be an array')
  for (const member of value.members) {
    if (typeof member?.memberId !== 'string') throw new Error('roster member needs a memberId')
    if (typeof member.name !== 'string' || !NAME_PATTERN.test(member.name)) {
      throw new Error(`roster member name "${String(member.name)}" is invalid`)
    }
    if (!Number.isSafeInteger(member.generation) || member.generation < 1) {
      throw new Error('roster member generation must be a positive integer')
    }
    if (typeof PHASE[member.phase] !== 'string') throw new Error(`roster member phase "${String(member.phase)}" is unknown`)
  }
  return value
}

/** The hand-built domain specification. */
export const ROSTER_SPEC = {
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    rosters: { valueSchema: { parse: parseRoster } },
  },
}

/**
 * Open the roster domain and return its table.
 * @param ctx - plugin context, with `storageDomain` injected.
 * @returns the roster table handle.
 */
export async function openRosterStore(ctx) {
  const domain = await ctx.storageDomain.open(ROSTER_SPEC)
  ctx.effect(() => () => domain.close(), 'team-control.domainClose()')
  return domain.table('rosters')
}

/** Read one Lead's roster, or an empty roster when none exists yet. */
export function readRoster(table, leadSessionId) {
  return table.get(leadSessionId) ?? { leadSessionId, members: [] }
}

/** Persist a roster, stamping the write time. */
export async function writeRoster(table, leadSessionId, roster) {
  const next = { ...roster, leadSessionId, updatedAt: new Date().toISOString() }
  await table.put(leadSessionId, next)
  return next
}

/**
 * Atomically change one Lead's roster.
 * The table's `update` is a compare-free read-modify-write serialized by the storage facility, which is
 * the only serialization available to a plugin here.
 * @param table - roster table.
 * @param leadSessionId - Lead whose roster changes.
 * @param mutate - pure function from the current roster to the next one.
 * @returns the persisted roster.
 */
export async function updateRoster(table, leadSessionId, mutate) {
  const current = readRoster(table, leadSessionId)
  const next = mutate(current)
  return await writeRoster(table, leadSessionId, { ...next, leadSessionId })
}

/** The model-facing target of a member. Generation 1 keeps the bare name. */
export function targetOf(member) {
  return member.generation === 1 ? member.name : `${member.name}-g${member.generation}`
}

/** Find one addressable member by its model-facing target. */
export function findByTarget(roster, target) {
  return roster.members.find((member) => targetOf(member) === target && ADDRESSABLE.has(member.phase))
}

/**
 * Reserve the next generation of a base name and return the provisioning record.
 * The caller persists this record before starting the child, so a crash leaves a visible reservation
 * rather than an invisible child.
 */
export function planMember(roster, baseName, label) {
  if (!NAME_PATTERN.test(baseName)) {
    throw new Error(`member name "${baseName}" must match ${String(NAME_PATTERN)}`)
  }
  if (baseName === 'lead') throw new Error('member name "lead" is reserved for the root agent')
  const used = roster.members.filter((member) => member.name === baseName)
  const generation = used.reduce((highest, member) => Math.max(highest, member.generation), 0) + 1
  const planned = {
    memberId: randomUUID(),
    name: baseName,
    generation,
    childId: randomUUID(),
    phase: PHASE.provisioning,
    label,
    createdAt: new Date().toISOString(),
  }
  const target = targetOf(planned)
  const live = roster.members.find((member) => targetOf(member) === target && ADDRESSABLE.has(member.phase))
  if (live !== undefined) throw new Error(`a live member already uses the target "${target}"`)
  return planned
}

/** Replace one member in a roster by memberId. */
export function withMember(roster, member) {
  const index = roster.members.findIndex((candidate) => candidate.memberId === member.memberId)
  const members = [...roster.members]
  if (index === -1) members.push(member)
  else members[index] = member
  return { ...roster, members }
}

/** Resolve one member's live state without activating it. */
export function liveStateOf(ctx, member) {
  const agent = ctx.agents.get(member.childId)
  if (agent === undefined) return { resident: false, status: 'unloaded' }
  return { resident: true, status: agent.status === 'running' ? 'running' : 'idle' }
}
