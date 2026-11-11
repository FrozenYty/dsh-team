/**
 * Session-artifact trash for retired members.
 *
 * Retirement must be recoverable, so the member's persisted session is *moved* into a trash directory
 * instead of being deleted. The move also drops the artifact out of the session-query index, which is
 * what makes the member disappear from the host's own lists; that effect is why this module exists.
 *
 * Two branches are allowed to remove bytes, and no others: the cross-device move fallback removes the
 * source it has already copied, and `pruneLeadTrash` removes the oldest artifacts once a Lead's trash
 * passes the effective cap (ADR 0011, ADR 0012). A pruned artifact is gone for good, which is why the
 * tombstone keeps saying where it went.
 *
 * No `@deepseek-ai/*` import: a profile-linked bundle cannot resolve those packages (ADR 0002).
 */

import { cp, lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Environment override for the plugin data directory; tests use it too. */
const DATA_DIR_ENV = 'DSH_TEAM_ROSTER_DATA_DIR'

/**
 * How many retired sessions one Lead's trash keeps when the plugin config sets no cap.
 *
 * This is a documented default, not the authority: the effective cap is the `trashLimit` config field
 * resolved from the bundle's patch row by `resolveTrashLimit` below (ADR 0012, superseding point 1 of
 * ADR 0011). The unit is one Lead's trash directory and the content is whole Session artifacts, so 20
 * keeps a long recent history recoverable while bounding the growth; every retirement past the cap
 * removes exactly one older artifact, oldest first.
 */
export const DEFAULT_TRASH_LIMIT = 20

/** The plugin config field that carries the cap. */
export const TRASH_LIMIT_FIELD = 'trashLimit'

/** The smallest legal cap, mirroring the official integer config fields' `minimum: 1` bound. */
export const TRASH_LIMIT_MINIMUM = 1

/**
 * Resolve the plugin data directory.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @param {string} home - user home directory.
 * @returns {string} absolute data directory.
 */
export function resolveDataDir(env = process.env, home = homedir()) {
  const override = env[DATA_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(home, '.dsh', 'team-roster')
}

/** Render one rejected value so the message distinguishes `'20'` from `20` and shows `NaN` and `null`. */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value) ?? String(value)
  return String(value)
}

/**
 * Resolve the effective per-Lead retention cap from the plugin config.
 *
 * The official Agent Teams row declares `maxMembers`, `maxTasks`, `maxMessageBytes` and
 * `disposalTimeoutMs` as config fields with a default and `minimum: 1`, and a value outside that range
 * is refused rather than clamped. This mirrors that, minus the part of it a zero-import bundle cannot
 * have (ADR 0012): an absent field takes `DEFAULT_TRASH_LIMIT`, and anything that is not an integer of
 * at least `TRASH_LIMIT_MINIMUM` is refused with the field, the value it saw and the minimum named.
 * `apply` calls this before it registers anything, so a bad patch value fails the load, not the first
 * retirement.
 * @param {unknown} config - the plugin config the bundle's patch row supplied, if any.
 * @returns {number} the effective cap.
 * @throws {TypeError} when the config is not an object, or the field is present and not a positive integer.
 */
export function resolveTrashLimit(config) {
  if (config === undefined || config === null) return DEFAULT_TRASH_LIMIT
  const field = TRASH_LIMIT_FIELD
  const reject = (value) => new TypeError(
    `dsh-team-roster: config field "${field}" must be an integer >= ${TRASH_LIMIT_MINIMUM} `
    + `(minimum ${TRASH_LIMIT_MINIMUM}); received ${value}`,
  )
  if (typeof config !== 'object') throw reject(describeValue(config))
  const value = config[field]
  if (value === undefined) return DEFAULT_TRASH_LIMIT
  // `null` is deliberately not the default: it is a present, wrong value, and the official schema
  // accepts `null` only because its `anyOf` also admits a Loader expression.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < TRASH_LIMIT_MINIMUM) {
    throw reject(describeValue(value))
  }
  return value
}

/**
 * Decode the persistence backend's path-segment encoding (`~XXXX`), so a directory name can be compared
 * with a Session id.
 * @param {string} segment - one path segment.
 * @returns {string} decoded text.
 */
export function decodeSegment(segment) {
  return segment.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Choose what to move: the whole session directory when the artifact path points inside a directory
 * named after the Session, otherwise just the artifact file.
 * @param {string} locationPath - path the persistence backend reports.
 * @param {string} memberId - member Session id.
 * @returns {Promise<{path: string, isDirectory: boolean}|undefined>} source, or undefined when absent.
 */
export async function resolveSource(locationPath, memberId) {
  const info = await lstat(locationPath).catch(() => undefined)
  if (info === undefined) return undefined
  if (info.isDirectory()) return { path: locationPath, isDirectory: true }
  const parent = dirname(locationPath)
  if (decodeSegment(basename(parent)) === memberId) {
    const parentInfo = await lstat(parent).catch(() => undefined)
    if (parentInfo?.isDirectory() === true) return { path: parent, isDirectory: true }
  }
  return { path: locationPath, isDirectory: false }
}

/**
 * Move one artifact into the trash root. `rename` first; a cross-device error falls back to copy + remove
 * of the source, the one branch here that removes anything (the retention cap removes entries later,
 * never a source on the move path).
 * @param {{sourcePath: string, isDirectory?: boolean, trashRoot: string, dirName: string, renameFn?: typeof rename}} options
 * @returns {Promise<string>} the trash directory that now holds the artifact.
 */
export async function moveSessionArtifact({
  sourcePath,
  isDirectory = false,
  trashRoot,
  dirName,
  renameFn = rename,
}) {
  await mkdir(trashRoot, { recursive: true })
  const target = join(trashRoot, dirName)
  const moveDirectory = async () => {
    try {
      await renameFn(sourcePath, target)
      return target
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    await cp(sourcePath, target, { recursive: true, force: false, errorOnExist: false })
    await rm(sourcePath, { recursive: true, force: true })
    return target
  }
  if (isDirectory) return await moveDirectory()

  const finalPath = join(target, basename(sourcePath))
  try {
    await mkdir(target, { recursive: true })
    await renameFn(sourcePath, finalPath)
    return target
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  await mkdir(target, { recursive: true })
  await cp(sourcePath, finalPath, { force: false, errorOnExist: false })
  await rm(sourcePath, { force: true })
  return target
}

/**
 * Decide where one member's persisted session belongs in the trash, without moving anything yet.
 *
 * Retirement writes its tombstone before the move, so the intended trash path has to exist as a value
 * first: that is what lets a crash between the tombstone and the move leave a record pointing at the
 * place the artifact was meant to go. Returns a reason instead of throwing, like every other failure
 * on this path.
 * @param {object} ctx - host plugin context.
 * @param {{leadSessionId: string, memberId: string, dataDir: string, now?: number}} request
 * @returns {Promise<
 *   {planned: true, trashPath: string, originalPath: string, kind: 'directory'|'file',
 *    source: {path: string, isDirectory: boolean}, trashRoot: string, dirName: string}
 *   | {planned: false, reason: string}>}
 */
export async function planMemberTrash(ctx, request) {
  const { leadSessionId, memberId, dataDir } = request
  const stamp = Number.isFinite(request.now) ? Number(request.now) : Date.now()
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    return { planned: false, reason: 'no-persistence' }
  }
  let snapshot
  try {
    snapshot = await persistence.stat(memberId)
  } catch (error) {
    return { planned: false, reason: `stat-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const locationPath = snapshot?.location?.path
  if (typeof locationPath !== 'string' || locationPath === '') {
    return { planned: false, reason: 'no-artifact' }
  }
  const source = await resolveSource(locationPath, memberId)
  if (source === undefined) return { planned: false, reason: 'artifact-missing' }
  const trashRoot = join(dataDir, 'trash', leadSessionId)
  const dirName = `${memberId}-${stamp}`
  return {
    planned: true,
    trashPath: join(trashRoot, dirName),
    originalPath: source.path,
    kind: source.isDirectory ? 'directory' : 'file',
    source,
    trashRoot,
    dirName,
  }
}

/**
 * Move the artifact a plan named. Every failure is reported, never thrown: retirement is a lifecycle
 * fact owned by the record, and a storage problem must not leave the roster claiming a member is live.
 * @param {object} plan - result of `planMemberTrash` with `planned: true`.
 * @param {{renameFn?: typeof rename}} request - test seam for the cross-device branch.
 * @returns {Promise<{moved: true} | {moved: false, reason: string}>}
 */
export async function applyMemberTrash(plan, request = {}) {
  try {
    await moveSessionArtifact({
      sourcePath: plan.source.path,
      isDirectory: plan.source.isDirectory,
      trashRoot: plan.trashRoot,
      dirName: plan.dirName,
      ...request.renameFn === undefined ? {} : { renameFn: request.renameFn },
    })
    return { moved: true }
  } catch (error) {
    return { moved: false, reason: `move-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Move one member's persisted session into this plugin's trash.
 * Kept as the plan-then-move pair above; callers that must tombstone first use those two directly.
 * @param {object} ctx - host plugin context.
 * @param {{leadSessionId: string, memberId: string, dataDir: string, now?: number, renameFn?: typeof rename}} request
 * @returns {Promise<{moved: boolean, trashPath?: string, originalPath?: string, kind?: 'directory'|'file', reason?: string}>}
 */
export async function trashMemberSession(ctx, request) {
  const plan = await planMemberTrash(ctx, request)
  if (!plan.planned) return { moved: false, reason: plan.reason }
  const outcome = await applyMemberTrash(plan, request)
  if (!outcome.moved) return { moved: false, reason: outcome.reason }
  return { moved: true, trashPath: plan.trashPath, originalPath: plan.originalPath, kind: plan.kind }
}

/**
 * Whether one path exists. A tombstone can outlive the move it was written for, so restoring tells
 * "the artifact was never moved" from "the artifact disappeared" by looking where it came from.
 * @param {string} path - absolute path to test.
 * @returns {Promise<boolean>} whether the path exists.
 */
export async function pathExists(path) {
  return (await lstat(path).catch(() => undefined)) !== undefined
}

/**
 * Derive the directory that holds child Session directories, using any sibling still on disk.
 * A reported location looks like `.../<workspace-key>/<childId>/<artifact>`, so two `dirname` calls reach
 * the directory whose children are member directories.
 * @param {{stat?: (id: string) => Promise<unknown>}|undefined} persistence - session persistence service.
 * @param {string[]} childIds - candidate sibling Session ids.
 * @param {string} exceptId - the member being restored; never used as its own template.
 * @returns {Promise<string|undefined>} the sessions root, or undefined when no sibling is readable.
 */
export async function sessionRootFromSibling(persistence, childIds, exceptId) {
  if (persistence === undefined || typeof persistence.stat !== 'function') return undefined
  for (const childId of childIds) {
    if (childId === exceptId) continue
    let snapshot
    try {
      snapshot = await persistence.stat(childId)
    } catch (error) {
      continue
    }
    const reported = snapshot?.location?.path
    if (typeof reported !== 'string' || reported === '') continue
    return dirname(dirname(reported))
  }
  return undefined
}

/**
 * Move a trashed artifact back where it came from. This is the other half of retirement: the record keeps
 * the trash path and the original path, so recovery is a move, not a guess. Idempotent and
 * non-destructive — an existing destination is never overwritten.
 * @param {{trashPath: string, originalPath: string, kind?: 'directory'|'file', renameFn?: typeof rename}} request
 * @returns {Promise<{restored: boolean, path?: string, reason?: string}>}
 */
export async function restoreSessionArtifact(request) {
  const { trashPath, originalPath, kind = 'directory' } = request
  if (typeof trashPath !== 'string' || typeof originalPath !== 'string') {
    return { restored: false, reason: 'no-recorded-path' }
  }
  const trashInfo = await lstat(trashPath).catch(() => undefined)
  if (trashInfo === undefined) return { restored: false, reason: 'trash-missing' }
  const artifactPath = kind === 'file' ? join(trashPath, basename(originalPath)) : trashPath
  const artifactInfo = await lstat(artifactPath).catch(() => undefined)
  if (artifactInfo === undefined) return { restored: false, reason: 'artifact-missing' }
  const destinationInfo = await lstat(originalPath).catch(() => undefined)
  if (destinationInfo !== undefined) return { restored: false, reason: 'destination-exists' }

  await mkdir(dirname(originalPath), { recursive: true })
  const renameFn = request.renameFn ?? rename
  try {
    await renameFn(artifactPath, originalPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      return { restored: false, reason: `restore-failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (kind === 'file') {
      await cp(artifactPath, originalPath, { force: false, errorOnExist: false })
      await rm(artifactPath, { force: true })
    } else {
      await cp(artifactPath, originalPath, { recursive: true, force: false, errorOnExist: false })
      await rm(artifactPath, { recursive: true, force: true })
    }
  }
  if (kind === 'file') {
    // The trash entry for a moved file is a wrapper directory that is empty now. `rmdir` fails rather
    // than acting recursively, so it cannot touch data if the directory is not empty.
    await rmdir(trashPath).catch(() => undefined)
  }
  // Drop the per-Lead trash directory once it has no entries left; `rmdir` refuses a non-empty one.
  await rmdir(dirname(trashPath)).catch(() => undefined)
  return { restored: true, path: originalPath }
}

/**
 * Parse one trash directory name, `<memberId>-<ms>`, exactly as retirement writes it.
 *
 * The leading `.+` is greedy, so a member id that itself contains hyphens — a UUID, or an adopted
 * child Session id — splits at the last one and keeps its stamp. A name this plugin did not write
 * returns undefined and is therefore left alone; the trash is a directory an operator can also put
 * things in, and retention must never touch what it cannot account for.
 * @param {string} name - one direct child's name.
 * @returns {{memberId: string, stamp: number}|undefined}
 */
export function parseTrashDirName(name) {
  const match = /^(.+)-(\d+)$/.exec(name)
  if (match === null) return undefined
  const [, memberId, digits] = match
  const stamp = Number(digits)
  if (!Number.isSafeInteger(stamp)) return undefined
  // Conservative identity rule: a Session id is letters, digits and these separators. Anything else
  // is not a name this plugin wrote and is not considered.
  if (memberId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(memberId)) return undefined
  return { memberId, stamp }
}

/**
 * Bound one Lead's trash to `limit` artifacts, oldest first. The one deletion this plugin does
 * on its own bytes: the platform has no Session-deletion API, so a cap that does not remove its own
 * trash copies does not bound anything (ADR 0011).
 *
 * Conservative by construction:
 *
 *   - only direct children of this one Lead's trash directory are considered;
 *   - only names shaped `<memberId>-<ms>` with a plausible member id and a numeric stamp qualify, and
 *     only when a member record points at that exact path — a foreign name, a file, or an entry no
 *     tombstone accounts for is left where it is;
 *   - only a `trashState: 'done'` record may be removed. A `pending` move may or may not have landed,
 *     so its entry is counted against the cap but never deleted.
 *
 * The caller has already confirmed the move and holds the roster, so nothing here writes a record: it
 * answers which entries it removed and the caller flips those tombstones to `trashState: 'pruned'`.
 *
 * @param {{trashRoot: string, limit?: number, members?: object[]}} request - `members` is the Lead's
 *   roster member array; `limit` is the effective cap the caller resolved from the plugin config
 *   (ADR 0012) and defaults to the documented `DEFAULT_TRASH_LIMIT`, which is what `retireMember` falls
 *   back to when no config was supplied.
 * @returns {Promise<{pruned: number, removed: Array<{memberId: string, trashPath: string}>}>}
 */
export async function pruneLeadTrash({ trashRoot, limit = DEFAULT_TRASH_LIMIT, members = [] }) {
  const none = { pruned: 0, removed: [] }
  if (typeof trashRoot !== 'string' || trashRoot.trim() === '') return none
  const entries = await readdir(trashRoot, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return none

  // The tombstone is the authority: an artifact is a candidate only when a record says the move
  // landed (or is still in flight) and that this is where it went.
  //
  // `trashState` arrived with the cap in 0.7.0, so every tombstone written before it carries a
  // `trashPath` and no state at all. A record with a path but no state has completed its move — the
  // field simply did not exist yet — and treating it as anything else leaves the whole legacy trash
  // permanently exempt, which is exactly what the first live run of the cap did.
  const byPath = new Map()
  for (const member of members) {
    if (typeof member?.trashPath !== 'string' || member.trashPath === '') continue
    byPath.set(resolve(member.trashPath), { ...member, trashState: member.trashState ?? 'done' })
  }

  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const parsed = parseTrashDirName(entry.name)
    if (parsed === undefined) continue
    const trashPath = join(trashRoot, entry.name)
    const member = byPath.get(resolve(trashPath))
    if (member === undefined) continue
    if (member.trashState !== 'done' && member.trashState !== 'pending') continue
    candidates.push({ ...parsed, name: entry.name, trashPath, trashState: member.trashState })
  }

  const excess = candidates.length - limit
  if (excess <= 0) return none

  // Oldest first, by the millisecond stamp the name carries. A candidate always carries one, so the
  // mtime fallback the design allows for an unparseable name is subsumed by the candidacy rule; the
  // branch below is kept so widening that rule cannot silently change the order. Identical stamps
  // fall back to the name, which keeps the order deterministic.
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.stamp)) {
      const info = await lstat(candidate.trashPath).catch(() => undefined)
      candidate.stamp = info?.mtimeMs ?? 0
    }
  }
  candidates.sort((a, b) => a.stamp - b.stamp || (a.name < b.name ? -1 : 1))

  const removed = []
  for (const candidate of candidates) {
    if (removed.length >= excess) break
    if (candidate.trashState !== 'done') continue
    try {
      await rm(candidate.trashPath, { recursive: true, force: true })
    } catch (error) {
      // A file that refuses to go is reported by staying there, and the record keeps saying `done`.
      continue
    }
    removed.push({ memberId: candidate.memberId, trashPath: candidate.trashPath })
  }
  return { pruned: removed.length, removed }
}
