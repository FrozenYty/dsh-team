/**
 * Host-side effects that make a retired member actually disappear, and that keep the shipped roster's
 * member budget usable after retirement.
 *
 * Two mechanisms, both borrowed from a peer plugin and both implemented here with a disposer so plugin
 * unload restores the host exactly:
 *
 *   1. **Projection filter** — the host's `sessionController` serves `/api/session/list` and the
 *      `control`/`follow` streams, which carry `subagentCatalog` and `agentTeam.members`. Retired ids are
 *      stripped at that exit, so every client (top subagent picker, built-in team panel) stops rendering
 *      them without touching host source or rebuilding the Web app.
 *   2. **Slot credit** — the shipped legacy roster counts `members.length` against a single
 *      `maxMembers`. While a spawn runs, the effective limit is raised by the number of retired members
 *      of *that* Lead, so one retirement buys back one slot without editing the append-only log.
 *
 * Both are capability-probed and silently skipped when the host shape is absent: a Harness upgrade must
 * degrade the feature, never break the plugin.
 */

/** Marks the wrapped service so a reload cannot wrap it twice. */
const FILTER_MARK = Symbol.for('dsh.team-roster.projection-filter')
/** Marks the patched roster, and holds its refresh function for reloads. */
const SLOT_MARK = Symbol.for('dsh.team-roster.slot-credit')

/** Session-list methods that return one value. */
const UNARY_METHODS = ['list', 'projections']
/** Session-list methods that stream frames. */
const STREAM_METHODS = ['control', 'follow']

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
  const visit = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > maxDepth) return
    if (Array.isArray(node.subagentCatalog)) node.subagentCatalog = node.subagentCatalog.filter((entry) => !isRetired(entry))
    if (node.agentTeam !== null && typeof node.agentTeam === 'object' && Array.isArray(node.agentTeam.members)) {
      node.agentTeam.members = node.agentTeam.members.filter((entry) => !isRetired(entry))
    }
    // Projection frames look like { key: 'agentTeam', value: { members } }.
    if (node.key === 'agentTeam' && node.value !== null && typeof node.value === 'object' && Array.isArray(node.value.members)) {
      node.value.members = node.value.members.filter((entry) => !isRetired(entry))
    }
    if (node.key === 'subagentCatalog' && Array.isArray(node.value)) {
      node.value = node.value.filter((entry) => !isRetired(entry))
    }
    for (const key of Object.keys(node)) {
      if (key === 'subagentCatalog' || key === 'agentTeam') continue
      visit(node[key], depth + 1)
    }
  }
  visit(payload, 0)
  return payload
}

/** A no-op disposer. */
const NOOP = () => {}

/**
 * Wrap the host session-list exits so retired members are never sent to a client.
 * @param {object} ctx - host plugin context.
 * @param {{readRetired: () => Promise<Set<string>>, log?: (line: string) => void, ttlMs?: number}} options
 * @returns {{installed: boolean, dispose: () => void, invalidate: () => void}}
 */
export function installProjectionFilter(ctx, options) {
  const { readRetired, log = () => {}, ttlMs = 2000 } = options
  const service = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
  if (service === undefined || service === null) {
    return { installed: false, dispose: NOOP, invalidate: NOOP }
  }
  if (service[FILTER_MARK] !== undefined) {
    // Already installed by a previous load of this plugin; reuse its refresher.
    return { installed: true, dispose: NOOP, invalidate: service[FILTER_MARK].invalidate }
  }

  const cache = { at: 0, ids: new Set() }
  const invalidate = () => { cache.at = 0 }
  const retiredIds = async () => {
    if (Date.now() - cache.at < ttlMs) return cache.ids
    try {
      cache.at = Date.now()
      cache.ids = await readRetired()
    } catch (error) {
      log(`team-roster: could not read tombstones, serving unfiltered projections (${error instanceof Error ? error.message : String(error)})`)
      cache.at = Date.now()
      cache.ids = new Set()
    }
    return cache.ids
  }
  const strip = async (value) => {
    const ids = await retiredIds()
    return ids.size === 0 ? value : stripRetiredMembers(value, ids)
  }

  const restores = []
  for (const method of UNARY_METHODS) {
    const original = service[method]
    if (typeof original !== 'function') continue
    service[method] = async function teamRosterFilteredUnary(...args) {
      return await strip(await original.apply(this, args))
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
      live.current = extra
      try {
        return await originalSpawn.call(this, caller, request)
      } finally {
        live.current = 0
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
