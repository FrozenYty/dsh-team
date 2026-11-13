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

/**
 * Environment override for the plugin data directory; tests use it too.
 *
 * The variable and the directory it guards keep the pre-rename `TEAM_ROSTER` spelling on purpose
 * (ADR 0014). Every tombstone written before this field existed records an absolute `trashPath` under
 * `~/.dsh/team-roster`, and that directory is still the last leg of the read-time fallback chain
 * `trashPathCandidates` below describes: renaming either the default directory or the variable would
 * leave those recorded paths outside every root the plugin looks in, so the retention cap would stop
 * seeing those artifacts and `restore_member` would move a file back from a directory nothing writes to
 * any more. The package name changed; the place durable bytes already live did not.
 */
const DATA_DIR_ENV = 'DSH_TEAM_DATA_DIR'
/** The pre-rename name of the same variable; still honoured so an existing profile keeps working. */
const LEGACY_DATA_DIR_ENV = 'DSH_TEAM_ROSTER_DATA_DIR'

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
 * The data directory every earlier release wrote into, under the frozen name ADR 0014 protects.
 *
 * Two jobs. It is the last leg of the read-time fallback chain — an artifact that is not under the
 * directory in effect is still looked for here, which is what keeps a trash a Lead already has restorable
 * after the configured root moves — and it is the root of last resort: a Session with no workspace, and no
 * override, keeps its roster here, so every Session has somewhere a person could open.
 * @param {string} home - user home directory.
 * @returns {string} the frozen default data directory.
 */
export function frozenDataDir(home = homedir()) {
  return join(home, '.dsh', 'team-roster')
}

/**
 * The workspace-relative directory this plugin owns, beside the memory notebook.
 *
 * One folder holds everything dsh-team writes: the roster file, its import marker and the trash. It is
 * a *relative* name because the absolute root is per workspace, not per machine.
 */
export const TEAM_DIR = '.agents/team'

/**
 * The data directory an operator configured, or undefined when none is set.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @returns {string|undefined} the configured root, trimmed.
 */
function configuredDataDir(env) {
  for (const variable of [DATA_DIR_ENV, LEGACY_DATA_DIR_ENV]) {
    const override = env?.[variable]
    if (typeof override === 'string' && override.trim() !== '') return override.trim()
  }
  return undefined
}

/**
 * Resolve the plugin data directory.
 *
 * The order is the operator's override, then the workspace the caller named, then the frozen pre-0.26.0
 * directory. All three are destinations: the frozen one is where a Session with no workspace keeps its
 * roster, and where an artifact from an earlier release still sits (see `trashPathCandidates` below).
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @param {string} home - user home directory.
 * @param {string} [cwd] - the workspace directory this call is for.
 * @returns {string} absolute data directory.
 */
export function resolveDataDir(env = process.env, home = homedir(), cwd) {
  const configured = configuredDataDir(env)
  if (configured !== undefined) return configured
  if (typeof cwd === 'string' && cwd !== '') return resolve(cwd, TEAM_DIR)
  return frozenDataDir(home)
}

/**
 * The data root each Lead Session is bound to, for the life of this process.
 *
 * A workspace root is derived from the Lead's working directory, and a session's working directory can
 * change while it runs (`working_directory` is a tool). Resolving the root on every call would therefore
 * move the data out from under a running Lead: its next read would look in the new workspace, find
 * nothing, and its records would look orphaned. So the first resolution binds, and every later one
 * answers the bound root. The binding lives here, in this process's memory — nothing a
 * `working_directory` call touches can reach it — and it is keyed by Lead Session id, so two Leads in
 * two workspaces each keep their own root.
 *
 * `undefined` is no longer an answer: a Session whose workspace cannot be known (no working directory, no
 * override) keeps its roster under the frozen pre-0.26.0 directory — a real directory, a real file, and one
 * a person can open. That is what let the storage domain stop being written: there is always somewhere for
 * the bytes to go, so nothing has to fall through to it.
 *
 * The binding is deliberately not persisted. A file that recorded it would itself live at a location the
 * current directory decides, so it could not settle the very question it was written to answer; and after
 * a restart the session's own working directory is the host's answer, which is a better starting point
 * than a stale absolute path. What *is* durable is the roster file at the bound root, and that is what a
 * later process reads.
 * @param {{env?: NodeJS.ProcessEnv, home?: string}} [options] - the environment and home directory the
 *   configured override is read from.
 * @returns {{bind: (leadSessionId: string, cwd?: string) => string,
 *   rootOf: (leadSessionId: string) => string|undefined, roots: () => Map<string, string>}}
 */
export function createRootBinder({ env = process.env, home = homedir() } = {}) {
  const bound = new Map()
  const configured = configuredDataDir(env)
  return {
    bind(leadSessionId, cwd) {
      const existing = bound.get(leadSessionId)
      if (existing !== undefined) return existing
      const root = configured
        ?? (typeof cwd === 'string' && cwd !== '' ? resolve(cwd, TEAM_DIR) : frozenDataDir(home))
      bound.set(leadSessionId, root)
      return root
    },
    rootOf(leadSessionId) {
      return bound.get(leadSessionId)
    },
    roots() {
      return new Map(bound)
    },
  }
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
    `dsh-team: config field "${field}" must be an integer >= ${TRASH_LIMIT_MINIMUM} `
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
 * The two path segments one session's directory sits at, under the sessions root: `<slug>/<leaf>`.
 *
 * This is what a tombstone stores instead of an absolute path, for the reason ADR 0028 gave for the trash:
 * the roster is a file a person copies to another machine, and an absolute path from this one names
 * nothing there. Both segments are taken **as the host spelled them on disk** — the leaf is the encoded
 * Session id the persistence backend uses, and the first segment is the workspace slug *the host chose*,
 * never recomputed from the working directory: a prediction of the host's naming rules would break
 * silently the day they change, and this field is evidence of what the host actually did.
 *
 * The anchor is the member's own Session id: a session directory is the one named after it. When the
 * artifact does not sit in such a directory (the backend reported a bare file somewhere else), there is
 * nothing to make relative, and the caller stores no path at all rather than a guess.
 * @param {{path: string, isDirectory: boolean}} source - the artifact a retirement is about to move.
 * @param {string} memberId - the member's Session id.
 * @returns {string|undefined} the relative path with forward slashes, or undefined when there is no anchor.
 */
export function originalRelPathOf(source, memberId) {
  const sessionDir = source.isDirectory && decodeSegment(basename(source.path)) === memberId
    ? source.path
    : !source.isDirectory && decodeSegment(basename(dirname(source.path))) === memberId
      ? dirname(source.path)
      : undefined
  if (sessionDir === undefined) return undefined
  const leaf = basename(sessionDir)
  const slug = basename(dirname(sessionDir))
  if (slug === '' || leaf === '') return undefined
  // Forward slashes on purpose: the field is read on the machine the roster travelled to, which may not be
  // the platform that wrote it, so the separator must be the one both of them agree on.
  return `${slug}/${leaf}`
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
 *   {planned: true, trashPath: string, trashRelPath: string, originalPath: string, originalRelPath?: string,
 *    kind: 'directory'|'file', source: {path: string, isDirectory: boolean}, trashRoot: string,
 *    dirName: string}
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
  const originalRelPath = originalRelPathOf(source, memberId)
  return {
    planned: true,
    trashPath: join(trashRoot, dirName),
    // What the tombstone stores: the directory this retirement gave the artifact, and where it sits
    // under the data root. Both are stable when the root moves; an absolute path is not. The relative path
    // is written with forward slashes, like every other path this plugin puts in a record: a roster carried
    // to another machine may be read by a platform that does not treat `\` as a separator, and a stored
    // separator that only means "directory" on the machine that wrote it is not a relative path there.
    trashRelPath: ['trash', leadSessionId, dirName].join('/'),
    // Where the artifact came from, as the sessions root plus these two segments. The absolute is computed
    // at read time from the sessions root in effect *there*, which is what makes the record portable.
    ...(originalRelPath === undefined ? {} : { originalRelPath }),
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
 * The last segment of a recorded path, or undefined when it has none.
 *
 * `basename('/')` and `basename('C:\\')` are the empty string, not undefined, so a corrupt record whose
 * path is a bare root used to answer `''` and be treated as a real directory name: restore then resolved
 * the whole root — the Lead's trash directory itself — and moved *that*, failing with `EBUSY` instead of
 * reporting `no-recorded-path`.
 * @param {unknown} path - one recorded path.
 * @returns {string|undefined} its last segment, or undefined when there is nothing to name.
 */
function lastSegment(path) {
  if (typeof path !== 'string' || path === '') return undefined
  const name = basename(path)
  return name === '' ? undefined : name
}

/**
 * The segments of a recorded **root-relative** path, split on either separator.
 *
 * `trashRelPath` is written with forward slashes, and records written before that was true carry the
 * platform separator the machine used — which on POSIX is a literal character inside a single segment, so
 * reading such a record with `resolve` or `join` once put the artifact under `<root>/trash\lead\dir`. The
 * write side is strict and the read side is tolerant, which is the same asymmetry the rest of the path
 * chain follows: a record is a file that travels, and the machine reading it may not be the machine that
 * wrote it. No legal segment of this field contains a backslash — both the Lead and the child Session id
 * are encoded identities — so splitting on both is safe.
 * @param {unknown} path - a recorded relative path.
 * @returns {string[]} its segments, empty when there are none.
 */
export function relativeSegments(path) {
  if (typeof path !== 'string') return []
  return path.split(/[\\/]+/).filter((segment) => segment !== '')
}

/**
 * The trash directory name a tombstone records, from either stored shape.
 *
 * A record written from this release carries `trashDir` — the name retirement gave the directory — and
 * `trashRelPath`, where that directory sits under the data root. One written before it carries the
 * absolute `trashPath` the move used, and its name is the last segment of that path. The name is the
 * part of a trash location that survives the root moving, so both readers — restore and the retention
 * cap — go through it instead of through a recorded absolute path.
 * @param {object} record - one roster member record.
 * @returns {string|undefined} the directory name, or undefined when the tombstone names no destination.
 */
export function recordedTrashDir(record) {
  const named = record?.trashDir
  if (typeof named === 'string' && named !== '') return named
  const relative = relativeSegments(record?.trashRelPath)
  if (relative.length > 0) return relative[relative.length - 1]
  return lastSegment(record?.trashPath)
}

/**
 * The paths one tombstone's artifact may be at, in the order the design fixed.
 *
 *   1. the data directory in effect — the recorded root-relative path, or the trash layout rebuilt from
 *      the directory name when the record carries a name but no relative path;
 *   2. the absolute path the record itself carries, which is what every tombstone written before this
 *      field has and what keeps those records restorable with no migration at all;
 *   3. the frozen default directory, where an artifact nothing has moved yet still sits.
 *
 * Duplicates are dropped, so the ordinary case — where the recorded relative path and the rebuilt
 * layout describe one directory — yields one candidate for that leg rather than two.
 * @param {{record: object, leadSessionId: string, dataDir?: string, home?: string}} request
 * @returns {Array<{path: string, leg: 'root'|'legacy'|'frozen'}>} absolute paths, tried in order.
 */
export function trashPathCandidates({ record, leadSessionId, dataDir, home = homedir() }) {
  const candidates = []
  const add = (path, leg) => {
    if (typeof path !== 'string' || path === '') return
    const absolute = resolve(path)
    if (candidates.some((candidate) => candidate.path === absolute)) return
    candidates.push({ path: absolute, leg })
  }
  const usableRoot = typeof dataDir === 'string' && dataDir !== ''
  const relative = relativeSegments(record?.trashRelPath)
  if (usableRoot && relative.length > 0) add(join(dataDir, ...relative), 'root')
  const named = recordedTrashDir(record)
  if (usableRoot && named !== undefined) add(join(dataDir, 'trash', leadSessionId, named), 'root')
  add(record?.trashPath, 'legacy')
  if (named !== undefined) add(join(frozenDataDir(home), 'trash', leadSessionId, named), 'frozen')
  return candidates
}

/**
 * The absolute path a tombstone says its artifact went to, without touching the filesystem.
 *
 * A tool result prints a path, so a record written from this release — which carries no absolute path — is
 * resolved through the same chain restore uses and reported at its first candidate. A recorded absolute
 * path wins when the record has one: "where it went" is a fact about the move, not about the root in
 * effect now.
 * @param {{record: object, leadSessionId: string, dataDir?: string, home?: string}} request
 * @returns {string|undefined} an absolute path, or undefined when no destination was recorded.
 */
export function recordedTrashPath({ record, leadSessionId, dataDir, home = homedir() }) {
  const absolute = record?.trashPath
  if (typeof absolute === 'string' && absolute !== '') return resolve(absolute)
  return trashPathCandidates({ record, leadSessionId, dataDir, home })[0]?.path
}

/**
 * Find where a tombstone's artifact actually is: the first candidate of the fallback chain that exists.
 *
 * Nothing is thrown and nothing is guessed. `undefined` means every leg was tried and none holds the
 * artifact — the normal state of a `pruned` tombstone, and also of a `done` one whose directory an
 * operator removed. Both callers report that as `trash-missing`, exactly as they did when a single
 * recorded absolute path was the only place they looked.
 * @param {{record: object, leadSessionId: string, dataDir?: string, home?: string}} request
 * @returns {Promise<{path: string, leg: 'root'|'legacy'|'frozen'}|undefined>} the first path that exists.
 */
export async function locateTrashedArtifact({ record, leadSessionId, dataDir, home = homedir() }) {
  for (const candidate of trashPathCandidates({ record, leadSessionId, dataDir, home })) {
    if (await pathExists(candidate.path)) return candidate
  }
  return undefined
}

/**
 * Whether a tombstone that says its move landed no longer has anything behind it.
 *
 * This is the rule a migration applies to the records the retention defect left wrong. A `done` tombstone
 * whose artifact is not on any leg of the chain was pruned by the cap — the cap is the only deletion on
 * this path — and has to become `pruned`, which is what makes `restore_member` answer the typed reason
 * rather than the generic `trash-missing`. A record that never claimed a landed move is not this
 * question's business: a `pending` move may or may not have landed, and a record naming no destination
 * moved nothing.
 * @param {{record: object, leadSessionId: string, dataDir?: string, home?: string}} request
 * @returns {Promise<boolean>} true when the record claims a landed move and the bytes are gone.
 */
export async function artifactIsMissing({ record, leadSessionId, dataDir, home = homedir() }) {
  if (record?.trashState !== undefined && record.trashState !== 'done') return false
  if (recordedTrashDir(record) === undefined) return false
  return (await locateTrashedArtifact({ record, leadSessionId, dataDir, home })) === undefined
}

/**
 * Derive the sessions root — the directory whose children are the workspace directories the host made —
 * from any sibling Session still on disk.
 *
 * The anchor is the sibling's own Session id, not a fixed number of `dirname` calls: the backend may report
 * the session directory (`.../<slug>/<id>`) or a file inside it (`.../<slug>/<id>/artifact`), and counting
 * directories gets one of the two wrong. Everything above the segment named after the sibling is the root,
 * whatever the id decoded to on disk, and the segment immediately above it is the slug the host chose —
 * which a caller resolving a stored relative path must *not* reuse, because a roster that travelled carries
 * the other machine's slug inside the path it stores.
 *
 * This is the only way the bundle can see the sessions root: through the persistence service, from a
 * session that is still where the host put it. Asking for the member being restored does not work — a
 * retired member's artifact is in the trash by definition, so the live store is the one place it is not,
 * and a tombstone's own recorded absolute path belongs to the machine that wrote it.
 * @param {{stat?: (id: string) => Promise<unknown>}|undefined} persistence - session persistence service.
 * @param {string[]} childIds - candidate sibling Session ids.
 * @param {string} exceptId - the member being restored; never used as its own template.
 * @returns {Promise<string|undefined>} the sessions root, or undefined when no sibling is readable.
 */
/**
 * The sessions root implied by one reported artifact path, or undefined when it is too short to hold one.
 *
 * The anchor is the Session id, not a fixed number of `dirname` calls: the backend may report the session
 * directory (`.../<slug>/<id>`) or a file inside it (`.../<slug>/<id>/artifact`), and counting directories
 * gets one of the two wrong. Everything above the segment named after the Session is the root, and the
 * segment immediately above it is the slug the host chose — which a caller resolving a stored relative path
 * must *not* reuse, because a roster that travelled carries the other machine's slug inside the path.
 * @param {string} reported - a path the persistence service reported.
 * @param {string} childId - the Session id that path is for.
 * @returns {string|undefined} the sessions root.
 */
function sessionsRootOfReport(reported, childId) {
  const segments = reported.split(/[\\/]+/).filter((segment) => segment !== '')
  const at = segments.findIndex((segment) => decodeSegment(segment) === childId)
  // Fewer than two segments above the id means the report is too short to hold a root and a slug.
  if (at < 2) return undefined
  // Drop the session directory, anything below it, and the slug above it.
  let root = reported
  for (let level = 0; level < segments.length - at + 1; level += 1) root = dirname(root)
  return root
}

/**
 * The sessions root one Session's own report implies, or undefined when the host no longer knows it.
 *
 * This is the leg that answers for a Lead whose only member is the one being restored, and for the crash
 * window of a `pending` move, where the artifact never left. It is also the *same machine's* root whenever
 * it answers at all, so it can never send a roster that travelled back to the machine it came from.
 * @param {{stat?: (id: string) => Promise<unknown>}|undefined} persistence - session persistence service.
 * @param {string} childId - the Session id to ask about.
 * @returns {Promise<string|undefined>} the sessions root.
 */
export async function sessionsRootFromReport(persistence, childId) {
  if (persistence === undefined || typeof persistence.stat !== 'function') return undefined
  let snapshot
  try {
    snapshot = await persistence.stat(childId)
  } catch (error) {
    return undefined
  }
  const reported = snapshot?.location?.path
  if (typeof reported !== 'string' || reported === '') return undefined
  return sessionsRootOfReport(reported, childId)
}

/**
 * Derive the sessions root from any sibling Session still on disk.
 * @param {{stat?: (id: string) => Promise<unknown>}|undefined} persistence - session persistence service.
 * @param {string[]} childIds - candidate sibling Session ids.
 * @param {string} exceptId - the member being restored; never used as its own template.
 * @returns {Promise<string|undefined>} the sessions root, or undefined when no sibling is readable.
 */
export async function sessionsRootFromSibling(persistence, childIds, exceptId) {
  for (const childId of childIds) {
    if (childId === exceptId) continue
    const root = await sessionsRootFromReport(persistence, childId)
    if (root !== undefined) return root
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
 * Parse one trash directory name, `<childId>-<ms>`, exactly as retirement writes it.
 *
 * The name carries the **child Session id**, which is not the record's identity: a spawned member's
 * `memberId` and `childId` are two different uuids, and only an adopted member has them equal. Retention
 * matches a tombstone by this name and then reports the record's own `memberId`; the `memberId` key below
 * is the id *as the name spells it*, which is what a record carrying no id of its own falls back to.
 *
 * The leading `.+` is greedy, so an id that itself contains hyphens — a UUID, or an adopted child Session
 * id — splits at the last one and keeps its stamp. A name this plugin did not write returns undefined and
 * is therefore left alone; the trash is a directory an operator can also put things in, and retention must
 * never touch what it cannot account for.
 * @param {string} name - one direct child's name.
 * @returns {{memberId: string, stamp: number}|undefined} the id the name carries, and its stamp.
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
 *   - only names shaped `<childId>-<ms>` with a plausible Session id and a numeric stamp qualify, and
 *     only when a member record names that exact directory — a foreign name, a file, or an entry no
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
  // landed (or is still in flight) and that this is where it went. The match is by directory name, not
  // by an absolute path: the name is what a tombstone keeps across a root change, and it is what both
  // stored shapes carry — `trashDir`, or the last segment of an older `trashPath`.
  //
  // `trashState` arrived with the cap in 0.7.0, so every tombstone written before it carries a
  // `trashPath` and no state at all. A record with a path but no state has completed its move — the
  // field simply did not exist yet — and treating it as anything else leaves the whole legacy trash
  // permanently exempt, which is exactly what the first live run of the cap did.
  const byDir = new Map()
  for (const member of members) {
    const dir = recordedTrashDir(member)
    if (dir === undefined) continue
    byDir.set(dir, { ...member, trashState: member.trashState ?? 'done' })
  }

  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const parsed = parseTrashDirName(entry.name)
    if (parsed === undefined) continue
    const trashPath = join(trashRoot, entry.name)
    const member = byDir.get(entry.name)
    if (member === undefined) continue
    if (member.trashState !== 'done' && member.trashState !== 'pending') continue
    // The name carries the child Session id, and that is *not* the roster identity: a spawned member's
    // `memberId` and `childId` are two different uuids, and `retireMember` flips records by `memberId`.
    // Reporting the parsed name here left every spawn-shaped tombstone at `done` while its bytes were
    // gone, so `restore_member` answered `trash-missing` instead of the `pruned` it promises.
    const memberId = typeof member.memberId === 'string' && member.memberId !== '' ? member.memberId : parsed.memberId
    candidates.push({ ...parsed, memberId, name: entry.name, trashPath, trashState: member.trashState })
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
