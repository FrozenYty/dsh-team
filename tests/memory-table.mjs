/**
 * A roster table fake with the three methods the lifecycle uses and the same serialization the storage
 * facility provides: writes queue on one chain, `update` hands its mutation the record as it is when
 * that write reaches the front of the chain, and an absent key refuses `update`.
 *
 * This is what makes a concurrency test meaningful — a fake that applied writes synchronously would
 * hide the read-modify-write race that `updateRoster` exists to avoid.
 */

import { PHASE } from '../roster.js'

/**
 * @param {{failRetirement?: boolean}} options - `failRetirement` refuses any write that carries a
 *   tombstone, which exercises the half-failure paths without a real storage backend.
 * @returns a table with `get`, `put`, `update` and `entries`.
 */
export function memoryTable({ failRetirement = false } = {}) {
  const rows = new Map()
  let chain = Promise.resolve()
  const enqueue = (job) => {
    const result = chain.then(job, job)
    chain = result.then(() => undefined, () => undefined)
    return result
  }
  const guard = (value) => {
    if (failRetirement && value.members.some((member) => member.phase === PHASE.retired)) {
      throw new Error('the storage domain refused the tombstone')
    }
    return value
  }
  return {
    get: (key) => rows.get(key),
    put: (key, value) => enqueue(() => {
      rows.set(key, guard(value))
    }),
    update: (key, mutate) => enqueue(() => {
      if (!rows.has(key)) throw new Error(`no record "${key}" to update`)
      const next = guard(mutate(rows.get(key)))
      rows.set(key, next)
      return next
    }),
    entries: () => [...rows.entries()][Symbol.iterator](),
  }
}
