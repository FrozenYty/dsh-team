/**
 * Session-artifact trash for retired members.
 *
 * Retirement must be recoverable, so the member's persisted session is *moved* into a trash directory
 * instead of being deleted. The move also drops the artifact out of the session-query index, which is
 * what makes the member disappear from the host's own lists; that effect is why this module exists and
 * why nothing here ever calls `rm` except the cross-device fallback.
 *
 * No `@deepseek-ai/*` import: a profile-linked bundle cannot resolve those packages (ADR 0002).
 */

import { cp, lstat, mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Environment override for the plugin data directory; tests use it too. */
const DATA_DIR_ENV = 'DSH_TEAM_ROSTER_DATA_DIR'

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
 * of the source, which is the only branch allowed to delete anything.
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
 * Move one member's persisted session into this plugin's trash.
 * Every failure is reported, never thrown: retirement is a lifecycle fact, and a storage problem must
 * not leave the roster claiming a member is still live.
 * @param {object} ctx - host plugin context.
 * @param {{leadSessionId: string, memberId: string, dataDir: string, now?: number, renameFn?: typeof rename}} request
 * @returns {Promise<{moved: boolean, trashPath?: string, originalPath?: string, kind?: 'directory'|'file', reason?: string}>}
 */
export async function trashMemberSession(ctx, request) {
  const { leadSessionId, memberId, dataDir } = request
  const stamp = Number.isFinite(request.now) ? Number(request.now) : Date.now()
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    return { moved: false, reason: 'no-persistence' }
  }
  let snapshot
  try {
    snapshot = await persistence.stat(memberId)
  } catch (error) {
    return { moved: false, reason: `stat-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const locationPath = snapshot?.location?.path
  if (typeof locationPath !== 'string' || locationPath === '') {
    return { moved: false, reason: 'no-artifact' }
  }
  const source = await resolveSource(locationPath, memberId)
  if (source === undefined) return { moved: false, reason: 'artifact-missing' }
  try {
    const trashPath = await moveSessionArtifact({
      sourcePath: source.path,
      isDirectory: source.isDirectory,
      trashRoot: join(dataDir, 'trash', leadSessionId),
      dirName: `${memberId}-${stamp}`,
      ...request.renameFn === undefined ? {} : { renameFn: request.renameFn },
    })
    return {
      moved: true,
      trashPath,
      originalPath: source.path,
      kind: source.isDirectory ? 'directory' : 'file',
    }
  } catch (error) {
    return { moved: false, reason: `move-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
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
