/**
 * One-off migration: move a workspace's trashed artifacts and its roster records from the pre-0.26.0
 * storage to the workspace.
 *
 * This is not a bundle capability and is deliberately not published. It exists because the durable state
 * moved twice in one release pair — the roster from the `team_roster` storage domain to
 * `<workspace>/.agents/team/roster.json` (ADR 0027), the trash from `~/.dsh/team-roster` to
 * `<workspace>/.agents/team/trash/` — and the artifacts and the absolute paths recorded beside them did
 * not move themselves.
 *
 * Three rules shape everything here:
 *
 *   - **A dry run is the default.** `--apply` is required to write anything, and a dry run reads only
 *     files that the plugin already reads.
 *   - **The domain is the rollback.** It is read, copied into the backup, and never written or deleted;
 *     deleting it would remove the only other copy of the records.
 *   - **A copy is verified before its source is deleted.** The move is cross-volume on the machine this
 *     was written for, so a copy is the only mechanism; the copy is compared with its source by file
 *     count and byte total, and a mismatch aborts that artifact with both sides left intact.
 *
 * The records are found through the same chain the plugin uses (`trashPathCandidates` /
 * `locateTrashedArtifact`), so a tombstone from any release resolves without a fourth resolver here. A
 * record whose artifact is on no leg at all is one the retention cap emptied, and is reconciled to
 * `pruned` by `artifactIsMissing` — the rule T1/T2's retention fix established.
 *
 * Usage:
 *   node scripts/migrate-roster.mjs --workspace D:\MYPROJS            # dry run, prints the plan
 *   node scripts/migrate-roster.mjs --workspace D:\MYPROJS --apply    # writes, after a backup
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PHASE, ROSTER_FILE_NAME, TRASH_STATE } from '../roster.js'
import {
  artifactIsMissing,
  locateTrashedArtifact,
  recordedTrashDir,
  resolveDataDir,
} from '../trash.js'

/** Where the plugin kept its trash before this release pair, and where a profile's override points. */
export const DEFAULT_TRASH_ROOT = (home) => join(home, '.dsh', 'team-roster')

/** The storage domain the records were imported from, and the rollback path. Never written. */
export const DEFAULT_DOMAIN = (home) => join(home, '.dsh', 'storages', 'team_roster.json')

/** The line every report ends with. The plugin caches the roster in memory, so a restart is required. */
export const RESTART_NOTICE = 'A second restart is required afterwards: the plugin keeps the roster in memory and only re-reads the file on a load or a write, so until it restarts it serves the pre-migration records.'

/** The absolute path of a record's artifact in the new layout: `<dataRoot>/trash/<lead>/<dirName>`. */
export function destinationOf(dataRoot, leadSessionId, dirName) {
  return join(dataRoot, 'trash', leadSessionId, dirName)
}

/** The value the record has to carry afterwards: the directory name and the root-relative path. */
export function migratedFields(leadSessionId, dirName) {
  return { trashDir: dirName, trashRelPath: join('trash', leadSessionId, dirName) }
}

/**
 * Whether one record already carries the migrated shape for this destination.
 * @param {object} record - one roster member record.
 * @param {{trashDir: string, trashRelPath: string}} fields - what it should carry.
 * @returns {boolean} true when nothing has to be rewritten.
 */
export function isMigrated(record, fields) {
  return record?.trashPath === undefined
    && record?.trashDir === fields.trashDir
    && record?.trashRelPath === fields.trashRelPath
}

/** Read a JSON file, distinguishing "absent" from "unreadable" — the two need different sentences. */
async function readJsonFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true }
    return { problem: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { value: JSON.parse(text), text }
  } catch (error) {
    return { problem: `not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** One artifact's size: a file counts once, a directory is walked. The verification unit, not a glance. */
async function treeStats(path) {
  const info = await stat(path)
  if (!info.isDirectory()) return { files: 1, bytes: info.size }
  let files = 0
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = await treeStats(join(path, entry.name))
    files += child.files
    bytes += child.bytes
  }
  return { files, bytes }
}

/**
 * Copy one artifact and prove the copy: the destination must hold the same number of files and the same
 * byte total before the source may be deleted. `copyFn` is a seam so a test can make the copy fail or
 * come up short; a failure deletes what this call created and leaves the source untouched.
 * @param {{source: string, destination: string, isDirectory: boolean, copyFn?: Function}} request
 * @returns {Promise<{copied: true, files: number, bytes: number}|{copied: false, reason: string}>}
 */
async function copyArtifact({ source, destination, isDirectory, copyFn = defaultCopy }) {
  const before = await treeStats(source)
  try {
    await mkdir(isDirectory ? dirname(destination) : destination, { recursive: true })
    await copyFn(source, isDirectory ? destination : join(destination, basename(source)), isDirectory)
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    return { copied: false, reason: `copy failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const after = await treeStats(destination)
  if (after.files !== before.files || after.bytes !== before.bytes) {
    // This run's own incomplete copy; the source is still where it was, and a partial destination would
    // be mistaken for a finished one on the next run.
    await rm(destination, { recursive: true, force: true })
    return {
      copied: false,
      reason: `copy verification failed: source ${before.files} files/${before.bytes} bytes, copy ${after.files} files/${after.bytes} bytes`,
    }
  }
  return { copied: true, ...after }
}

const defaultCopy = (from, to) => cp(from, to, { recursive: true, force: false, errorOnExist: false })

/**
 * Move one artifact into the new layout: `rename` when the volumes allow it, otherwise verified copy then
 * remove. The destination is never overwritten: an existing destination is the caller's decision.
 * @param {{source: string, destination: string, renameFn?: Function, copyFn?: Function}} request
 * @returns {Promise<{moved: true, method: 'rename'|'copy', files: number, bytes: number}|{moved: false, reason: string}>}
 */
async function moveArtifact({ source, destination, renameFn = rename, copyFn = defaultCopy }) {
  const info = await stat(source)
  const isDirectory = info.isDirectory()
  const stats = await treeStats(source)
  try {
    if (isDirectory) {
      await mkdir(dirname(destination), { recursive: true })
      await renameFn(source, destination)
    } else {
      await mkdir(destination, { recursive: true })
      await renameFn(source, join(destination, basename(source)))
    }
    return { moved: true, method: 'rename', ...stats }
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return { moved: false, reason: 'destination exists' }
      throw error
    }
  }
  const copied = await copyArtifact({ source, destination, isDirectory, copyFn })
  if (!copied.copied) return { moved: false, reason: copied.reason }
  await rm(source, { recursive: true, force: true })
  return { moved: true, method: 'copy', ...stats }
}

/** A path segment that cannot escape its parent: a corrupt record must not name `..\..\somewhere`. */
const safeSegment = (value) => typeof value === 'string' && value !== '' && basename(value) === value && !value.includes('..')

/**
 * Build the plan. Reads the roster file (or, in a dry run only, the storage domain), and decides for every
 * retirable record what would happen to it. Writes nothing.
 * @param {{workspace: string, home?: string, dataDir?: string, trashRoot?: string, domain?: string, apply?: boolean, copyFn?: Function, renameFn?: Function}} request
 * @returns {Promise<{refusal?: object, plan?: object}>}
 */
export async function planMigration({
  workspace,
  home = homedir(),
  dataDir,
  trashRoot,
  domain,
  apply = false,
}) {
  if (typeof workspace !== 'string' || workspace === '') {
    return { refusal: { reason: 'no-workspace', message: 'Pass --workspace <path>: the workspace whose .agents/team/ holds the roster file.' } }
  }
  const workspaceRoot = resolve(workspace)
  const dataRoot = resolve(dataDir ?? resolveDataDir(process.env, home, workspaceRoot))
  const rosterFile = join(dataRoot, ROSTER_FILE_NAME)
  const trash = resolve(trashRoot ?? DEFAULT_TRASH_ROOT(home))
  const domainPath = resolve(domain ?? DEFAULT_DOMAIN(home))

  // --apply waits for the plugin to have imported the records into the workspace; a dry run can read the
  // domain, because until that import runs it is where the records live.
  const file = await readJsonFile(rosterFile)
  let source
  if (file.value !== undefined) {
    source = { kind: 'file', path: rosterFile, data: file.value, text: file.text }
  } else if (apply) {
    return {
      refusal: {
        reason: 'roster-file-missing',
        path: rosterFile,
        message: `Refusing to apply: ${rosterFile} does not exist. The plugin imports the records into it the first time a Lead in this workspace uses its tools, so restart the app, call one roster tool, and run this again.`,
      },
    }
  } else {
    const fallback = await readJsonFile(domainPath)
    if (fallback.value === undefined) {
      return {
        refusal: {
          reason: 'no-records',
          path: domainPath,
          message: `${rosterFile} does not exist and the storage domain ${domainPath} could not be read${fallback.problem === undefined ? '' : ` (${fallback.problem})`}, so there is nothing to plan.`,
        },
      }
    }
    source = { kind: 'domain', path: domainPath, data: fallback.value, text: fallback.text }
  }
  // The domain wraps its tables (`tables.rosters`); the roster file this release writes does not. One
  // reader handles both, so the dry run can read today's records and the apply reads tomorrow's.
  const rosters = source.data?.rosters ?? source.data?.tables?.rosters
  if (rosters === null || typeof rosters !== 'object' || Array.isArray(rosters)) {
    return {
      refusal: { reason: 'no-rosters', path: source.path, message: `${source.path} has no roster table, so it does not hold a roster and nothing will be touched.` },
    }
  }

  const actions = []
  for (const [leadSessionId, roster] of Object.entries(rosters)) {
    const members = Array.isArray(roster?.members) ? roster.members : []
    for (const member of members) {
      const base = { leadSessionId, memberId: member?.memberId, name: member?.name }
      if (member?.phase !== PHASE.retired) {
        actions.push({ ...base, kind: 'leave', reason: 'not-retired' })
        continue
      }
      if (member.trashState === TRASH_STATE.pending) {
        actions.push({ ...base, kind: 'leave', reason: 'pending-move' })
        continue
      }
      const dirName = recordedTrashDir(member)
      if (dirName === undefined) {
        actions.push({ ...base, kind: 'leave', reason: 'no-destination' })
        continue
      }
      if (!safeSegment(leadSessionId) || !safeSegment(dirName)) {
        actions.push({ ...base, dirName, kind: 'refuse', reason: 'unsafe-path-segment' })
        continue
      }
      const destination = destinationOf(dataRoot, leadSessionId, dirName)
      const fields = migratedFields(leadSessionId, dirName)
      const rewritten = isMigrated(member, fields)
      // The destination first: after a successful run the artifact lives there, and the old chain no
      // longer holds it — reading "on no leg" as pruned before this check would empty the record.
      const atDestination = await exists(destination)
      if (atDestination) {
        const located = await locateTrashedArtifact({ record: member, leadSessionId, dataDir: trash, home })
        // Both sides still there: a previous run copied and then stopped before removing the source. The
        // copy is the one that stays; the old copy is dropped only when the two are provably the same.
        if (located !== undefined) {
          const identical = await sameSize(located.path, destination)
          if (identical === false) {
            actions.push({ ...base, dirName, destination, kind: 'refuse', reason: 'destination-conflict', source: located.path })
            continue
          }
          actions.push({ ...base, dirName, kind: 'drop-duplicate', source: located.path, destination })
          continue
        }
        actions.push({ ...base, dirName, destination, kind: rewritten ? 'noop' : 'rewrite' })
        continue
      }
      const located = await locateTrashedArtifact({ record: member, leadSessionId, dataDir: trash, home })
      if (located !== undefined) {
        const stats = await treeStats(located.path)
        actions.push({ ...base, dirName, kind: 'move', source: located.path, destination, files: stats.files, bytes: stats.bytes, rewritten })
        continue
      }
      // No leg holds it. A record that claims a landed move is one the retention cap emptied; a `pruned`
      // record already says so, and an unknown state is not this script's to interpret.
      if (member.trashState === TRASH_STATE.done || member.trashState === undefined) {
        actions.push({ ...base, dirName, kind: 'reconcile-pruned' })
        continue
      }
      actions.push({ ...base, dirName, kind: 'leave', reason: member.trashState === TRASH_STATE.pruned ? 'already-pruned' : 'unknown-trash-state' })
    }
  }

  return {
    plan: {
      apply,
      workspace: workspaceRoot,
      dataRoot,
      rosterFile,
      domain: domainPath,
      trashRoot: trash,
      source,
      actions,
      summary: summarize(actions),
    },
  }
}

const exists = async (path) => {
  const info = await stat(path).catch(() => undefined)
  return info !== undefined
}

/** Whether two artifacts hold the same files and bytes, without copying anything. */
async function sameSize(left, right) {
  const [a, b] = await Promise.all([treeStats(left), treeStats(right)])
  return a.files === b.files && a.bytes === b.bytes
}

/** Count the plan the way the report reads it. */
export function summarize(actions) {
  const count = (predicate) => actions.filter(predicate).length
  return {
    artifactsToMove: count((action) => action.kind === 'move'),
    artifactsAlreadyAtDestination: count((action) => action.kind === 'noop' || action.kind === 'rewrite' || action.kind === 'drop-duplicate'),
    recordsToRewrite: count((action) => (action.kind === 'move' && action.rewritten === false) || action.kind === 'rewrite'),
    recordsAlreadyMigrated: count((action) => action.kind === 'noop'),
    recordsToPrune: count((action) => action.kind === 'reconcile-pruned'),
    leftAlone: Object.fromEntries(
      ['not-retired', 'pending-move', 'no-destination', 'already-pruned', 'unknown-trash-state']
        .map((reason) => [reason, count((action) => action.kind === 'leave' && action.reason === reason)])
        .filter(([, value]) => value > 0),
    ),
    refused: actions.filter((action) => action.kind === 'refuse'),
  }
}

/** Render the plan and the result the way the operator reads them. */
export function formatReport(plan, outcome) {
  const lines = []
  lines.push(`dsh-team roster migration — ${outcome === undefined ? 'DRY RUN (nothing was written)' : 'APPLIED'}`)
  lines.push(`workspace   ${plan.workspace}`)
  lines.push(`data root   ${plan.dataRoot}`)
  lines.push(`roster      ${plan.rosterFile}${plan.source.kind === 'domain' ? '  (does not exist; reading the storage domain)' : ''}`)
  lines.push(`domain      ${plan.domain}  (read only — the rollback path)`)
  lines.push(`trash root  ${plan.trashRoot}`)
  lines.push(`source      ${plan.source.kind}: ${plan.source.path}`)
  lines.push('')
  for (const action of plan.actions) {
    const who = `${action.leadSessionId}/${action.dirName ?? action.name ?? action.memberId ?? '?'}`
    if (action.kind === 'move') lines.push(`move     ${who}  ${action.source} -> ${action.destination}`)
    else if (action.kind === 'drop-duplicate') lines.push(`drop     ${who}  ${action.destination} already holds it; removing the old copy ${action.source}`)
    else if (action.kind === 'rewrite') lines.push(`rewrite  ${who}  already at ${action.destination}; record still names the old shape`)
    else if (action.kind === 'noop') lines.push(`noop     ${who}  already in place`)
    else if (action.kind === 'reconcile-pruned') lines.push(`prune    ${who}  artifact gone on every leg -> ${TRASH_STATE.pruned}`)
    else if (action.kind === 'refuse') lines.push(`REFUSED  ${who}  ${action.reason}${action.source === undefined ? '' : ` (${action.source})`}`)
    else lines.push(`leave    ${who}  ${action.reason}`)
  }
  lines.push('')
  lines.push('summary')
  lines.push(`  artifacts moved                  ${plan.summary.artifactsToMove}`)
  lines.push(`  artifacts already at destination ${plan.summary.artifactsAlreadyAtDestination}`)
  lines.push(`  records rewritten                ${plan.summary.recordsToRewrite}`)
  lines.push(`  records already migrated         ${plan.summary.recordsAlreadyMigrated}`)
  lines.push(`  records reconciled to ${TRASH_STATE.pruned}      ${plan.summary.recordsToPrune}`)
  lines.push(`  refused                          ${plan.summary.refused.length}`)
  for (const [reason, value] of Object.entries(plan.summary.leftAlone)) lines.push(`  left alone (${reason})           ${value}`)
  if (outcome !== undefined) {
    lines.push('')
    lines.push(`backup      ${outcome.backupDir}`)
    lines.push(`moved ${outcome.moved}, rewritten ${outcome.rewritten}, reconciled ${outcome.reconciled}, refused ${outcome.refused.length}`)
    for (const refusal of outcome.refused) lines.push(`  REFUSED ${refusal.leadSessionId}/${refusal.dirName}: ${refusal.reason}`)
  }
  lines.push('')
  lines.push(RESTART_NOTICE)
  return lines.join('\n')
}

/**
 * Apply the plan. Backup first, then move, rewrite and reconcile; the roster file is replaced once, at the
 * end, so a crash mid-run leaves the records naming a move that either happened or did not.
 * @param {object} plan - the plan `planMigration` returned.
 * @param {{domain?: string, now?: () => string, copyFn?: Function, renameFn?: Function, backupRoot?: string}} request
 * @returns {Promise<{backupDir: string, moved: number, rewritten: number, reconciled: number, refused: object[]}>}
 */
export async function applyMigration(plan, { now = () => new Date().toISOString(), copyFn, renameFn } = {}) {
  const stamp = now().replace(/[:.]/g, '-')
  const backupDir = join(plan.dataRoot, 'backups', stamp)
  await mkdir(backupDir, { recursive: true })
  // The two full copies first — byte for byte, not re-serialized — then the manifest, then anything else.
  await writeFile(join(backupDir, ROSTER_FILE_NAME), plan.source.text, 'utf8')
  const domainCopy = join(backupDir, 'team_roster.json')
  const domain = await readJsonFile(plan.domain)
  if (domain.text !== undefined) {
    await writeFile(domainCopy, domain.text, 'utf8')
  }
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify({
    createdAt: now(),
    workspace: plan.workspace,
    dataRoot: plan.dataRoot,
    rosterFile: { path: plan.rosterFile, copiedTo: join(backupDir, ROSTER_FILE_NAME) },
    domain: { path: plan.domain, copied: domain.text !== undefined, copiedTo: domain.text === undefined ? undefined : domainCopy },
    trashRoot: plan.trashRoot,
    records: plan.actions,
  }, null, 2), 'utf8')

  const data = JSON.parse(plan.source.text)
  const refused = []
  let moved = 0
  let rewritten = 0
  let reconciled = 0
  for (const action of plan.actions) {
    if (action.kind === 'refuse') {
      refused.push(action)
      continue
    }
    const members = data.rosters[action.leadSessionId]?.members
    const index = Array.isArray(members) ? members.findIndex((member) => member?.memberId === action.memberId) : -1
    const member = index === -1 ? undefined : members[index]
    if (action.kind === 'move') {
      const outcome = await moveArtifact({ source: action.source, destination: action.destination, copyFn, renameFn })
      if (!outcome.moved) {
        refused.push({ ...action, reason: outcome.reason })
        continue
      }
      moved += 1
    }
    if (action.kind === 'drop-duplicate') {
      // Re-verified at the moment of deletion, not only when the plan was built.
      if (await sameSize(action.source, action.destination)) await rm(action.source, { recursive: true, force: true })
      else refused.push({ ...action, reason: 'destination-conflict' })
      continue
    }
    if (member === undefined) continue
    if (action.kind === 'move' || action.kind === 'rewrite') {
      const fields = migratedFields(action.leadSessionId, action.dirName)
      if (!isMigrated(member, fields)) rewritten += 1
      delete member.trashPath
      Object.assign(member, fields)
    } else if (action.kind === 'reconcile-pruned') {
      member.trashState = TRASH_STATE.pruned
      reconciled += 1
    }
  }

  if (rewritten > 0 || reconciled > 0) {
    const serial = Number.isSafeInteger(data.serial) ? data.serial : 0
    await replaceFileAtomic(plan.rosterFile, JSON.stringify({ ...data, version: 1, serial: serial + 1, updatedAt: now() }, null, 2))
  }
  return { backupDir, moved, rewritten, reconciled, refused }
}

/** Replace one file through a temporary sibling, so a crash leaves the whole old file or the whole new one. */
async function replaceFileAtomic(file, text) {
  const temporary = `${file}.${process.pid}.migration.tmp`
  await writeFile(temporary, text, 'utf8')
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Parse the command line. `--apply` is the only way to write anything. */
export function parseArgs(argv) {
  const request = { apply: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      index += 1
      return next
    }
    if (flag === '--apply') request.apply = true
    else if (flag === '--workspace') request.workspace = value()
    else if (flag === '--data-dir') request.dataDir = value()
    else if (flag === '--trash-root') request.trashRoot = value()
    else if (flag === '--domain') request.domain = value()
    else if (flag === '--help' || flag === '-h') request.help = true
    else throw new Error(`unknown argument ${JSON.stringify(flag)}; use --workspace, --apply, --data-dir, --trash-root, --domain`)
  }
  return request
}

const USAGE = `Usage: node scripts/migrate-roster.mjs --workspace <path> [--apply]

  --workspace <path>   the workspace whose .agents/team/roster.json to migrate (required)
  --apply              write: back up, move artifacts, rewrite records. Omitted, this is a dry run.
  --data-dir <path>    where the roster file lives; default: the plugin's own resolution for the workspace
  --trash-root <path>  where the old trash lives; default: DSH_TEAM_DATA_DIR/DSH_TEAM_ROSTER_DATA_DIR,
                       else ~/.dsh/team-roster
  --domain <path>      the storage domain to copy into the backup; default ~/.dsh/storages/team_roster.json

A dry run prints the whole plan and touches nothing. --apply refuses unless the roster file already exists:
the plugin imports the records into the workspace on its first roster call after the upgrade.`

/** The command line entry point. Exit codes: 0 clean, 1 refused or incomplete, 2 bad arguments. */
async function main(argv) {
  let request
  try {
    request = parseArgs(argv)
  } catch (error) {
    console.error(`migrate-roster: ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    return 2
  }
  if (request.help) {
    console.log(USAGE)
    return 0
  }
  const planned = await planMigration(request)
  if (planned.refusal !== undefined) {
    console.error(`migrate-roster: refused (${planned.refusal.reason})`)
    console.error(planned.refusal.message)
    return 1
  }
  if (!request.apply) {
    console.log(formatReport(planned.plan))
    return 0
  }
  const outcome = await applyMigration(planned.plan)
  console.log(formatReport(planned.plan, outcome))
  return outcome.refused.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
