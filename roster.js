/**
 * Durable roster storage and lifecycle helpers for dsh-team.
 *
 * No imports beyond Node's own modules: a profile-linked bundle cannot resolve `@deepseek-ai/*` or
 * `zod` (ADR 0002). The domain spec below is therefore hand-built. That is safe because the storage
 * facility calls exactly one method on a value schema — `.parse` — when it opens a domain and when it
 * decodes a record; the canonical `defineDomain` constructor only adds load-time validation we cannot
 * import.
 *
 * One roster record per Lead Session holds every member of that Lead's team. The record is the durable
 * lifecycle fact; live state (resident, running) is read from the Harness at call time and never stored,
 * so the two can never disagree.
 *
 * The bytes are this plugin's own: one `roster.json` per workspace root under `.agents/team/`, written
 * with plain `node:fs`. The storage domain is kept as the one-time import source and the rollback path,
 * and it is never deleted (`docs/roster-storage-en.md`).
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_TRASH_LIMIT, locateTrashedArtifact, recordedTrashDir } from './trash.js'

/**
 * The two values `provenance.json`'s `source` has ever held.
 *
 * `seed` is the file the user named with `DSH_TEAM_SEED`. `domain` is the name of the host domain records
 * used to be imported from, FROZEN at `team_roster` (ADR 0014): nothing opens that domain any more
 * (ADR 0031), so no new file can say it, but a `provenance.json` written by an earlier release does, and a
 * reader must still be able to name what it says. It is a *value* — the frozen name of a facility the
 * plugin no longer opens, injects or reads.
 */
export const PROVENANCE_SOURCE = {
  seed: 'seed',
  domain: 'team_roster',
}

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
 * (ADR 0011): the tombstone keeps the trash directory it recorded — it still says where the artifact
 * went — and differs from `done` in that the bytes are gone, so `restore_member` answers `pruned`
 * instead of moving anything back.
 */
export const TRASH_STATE = {
  pending: 'pending',
  done: 'done',
  none: 'none',
  pruned: 'pruned',
}

/**
 * Task status. A task is open work or finished work; there is no third state and no priority, because
 * P2-09 is about handing work over, not about tracking it (ADR 0017).
 */
export const TASK_STATUS = {
  open: 'open',
  done: 'done',
}

/**
 * How long a member lives, as the spawn call declares it (ADR 0026).
 *
 * A member is a division of labour, not a task, and the two lifetimes are the two answers a Lead can
 * give to "is this a role or one piece of work?":
 *
 *   - `standing` — a role the Lead expects to use again. It is never retired automatically, and
 *     `retire_member` on it asks the person first;
 *   - `one-shot` — the parallel fan-out: a member created for one piece of work, which a lazy sweep
 *     retires by itself once it has run, stopped and still owns nothing.
 *
 * The declaration is the person's prior consent, so it is made once, on the spawn call, and is never
 * inherited: not from a predecessor on a `replace`, and not from a definition file — a file that
 * declared it would make every successor of a replacement inherit it, and a `replace` would then hand
 * over work and self-retire, orphaning exactly what it had just received (ADR 0026).
 */
export const LIFETIME = {
  standing: 'standing',
  oneShot: 'one-shot',
}

/**
 * How many re-tasks of a one-shot member are evidence that it is really a standing role.
 *
 * The advice is never a conversion: the plugin only reports it, and the Lead declares the new lifetime
 * at the next spawn (ADR 0026). Two is the smallest number that is not the single follow-up message any
 * member may get, so it is the threshold for both signals the record can prove — accepted messages and
 * assignment changes written after the spawn.
 */
export const RETASK_MIN = 2

/**
 * Where the provider and model a member carries came from (ADR 0024).
 *
 * `caller` — the spawn call named the route (directly, or through a member definition), so the plugin
 * forwarded what the caller chose; `plugin` — the caller named a route, but not these two fields, so the
 * plugin completed them from the Lead's current route so the recorded route is the whole one; `inherited`
 * — the plugin forwarded nothing and the Harness inherited the Lead's route on its own, which is also
 * the path taken when the route could not be resolved or the provider cannot apply it.
 */
export const ROUTE_SOURCE = {
  caller: 'caller',
  plugin: 'plugin',
  inherited: 'inherited',
}

/**
 * Why a member's route was not forwarded (`source: 'inherited'`). Absent on every other source, and also
 * absent when the plugin did forward a route — there is nothing to explain about the normal path.
 *
 * `no-session-route` — the Lead Session exposes no usable current route (no `requestHeader()` accessor,
 * no config, or a config without both a provider and a model); `capability-absent` — the spawn provider
 * does not advertise `agentOptions`, so forwarding one would make the start fail. Both are the cases this
 * release must not turn into a failed spawn (ADR 0024).
 */
export const ROUTE_SELECT_REASON = {
  noSessionRoute: 'no-session-route',
  capabilityAbsent: 'capability-absent',
}

/**
 * Cap on a task title, refused rather than truncated, exactly like `LABEL_MAX`.
 *
 * 200 is not a new number: the roster already bounds its two model-written display strings at 200 — a
 * member label and a task title are the same kind of text, and the shipped team roster bounds a member
 * description at the same number. A longer "title" is prose, and prose belongs in the member's
 * `assignment`, which has its own, larger cap.
 */
export const TASK_TITLE_MAX = 200

/**
 * Cap on a task body, refused rather than truncated, exactly like `TASK_TITLE_MAX` and `ASSIGNMENT_MAX`.
 *
 * The body is where a task states what its title cannot: what "done" means for it and where the
 * predecessor stopped — the two things a successor is otherwise never told (ADR 0020). 2000 is twice
 * `ASSIGNMENT_MAX`, because an assignment is one sentence about a member's current work while a body
 * carries acceptance criteria and a stopping point, and it is eight times below the shipped board's
 * 16384-character description, because this board is one JSON document per Lead whose whole array is
 * rewritten by every spawn, retirement and task write (ADR 0017).
 */
export const TASK_BODY_MAX = 2000

/**
 * Cap on the tasks one Lead's roster may hold, refused rather than truncated.
 *
 * The unit is the whole `tasks` array, `done` entries included, because the array is what the single-file
 * domain rewrite pays for on every spawn, retirement and task write. 200 is an order of magnitude above a
 * plausible handover backlog and two orders above the largest brief this plugin renders (5 tasks, `docs/handoff-en.md` §1),
 * so it is a safety bound rather than a working limit. It matches nothing else in the repository on
 * purpose: the label cap bounds one string, this bounds a list.
 */
export const TASK_LIMIT = 200

/** Model-facing name rules, mirroring what the Harness accepts for child names. */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Validate a base member name.
 *
 * The rule lives outside `planMember` because a member definition declares its own `name` and must be
 * refused by the same rule the reservation would apply one call later (ADR 0018); duplicating the
 * pattern would let a definition name a member the roster then rejects.
 * @param {unknown} value - the model-supplied or file-declared base name.
 * @param {string} source - operation name, so the thrown message names what refused.
 * @returns {string} the base name.
 */
export function checkMemberName(value, source = 'planMember') {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new Error(`${source}: member name "${String(value)}" must match ${String(NAME_PATTERN)}`)
  }
  if (value === 'lead') throw new Error(`${source}: member name "lead" is reserved for the root agent`)
  return value
}

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
 * Upper bound on a stored handoff-brief template. A template exists to fix the shape of a brief that is
 * five short lines, and every replacement pays for it in a cold child's prompt, so it is bounded at the
 * same order as an assignment. Refused rather than truncated, for the same reason `checkLabel` refuses:
 * a template the model did not write is one it cannot recognise later.
 */
export const HANDOFF_TEMPLATE_MAX = 1000

/**
 * Upper bound on the brief a stored template renders. The template cap alone does not bound the result,
 * because a `{assignment}` value is itself up to `ASSIGNMENT_MAX`; a maximal template plus a maximal
 * assignment would defeat the point of a short brief. The built-in brief with a maximal assignment is
 * about 1,400 characters, so 2000 leaves a template room to add structure while still refusing a wall of
 * prose. It is measured only when a template is stored, which is what keeps a profile that stores none
 * byte-identical to the release before this one.
 */
export const HANDOFF_BRIEF_MAX = 2000

/**
 * The named fields a stored template may interpolate: the successor's target, the predecessor's target,
 * its label, the assignment recorded for it, and the pointer to the Lead's own task board. A token
 * outside this set is a typo (`{asignment}`) that would otherwise reach a child as literal text, so it is
 * refused when the template is stored. `{assignment}` is the one required placeholder — a brief without
 * it tells a successor its predecessor's role and where the work is, but not what the work was.
 */
export const HANDOFF_PLACEHOLDERS = ['successor', 'predecessor', 'label', 'assignment', 'task_board']

/**
 * Why one stored or supplied handoff template cannot be used, or undefined when it can.
 *
 * The set path throws this answer and the read path returns it, so a template that was hand-edited into
 * a record is reported instead of being silently written into a child's prompt.
 * @param {unknown} value - the template.
 * @returns {string|undefined} the reason, or undefined when the template is usable.
 */
export function handoffTemplateProblem(value) {
  if (typeof value !== 'string') return 'template must be a string'
  const text = value.trim()
  if (text.length === 0) return 'template must not be empty'
  if (text.length > HANDOFF_TEMPLATE_MAX) {
    return `template is ${text.length} characters; the cap is ${HANDOFF_TEMPLATE_MAX}`
  }
  const tokens = HANDOFF_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')
  const unknown = [...text.matchAll(/\{([^{}]*)\}/g)]
    .map((match) => match[1])
    .filter((name) => !HANDOFF_PLACEHOLDERS.includes(name))
  if (unknown.length > 0) {
    return `unknown placeholder {${unknown[0]}}; the placeholders are ${tokens}`
  }
  let rest = text
  for (const name of HANDOFF_PLACEHOLDERS) rest = rest.split(`{${name}}`).join('')
  if (/[{}]/.test(rest)) {
    return `a "{"/"}" that is not part of one of ${tokens} would reach the child as literal text`
  }
  if (!text.includes('{assignment}')) {
    return 'template must reference {assignment}: without it the successor is told its predecessor\'s role and where the work is, but not what the work was'
  }
  return undefined
}

/**
 * Validate and normalize a handoff-brief template.
 * Throws rather than truncating, like `checkLabel` and `checkAssignment`.
 * @param {unknown} value - the model-supplied template.
 * @param {string} source - operation name, so the thrown message names what refused.
 * @returns {string} the template, trimmed.
 */
export function checkHandoffTemplate(value, source = 'handoff_template') {
  const problem = handoffTemplateProblem(value)
  if (problem !== undefined) throw new Error(`${source}: ${problem}`)
  return value.trim()
}

/**
 * The stored template a composition may use, or undefined when there is none or it is not usable.
 * A stored value that fails the content rules stays on the record — the read form reports it — but is
 * never interpolated into a child's prompt, where a literal `{asignment}` would go unnoticed.
 * @param {unknown} stored - `roster.handoffTemplate`.
 * @returns {string|undefined} the trimmed template, or undefined.
 */
export function usableHandoffTemplate(stored) {
  if (typeof stored !== 'string' || handoffTemplateProblem(stored) !== undefined) return undefined
  return stored.trim()
}

/**
 * A member is addressable only while it is live. A `failed` member is still listed, and can be
 * retired, but nothing can be delivered to it: the state matrix refuses a message or a stop with a
 * typed reason, and this set is what keeps that refusal out of the `live` lookup.
 */
const ADDRESSABLE = new Set([PHASE.provisioning, PHASE.active])

/**
 * Validate and normalize a task title.
 * Throws rather than truncating, like `checkLabel`: a title the model did not write is one the Lead
 * cannot recognise in the handover list a successor is briefed with.
 * @param {unknown} value - the model-supplied title.
 * @param {string} source - operation name, so the thrown message names what refused.
 * @returns {string} the title, trimmed.
 */
export function checkTaskTitle(value, source = 'task') {
  if (typeof value !== 'string') throw new Error(`${source}: title must be a string`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`${source}: title must be a non-empty string`)
  if (text.length > TASK_TITLE_MAX) {
    throw new Error(`${source}: title is ${text.length} characters; the cap is ${TASK_TITLE_MAX}`)
  }
  return text
}

/**
 * Validate and normalize a task body.
 *
 * Throws rather than truncating, like `checkTaskTitle` and `checkAssignment`: a body the model did not
 * write is one it cannot recognise as its own statement of the work. An empty or blank string is a value
 * the write path refuses; the way to say "this task has no body" is `body: null` on `update`, which
 * removes the field rather than storing nothing as text.
 * @param {unknown} value - the model-supplied body.
 * @param {string} source - operation name, so the thrown message names what refused.
 * @returns {string} the body, trimmed.
 */
export function checkTaskBody(value, source = 'task') {
  if (typeof value !== 'string') throw new Error(`${source}: body must be a string`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`${source}: body must not be empty`)
  if (text.length > TASK_BODY_MAX) {
    throw new Error(`${source}: body is ${text.length} characters; the cap is ${TASK_BODY_MAX}`)
  }
  return text
}

/**
 * The tasks a roster record holds, always as an array.
 * A record written before P2-09 has no field at all, so "no tasks" is not a migration, it is the shape
 * every earlier release produced (ADR 0017).
 * @param {object} roster - one Lead's roster.
 * @returns {object[]} its tasks.
 */
export function tasksOf(roster) {
  return Array.isArray(roster.tasks) ? roster.tasks : []
}

/**
 * Find one task by id.
 * @param {object} roster - one Lead's roster.
 * @param {string} taskId - the id a `list` row carried.
 * @returns {object|undefined} the task, or undefined.
 */
export function findTask(roster, taskId) {
  return tasksOf(roster).find((task) => task.id === taskId)
}

/** Replace one task in a roster by id. */
export function withTask(roster, task) {
  const index = tasksOf(roster).findIndex((candidate) => candidate.id === task.id)
  const tasks = [...tasksOf(roster)]
  if (index === -1) tasks.push(task)
  else tasks[index] = task
  return { ...roster, tasks }
}

/**
 * Build the task a create call stores, refusing past the per-Lead cap.
 *
 * The cap is checked here, against the roster the write will land on, because that is the one place both
 * the current list and the new entry are known. Refused rather than truncated or silently dropped: a task
 * the model wrote is either stored or the call says why.
 * @param {object} roster - the Lead's current roster.
 * @param {{title: unknown, owner?: string, body?: string}} request - the model-supplied title, optional
 *   owner and optional body.
 * @param {string} source - operation name, for the refusal message.
 * @returns {object} the task to store.
 */
export function planTask(roster, { title, owner, body }, source = 'task_board') {
  const text = checkTaskTitle(title, source)
  const notes = body === undefined ? undefined : checkTaskBody(body, source)
  const tasks = tasksOf(roster)
  if (tasks.length >= TASK_LIMIT) {
    throw new Error(
      `${source}: this Lead's roster already holds ${tasks.length} tasks; the cap is ${TASK_LIMIT}. Set finished tasks to done and delete the ones nobody needs, then create this one.`,
    )
  }
  const task = {
    id: randomUUID(),
    title: text,
    status: TASK_STATUS.open,
    created_at: new Date().toISOString(),
  }
  if (notes !== undefined) task.body = notes
  if (typeof owner === 'string' && owner.length > 0) task.owner = owner
  return task
}

/**
 * The open tasks one member target owns, oldest first: what a replacement hands over and what a
 * retirement without a successor leaves unowned (§2 of `docs/task-board-en.md`, ADR 0017).
 * @param {object} roster - one Lead's roster.
 * @param {string} target - the model-facing target whose open tasks are wanted.
 * @returns {object[]} open tasks owned by that target.
 */
export function openTasksOf(roster, target) {
  return tasksOf(roster).filter((task) => task.status === TASK_STATUS.open && task.owner === target)
}

/**
 * Re-address every open task one target owns, or clear its owner when `to` is undefined.
 *
 * The re-address and the owner-clear are one mutation on purpose: a transfer that moved only half the
 * list would leave work pointing at a tombstone with no way to tell which half. `done` tasks are never
 * touched in either direction — finished work is the predecessor's record, not the successor's backlog.
 * @param {object} roster - one Lead's roster.
 * @param {string} from - the target whose open tasks move.
 * @param {string|undefined} to - the successor target, or undefined to leave them unowned.
 * @returns {{roster: object, moved: string[]}} the next roster and the ids that moved.
 */
export function reownerTasks(roster, from, to) {
  const moved = []
  const tasks = tasksOf(roster).map((task) => {
    if (task.status !== TASK_STATUS.open || task.owner !== from) return task
    moved.push(task.id)
    if (to === undefined) {
      const next = { ...task }
      delete next.owner
      return next
    }
    return { ...task, owner: to }
  })
  return { roster: { ...roster, tasks }, moved }
}

/**
 * Validate one roster record. Throws on anything the roster cannot represent.
 * Exported since the storage domain went: the domain's `valueSchema` used to be the only way a caller
 * could reach this validator, and a test that writes a record straight into a file needs the same rule the
 * loader applies — otherwise it asserts against a file the plugin would refuse.
 * @param {unknown} value - one stored record.
 * @returns {object} the same value, validated.
 */
export function parseRoster(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('roster must be an object')
  }
  if (typeof value.leadSessionId !== 'string' || value.leadSessionId.length === 0) {
    throw new Error('roster.leadSessionId must be a non-empty string')
  }
  if (!Array.isArray(value.members)) throw new Error('roster.members must be an array')
  // The P4-02 field. Only its type is checked here on purpose: the storage facility validates every
  // record of every Lead when it opens a domain (`invalid-record`, naming the table and key), so
  // refusing the whole domain over one Lead's brief template would hide every roster. The content
  // rules are enforced when a template is stored and reported by the read form (see
  // `handoffTemplateProblem`), never guessed at when the brief is composed.
  if (value.handoffTemplate !== undefined && typeof value.handoffTemplate !== 'string') {
    throw new Error('roster.handoffTemplate must be a string')
  }
  // The P2-09 field. Every check here is structural and none depends on a stored content rule, because
  // the storage facility validates every record of every Lead when it opens the domain: a `title` that is
  // merely too long, or a list past the write-time cap, must load and be handled on read (ADR 0017), or
  // one Lead's stale task list would hide every roster in the profile.
  if (value.tasks !== undefined) {
    if (!Array.isArray(value.tasks)) throw new Error('roster.tasks must be an array')
    const taskIds = new Set()
    for (const task of value.tasks) {
      if (task === null || typeof task !== 'object' || Array.isArray(task)) {
        throw new Error('roster task must be an object')
      }
      if (typeof task.id !== 'string' || task.id.length === 0) throw new Error('roster task needs an id')
      if (typeof TASK_STATUS[task.status] !== 'string') {
        throw new Error(`roster task status "${String(task.status)}" is unknown`)
      }
      if (task.owner !== undefined && (typeof task.owner !== 'string' || task.owner.length === 0)) {
        throw new Error('roster task owner must be a non-empty string')
      }
      if (taskIds.has(task.id)) throw new Error(`roster task id "${task.id}" appears twice`)
      taskIds.add(task.id)
    }
  }
  // The v0.28.6 field: every retired child Session id this Lead has ever had, including the ones whose
  // records moved to the archive. Optional, so a record written before it loads unchanged, and only its
  // shape is checked here: a record that lost the list still serves, because the hooks fall back to
  // scanning the tombstones that remain (ADR 0017's rule about never hiding a roster over one field).
  if (value.retiredChildIds !== undefined) {
    if (!Array.isArray(value.retiredChildIds)) throw new Error('roster.retiredChildIds must be an array')
    for (const id of value.retiredChildIds) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('roster.retiredChildIds must hold non-empty strings')
      }
    }
  }
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
    // The v0.25.0 pair, on a one-shot member only: how many messages it was sent and how many
    // assignments were written for it after the spawn. They are the evidence `list_members` advises on,
    // and they are counted rather than inferred, because the assignment field itself keeps only the last
    // value. Optional, so every earlier record loads unchanged.
    for (const field of ['messageCount', 'assignmentCount']) {
      if (member[field] !== undefined && (!Number.isSafeInteger(member[field]) || member[field] < 0)) {
        throw new Error(`roster member ${field} must be a non-negative integer`)
      }
    }
    // The v0.22.0 field, checked on load like `ephemeral`: optional, so every record written before it
    // exists loads unchanged, but a record that carries one must carry the shape the read reasons about.
    // Only the structure is checked here — a `provider` or `model` an older profile wrote as something
    // else is not this field's business, and refusing a whole domain over one Lead's record would hide
    // every roster (ADR 0017, ADR 0024).
    if (member.route !== undefined) {
      const route = member.route
      if (route === null || typeof route !== 'object' || Array.isArray(route)) {
        throw new Error('roster member route must be an object')
      }
      if (typeof ROUTE_SOURCE[route.source] !== 'string') {
        throw new Error(`roster member route source "${String(route.source)}" is unknown`)
      }
      if (route.provider !== undefined && (typeof route.provider !== 'string' || route.provider.length === 0)) {
        throw new Error('roster member route provider must be a non-empty string')
      }
      if (route.model !== undefined && (typeof route.model !== 'string' || route.model.length === 0)) {
        throw new Error('roster member route model must be a non-empty string')
      }
      if (route.select_reason !== undefined && !Object.values(ROUTE_SELECT_REASON).includes(route.select_reason)) {
        throw new Error(`roster member route select_reason "${String(route.select_reason)}" is unknown`)
      }
    }
    // The two halves of the succession link, checked on load like `route` above: a replacement writes the
    // forward half on the successor it starts and the reverse half on the tombstone it leaves, both in the
    // mutation that creates the record, so a chain reads from either end (ADR 0032). Structure only — an
    // edge names a member id, and the record that id names may legitimately be absent, because a tombstone
    // past the retention window leaves the roster for the archive (ADR 0030). That is why this refuses a
    // malformed edge but never an edge that "names nothing": the second is exactly what a correct record
    // looks like once its predecessor has been archived, and a check that cannot tell the two apart would
    // refuse good data.
    if (member.predecessor !== undefined) {
      if (typeof member.predecessor !== 'string' || member.predecessor.length === 0) {
        throw new Error('roster member predecessor must be a non-empty member id')
      }
    }
    if (member.successor !== undefined) {
      const successor = member.successor
      if (successor === null || typeof successor !== 'object' || Array.isArray(successor)) {
        throw new Error('roster member successor must be an object')
      }
      if (typeof successor.target !== 'string' || successor.target.length === 0) {
        throw new Error('roster member successor needs a target')
      }
      if (typeof successor.member_id !== 'string' || successor.member_id.length === 0) {
        throw new Error('roster member successor needs a member_id')
      }
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

/**
 * Open the roster store for this process: each Lead's own file at its bound root, seeded for a new root
 * from the file the user named.
 *
 * No host storage domain is opened, read or written. That facility was the import source and the rollback
 * path while the records lived in it; they have lived in files since ADR 0027 and every Session has a root
 * since ADR 0031, so the import leg's job is finished: a profile that still has a domain file left on disk
 * can point `DSH_TEAM_SEED` at it, because a seed accepts a domain dump's shape as well as this plugin's.
 * @param binder - the root binder from `trash.js`; every Lead is bound, so this is never undefined.
 * @param {{trashLimit?: number, seed?: string}} options - `trashLimit` is the effective retention cap the
 *   tombstone window is derived from, so the window cannot drift out of step with the cap that empties the
 *   trash; `seed` is `DSH_TEAM_SEED`, the file a new root reads its records from.
 * @returns the roster source: `{ table, bind, ready, readyFor, report }`.
 */
export async function openRosterStore(binder, { trashLimit, seed = process.env[SEED_ENV] } = {}) {
  return createRosterSource({ binder, trashLimit, seed })
}

/** The one file a workspace's rosters live in, under the bound root. */
export const ROSTER_FILE_NAME = 'roster.json'

/** The record of the one-time import into a root: which Lead came across, what it came from, and when. */
export const PROVENANCE_FILE_NAME = 'provenance.json'

/**
 * Where this plugin keeps the tombstones that are past the trash retention window: append-only, one JSON
 * object per line, each the full tombstone with when and why it left the roster.
 *
 * A tombstone belongs in `roster.json` exactly while its artifact could still exist — beyond the newest
 * `trashLimit` retirements the retention cap has already removed the bytes, so the record can only answer
 * `pruned`. Archiving it is therefore lossless for functionality, and the file keeps what the roster
 * cannot afford to: every one of them, forever, in a form a human can read without a tool.
 *
 * It is never read on the hot path — not at load, not by `list_members`, not by the host hooks. The two
 * reads are a refusal (`restore_member` naming where the record went) and `restore_member`'s own lookup.
 */
export const ARCHIVE_FILE_NAME = 'archive.jsonl'

/** The content of a roster file that has never been written. */
const emptyRosterFile = () => ({ version: 1, serial: 0, rosters: {} })

/** One sentence for a caught error, so a report never says "Error" and nothing else. */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one JSON file, telling "there is no such file" apart from "it is there and I cannot use it".
 * @param {string} file - absolute path.
 * @returns {Promise<{exists: boolean, value?: object, problem?: string}>}
 */
async function readJsonFile(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false }
    return { exists: true, problem: `unreadable (${describeError(error)})` }
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { exists: true, problem: `not valid JSON (${describeError(error)})` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { exists: true, problem: 'not a JSON object' }
  }
  return { exists: true, value }
}

/**
 * Decode one roster file: its `serial` and its records, or the reason it cannot be used.
 *
 * Every record is validated with the same `parseRoster` the storage facility applied when it opened the
 * domain, so a file with one corrupt record is refused as a whole and the root falls back to the domain
 * — exactly what `invalid-record` did for a domain. A file that loads anyway would put a malformed record
 * in front of every tool.
 * @param {{value?: object}} reading - what `readJsonFile` returned.
 * @returns {{serial: number, rosters: object}|{problem: string}}
 */
function decodeRosterFile(reading) {
  const rosters = reading.value?.rosters
  if (rosters === null || typeof rosters !== 'object' || Array.isArray(rosters)) {
    return { problem: 'no "rosters" object' }
  }
  for (const [leadSessionId, roster] of Object.entries(rosters)) {
    try {
      parseRoster(roster)
    } catch (error) {
      return { problem: `record "${leadSessionId}" is invalid (${describeError(error)})` }
    }
  }
  return {
    serial: Number.isSafeInteger(reading.value.serial) ? reading.value.serial : 0,
    rosters: { ...rosters },
  }
}

/**
 * Replace one file without ever leaving it half-written: the new bytes go to a temporary sibling, which
 * is then renamed over the target. A rename inside one directory is the platform's atomic replacement,
 * so a crash before it leaves the previous file exactly as it was and a crash after it leaves the new
 * one; there is no window in which the file is short. The temporary file is removed when the rename
 * itself fails.
 * @param {string} file - absolute path of the file to replace.
 * @param {string} text - the complete new content.
 * @param {(from: string, to: string) => Promise<void>} renameFn - the rename, injectable so a test can
 *   fail it and prove the previous file survives.
 */
async function replaceFileAtomic(file, text, renameFn) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, 'utf8')
  try {
    await renameFn(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Why a tombstone left the roster, as the archive records it on the line it writes. */
export const ARCHIVE_REASON = 'beyond-trash-window'

/**
 * When one tombstone left the roster: its retirement time, falling back to the stamp its trash directory
 * carries, then to zero. The order decides which tombstones are the newest `trashLimit`, so it is stable
 * for records written by any release — a record that recorded no retirement time still sorts by the
 * millisecond stamp in the name of the artifact it moved.
 * @param {object} member - one roster member record.
 * @returns {number} milliseconds, or 0 when the record carries no time at all.
 */
function retireStamp(member) {
  const at = Date.parse(member?.retiredAt ?? '')
  if (Number.isFinite(at)) return at
  const stamp = /-(\d+)$/.exec(recordedTrashDir(member) ?? '')
  return stamp === null ? 0 : Number(stamp[1])
}

/**
 * Read one archived tombstone by target, out of `<dataDir>/archive.jsonl`.
 *
 * Called only where a lookup has already failed — a `restore_member` refusal, or a `replace` whose
 * predecessor is not in the roster — so the hot path never opens the file. The archive is history, and a
 * missing or half-written line is skipped rather than raised: it cannot make anything worse than the
 * refusal the caller is already composing.
 * @param {string} dataDir - the data directory in effect (the bound root).
 * @param {string} target - the model-facing target as the caller wrote it.
 * @returns {Promise<{path: string, member: object, archivedAt: string|undefined}|undefined>}
 */
export async function findArchived(dataDir, target) {
  const path = join(dataDir, ARCHIVE_FILE_NAME)
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const member = row?.member
    if (member === null || typeof member !== 'object' || Array.isArray(member)) continue
    if (targetOf(member) === target) return { path, member, archivedAt: row.archivedAt }
  }
  return undefined
}

/**
 * The seed file the user names, for a root that has no roster yet.
 *
 * `DSH_TEAM_SEED` is a path to one file, read once per new root and never written. It is what replaced the
 * storage domain's second role: a Lead that binds a different workspace — a moved project, a second
 * workspace — needs its records, and without them a new root starts empty, which means no tombstones,
 * which means `ensureAdopted` gives every child of that Lead a fresh live row. It accepts both shapes,
 * because the record of a roster is worth carrying between machines and a storage-domain dump is what some
 * users already have:
 *
 *   - this plugin's own `roster.json` — `{version, serial, rosters}`;
 *   - a storage-domain dump — `{unit, global, tables: {rosters}}`.
 *
 * A seed that is configured and unusable is a **problem, not a fallback**: a typo in a path must not read
 * someone else's records and look like success. The root stays empty and `list_members` says why.
 */
const SEED_ENV = 'DSH_TEAM_SEED'

/**
 * Read a seed file into `{rosters}` or a refusal.
 * @param {string} path - the file the user named.
 * @returns {Promise<{rosters: object, path: string}|{problem: string}>}
 */
async function readSeed(path) {
  const reading = await readJsonFile(path)
  if (reading.value === undefined) {
    return reading.exists === false
      ? { problem: `the seed ${path} does not exist` }
      : { problem: `the seed ${path} could not be read (${reading.problem ?? 'unknown reason'})` }
  }
  // Both shapes, told apart by the top-level keys rather than by a guess or a flag.
  const rosters = reading.value.rosters ?? reading.value.tables?.rosters
  if (rosters === null || typeof rosters !== 'object' || Array.isArray(rosters)) {
    return { problem: `the seed ${path} holds no roster table: expected this plugin's {version, serial, rosters} or a storage-domain dump's {tables: {rosters}}` }
  }
  for (const [leadSessionId, record] of Object.entries(rosters)) {
    try {
      parseRoster(record)
    } catch (error) {
      return { problem: `the seed ${path} holds a record this plugin refuses ("${leadSessionId}": ${describeError(error)})` }
    }
  }
  return { rosters, path }
}

/**
 * The rosters this process serves, and the one place that decides where their bytes go.
 *
 * **One writer per workspace.** The rosters of one workspace live in one file, and nothing serializes
 * two processes that open it: a lock file was rejected because it adds a stale-lock failure mode that
 * nothing cleans up, while the file itself already reveals the second writer. Every write re-reads the
 * file first — which is also what merges a concurrent change instead of clobbering it — and reports a
 * serial it did not write as `foreign_write_at`. Two Lead Sessions in one workspace therefore share a
 * file by design; the honest limit is that a second writer is detected when this process next reads or
 * writes, not the instant it writes.
 *
 * A root is served in one of two modes, and the second is the rollback:
 *
 *   - **file** — the Lead's root holds `roster.json`; reads and writes go there. It is created by
 *     importing the Lead's record from the storage domain once, which the marker beside it records;
 *   - **storage domain** — no root could be resolved for the Lead (no workspace, no override), or the
 *     file is absent and has just been imported from the domain. The domain is never written to once a
 *     root exists, and it is never deleted, so deleting `roster.json` puts a workspace back on it.
 *
 * @param {{binder?: object, renameFn?: Function, now?: () => string,
 *   trashLimit?: number, home?: string, seed?: string}} options -
 *   `binder` answers which root a Lead is bound to, `renameFn` is the atomic-replacement seam,
 *   `trashLimit` is the effective retention cap the tombstone window is derived from, `home` is the
 *   account directory the artifact chain's frozen leg resolves under, and `seed` is the file a new root is
 *   seeded from.
 * @returns {{table: object, bind: Function, ready: Function, readyFor: Function, report: Function}}
 */
export function createRosterSource({
  binder,
  renameFn = rename,
  now = () => new Date().toISOString(),
  trashLimit = DEFAULT_TRASH_LIMIT,
  home = homedir(),
  seed,
} = {}) {
  /** One state per root this process has touched. */
  const states = new Map()

  const stateOf = (root) => {
    let state = states.get(root)
    if (state === undefined) {
      state = {
        root,
        file: join(root, ROSTER_FILE_NAME),
        marker: join(root, PROVENANCE_FILE_NAME),
        archive: join(root, ARCHIVE_FILE_NAME),
        content: emptyRosterFile(),
        loaded: false,
        loading: undefined,
        problem: undefined,
        importedAt: undefined,
        foreignWriteAt: undefined,
        // Whether a roster file was already here when this root was first loaded. The seed applies only to
        // a root without one: an existing file is the truth, and a seed must never touch it.
        existed: false,
        // The seed reading, memoized per root: one file read however many Leads bind here.
        seed: undefined,
        // The file serial this process last wrote. `0` means "never written here", which is why it is
        // also the guard that stops the first load from reporting a writer that does not exist.
        lastSerial: 0,
        chain: Promise.resolve(),
      }
      states.set(root, state)
    }
    return state
  }

  const enqueue = (state, job) => {
    const result = state.chain.then(job, job)
    state.chain = result.then(() => undefined, () => undefined)
    return result
  }

  /** Read the root's file into memory. A file that cannot be used leaves the root on the legacy legs. */
  const load = async (state) => {
    if (state.loaded) return
    const reading = await readJsonFile(state.file)
    // Whether a file is already here, whatever its state: the seed is for a root that has no roster at all.
    state.existed = reading.value !== undefined || reading.exists === true
    if (reading.value !== undefined) {
      const decoded = decodeRosterFile(reading)
      if (decoded.rosters !== undefined) {
        state.content = { version: 1, serial: decoded.serial, rosters: decoded.rosters }
        state.lastSerial = decoded.serial
      } else {
        state.problem = decoded.problem
      }
    } else if (reading.exists) {
      state.problem = reading.problem ?? 'unreadable'
    }
    state.loaded = true
  }

  /** The freshest content for one root: the file on disk when it can be read, the memory copy otherwise. */
  const freshest = async (state) => {
    const reading = await readJsonFile(state.file)
    if (reading.value !== undefined) {
      const decoded = decodeRosterFile(reading)
      if (decoded.rosters === undefined) {
        state.problem = decoded.problem
        return state.content
      }
      if (state.lastSerial !== 0 && decoded.serial !== state.lastSerial) {
        // Somebody else wrote this file since this process last did. The change is merged below rather
        // than clobbered, and the fact is kept for the read report.
        state.foreignWriteAt = typeof reading.value.updatedAt === 'string' ? reading.value.updatedAt : now()
      }
      // The file is the truth, so a successful read also refreshes what this process serves.
      state.content = { version: 1, serial: decoded.serial, rosters: decoded.rosters }
      return state.content
    }
    if (reading.exists) state.problem = reading.problem ?? 'unreadable'
    return state.content
  }

  /** Write the whole file for one root, and remember what this process wrote. */
  const persist = async (state, content) => {
    const next = { ...content, serial: content.serial + 1, updatedAt: now() }
    await replaceFileAtomic(state.file, `${JSON.stringify(next, null, 2)}\n`, renameFn)
    state.content = next
    state.lastSerial = next.serial
    // A problem is deliberately not cleared here. It is a fact about this process's session — the file
    // was unusable at some point and these records were served from the domain — and a reader that only
    // saw the repaired file would never learn that.
    return next
  }

  /**
   * Record one import beside the file, so a reader can tell where the records came from.
   * @param {object} state - the root's state.
   * @param {string} leadSessionId - the Lead that was seeded.
   * @param {object} record - the record as it came across.
   * @param {{source: string, path?: string}} origin - where it came from, as the reader must see it.
   */
  const writeMarker = async (state, leadSessionId, record, origin) => {
    const reading = await readJsonFile(state.marker)
    const leads = { ...(reading.value?.leads ?? {}) }
    leads[leadSessionId] = {
      importedAt: state.importedAt,
      members: Array.isArray(record?.members) ? record.members.length : 0,
      tasks: Array.isArray(record?.tasks) ? record.tasks.length : 0,
    }
    await replaceFileAtomic(
      state.marker,
      `${JSON.stringify({ version: 1, source: origin.source, ...(origin.path === undefined ? {} : { path: origin.path }), leads }, null, 2)}\n`,
      renameFn,
    )
  }

  /**
   * Seed one Lead's record into a new root.
   *
   * The source order is the seed, then nothing. There is no host storage domain behind it any more
   * (ADR 0031): every Session has a root, so the domain's records reach a file on the first load of a
   * release that still reads it, and a profile that skipped those releases points `DSH_TEAM_SEED` at the
   * domain file it still has — a seed accepts that shape.
   *
   * A seed that is configured and unusable is a problem, not a silent empty root: a typo in a path is the
   * one failure a person cannot see from the outside. The root stays empty and `list_members` reports the
   * reason.
   * @returns {Promise<{record: object, origin: object}|undefined>} the seeded record, or nothing to import.
   */
  const seedFor = async (state, leadSessionId) => {
    if (state.existed === true) return undefined
    if (state.seed === undefined) state.seed = seed === undefined || seed === '' ? { absent: true } : await readSeed(seed)
    if (state.seed.problem !== undefined) {
      state.problem = state.seed.problem
      return undefined
    }
    if (state.seed.rosters === undefined) return undefined
    const record = state.seed.rosters[leadSessionId]
    return record === undefined ? undefined : { record, origin: { source: PROVENANCE_SOURCE.seed, path: state.seed.path } }
  }

  /**
   * Import one Lead's record into this root, once, from the seed.
   *
   * This is the one write a load can make, and it is deliberately best-effort: the imported content is
   * served whether or not it reaches the disk, so a read-only workspace still answers with the Lead's
   * real roster and reports why it could not keep it.
   */
  const importLead = async (state, leadSessionId) => {
    await enqueue(state, async () => {
      if (state.content.rosters[leadSessionId] !== undefined) return
      const seeded = await seedFor(state, leadSessionId)
      if (seeded === undefined) return
      const { record, origin } = seeded
      state.content = {
        ...state.content,
        rosters: { ...state.content.rosters, [leadSessionId]: record },
      }
      state.importedAt = now()
      try {
        // The import is a write, so it is bounded like any other: the backlog that accumulated before this
        // release is flushed the first time a Lead's tools load, not whenever somebody happens to write
        // next. The provenance still records what came across, not what the window kept.
        state.content = {
          ...state.content,
          rosters: { ...state.content.rosters, [leadSessionId]: await bound(state, leadSessionId, undefined, record) },
        }
        await persist(state, state.content)
        await writeMarker(state, leadSessionId, record, origin)
      } catch (error) {
        state.problem = `the imported roster could not be written (${describeError(error)})`
      }
    })
  }

  const loadAndImport = async (state, leadSessionId) => {
    state.loading ??= load(state)
    await state.loading
    await importLead(state, leadSessionId)
  }

  /**
   * Bound one Lead's tombstones: keep the newest `trashLimit`, append the rest to the archive.
   *
   * This is the invariant, and it is enforced on the file rather than on one operation — any write of any
   * kind bounds the record, so the tombstones that accumulated before this release are flushed by the next
   * write instead of needing a one-off migration.
   *
   * A tombstone may leave the roster only when removing it cannot lose anything a reader could still act
   * on, and each condition is a fact rather than an intention:
   *
   *   - it is past the newest `trashLimit` tombstones, which is where the retention cap has already been
   *     removing artifacts — the window is derived from that cap so the two cannot drift apart;
   *   - it names a trash destination (a record that moved nothing, or that the workspace archive hid,
   *     keeps its state and stays: its artifact is somewhere a restore could still reach);
   *   - its move is not `pending` (a move in flight may or may not have landed);
   *   - and **its artifact is on no leg of the chain `restore_member` searches**. The window decides when
   *     to look; the filesystem decides. A record whose bytes are still there stays, whatever its age.
   *
   * What is archived keeps its id: `retiredChildIds` is every retired child Session id this Lead has ever
   * had, archived ones included, because the host hooks strip the shipped panels by id and a tombstone that
   * left the roster must not let its member reappear there. The list is rewritten on every write so a
   * restored member leaves it — a live member the panel stripped would be worse than a stale record.
   */
  const bound = async (state, leadSessionId, previous, produced) => {
    const ids = new Set(previous?.retiredChildIds ?? [])
    for (const member of produced.members) {
      if (typeof member?.childId !== 'string' || member.childId === '') continue
      if (member.phase === PHASE.retired) ids.add(member.childId)
      else ids.delete(member.childId)
    }
    const tombstones = produced.members.filter((member) => member?.phase === PHASE.retired)
    const ordered = [...tombstones].sort((left, right) => retireStamp(right) - retireStamp(left)
      || (targetOf(left) < targetOf(right) ? -1 : 1))
    const archived = []
    for (const member of ordered.slice(trashLimit)) {
      if (recordedTrashDir(member) === undefined) continue
      if (member.trashState === TRASH_STATE.pending) continue
      if (await locateTrashedArtifact({ record: member, leadSessionId, dataDir: state.root, home }) !== undefined) continue
      archived.push(member)
    }
    if (archived.length === 0) return { ...produced, retiredChildIds: [...ids].sort() }
    // The root may not exist yet — an import into a fresh workspace is the first write there — and an
    // append does not create its own directory the way the atomic replacement does.
    await mkdir(state.root, { recursive: true })
    // Appended before the roster is replaced: a crash between the two leaves a duplicate line in an
    // append-only history, which a reader can ignore, where the other order would lose the record.
    await appendFile(state.archive, archived
      .map((member) => `${JSON.stringify({ archivedAt: now(), reason: ARCHIVE_REASON, leadSessionId, member })}\n`)
      .join(''), 'utf8')
    const gone = new Set(archived.map((member) => member.memberId))
    return {
      ...produced,
      members: produced.members.filter((member) => !gone.has(member?.memberId)),
      retiredChildIds: [...ids].sort(),
    }
  }

  /** One write, on this root's chain: re-read, change, bound, replace. */
  const write = (state, leadSessionId, produce) => enqueue(state, async () => {
    const fresh = await freshest(state)
    const current = fresh.rosters[leadSessionId]
    const stored = await bound(state, leadSessionId, current, produce(current))
    const next = await persist(state, { ...fresh, rosters: { ...fresh.rosters, [leadSessionId]: stored } })
    return next.rosters[leadSessionId]
  })

  /**
   * The root one Lead's bytes belong to.
   *
   * Every Session is bound (`createRootBinder` answers the frozen directory when there is no workspace), so
   * a write with no root is a caller that never bound the Lead — a bug worth naming, not a case worth
   * silently falling through to the storage domain, which is what this plugin used to do and what it must
   * never do again: the domain is read-only history now.
   * @param {string} leadSessionId - the Lead whose root is wanted.
   * @returns {string} the bound root.
   */
  const rootFor = (leadSessionId) => {
    const root = binder?.rootOf?.(leadSessionId)
    if (root === undefined) {
      throw new Error(`team_roster: no data root is bound for "${leadSessionId}", so there is nowhere to write — bind the Lead before its roster is written`)
    }
    return root
  }

  const table = {
    /**
     * One Lead's record, or undefined when this process has not loaded its root yet.
     *
     * A read does not fall back to the storage domain: the domain's records reach a file through the import
     * in `importLead`, and answering from two places at once is how a reader ends up with records its file
     * does not have.
     */
    get(leadSessionId) {
      const root = binder?.rootOf?.(leadSessionId)
      if (root === undefined) return undefined
      const state = states.get(root)
      if (state === undefined || !state.loaded) return undefined
      return state.content.rosters[leadSessionId]
    },
    async put(leadSessionId, value) {
      const state = stateOf(rootFor(leadSessionId))
      state.loading ??= load(state)
      await state.loading
      return await write(state, leadSessionId, () => value)
    },
    async update(leadSessionId, mutate) {
      const state = stateOf(rootFor(leadSessionId))
      state.loading ??= load(state)
      await state.loading
      return await write(state, leadSessionId, (current) => {
        if (current === undefined) throw new Error(`no record "${leadSessionId}" to update`)
        return stampRoster(mutate(current), leadSessionId)
      })
    },
    entries() {
      const rows = []
      for (const state of states.values()) {
        for (const [leadSessionId, roster] of Object.entries(state.content.rosters)) rows.push([leadSessionId, roster])
      }
      return rows[Symbol.iterator]()
    },
  }

  return {
    table,
    /**
     * Bind one Lead to the root its workspace names, and start loading that root.
     * Synchronous on purpose: it is called while a Lead's tools are registered, and the load continues
     * on its own while the first tool call is still on its way.
     * @returns {string} the bound root — every Session gets one.
     */
    bind(leadSessionId, cwd) {
      const root = binder?.bind?.(leadSessionId, cwd)
      if (root === undefined) return undefined
      const state = stateOf(root)
      state.loading ??= load(state)
      return root
    },
    /** Every root bound so far is loaded and imported. */
    async ready() {
      for (const [leadSessionId, root] of binder?.roots?.() ?? []) {
        await loadAndImport(stateOf(root), leadSessionId)
      }
    },
    /** One Lead's root is loaded and imported. */
    async readyFor(leadSessionId) {
      const root = binder?.rootOf?.(leadSessionId)
      if (root === undefined) return
      await loadAndImport(stateOf(root), leadSessionId)
    },
    /**
     * Where this Lead's roster is, and anything a reader has to know about it: where it was imported
     * from, a writer this process did not expect, or a file it could not read.
     * @param {string} leadSessionId - the Lead asking.
     * @returns {object} the `storage` block of `list_members`.
     */
    report(leadSessionId) {
      const root = binder?.rootOf?.(leadSessionId)
      if (root === undefined) {
        // Every Session is bound when its tools are installed, so this is the shape of a read that arrived
        // before the binding — a caller that never bound its Lead, rather than a state a person can reach.
        return {
          source: 'none',
          message: 'This process has not bound a data root for this Lead, so it has no roster to report. Give the Session a working directory, so its roster lives under <workspace>/.agents/team/, or set DSH_TEAM_DATA_DIR to name that directory; with neither, the roster goes to <home>/.dsh/team-roster.',
        }
      }
      const state = states.get(root)
      const value = { source: 'file', path: join(root, ROSTER_FILE_NAME) }
      const notes = []
      if (state?.importedAt !== undefined) value.imported_at = state.importedAt
      if (state?.foreignWriteAt !== undefined) {
        value.foreign_write_at = state.foreignWriteAt
        notes.push(`another writer changed this workspace's roster at ${state.foreignWriteAt}, and dsh-team expects one writer per workspace: two Lead Sessions in one workspace share this file and the last write wins`)
      }
      if (state?.problem !== undefined) {
        value.read_problem = state.problem
        notes.push(`the roster file could not be used for this Lead (${state.problem}); its records come from what the seed or the legacy domain holds, and the next successful write repairs the file`)
      }
      if (notes.length > 0) value.message = `${notes.join('; ')}.`
      return value
    },
  }
}

/** Read one Lead's roster, or an empty roster when none exists yet. */
export function readRoster(table, leadSessionId) {
  return table.get(leadSessionId) ?? { leadSessionId, members: [] }
}

/**
 * How many of one Lead's tombstones are in the archive rather than in this record.
 *
 * `retiredChildIds` is every retired id this Lead has ever had, so the ones a remaining tombstone still
 * holds are exactly the ones that are not archived. A record written before the field exists keeps no
 * archive and answers 0, which is also true of the storage-domain mode: nothing is bounded without a root
 * to archive beside.
 * @param {object} roster - one Lead's record.
 * @returns {number} the archived tombstone count.
 */
export function archivedCount(roster) {
  if (!Array.isArray(roster?.retiredChildIds)) return 0
  const here = new Set((roster.members ?? [])
    .filter((member) => member?.phase === PHASE.retired)
    .map((member) => member.childId))
  return roster.retiredChildIds.filter((id) => !here.has(id)).length
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
 * The live member that currently holds the base name a stale target belonged to, when another generation
 * does.
 *
 * A target is namespaced by generation (`reviewer`, `reviewer-g2`, ...), so a refusal for a stale one is
 * actionable only when it says which live member the *name* now reaches: the caller can retarget with
 * that target instead of re-reading the roster. The base name is read from the stale record itself, not
 * by stripping a `-g<N>` suffix, because a base name may legally end in `-g2` on its own.
 * @param roster - one Lead's roster.
 * @param target - the stale model-facing target.
 * @returns {{target: string, generation: number}|undefined} the highest-generation live holder of that
 *   name, or undefined when the target is unknown or no other generation is live.
 */
export function currentHolderOf(roster, target) {
  const stale = findAnyTarget(roster, target)
  if (stale === undefined) return undefined
  let holder
  for (const member of roster.members) {
    if (member.name !== stale.name || member.memberId === stale.memberId) continue
    if (!ADDRESSABLE.has(member.phase)) continue
    if (holder === undefined || member.generation > holder.generation) holder = member
  }
  return holder === undefined ? undefined : { target: targetOf(holder), generation: holder.generation }
}

/**
 * The lifetime one stored member has.
 *
 * `ephemeral: true` is the durable spelling and the whole fact: a record with no flag is standing, which
 * is what every member written before either word existed is. The field is not renamed on the record,
 * because it is already in every roster and in ADR 0013 — the vocabulary changed, not the bytes
 * (ADR 0014, ADR 0026).
 * @param {object|undefined} member - one stored member record.
 * @returns {string} `standing` or `one-shot`.
 */
export function lifetimeOf(member) {
  return member?.ephemeral === true ? LIFETIME.oneShot : LIFETIME.standing
}

/**
 * What a spawn call declared its member's lifetime to be, from either spelling.
 *
 * `lifetime` is the vocabulary; `ephemeral: true` is the pre-v0.25 spelling of the same declaration and
 * keeps working, because ADR 0013 named it and every stored record carries it. A call that passes both
 * consistently is accepted; one that passes them inconsistently is refused rather than resolved, because
 * a tie-break would make one of the two fields a silent lie.
 *
 * Nothing else is consulted. A `replace` does not inherit the predecessor's lifetime, and a definition
 * file cannot declare one, so an omitted declaration is `standing` — the safe side, because only a
 * one-shot is ever retired without asking (ADR 0026).
 * @param {{lifetime?: string, ephemeral?: boolean}} call - the spawn call's two fields.
 * @param {string} source - operation name, so a refusal names what refused.
 * @returns {string} `standing` or `one-shot`.
 */
export function declaredLifetime({ lifetime, ephemeral }, source = 'spawn_member') {
  if (lifetime !== undefined && lifetime !== LIFETIME.standing && lifetime !== LIFETIME.oneShot) {
    throw new Error(`${source}: lifetime must be "${LIFETIME.standing}" or "${LIFETIME.oneShot}"`)
  }
  const fromFlag = ephemeral === undefined ? undefined : ephemeral === true ? LIFETIME.oneShot : LIFETIME.standing
  if (lifetime !== undefined && fromFlag !== undefined && lifetime !== fromFlag) {
    throw new Error(
      `${source}: lifetime "${lifetime}" and ephemeral: ${ephemeral} declare different lifetimes; pass one of them, or make them agree`,
    )
  }
  return lifetime ?? fromFlag ?? LIFETIME.standing
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
 * @param oneShot - true to record the member as one-shot: a lazy sweep retires it once it has run,
 *   stopped and still owns no open task (ADR 0013, ADR 0026). Only `true` is stored, so a record for a
 *   standing member is byte-identical to one written before this flag existed.
 */
export function planMember(roster, baseName, label, assignment, oneShot = false) {
  checkMemberName(baseName, 'planMember')
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
  if (oneShot === true) planned.ephemeral = true
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
 * Attach the route a member was started on, or leave the record untouched when there is none to record.
 *
 * A record with no route is not a defect: the field is optional, so every member spawned before this
 * release, and every member whose route could not be resolved, stays exactly the record it was. The
 * field is written once at spawn, next to the reservation it belongs to — never updated afterwards,
 * because it is a fact about the start and `started_with` is the receipt for the request (ADR 0016,
 * ADR 0024).
 * @param {object} member - the record being written.
 * @param {object|undefined} route - what to record, or undefined to record nothing.
 * @returns {object} the record to persist.
 */
export function withRoute(member, route) {
  return route === undefined ? member : { ...member, route }
}

/**
 * Whether a member's recorded route is one the Lead is no longer on.
 *
 * The comparison is the whole point of recording a route: a member started before a model switch keeps
 * the provider and model it was started with for its whole life, so it is still billed to the API it
 * began on while its Lead has moved. A row is flagged only when both sides name a complete route and
 * they differ — a member with no recorded route, or a Lead whose own route cannot be read, is not
 * evidence of a straggler and is left unflagged rather than guessed at (ADR 0024).
 * @param {object} member - one stored member record.
 * @param {{provider: string, model: string}|undefined} leadRoute - the Lead's current route.
 * @returns {boolean} true when the member's route differs from the Lead's.
 */
export function staleRouteOf(member, leadRoute) {
  const route = member?.route
  if (route === undefined || leadRoute === undefined) return false
  if (typeof route.provider !== 'string' || typeof route.model !== 'string') return false
  return route.provider !== leadRoute.provider || route.model !== leadRoute.model
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
