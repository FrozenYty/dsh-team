/**
 * What a tombstone stores about where its artifact came from, so a roster can travel.
 *
 * `DSH_TEAM_SEED` exists so a person can carry a roster to another machine or another workspace, and an
 * absolute path from this machine names nothing there. The record therefore stores
 * `<workspace-slug>/<leaf>` — the two path segments the host itself used, both kept as data, with the
 * absolute computed at read time from the sessions root in effect *there* — and that is the shape ADR 0028
 * chose for the trash, applied to the path a restore moves the artifact back to.
 *
 * Three things are being pinned here, and only one of them is about bytes:
 *
 *   - the migration is a **read** rule: a record written before this release still restores from its
 *     absolute path, with no script run over it;
 *   - the portable claim is **tested rather than asserted**: a record that came from another machine's
 *     sessions root puts its artifact back under *this* one;
 *   - the file a person copies carries no machine-specific path for this field, and is measurably smaller
 *     for it.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { restoreMember, retireMember, spawnMember } from '../actions.js'
import { PHASE, ROSTER_FILE_NAME, TRASH_STATE, createRosterSource, readRoster } from '../roster.js'
import { TEAM_DIR, createRootBinder } from '../trash.js'
import { memoryTable } from './memory-table.mjs'

const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-portable-'))

/**
 * A context fake with a real sessions tree behind it: `sessions()` answers per Session id, and only while
 * that Session sits where the host put it. `artifactOf` is the persistence service the trash plan needs.
 */
function fakeCtx({ sessionsRoot, artifacts = {} } = {}) {
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => ({ childId: spec.childId }),
      drainChildren: async () => {},
    },
    agents: { get: () => undefined },
    get: (name) => (name === 'sessionPersistence' && sessionsRoot !== undefined
      ? {
        stat: async (id) => {
          const direct = artifacts[id]
          if (typeof direct === 'string') return { location: { path: direct } }
          const slugs = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
          for (const slug of slugs) {
            if (!slug.isDirectory()) continue
            const dir = join(sessionsRoot, slug.name, id)
            if (existsSync(dir)) return { location: { path: join(dir, 'session.jsonl') } }
          }
          return undefined
        },
      }
      : undefined),
  }
}

const lead = { id: 'lead-1', session: { id: 'lead-1' } }
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })
const call = (ctx, table, extra = {}) => ({
  ctx,
  table,
  leadSessionId: 'lead-1',
  leadAgent: lead,
  dataDir: join(tmpdir(), 'dsh-team-portable-data'),
  hooks: hooks(),
  ...extra,
})

/** One retired member as a roster holds it, with whatever path fields the caller is testing. */
const retiredMember = (overrides = {}) => ({
  memberId: 'member-1',
  childId: 'child-1',
  name: 'reviewer',
  label: 'Check the diff',
  generation: 1,
  phase: PHASE.retired,
  retiredAt: '2026-11-13T00:00:00.000Z',
  archived: false,
  trashState: TRASH_STATE.done,
  trashDir: 'child-1-1001',
  trashRelPath: join('trash', 'lead-1', 'child-1-1001'),
  trashKind: 'directory',
  ...overrides,
})

/** One live member, so the sessions root has a neighbour still where the host put it. */
const liveMember = (childId) => ({
  memberId: `member-${childId}`,
  childId,
  name: 'scribe',
  label: 'Write it down',
  generation: 1,
  phase: PHASE.active,
})

const rosterOf = (...members) => ({ leadSessionId: 'lead-1', members })

/** Put a retired member's artifact in this machine's trash, where the record says it is. */
async function trashArtifact(dataDir, dirName = 'child-1-1001') {
  const dir = join(dataDir, 'trash', 'lead-1', dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), 'log')
  return dir
}

test('a record carrying only the legacy absolute still restores, so the migration is a read rule', async () => {
  // A record written by the release before this one: no relative form, and the sessions root cannot even be
  // derived here (no persistence service at all), so the only thing that can answer is the path it kept.
  const dataDir = await scratch()
  await trashArtifact(dataDir)
  const original = join(await scratch(), 'sessions', 'key', 'child-1')
  const ctx = fakeCtx()
  const table = memoryTable()
  await table.put('lead-1', rosterOf(retiredMember({ originalPath: original })))

  const restored = await restoreMember(call(ctx, table, { target: 'reviewer', dataDir }))
  assert.equal(restored.restored, true, 'the absolute path it was written with is enough')
  assert.equal(restored.reason, 'moved-back')
  assert.equal(existsSync(join(original, 'session.jsonl')), true)
  assert.equal(memberNamed(table, 'reviewer').phase, PHASE.active)
})

test('a record carrying only the relative form restores into the root in effect', async () => {
  const dataDir = await scratch()
  await trashArtifact(dataDir)
  const sessionsRoot = join(await scratch(), 'sessions')
  // A sibling still where this host put it: that is how the root is found.
  await mkdir(join(sessionsRoot, 'key', 'sibling-1'), { recursive: true })
  const ctx = fakeCtx({ sessionsRoot })
  const table = memoryTable()
  await table.put('lead-1', rosterOf(
    liveMember('sibling-1'),
    retiredMember({ originalRelPath: 'key/child-1' }),
  ))

  const restored = await restoreMember(call(ctx, table, { target: 'reviewer', dataDir }))
  assert.equal(restored.restored, true)
  assert.equal(join(sessionsRoot, 'key', 'child-1'), restored.path, 'the path is the root in effect plus what the record stores')
  assert.equal(existsSync(join(sessionsRoot, 'key', 'child-1', 'session.jsonl')), true)
})

test('a roster seeded into another home restores under that home\'s sessions root, not the one recorded', async () => {
  // The record came from a machine whose workspace slug was `--OTHER-WS--`. This machine has a different
  // slug and a different sessions root; the slug in the record is data, so it is honoured, and the root is
  // this one.
  const dataDir = await scratch()
  await trashArtifact(dataDir)
  const here = join(await scratch(), 'sessions')
  await mkdir(join(here, '--this-machine--', 'sibling-9'), { recursive: true })
  const ctx = fakeCtx({ sessionsRoot: here })
  const table = memoryTable()
  await table.put('lead-1', rosterOf(
    liveMember('sibling-9'),
    retiredMember({ childId: 'from-machine-a', originalRelPath: '--OTHER-WS--/from-machine-a' }),
  ))

  const restored = await restoreMember(call(ctx, table, { target: 'reviewer', dataDir }))
  assert.equal(restored.restored, true)
  assert.equal(restored.path, join(here, '--OTHER-WS--', 'from-machine-a'), 'the recorded slug under *this* sessions root')
  assert.equal(existsSync(join(here, '--OTHER-WS--', 'from-machine-a', 'session.jsonl')), true)
  assert.equal(existsSync(join(here, '--this-machine--', 'from-machine-a')), false, 'and nothing was put under this machine\'s own slug')
})

test('a retirement stores no absolute original path, and the file it writes is smaller for it', async () => {
  const dataDir = await scratch()
  const sessionsRoot = join(await scratch(), 'sessions')
  const ctx = fakeCtx({ sessionsRoot })
  const table = memoryTable()
  await spawnMember(call(ctx, table, { name: 'reviewer', label: 'Check the diff', prompt: 'Start.' }))
  const childId = memberNamed(table, 'reviewer').childId
  const memberDir = join(sessionsRoot, 'key', childId)
  await mkdir(memberDir, { recursive: true })
  await writeFile(join(memberDir, 'session.jsonl'), 'log')

  const retired = await retireMember(call(ctx, table, { target: 'reviewer', dataDir }))
  assert.equal(retired.trashed, true)

  const record = memberNamed(table, 'reviewer')
  assert.equal(record.originalPath, undefined, 'no absolute path from this machine')
  assert.equal(record.originalRelPath, ['key', childId].join('/'), 'the two segments the host used, and nothing above them')
  assert.equal(record.originalRelPath.startsWith('/'), false)

  // The serialized record, which is what a person copies: no part of this machine's sessions root in it.
  const text = JSON.stringify(readRoster(table, 'lead-1'))
  assert.equal(text.includes(sessionsRoot), false, 'the sessions root of this machine is not in the file')
  assert.equal(text.includes('originalPath'), false, 'the field is gone, not merely empty')

  // And it is smaller: the absolute this machine would have recorded against what the record actually says.
  const wouldHaveBeen = JSON.stringify({ ...record, originalPath: memberDir })
  const actuallyIs = JSON.stringify(record)
  assert.ok(wouldHaveBeen.length - actuallyIs.length > 20, `the portable field is at least 20 bytes smaller (${wouldHaveBeen.length - actuallyIs.length})`)
})

test('a relative path whose sessions root cannot be resolved falls back to the recorded absolute', async () => {
  // Both fields present: a record that carried a path before this release and was rewritten in the portable
  // shape. Nothing on disk names the root here (no persistence service), so the absolute is the answer —
  // a path that is wrong is still better than a refusal the person cannot act on.
  const dataDir = await scratch()
  await trashArtifact(dataDir)
  const original = join(await scratch(), 'sessions', 'key', 'child-1')
  const ctx = fakeCtx()
  const table = memoryTable()
  await table.put('lead-1', rosterOf(retiredMember({ originalPath: original, originalRelPath: 'key/child-1' })))

  const restored = await restoreMember(call(ctx, table, { target: 'reviewer', dataDir }))
  assert.equal(restored.restored, true)
  assert.equal(existsSync(join(original, 'session.jsonl')), true, 'the fallback leg is the one that moved it back')
})

test('a stored relative path is validated when the record loads', async () => {
  const cases = [
    ['an absolute path', '/root/key/child-1', /must be relative to the sessions root/],
    ['a Windows drive', 'C:/Users/someone/key/child-1', /must be relative to the sessions root/],
    ['a backslash separator', 'key\\child-1', /must use forward slashes/],
    ['a path that escapes the root', 'key/../../child-1', /must not escape the sessions root/],
    ['an empty segment', 'key//child-1', /must not escape the sessions root/],
    ['an empty string', '', /must be a non-empty string/],
  ]
  for (const [label, value, message] of cases) {
    const source = await loadRecord({ originalRelPath: value })
    assert.match(source.report('lead-1').read_problem, message, label)
    assert.deepEqual(readRoster(source.table, 'lead-1').members, [], 'and the record is refused rather than half-served')
  }
  // A legal one loads, and so does a record written before the field existed.
  const legal = await loadRecord({ originalRelPath: '--ws--/child-1' })
  assert.equal(legal.report('lead-1').read_problem, undefined)
  assert.equal(readRoster(legal.table, 'lead-1').members.length, 1)
  const legacy = await loadRecord({})
  assert.equal(legacy.report('lead-1').read_problem, undefined)
})

/** Load one hand-written roster record the way the plugin does, through a file and a fresh store. */
async function loadRecord(overrides) {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, TEAM_DIR), { recursive: true })
  await writeFile(
    join(workspace, TEAM_DIR, ROSTER_FILE_NAME),
    JSON.stringify({ version: 1, serial: 1, updatedAt: 'x', rosters: { 'lead-1': rosterOf(retiredMember(overrides)) } }),
    'utf8',
  )
  const source = createRosterSource({ binder: createRootBinder({ env: {}, home: join(root, 'home') }) })
  source.bind('lead-1', workspace)
  await source.readyFor('lead-1')
  return source
}

/** The member a read serves, by target. */
function memberNamed(table, name = 'reviewer') {
  return readRoster(table, 'lead-1').members.find((member) => member.name === name)
}

test('the profile-shaped roster saves its measured bytes, record by record', async () => {
  // The shape measured on this machine: `<home>/.dsh/sessions/<workspace-key>/<child id>`, 36 characters of
  // id and a 32-character root. Twenty tombstones, which is what the window keeps, before and after.
  const home = 'C:\\Users\\someone'
  const root = `${home}\\.dsh\\sessions`
  const members = Array.from({ length: 20 }, (_, index) => ({
    memberId: `member-${index}`,
    childId: `5a733d3b-e979-46f1-bb4a-7b31f19a7${String(index).padStart(2, '0')}`,
    name: 'reviewer',
    label: 'Check the diff',
    generation: index + 1,
    phase: PHASE.retired,
    retiredAt: '2026-11-13T00:00:00.000Z',
    archived: false,
    trashState: TRASH_STATE.done,
    trashDir: `child-${index}-1001`,
    trashRelPath: `trash/lead-1/child-${index}-1001`,
    originalPath: `${root}\\--D-MYPROJS--\\5a733d3b-e979-46f1-bb4a-7b31f19a7${String(index).padStart(2, '0')}`,
  }))
  const before = JSON.stringify({ leadSessionId: 'lead-1', members })
  const after = JSON.stringify({
    leadSessionId: 'lead-1',
    members: members.map(({ originalPath, ...member }) => ({ ...member, originalRelPath: originalPath.slice(root.length + 1).split('\\').join('/') })),
  })
  const saved = before.length - after.length
  assert.ok(saved > 0, 'the portable form is smaller')
  // Per record the difference is the root plus its escaping, minus the separator: measured at 39 bytes on
  // this machine's shape. A tenth of that is the floor the check holds to, so it fails if the field stops
  // being relative without pretending to pin a platform's separator.
  assert.ok(saved / 20 > 20, `at least 20 bytes per record (measured ${(saved / 20).toFixed(1)})`)
})
