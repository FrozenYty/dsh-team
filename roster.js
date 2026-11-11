/**
 * Durable roster storage and lifecycle helpers for dsh-team-roster.
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
const DOMAIN_NAME = 'team_roster'
/** The domain this plugin used before it was renamed; read once so an existing roster is not orphaned. */
const LEGACY_DOMAIN_NAME = 'team_control'

/** Lifecycle phases. `dormant` is deliberately absent: P4-01 needed no new phase, because an ephemeral
 * member keeps its phase and is retired by a lazy sweep once it has run and stopped (ADR 0013). */
export const PHASE = {
  provisioning: 'provisioning',
  active: 'active',
  retired: 'retired',
  failed: 'failed',
}

/**
 * How far a retirement's artifact move got.
 *
 * `pruned` means the move landed and the artifact was later removed by the per-Lead retention cap
 * (ADR 0011): the tombstone keeps `trashPath` — it still says where the artifact went — and differs
 * from `done` in that the bytes are gone, so `restore_member` answers `pruned` instead of moving
 * anything back.
 */
export const TRASH_STATE = {
  pending: 'pending',
  done: 'done',
  none: 'none',
  pruned: 'pruned',
}

/** Model-facing name rules, mirroring what the Harness accepts for child names. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Upper bound on a member's `assignment`, so one record cannot grow without limit. The assignment is
 * what a successor is briefed with, so it is a short statement of the work, not a transcript.
 */
export const ASSIGNMENT_MAX = 1000

/**
 * Cap on the label. The label is display text, and the roster is one JSON document per Lead in a
 * single-file domain, so every write rewrites it: an uncapped label is paid for on every spawn and
 * every retirement. 200 matches the cap the shipped team roster puts on a member description.
 *
 * This is a write-time contract. A record already on disk is NOT rejected for a longer label, because
 * refusing to load a whole roster over a display field would brick the plugin; only new writes are
 * bounded.
 */
export const LABEL_MAX = 200

/**
 * Validate and normalize a member label. Throws rather than truncating, for the same reason the
 * assignment does: a label the model did not write is a label it cannot recognise later.
 * @param {unknown} value - the model-supplied label.
 * @param {string} source - operation name, so the thrown message names what refused.
 * @returns {string} the label, trimmed.
 */
export function checkLabel(value, source = 'label') {
  if (typeof value !== 'string') throw new Error(`${source}: label must be a string`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`${source}: label must be a non-empty string`)
  if (text.length > LABEL_MAX) {
    throw new Error(`${source}: label is ${text.length} characters; the cap is ${LABEL_MAX}`)
  }
  return text
}

/**
 * Validate and normalize a member assignment.
 * Throws rather than truncating: a silently shortened assignment would be handed to a successor as if
 * the model had written it that way.
 * @param {unknown} value - the model-supplied assignment.
 * @param {string} source - operation name, so the thrown message names what refused.
 * @returns {string} the assignment, trimmed.
 */
export function checkAssignment(value, source = 'assignment') {  if (typeof value !== 'string') throw new Error(`${source}: assignment must be a string`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`${source}: assignment must not be empty`)
  if (text.length > ASSIGNMENT_MAX) {
    throw new Error(`${source}: assignment is ${text.length} characters; the cap is ${ASSIGNMENT_MAX}`)
  }
  return text
}

/**
 * A member is addressable only while it is live. A `failed` member is still listed, and can be
 * retired, but nothing can be delivered to it: the state matrix refuses a message or a stop with a
 * typed reason, and this set is what keeps that refusal out of the `live` lookup.
 */
const ADDRESSABLE = new Set([PHASE.provisioning, PHASE.active])

/** Validate one roster record. Throws on anything the roster cannot represent. */
function parseRoster(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('roster must be an object')
  }
  if (typeof value.leadSessionId !== 'string' || value.leadSessionId.length === 0) {
    throw new Error('roster.leadSessionId must be a non-empty string')
  }
  if (!Array.isArray(value.members)) throw new Error('roster.members must be an array')
  const targets = new Set()
  for (const member of value.members) {
    if (typeof member?.memberId !== 'string') throw new Error('roster member needs a memberId')
    if (typeof member.name !== 'string' || !NAME_PATTERN.test(member.name)) {
      throw new Error(`roster member name "${String(member.name)}" is invalid`)
    }
    if (!Number.isSafeInteger(member.generation) || member.generation < 1) {
      throw new Error('roster member generation must be a positive integer')
    }
    if (typeof PHASE[member.phase] !== 'string') throw new Error(`roster member phase "${String(member.phase)}" is unknown`)
    if (member.trashState !== undefined && typeof TRASH_STATE[member.trashState] !== 'string') {
      throw new Error(`roster member trashState "${String(member.trashState)}" is unknown`)
    }
    if (member.assignment !== undefined) {
      if (typeof member.assignment !== 'string') throw new Error('roster member assignment must be a string')
      if (member.assignment.length > ASSIGNMENT_MAX) {
        throw new Error(`roster member assignment exceeds ${ASSIGNMENT_MAX} characters`)
      }
    }
    // The P4-01 pair. Both are optional, so every record written before this feature loads unchanged;
    // a record that carries them must carry them in the shape the sweep reasons about.
    if (member.ephemeral !== undefined && typeof member.ephemeral !== 'boolean') {
      throw new Error('roster member ephemeral must be a boolean')
    }
    if (member.startedAt !== undefined && (typeof member.startedAt !== 'string' || member.startedAt === '')) {
      throw new Error('roster member startedAt must be a non-empty string')
    }
    // Every tool selects a member by its target, and the lookup takes the first match. A record that
    // holds one target twice would resolve silently to whichever member was written first, so it is
    // refused when the record is loaded rather than guessed at when it is used.
    const target = targetOf(member)
    if (targets.has(target)) {
      throw new Error(`roster member target "${target}" is held by more than one member`)
    }
    targets.add(target)
  }
  return value
}

/** The hand-built domain specification. */
export const ROSTER_SPEC = domainSpec(DOMAIN_NAME)

/** Build the domain spec for one domain name; the shape is identical for the legacy domain. */
function domainSpec(name) {
  return {
    name,
    version: 1,
    tables: {
      rosters: { valueSchema: { parse: parseRoster } },
    },
  }
}

/**
 * Copy a roster from the pre-rename domain the first time the new domain is opened.
 * The legacy domain is left in place: if this copy is ever wrong, the source is still there.
 * @param ctx - plugin context, with `storageDomain` injected.
 * @param table - the new domain's roster table.
 */
async function migrateLegacyRoster(ctx, table) {
  for (const _existing of table.entries()) return
  let legacy
  try {
    legacy = await ctx.storageDomain.open(domainSpec(LEGACY_DOMAIN_NAME))
  } catch (error) {
    return
  }
  try {
    for (const [leadSessionId, roster] of legacy.table('rosters').entries()) {
      await table.put(leadSessionId, roster)
    }
  } finally {
    await legacy.close()
  }
}

/**
 * Open the roster domain and return its table.
 * @param ctx - plugin context, with `storageDomain` injected.
 * @returns the roster table handle.
 */
export async function openRosterStore(ctx) {
  const domain = await ctx.storageDomain.open(ROSTER_SPEC)
  ctx.effect(() => () => domain.close(), 'team-roster.domainClose()')
  const table = domain.table('rosters')
  await migrateLegacyRoster(ctx, table)
  return table
}

/** Read one Lead's roster, or an empty roster when none exists yet. */
export function readRoster(table, leadSessionId) {
  return table.get(leadSessionId) ?? { leadSessionId, members: [] }
}

/** Stamp a roster as the record for one Lead, validating what is about to be stored. */
function stampRoster(roster, leadSessionId) {
  return parseRoster({ ...roster, leadSessionId, updatedAt: new Date().toISOString() })
}

/**
 * Atomically change one Lead's roster, through the storage table's own serialized `update`.
 *
 * The table runs the whole read-modify-write on its single write chain and hands the mutation the
 * record as it is when that write reaches the front of the chain — not the snapshot the caller read
 * before its last `await`. That is what stops a mutation computed across a discovery read, a drain or
 * a file move from putting a tombstone back to life.
 *
 * `update` refuses a key that does not exist yet, so the first mutation seeds an empty record with
 * `put` and then applies itself to that seed. The mutation must be synchronous: the table stores
 * exactly what the function returns.
 *
 * @param table - roster table.
 * @param leadSessionId - Lead whose roster changes.
 * @param mutate - synchronous function from the current roster to the next one.
 * @returns the persisted roster.
 */
export async function updateRoster(table, leadSessionId, mutate) {
  if (table.get(leadSessionId) === undefined) {
    await table.put(leadSessionId, stampRoster({ leadSessionId, members: [] }, leadSessionId))
  }
  return await table.update(leadSessionId, (current) => stampRoster(mutate(current), leadSessionId))
}

/** The model-facing target of a member. Generation 1 keeps the bare name. */
export function targetOf(member) {
  return member.generation === 1 ? member.name : `${member.name}-g${member.generation}`
}

/** Find one live member by its model-facing target. */
export function findByTarget(roster, target) {
  return roster.members.find((member) => targetOf(member) === target && ADDRESSABLE.has(member.phase))
}

/**
 * Find one member by its model-facing target in any phase, tombstone included.
 * This is the lookup the lifecycle operations use when a repeat has to answer for itself instead of
 * being reported as an unknown target.
 * @param roster - one Lead's roster.
 * @param target - model-facing target.
 * @returns the member, or undefined.
 */
export function findAnyTarget(roster, target) {
  return roster.members.find((member) => targetOf(member) === target)
}

/** Whether a target is already used by a live member. */
export function hasLiveTarget(roster, target) {
  return roster.members.some((member) => targetOf(member) === target && ADDRESSABLE.has(member.phase))
}

/**
 * Reserve the next generation of a base name and return the provisioning record.
 * The caller persists this record before starting the child, so a crash leaves a visible reservation
 * rather than an invisible child.
 * @param roster - the Lead's current roster.
 * @param baseName - base name whose next generation is reserved.
 * @param label - responsibility text shown to the model.
 * @param assignment - optional already-validated assignment; it is the durable statement of the work a
 *   successor is briefed with (see `checkAssignment`).
 * @param ephemeral - true to record the member as one-shot: a lazy sweep retires it once it has run and
 *   stopped (ADR 0013). Only `true` is stored, so a record for a normal member is byte-identical to one
 *   written before this flag existed.
 */
export function planMember(roster, baseName, label, assignment, ephemeral = false) {
  if (!NAME_PATTERN.test(baseName)) {
    throw new Error(`member name "${baseName}" must match ${String(NAME_PATTERN)}`)
  }
  if (baseName === 'lead') throw new Error('member name "lead" is reserved for the root agent')
  const trimmedLabel = checkLabel(label, 'planMember')
  const used = roster.members.filter((member) => member.name === baseName)
  const generation = used.reduce((highest, member) => Math.max(highest, member.generation), 0) + 1
  const planned = {
    memberId: randomUUID(),
    name: baseName,
    generation,
    childId: randomUUID(),
    phase: PHASE.provisioning,
    label: trimmedLabel,
    createdAt: new Date().toISOString(),
  }
  if (typeof assignment === 'string' && assignment.length > 0) planned.assignment = checkAssignment(assignment, 'planMember')
  if (ephemeral === true) planned.ephemeral = true
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

/**
 * Adopt one member discovered outside this roster, so the removal this plugin provides applies to it
 * too. The member keeps its Session id as its identity; only the lifecycle bookkeeping is ours. Both
 * discovery sources are passed as the same row shape: the shipped team roster (id, name, description,
 * status) and a subagent-registry row (id, mode, label), with the label standing in for the name.
 * @param roster - the Lead's current roster.
 * @param shipped - one discovery row: child Session id, name, description and status.
 * @returns the provisional member record, or undefined when the child has no usable identity.
 */
export function adoptMember(roster, shipped) {
  if (typeof shipped?.id !== 'string' || shipped.id.length === 0) return undefined
  // The shipped roster allows names this registry would reject; fall back to a normalized form and
  // keep the Session id as the durable identity either way.
  let name = typeof shipped.name === 'string' ? shipped.name.toLowerCase() : ''
  if (!NAME_PATTERN.test(name)) {
    name = name.replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').replace(/-+$/, '').slice(0, 32)
  }
  if (!NAME_PATTERN.test(name)) name = 'member'
  const label = typeof shipped.description === 'string' && shipped.description.length > 0
    ? shipped.description
    : 'Adopted shipped-team member'
  const used = roster.members.filter((member) => member.name === name)
  let generation = used.reduce((highest, member) => Math.max(highest, member.generation), 0) + 1
  let planned = {
    memberId: shipped.id,
    name,
    generation,
    childId: shipped.id,
    phase: shipped.status === 'failed' ? PHASE.failed : PHASE.active,
    label,
    createdAt: new Date().toISOString(),
    adopted: true,
  }
  // Never collide with a live target; a shipped name may already have been adopted before.
  while (roster.members.some((member) => targetOf(member) === targetOf(planned) && ADDRESSABLE.has(member.phase))) {
    generation += 1
    planned = { ...planned, generation }
  }
  return planned
}

/** Resolve one member's live state without activating it. */
export function liveStateOf(ctx, member) {
  const agent = ctx.agents.get(member.childId)
  if (agent === undefined) return { resident: false, status: 'unloaded' }
  return { resident: true, status: agent.status === 'running' ? 'running' : 'idle' }
}
