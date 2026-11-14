/**
 * The name guard: a dead name belongs in the record and must not be in the living surface.
 *
 * `scripts/check.mjs` §10 runs this over the repository; these tests drive the same functions over synthetic
 * surfaces, because a guard with nothing to catch is unproven and a guard that compares nothing passes for
 * the wrong reason. The real tree is asserted here too, so the coverage number is a value the suite holds
 * rather than a line someone read once.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  auditClaims,
  candidatesIn,
  coverageLine,
  collectLivingSurface,
  declaredNamesOf,
  findUndeclared,
  foreignClaims,
  foreignReason,
  formatDeadClaim,
  formatProblem,
  suggestionFor,
} from '../scripts/name-guard.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The surface a synthetic document makes: markdown for a document, strings for code. */
const document = (path, text) => ({ path, text, markdown: true })
const code = (path, text) => ({ path, text, markdown: false })

test('an undeclared name fails with the file, the name and the suggestion', () => {
  const declared = declaredNamesOf("name: 'list_members',\n    task_board: TASK_BOARD_VALUE,\n")
  const found = findUndeclared({
    files: [document('docs/lessons-en.md', 'Call `list_members`, then read `task_bord` to see the work.')],
    declared,
  })
  assert.equal(found.problems.length, 1)
  const [problem] = found.problems
  assert.equal(problem.path, 'docs/lessons-en.md')
  assert.equal(problem.line, 1)
  assert.equal(problem.token, 'task_bord')
  assert.equal(problem.nearest, 'task_board', 'one letter away, and the reader is told which name they meant')
  assert.equal(
    formatProblem(problem),
    'docs/lessons-en.md:1: "task_bord" is not a declared name — did you mean "task_board"?',
  )
})

test('a declared name is clean, so the guard cannot pass by comparing nothing', () => {
  const declared = declaredNamesOf("name: 'list_members',\n    trash_bytes: { type: 'integer' },\n")
  const found = findUndeclared({
    files: [document('README.md', 'Read `list_members` and its `trash_bytes` field.')],
    declared,
  })
  assert.deepEqual(found.problems, [])
  assert.equal(found.scanned, 1, 'one file was read')
  assert.equal(found.compared, 2, 'and two names were compared, so the pass means something')
})

test('a candidate is only a name written as a name', () => {
  // Hyphens, colons, dots and uppercase disqualify a token before the comparison, which is what keeps the
  // check quiet enough to read: these are four shapes that must never be compared.
  assert.deepEqual(candidatesIn('`dsh-team-relay` `path:line` `DSH_TEAM_DATA_DIR` `archive.jsonl`', true), [])
  assert.deepEqual(candidatesIn('`list_members`', true), [{ token: 'list_members', line: 1 }])
  // Code files are scanned inside strings, because a description is where a model meets a field name.
  assert.deepEqual(candidatesIn("const hint = 'read `spend_tokens` first'", false), [{ token: 'spend_tokens', line: 1 }])
})

test('a foreign name needs its reason, and the reason is what silences it', () => {
  assert.equal(
    foreignReason('list_agents'),
    'a tool the Harness ships; this plugin points at it, it does not declare it',
  )
  assert.equal(foreignReason('team_task_create'), 'a name of the shipped experimental team packages, kept where the docs say what this plugin replaces')
  assert.equal(foreignReason('task_bord'), undefined, 'a neighbour of a declared name is never allowlisted')
})

test('the suggestion is the nearest declared name, or nothing when none is near', () => {
  assert.equal(suggestionFor('task_bord', new Set(['task_board', 'list_members'])), 'task_board')
  assert.equal(suggestionFor('zzzz_zzzz', new Set(['task_board'])), undefined)
})

test('the real tree passes, and the coverage is a number rather than a claim', () => {
  const manifest = readJson('package.json')
  const docNames = readdir('docs').filter((name) => name.endsWith('.md'))
  const files = collectLivingSurface({ root, published: manifest.files ?? [], docNames })
  const found = findUndeclared({ files, declared: declaredNamesOf(read('index.js')) })
  assert.deepEqual(found.problems, [], 'no dead name in the living surface')
  // The numbers are the guard's own coverage: it is only as good as what it read, so this test holds both.
  assert.ok(found.scanned >= 25, `scanned ${found.scanned} living files`)
  assert.ok(found.compared >= 1000, `compared ${found.compared} identifier-shaped names`)
})

function read(relative) {
  return readFileSync(join(root, relative), 'utf8')
}
function readJson(relative) {
  return JSON.parse(read(relative))
}
function readdir(relative) {
  return readdirSync(join(root, relative))
}

test('a claim that permits nothing is a failure, naming the claim and its reason', () => {
  const claims = [
    { name: 'live claim', match: /^list_members$/, reason: 'a name that is on the surface' },
    { name: 'dead claim', match: /^zzzz_nothing$/, reason: 'a reason that looked reasonable once' },
  ]
  const found = findUndeclared({
    files: [document('README.md', 'Read `list_members`.')],
    declared: declaredNamesOf("name: 'list_members',\n"),
    claims,
  })
  assert.deepEqual(found.problems, [], 'both tokens are accounted for, so nothing is undeclared')
  assert.deepEqual(found.claims.map((claim) => claim.matches), [1, 0], 'the audit counts what each claim permits')
  assert.equal(found.dead.length, 1)
  assert.equal(found.dead[0].name, 'dead claim')
  assert.equal(
    formatDeadClaim(found.dead[0]),
    'scripts/name-guard.mjs: the allowlist claim "dead claim" matches nothing in the living surface'
      + ' — delete it, or check whether the surface moved. Its reason was: "a reason that looked reasonable once"',
  )
})

test('every real claim is load-bearing today, and the coverage line says so', () => {
  const manifest = readJson('package.json')
  const docNames = readdir('docs').filter((name) => name.endsWith('.md'))
  const files = collectLivingSurface({ root, published: manifest.files ?? [], docNames })
  const found = findUndeclared({ files, declared: declaredNamesOf(read('index.js')) })
  assert.equal(found.dead.length, 0, 'no claim is dead weight')
  assert.equal(found.claims.length, foreignClaims().length, 'every claim is audited, not a subset')
  for (const claim of found.claims) {
    assert.ok(claim.matches > 0, `the claim "${claim.name}" permits something (${claim.matches} occurrence(s))`)
  }
  // The counts are the measurement, so they are printed rather than implied: one line, claim by claim.
  const line = coverageLine(found)
  assert.match(line, /^names: \d+ identifier-shaped name\(s\) compared across \d+ living file\(s\); allowlist: 4\/4 claim\(s\) matched \(/)
  for (const claim of found.claims) assert.ok(line.includes(`${claim.name} ${claim.matches}`), line)
})

test('the audit counts occurrences, not distinct tokens', () => {
  const claims = [{ name: 'twice', match: /^list_members$/, reason: 'probe' }]
  const audit = auditClaims([{ token: 'list_members' }, { token: 'list_members' }, { token: 'task_board' }], claims)
  assert.equal(audit.claims[0].matches, 2, 'two occurrences, one claim')
  assert.deepEqual(audit.dead, [])
})
