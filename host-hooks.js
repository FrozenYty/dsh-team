/**
 * Host-side effects that make a retired member actually disappear, make the members this plugin owns
 * appear in the shipped team panel, and keep the shipped roster's member budget usable after retirement.
 *
 * Four mechanisms, all implemented here with a disposer so plugin unload restores the host exactly:
 *
 *   1. **Projection filter, strip** — the host's `sessionController` serves `/api/session/list` and the
 *      `control`/`follow` streams, which carry `subagentCatalog` and `agentTeam.members`. Retired ids are
 *      stripped at that exit, so every client (top subagent picker, built-in team panel) stops rendering
 *      them without touching host source or rebuilding the Web app.
 *   2. **Projection filter, merge** — the built-in team panel renders `agentTeam` from the shipped fold,
 *      which never heard of a member started through `ctx.subagents`. The same exit appends this Lead's
 *      live members to the outgoing value, in the four fields the wire schema requires (ADR 0023).
 *   3. **Shipped roster read** — the shipped `list_agents` tool answers from
 *      `agentTeams.listMembers(caller)`, which folds the append-only Team journal and therefore keeps a
 *      retired member forever. That method is patched to drop the same retired ids (ADR 0025).
 *   4. **Slot credit** — the shipped legacy roster counts `members.length` against a single
 *      `maxMembers`. While a spawn runs, the effective limit is raised by the number of retired members
 *      of *that* Lead, so one retirement buys back one slot without editing the append-only log.
 *
 * The projection halves only rewrite the copy a client is about to receive; the shipped roster read only
 * drops rows from the array it was about to return; the Session log is never written. Everything is
 * capability-probed and skipped when the host shape is absent: a Harness upgrade must degrade the
 * feature, never break the plugin. A tombstone read that fails is not silent either: the last good set
 * stays in force and the failure is reported through `list_members` (ADR 0025).
 */

/** Marks the wrapped service so a reload cannot wrap it twice. */
const FILTER_MARK = Symbol.for('dsh.team-roster.projection-filter')
/** Marks the patched shipped roster read, so a reload cannot wrap it twice. */
const ROSTER_READ_MARK = Symbol.for('dsh.team-roster.roster-read')
/** Marks the patched roster, and holds its refresh function for reloads. */
const SLOT_MARK = Symbol.for('dsh.team-roster.slot-credit')

/**
 * The one tombstone set every host hook reads, with the one invalidation a retirement or a restore
 * performs.
 *
 * A read that throws is the failure nobody could see before: the hooks used to answer with an empty set,
 * so both shipped lists came back full and nothing said so. The last good set stays in force instead,
 * and `report()` says the read failed and how many ids are still being stripped (ADR 0025).
 * @param {{readRetired: () => Promise<Set<string>>, log?: (line: string) => void, ttlMs?: number}} options
 * @returns {{ids: () => Promise<Set<string>>, invalidate: () => void, report: () => Promise<{ids: number, failed: boolean}>}}
 */
export function createRetiredCache({ readRetired, log = () => {}, ttlMs = 2000 }) {
  const cache = { at: 0, ids: new Set(), failed: false }
  const load = async () => {
    try {
      const ids = await readRetired()
      cache.ids = ids instanceof Set ? ids : new Set()
      cache.failed = false
    } catch (error) {
      cache.failed = true
      log(`team-roster: could not read tombstones, the last set stays in force (${cache.ids.size} ids) (${error instanceof Error ? error.message : String(error)})`)
    }
    cache.at = Date.now()
    return cache.ids
  }
  return {
    ids: async () => (Date.now() - cache.at < ttlMs ? cache.ids : await load()),
    invalidate: () => { cache.at = 0 },
    // Forces one read, so the number a caller sees is the number the hooks are using now.
    report: async () => ({ ids: (await load()).size, failed: cache.failed }),
  }
}

/** Session-list methods that return one value. */
const UNARY_METHODS = ['list', 'projections']
/** Session-list methods that stream frames. */
const STREAM_METHODS = ['control', 'follow']

/** Whether one value is an `agentTeam` view (`{ members, tasks }`). */
const isTeamView = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Array.isArray(value.members)

/**
 * The value of a projection frame (`{ key, value }` or `{ key, val }`) when it names that key.
 * The installed `sessionController` publishes `{ key, val }`; `{ key, value }` is the shape this
 * filter was first written against and is kept so an older host is still served.
 */
const framedValue = (node, key) => {
  if (node.key !== key) return undefined
  return node.value !== undefined ? node.value : node.val
}

/** Replace the value `framedValue` returned, keeping the frame's own field name. */
const setFramedValue = (node, value) => {
  if (node.value !== undefined) node.value = value
  else node.val = value
}

/** Whether one object is the `projections` map of a control baseline, keyed by Lead Session id. */
const isProjectionIndex = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && !Object.hasOwn(value, 'values')

/**
 * Walk one outgoing payload and rewrite every team and catalog list it carries, at the exit where a
 * client-facing copy is built.
 *
 * The shapes are the installed `sessionController` ones: a list row's `projections.values`, a
 * `projections` baseline's `values`, a `control` baseline's `value.projections` map, a `control` change
 * frame's `changes[].val`, and a `follow` snapshot's `projections.values`. The Session id an
 * `agentTeam` value belongs to comes from the row's `sessionId`, the snapshot's `header.id`, the
 * baseline map's key, or the change frame's `sessionId`.
 * @param {unknown} payload - one session-list payload or streamed frame.
 * @param {{catalog: (entries: unknown[]) => unknown[], members: (members: unknown[], leadId: string|undefined) => unknown[]}} rewrite
 * @param {number} maxDepth - recursion guard for unexpected shapes.
 * @param {string|undefined} leadSessionId - Session the payload belongs to, when it carries no id.
 * @returns {unknown} the same payload reference.
 */
function rewriteExit(payload, rewrite, maxDepth, leadSessionId) {
  const visit = (node, depth, scope) => {
    if (node === null || typeof node !== 'object' || depth > maxDepth) return
    const leadId = typeof node.sessionId === 'string'
      ? node.sessionId
      : typeof node.header?.id === 'string' ? node.header.id : scope
    if (Array.isArray(node.subagentCatalog)) node.subagentCatalog = rewrite.catalog(node.subagentCatalog)
    if (isTeamView(node.agentTeam)) node.agentTeam.members = rewrite.members(node.agentTeam.members, leadId)
    const teamFrame = framedValue(node, 'agentTeam')
    if (isTeamView(teamFrame)) teamFrame.members = rewrite.members(teamFrame.members, leadId)
    const catalogFrame = framedValue(node, 'subagentCatalog')
    if (Array.isArray(catalogFrame)) setFramedValue(node, rewrite.catalog(catalogFrame))
    const index = isProjectionIndex(node.projections)
    if (index) {
      for (const [lead, block] of Object.entries(node.projections)) visit(block, depth + 1, lead)
    }
    for (const key of Object.keys(node)) {
      if (key === 'agentTeam' || key === 'subagentCatalog') continue
      if (key === 'projections' && index) continue
      visit(node[key], depth + 1, leadId)
    }
  }
  visit(payload, 0, leadSessionId)
  return payload
}

/**
 * Remove retired member ids from one session-list payload, in place.
 * @param {unknown} payload - a `/api/session/list` body, a projection frame, or one session row.
 * @param {Set<string>} retired - retired child Session ids.
 * @param {number} maxDepth - recursion guard for unexpected shapes.
 * @returns {unknown} the same payload reference.
 */
export function stripRetiredMembers(payload, retired, maxDepth = 8) {
  if (payload === null || typeof payload !== 'object' || !(retired instanceof Set) || retired.size === 0) {
    return payload
  }
  const isRetired = (entry) => entry !== null
    && typeof entry === 'object'
    && typeof entry.id === 'string'
    && retired.has(entry.id)
  return rewriteExit(payload, {
    catalog: (entries) => entries.filter((entry) => !isRetired(entry)),
    members: (members) => members.filter((entry) => !isRetired(entry)),
  }, maxDepth)
}

/**
 * Add this Lead's live members to one session-list payload, in place, without duplicating an id that is
 * already in a team value.
 *
 * The row is the four fields `teamMemberProjectionSchema` requires and the panel reads — `id`, `name`,
 * `role` and `phase` — and nothing else, because the wire schema is strict. `name` is the model-facing
 * target (`reviewer`, `reviewer-g2`), which is the handle the panel label and the click's conversation
 * share; `id` is the child Session id the roster recorded, which is what makes that click open the real
 * chat (ADR 0023).
 * @param {unknown} payload - one session-list payload or streamed frame.
 * @param {(leadSessionId: string) => Array<{id: string, name: string}>} readLive - live rows for one Lead.
 * @param {string|undefined} leadSessionId - Session the payload belongs to, when it carries no id.
 * @returns {unknown} the same payload reference.
 */
export function mergeLiveMembers(payload, readLive, leadSessionId) {
  if (payload === null || typeof payload !== 'object' || typeof readLive !== 'function') return payload
  return rewriteExit(payload, {
    catalog: (entries) => entries,
    members: (members, leadId) => {
      if (typeof leadId !== 'string') return members
      const live = readLive(leadId)
      if (!Array.isArray(live) || live.length === 0) return members
      const known = new Set(members.map((entry) => entry?.id))
      const added = []
      for (const member of live) {
        if (typeof member?.id !== 'string' || member.id.length === 0 || typeof member.name !== 'string') continue
        if (known.has(member.id)) continue
        known.add(member.id)
        added.push({ id: member.id, name: member.name, role: 'teammate', phase: 'active' })
      }
      return added.length === 0 ? members : [...members, ...added]
    },
  }, 8, leadSessionId)
}

/** A no-op disposer. */
const NOOP = () => {}

/**
 * Wrap the host session-list exits so retired members are never sent to a client, and the members this
 * plugin owns are.
 * @param {object} ctx - host plugin context.
 * @param {{cache?: object, readRetired?: () => Promise<Set<string>>, readLive?: (leadSessionId: string) => Array<{id: string, name: string}>, log?: (line: string) => void, ttlMs?: number}} options
 *   `cache` is the shared tombstone set when the caller has one; `readRetired` builds one otherwise.
 * @returns {{installed: boolean, dispose: () => void, invalidate: () => void}}
 */
export function installProjectionFilter(ctx, options) {
  const { readRetired, readLive = () => [], log = () => {}, ttlMs = 2000, cache = createRetiredCache({ readRetired, log, ttlMs }) } = options
  const service = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (service === undefined || service === null) {
    return { installed: false, dispose: NOOP, invalidate: NOOP }
  }
  if (service[FILTER_MARK] !== undefined) {
    // Already installed by a previous load of this plugin; reuse its refresher.
    return { installed: true, dispose: NOOP, invalidate: service[FILTER_MARK].invalidate }
  }

  const invalidate = cache.invalidate
  const retiredIds = cache.ids
  const strip = async (value, leadSessionId) => {
    const ids = await retiredIds()
    const stripped = ids.size === 0 ? value : stripRetiredMembers(value, ids)
    return mergeLiveMembers(stripped, readLive, typeof leadSessionId === 'string' ? leadSessionId : undefined)
  }

  const restores = []
  for (const method of UNARY_METHODS) {
    const original = service[method]
    if (typeof original !== 'function') continue
    service[method] = async function teamRosterFilteredUnary(...args) {
      // A `projections` read carries its Session id in the request; a list read carries one per row.
      return await strip(await original.apply(this, args), args[0]?.sessionId)
    }
    restores.push(() => { service[method] = original })
  }
  for (const method of STREAM_METHODS) {
    const original = service[method]
    if (typeof original !== 'function') continue
    service[method] = async function* teamRosterFilteredStream(...args) {
      for await (const frame of original.apply(this, args)) yield await strip(frame)
    }
    restores.push(() => { service[method] = original })
  }
  if (restores.length === 0) return { installed: false, dispose: NOOP, invalidate: NOOP }

  service[FILTER_MARK] = { invalidate }
  return {
    installed: true,
    invalidate,
    dispose() {
      for (const restore of restores.reverse()) restore()
      delete service[FILTER_MARK]
    },
  }
}

/**
 * Drop this plugin's retired ids from the shipped roster read the `list_agents` tool answers from.
 *
 * The shipped tool calls `agentTeams.listMembers(callingAgent(exec.agent, "list_agents"))` and maps the
 * returned array directly (`@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:321-327`), and
 * `agentTeams.listMembers` is the append-only Team journal's own view (`dsh-experimental-agent-team`
 * `lib/index.js:1496`, `lib/types/roster.js:103-134`), so a retired member stays in that list forever.
 * The method is patched to return the same `TeamMemberView[]` minus those ids; `lead` has its own
 * Session id, which is never a tombstone, so it always stays.
 *
 * The wrapper is deliberately **synchronous**: the shipped caller maps the result without awaiting it,
 * and an async wrapper would turn the array into a promise and break that `.map`. It therefore reads the
 * tombstone set synchronously, through `readRetiredNow`, from the in-memory roster table — the same set
 * the projection filter strips, with no cache to go stale, which is why a retirement needs no
 * invalidation here. `undefined` means the roster table is not resolved yet, and the rows are returned
 * unfiltered rather than guessed at.
 * @param {object} ctx - host plugin context.
 * @param {{readRetiredNow?: () => Set<string>|undefined}} options
 * @returns {{installed: boolean, dispose: () => void}}
 */
export function installRosterFilter(ctx, options = {}) {
  const { readRetiredNow = () => undefined } = options
  const service = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
  if (service === undefined || service === null || typeof service.listMembers !== 'function') {
    return { installed: false, dispose: NOOP }
  }
  if (service[ROSTER_READ_MARK] !== undefined) {
    return { installed: true, dispose: NOOP }
  }

  const original = service.listMembers
  service.listMembers = function teamRosterFilteredList(...args) {
    const rows = original.apply(this, args)
    if (!Array.isArray(rows)) return rows
    const retired = readRetiredNow()
    if (!(retired instanceof Set) || retired.size === 0) return rows
    return rows.filter((row) => row === null
      || typeof row !== 'object'
      || typeof row.id !== 'string'
      || !retired.has(row.id))
  }
  service[ROSTER_READ_MARK] = {}
  return {
    installed: true,
    dispose() {
      service.listMembers = original
      delete service[ROSTER_READ_MARK]
    },
  }
}

/**
 * Raise the shipped roster's effective `maxMembers` by the number of retired members of the spawning
 * Lead, for the duration of one spawn.
 * @param {object} ctx - host plugin context.
 * @param {{readRetiredByTeam: () => Promise<Map<string, number>>, log?: (line: string) => void}} options
 * @returns {{installed: boolean, refresh: () => Promise<number>, dispose: () => void}}
 */
export function installSlotCredit(ctx, options) {
  const { readRetiredByTeam, log = () => {} } = options
  const service = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
  const roster = service?.roster
  if (roster === null || roster === undefined || typeof roster.maxMembers !== 'number') {
    return { installed: false, refresh: async () => 0, dispose: NOOP }
  }
  if (roster[SLOT_MARK] !== undefined) {
    return { installed: true, refresh: roster[SLOT_MARK].refresh, dispose: NOOP }
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(roster, 'maxMembers')
  const originalSpawn = roster.spawn
  const base = roster.maxMembers
  const credit = new Map()
  const live = { current: 0 }

  Object.defineProperty(roster, 'maxMembers', {
    configurable: true,
    enumerable: true,
    get: () => base + live.current,
  })
  if (typeof originalSpawn === 'function') {
    roster.spawn = async function teamRosterScopedSpawn(caller, request) {
      let extra = 0
      try {
        extra = credit.get(roster.membership(caller).root.id) ?? 0
      } catch (error) {
        extra = 0
      }
      // `live.current` is one process-wide field and the real `maxMembers` read happens later, inside
      // `roster.spawn`'s transact. Restore the previous value rather than zero, so a spawn that is
      // itself caught by an outer spawn (or interleaved with one) does not lose the outer credit.
      const previous = live.current
      live.current = extra
      try {
        return await originalSpawn.call(this, caller, request)
      } finally {
        live.current = previous
      }
    }
  }

  const refresh = async () => {
    let total = 0
    try {
      const byTeam = await readRetiredByTeam()
      credit.clear()
      for (const [leadId, count] of byTeam) {
        credit.set(leadId, count)
        total += count
      }
    } catch (error) {
      log(`team-roster: could not read tombstones, slots are not credited (${error instanceof Error ? error.message : String(error)})`)
    }
    return total
  }

  roster[SLOT_MARK] = { refresh }
  return {
    installed: true,
    refresh,
    dispose() {
      if (typeof originalSpawn === 'function') roster.spawn = originalSpawn
      if (originalDescriptor === undefined) delete roster.maxMembers
      else Object.defineProperty(roster, 'maxMembers', originalDescriptor)
      delete roster[SLOT_MARK]
    },
  }
}
