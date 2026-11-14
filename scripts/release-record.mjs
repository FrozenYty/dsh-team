/**
 * The release-record guard: a change to anything but a document carries a complete record.
 *
 * This lives beside `check.mjs` for the reason `name-guard.mjs` does — the failure message is the artifact
 * here, and `check.mjs` is a script that runs on import, so anything a test needs to drive has to be a
 * module.
 *
 * **A check that requires only the version is satisfied by exactly the half-record this repository keeps
 * finding.** A bump without a changelog section, or a changelog section without a `PROGRESS.md` entry, is the
 * likelier mistake than no record at all, so the rule is all three: the manifest's version higher than
 * `origin/main`'s, the newest changelog section equal to it, and an entry naming it. The changelog half is
 * `check.mjs` §9's, which already compares the newest section with the manifest; this module compares the
 * version with the base and requires the entry, so the three parts are covered without a second copy of §9.
 *
 * **Substantive means any changed path that is not a `.md` file and not `package.json`.** That is wider than
 * "the published bundle" on purpose: the change that started this was four deleted lines in `scripts/`, and a
 * narrower rule would have required nothing for it. Documents, and the version file itself, are what a record
 * *is*; everything else is what a record is *for*.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the entry that names a release lives. */
export const PROGRESS = 'PROGRESS.md'

/** The file whose version is the record's first part. */
export const MANIFEST = 'package.json'

/**
 * Compare two dotted versions numerically, component by component.
 *
 * **Never compare versions as strings.** `0.41.10` is higher than `0.41.9`, and a string comparison says the
 * opposite while looking correct — the kind of bug that survives review because the code reads as obviously
 * right. Missing components are zero, so `0.41` and `0.41.0` are the same version.
 * @param {string} left - a version.
 * @param {string} right - a version.
 * @returns {number} -1, 0 or 1.
 */
export function compareVersions(left, right) {
  const parse = (value) => String(value ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

/**
 * The version a record would carry next: the patch after the base.
 * @param {string} version - the base version.
 * @returns {string} the next patch, or the base when it cannot be read as a version.
 */
export function nextPatch(version) {
  const parts = String(version ?? '').split('.')
  if (parts.length < 2 || parts.some((part) => !/^\d+$/.test(part))) return String(version ?? '')
  const last = Number.parseInt(parts[parts.length - 1], 10) + 1
  return [...parts.slice(0, -1), String(last)].join('.')
}

/** The version a manifest declares, or undefined when it cannot be read. */
export function versionOf(manifestText) {
  try {
    const parsed = JSON.parse(manifestText ?? '')
    return typeof parsed?.version === 'string' ? parsed.version : undefined
  } catch (error) {
    return undefined
  }
}

/**
 * Run git and read what it wrote, through a file rather than a pipe.
 *
 * The sandbox this runs under in development refuses named pipes, so `child_process` with the default
 * `stdio: 'pipe'` fails with EPERM while `'ignore'` and an open file descriptor work. Passing the output
 * through a temporary file keeps the guard runnable on the machine that writes it.
 * @param {string} root - the repository root.
 * @param {string[]} args - git arguments.
 * @returns {{text: string|undefined, problem: string|undefined}} what git wrote, or why it could not.
 */
export function gitRead(root, args) {
  const file = join(tmpdir(), `dsh-team-git-${process.pid}-${Math.random().toString(16).slice(2)}.out`)
  let fd
  try {
    fd = openSync(file, 'w')
    execFileSync('git', args, { stdio: ['ignore', fd, 'ignore'], cwd: root })
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(file, { force: true })
    return { text: undefined, problem: error instanceof Error ? error.message.split('\n')[0] : String(error) }
  }
  closeSync(fd)
  const text = readFileSync(file, 'utf8')
  rmSync(file, { force: true })
  return { text, problem: undefined }
}

/** The changed paths between the base branch and this working tree, substantive ones first. */
export function substantivePaths(paths) {
  return paths
    .map((path) => path.trim())
    .filter((path) => path !== '' && !path.endsWith('.md') && path !== MANIFEST)
}

/**
 * Audit one branch's release record.
 *
 * The four outcomes are deliberate: `not-run` when there is no base to compare with (reported, never a
 * failure — a gate that silently skips is worse than one that says it did not run), `not-needed` when the
 * branch touched only documents and the version file, `missing` with the failures to report, and `ok`.
 * @param {object} request
 * @param {string|undefined} request.baseVersion - the version `origin/main` declares, when it is resolvable.
 * @param {string|undefined} request.headVersion - the version this branch declares.
 * @param {string|undefined} request.baseProblem - why the base could not be resolved.
 * @param {string} request.progressText - the text of `PROGRESS.md`.
 * @param {string[]} request.changedPaths - every path this branch changed.
 * @returns {{status: string, failures: string[], baseVersion: string|undefined,
 *   headVersion: string|undefined, substantive: string[], reason: string|undefined}} the audit.
 */
export function auditReleaseRecord({ baseVersion, headVersion, baseProblem, progressText = '', changedPaths = [] }) {
  const substantive = substantivePaths(changedPaths)
  const base = { baseVersion, headVersion, substantive, reason: baseProblem }
  if (baseProblem !== undefined || typeof baseVersion !== 'string' || baseVersion === '') {
    return { status: 'not-run', failures: [], ...base }
  }
  if (substantive.length === 0) return { status: 'not-needed', failures: [], ...base }
  const failures = []
  if (headVersion === undefined) {
    failures.push(`${MANIFEST}: has no readable version, so this branch carries no release record`)
    return { status: 'missing', failures, ...base }
  }
  const order = compareVersions(headVersion, baseVersion)
  if (order === 0) {
    // The sentence names both artifacts, because a record is three parts and a reader has to be able to tell
    // which one is missing without opening anything.
    failures.push(`no release record on this branch: ${MANIFEST} is still ${baseVersion}, and the changelog has no ${nextPatch(baseVersion)} section`)
  } else if (order < 0) {
    failures.push(`${MANIFEST} declares ${headVersion}, which is lower than ${baseVersion} on origin/main — a release record moves forward, and a version that differs is not a version that is higher`)
  } else if (!String(progressText).includes(headVersion)) {
    failures.push(`${PROGRESS}: has no entry naming ${headVersion} — the record is a bump, a changelog section and an entry, or it is half a record`)
  }
  return { status: failures.length === 0 ? 'ok' : 'missing', failures, ...base }
}

/**
 * What the guard inspected, on one line, so the coverage can be argued with rather than assumed.
 * @param {object} report - an audit from `auditReleaseRecord`.
 * @returns {string} the line.
 */
export function releaseLine(report) {
  const base = report.baseVersion === undefined ? 'origin/main unresolved' : `base ${report.baseVersion}`
  const head = report.headVersion === undefined ? 'package.json unreadable' : `${MANIFEST} ${report.headVersion}`
  if (report.status === 'not-run') {
    return `release record: not checked — ${base} (${report.reason ?? 'unknown reason'}); ${report.substantive.length} substantive path(s) on this branch`
  }
  return `release record: ${base}, ${head}, ${report.substantive.length} substantive path(s)`
}
