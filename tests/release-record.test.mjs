/**
 * The release-record guard: a change to anything but a document carries a complete record.
 *
 * The tests drive the audit over synthetic branches, because the states that matter — a bump without an
 * entry, a version that goes backwards, a base that cannot be resolved — are the states this repository is
 * not in at any given moment. The real tree is checked too, for the coverage line rather than for a verdict:
 * a code branch is legitimately red until the record lands, which is what the guard is for.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  auditReleaseRecord,
  compareVersions,
  gitRead,
  nextPatch,
  releaseLine,
  substantivePaths,
  versionOf,
  MANIFEST,
  PROGRESS,
} from '../scripts/release-record.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('a substantive change with no bump fails, naming the version', () => {
  const report = auditReleaseRecord({
    baseVersion: '0.41.3',
    headVersion: '0.41.3',
    progressText: '## v0.41.3',
    changedPaths: ['scripts/release-record.mjs'],
  })
  assert.equal(report.status, 'missing')
  assert.deepEqual(report.failures, [
    'no release record on this branch: package.json is still 0.41.3, and the changelog has no 0.41.4 section',
  ])
})

test('a bump with no PROGRESS entry fails, naming PROGRESS.md', () => {
  const report = auditReleaseRecord({
    baseVersion: '0.41.3',
    headVersion: '0.41.4',
    progressText: '## 2026-11-14 — something older\n',
    changedPaths: ['scripts/check.mjs'],
  })
  assert.equal(report.status, 'missing')
  assert.equal(report.failures.length, 1)
  assert.match(report.failures[0], /^PROGRESS\.md: has no entry naming 0\.41\.4/)
  // The half-record is the case this guard exists for: a version check alone would call this branch done.
  assert.equal(PROGRESS, 'PROGRESS.md')
})

test('a version lower than the base fails, even though it differs', () => {
  const report = auditReleaseRecord({
    baseVersion: '0.42.0',
    headVersion: '0.41.9',
    progressText: 'names 0.41.9',
    changedPaths: ['index.js'],
  })
  assert.equal(report.status, 'missing')
  assert.deepEqual(report.failures, [
    'package.json declares 0.41.9, which is lower than 0.42.0 on origin/main — a release record moves forward, and a version that differs is not a version that is higher',
  ])
})

test('a documents-only branch passes with no bump', () => {
  for (const changedPaths of [['docs/routes-en.md'], ['README.md', 'CHANGELOG.md', 'PROGRESS.md', 'package.json']]) {
    const report = auditReleaseRecord({ baseVersion: '0.41.3', headVersion: '0.41.3', progressText: '', changedPaths })
    assert.equal(report.status, 'not-needed', `no record is required for ${changedPaths.join(', ')}`)
    assert.deepEqual(report.failures, [])
  }
  // And the rule that makes it so: a document, and the version file itself, are what a record *is*.
  assert.deepEqual(substantivePaths(['a.md', 'package.json', 'scripts/check.mjs']), ['scripts/check.mjs'])
})

test('an unresolvable base is reported, not failed', () => {
  const report = auditReleaseRecord({
    baseVersion: undefined,
    baseProblem: 'Command failed: git show origin/main:package.json',
    headVersion: '0.41.3',
    progressText: '',
    changedPaths: ['scripts/check.mjs'],
  })
  assert.equal(report.status, 'not-run')
  assert.deepEqual(report.failures, [], 'a gate that cannot run must not fail the branch')
  assert.match(releaseLine(report), /^release record: not checked — origin\/main unresolved/)
  assert.match(releaseLine(report), /1 substantive path\(s\) on this branch/)
})

test('a complete record passes, and the line says what was inspected', () => {
  const report = auditReleaseRecord({
    baseVersion: '0.41.3',
    headVersion: '0.41.4',
    progressText: '## 2026-11-14 — v0.41.4 the record lands\n',
    changedPaths: ['scripts/release-record.mjs', 'docs/routes-en.md'],
  })
  assert.equal(report.status, 'ok')
  assert.deepEqual(report.failures, [])
  assert.deepEqual(report.substantive, ['scripts/release-record.mjs'], 'the document is not substantive')
  assert.equal(releaseLine(report), 'release record: base 0.41.3, package.json 0.41.4, 1 substantive path(s)')
})

test('versions compare numerically, which is the trap the comment names', () => {
  assert.equal(compareVersions('0.41.10', '0.41.9'), 1, '0.41.10 is higher, and a string comparison says otherwise')
  assert.equal(compareVersions('0.41.9', '0.41.10'), -1)
  assert.equal(compareVersions('0.41.3', '0.41.3'), 0)
  assert.equal(compareVersions('0.42', '0.41.99'), 1)
  assert.equal(nextPatch('0.41.9'), '0.41.10')
  assert.equal(versionOf('{"version":"1.2.3"}'), '1.2.3')
  assert.equal(versionOf('not json'), undefined)
})

test('the real tree resolves its base, and the line reports what it compared', () => {
  const base = gitRead(root, ['show', `origin/main:${MANIFEST}`])
  assert.equal(base.problem, undefined, 'git is resolvable here, as the workflow now makes it in CI')
  const changed = gitRead(root, ['diff', '--name-only', 'origin/main...HEAD'])
  const report = auditReleaseRecord({
    baseVersion: versionOf(base.text),
    headVersion: versionOf(readFileSync(join(root, MANIFEST), 'utf8')),
    progressText: readFileSync(join(root, PROGRESS), 'utf8'),
    changedPaths: (changed.text ?? '').split(/\r?\n/),
  })
  // Not a verdict: a code branch is legitimately red until the record lands. This asserts that the guard
  // found its base and reports it, which is the half a silent gate would leave unstated.
  assert.notEqual(report.status, 'not-run')
  assert.match(releaseLine(report), new RegExp(`^release record: base ${report.baseVersion}, ${MANIFEST} `))
  assert.match(releaseLine(report), /\d+ substantive path\(s\)$/)
})
