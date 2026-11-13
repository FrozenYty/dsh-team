import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { test } from 'node:test'

import { retireMember, restoreMember } from '../actions.js'
import { PHASE, TRASH_STATE, parseRoster, planMember, readRoster, updateRoster } from '../roster.js'
import { DEFAULT_TRASH_LIMIT, TRASH_LIMIT_MINIMUM, parseTrashDirName, pruneLeadTrash, resolveTrashLimit } from '../trash.js'
import { memoryTable } from './memory-table.mjs'

const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-retention-'))
const trashRootOf = (root) => join(root, 'trash', 'lead-1')

/**
 * Create one trash entry on disk together with the tombstone-shaped row that accounts for it. The row
 * is only the three fields retention reads; the pure prune tests never load it into a roster.
 */
async function seedEntry(root, { memberId, stamp, state = TRASH_STATE.done, name }) {
  const trashPath = join(trashRootOf(root), name ?? `${memberId}-${stamp}`)
  await mkdir(trashPath, { recursive: true })
  await writeFile(join(trashPath, 'session.jsonl'), memberId)
  return { memberId, trashPath, state }
}

const memberRows = (entries) => entries.map(({ memberId, trashPath, state }) => ({ memberId, trashPath, trashState: state }))
const namesInTrash = async (root) => (await readdir(trashRootOf(root))).sort()

/** The host-side effects a retirement refreshes. */
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })
const lead = { session: { id: 'lead-1' } }

/**
 * A context carrying just what a retirement touches: no workspace service (so the archive branch never
 * runs), a persistence fake that reports the member's artifact, and the subagent seam. `artifactOf`
 * maps a child id to a real directory to move.
 */
function retirementCtx({ artifactOf = () => undefined } = {}) {
  return {
    agentTeams: { listMembers: () => [] },
    subagents: {
      listDescendants: async () => [],
      drainChildren: async () => {},
    },
    agents: { get: () => undefined },
    get: (name) => (name === 'sessionPersistence'
      ? { stat: async (id) => (artifactOf(id) === undefined ? undefined : { location: { path: artifactOf(id) } }) }
      : undefined),
  }
}

/** One valid roster record with the fields the domain validates. */
function record(overrides) {
  return {
    memberId: 'member-1',
    name: 'member-1',
    generation: 1,
    childId: 'member-1',
    phase: PHASE.active,
    label: 'Seeded member',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

test('the trash-directory name parser accepts a uid-plus-stamp name and refuses anything else', () => {
  // A UUID member id survives the greedy split: the last hyphen is the one before the stamp.
  assert.deepEqual(parseTrashDirName('550e8400-e29b-41d4-a716-446655440000-1700000000000'), {
    memberId: '550e8400-e29b-41d4-a716-446655440000',
    stamp: 1700000000000,
  })
  assert.deepEqual(parseTrashDirName('reviewer-g2-42'), { memberId: 'reviewer-g2', stamp: 42 })
  // A name this plugin did not write is never considered, so retention cannot touch it.
  assert.equal(parseTrashDirName('notes'), undefined)
  assert.equal(parseTrashDirName('member-x-abc'), undefined)
  assert.equal(parseTrashDirName('member-x-'), undefined)
  assert.equal(parseTrashDirName('..-1'), undefined)
})

test('a tombstone written before the cap existed is still eligible', async () => {
  const root = await scratch()
  const entries = []
  for (let index = 0; index < 5; index += 1) {
    entries.push(await seedEntry(root, { memberId: `legacy-${index}`, stamp: 1000 + index }))
  }
  // `trashState` arrived with the cap, so every earlier tombstone has a trashPath and no state. Reading
  // that absence as ineligible leaves the entire pre-existing trash permanently exempt: the first live
  // run of the cap pruned nothing for exactly this reason.
  const legacyRows = entries.map(({ memberId, trashPath }) => ({ memberId, trashPath }))
  const outcome = await pruneLeadTrash({ trashRoot: trashRootOf(root), limit: 2, members: legacyRows })
  assert.equal(outcome.pruned, 3)
  assert.deepEqual(await namesInTrash(root), ['legacy-3-1003', 'legacy-4-1004'])
})

test('a profile that configures nothing keeps the documented default cap, and a smaller trash is untouched', async () => {
  assert.equal(resolveTrashLimit(undefined), DEFAULT_TRASH_LIMIT)
  assert.equal(resolveTrashLimit({}), DEFAULT_TRASH_LIMIT)
  assert.equal(DEFAULT_TRASH_LIMIT, 20, 'the documented default is 20; the config, not the constant, is the authority')
  const root = await scratch()
  const entries = []
  for (let stamp = 1; stamp <= DEFAULT_TRASH_LIMIT; stamp += 1) {
    entries.push(await seedEntry(root, { memberId: `member-${stamp}`, stamp }))
  }
  const outcome = await pruneLeadTrash({ trashRoot: trashRootOf(root), members: memberRows(entries) })
  assert.deepEqual(outcome, { pruned: 0, removed: [] })
  assert.equal((await namesInTrash(root)).length, DEFAULT_TRASH_LIMIT, 'a trash at the cap keeps every artifact')
})

test('the cap comes from the config, and a value outside the range is refused rather than clamped', () => {
  assert.equal(resolveTrashLimit(null), DEFAULT_TRASH_LIMIT, 'an absent config takes the default')
  assert.equal(resolveTrashLimit({ trashLimit: undefined }), DEFAULT_TRASH_LIMIT, 'an absent field takes the default')
  assert.equal(resolveTrashLimit({ trashLimit: TRASH_LIMIT_MINIMUM }), TRASH_LIMIT_MINIMUM, 'the minimum itself is legal')
  assert.equal(resolveTrashLimit({ trashLimit: 7 }), 7)

  // `null` is a present, wrong value rather than the default: the official schema only admits it
  // because its `anyOf` also accepts a Loader expression.
  const refused = [[0, '0'], [-1, '-1'], [1.5, '1.5'], ['20', '"20"'], [Number.NaN, 'NaN'], [null, 'null']]
  for (const [value, seen] of refused) {
    assert.throws(
      () => resolveTrashLimit({ trashLimit: value }),
      (error) => {
        assert.ok(error instanceof TypeError, 'the refusal is a type error, not a clamp')
        assert.match(error.message, /trashLimit/, 'the message names the field')
        assert.match(error.message, /minimum 1/, 'the message names the minimum')
        assert.ok(error.message.includes(seen), `the message names the value it saw (${seen})`)
        return true
      },
      `trashLimit: ${String(value)} is refused`,
    )
  }
})

test('the oldest entries are removed first until the cap is met', async () => {
  const root = await scratch()
  const entries = []
  for (const stamp of [1000, 4000, 2000, 3000]) {
    entries.push(await seedEntry(root, { memberId: `member-${stamp}`, stamp }))
  }

  const outcome = await pruneLeadTrash({ trashRoot: trashRootOf(root), limit: 2, members: memberRows(entries) })

  assert.equal(outcome.pruned, 2)
  assert.deepEqual(outcome.removed.map((entry) => entry.memberId), ['member-1000', 'member-2000'])
  assert.deepEqual(await namesInTrash(root), ['member-3000-3000', 'member-4000-4000'])
})

test('a pending move is never pruned, even when it is the oldest entry', async () => {
  const root = await scratch()
  const pending = await seedEntry(root, { memberId: 'member-1', stamp: 1000, state: TRASH_STATE.pending })
  const second = await seedEntry(root, { memberId: 'member-2', stamp: 2000 })
  const third = await seedEntry(root, { memberId: 'member-3', stamp: 3000 })

  const outcome = await pruneLeadTrash({
    trashRoot: trashRootOf(root),
    limit: 1,
    members: memberRows([pending, second, third]),
  })

  assert.equal(outcome.pruned, 2)
  assert.deepEqual(outcome.removed.map((entry) => entry.memberId), ['member-2', 'member-3'])
  assert.deepEqual(await namesInTrash(root), ['member-1-1000'], 'the entry whose move is in flight survives')
})

test('a name this plugin did not write, and an entry with no tombstone, are left alone', async () => {
  const root = await scratch()
  const oldest = await seedEntry(root, { memberId: 'member-1', stamp: 1000 })
  const newest = await seedEntry(root, { memberId: 'member-2', stamp: 2000 })
  // Foreign names: one wholly unlike ours, one with a non-numeric stamp, one that is a file.
  await mkdir(join(trashRootOf(root), 'notes'), { recursive: true })
  await mkdir(join(trashRootOf(root), 'member-9-later'), { recursive: true })
  await writeFile(join(trashRootOf(root), 'member-2-3000'), 'a file, not a directory')
  // A conforming name that no tombstone accounts for.
  await mkdir(join(trashRootOf(root), 'member-8-4000'), { recursive: true })

  const outcome = await pruneLeadTrash({
    trashRoot: trashRootOf(root),
    limit: 1,
    members: memberRows([oldest, newest]),
  })

  assert.equal(outcome.pruned, 1)
  assert.deepEqual(outcome.removed.map((entry) => entry.memberId), ['member-1'])
  const left = await namesInTrash(root)
  for (const name of ['notes', 'member-9-later', 'member-2-3000', 'member-8-4000', 'member-2-2000']) {
    assert.ok(left.includes(name), `${name} survives`)
  }
})

test('pruning twice leaves the same state', async () => {
  const root = await scratch()
  const entries = []
  for (const stamp of [1000, 2000, 3000, 4000]) {
    entries.push(await seedEntry(root, { memberId: `member-${stamp}`, stamp }))
  }

  const first = await pruneLeadTrash({ trashRoot: trashRootOf(root), limit: 2, members: memberRows(entries) })
  assert.equal(first.pruned, 2)
  const afterFirst = await namesInTrash(root)

  const second = await pruneLeadTrash({ trashRoot: trashRootOf(root), limit: 2, members: memberRows(entries) })
  assert.deepEqual(second, { pruned: 0, removed: [] })
  assert.deepEqual(await namesInTrash(root), afterFirst)
})

test('a retirement that moved an artifact in prunes the oldest tombstone and keeps its trash path', async () => {
  const root = await scratch()
  const table = memoryTable()
  const seeded = []
  for (let index = 1; index <= DEFAULT_TRASH_LIMIT; index += 1) {
    const memberId = `seed-${index}`
    const entry = await seedEntry(root, { memberId, stamp: index })
    seeded.push(record({
      memberId,
      name: memberId,
      childId: memberId,
      phase: PHASE.retired,
      retiredAt: new Date(0).toISOString(),
      trashPath: entry.trashPath,
      trashKind: 'directory',
      originalPath: join(root, 'sessions', memberId),
      trashState: TRASH_STATE.done,
      archived: false,
    }))
  }
  const artifact = join(root, 'sessions', 'fresh-child')
  await mkdir(artifact, { recursive: true })
  await writeFile(join(artifact, 'session.jsonl'), 'log')
  seeded.push(record({ memberId: 'fresh', name: 'fresh', childId: 'fresh-child' }))
  seeded.push(record({ memberId: 'fresh-2', name: 'fresh-2', childId: 'fresh-2-child' }))
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: seeded }))

  const ctx = retirementCtx({ artifactOf: (id) => (id === 'fresh-child' ? artifact : undefined) })
  const retired = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: lead,
    dataDir: root,
    hooks: hooks(),
    target: 'fresh',
  })

  assert.equal(retired.trashed, true)
  assert.equal(retired.pruned, 1, 'the retirement that grew the trash enforced the cap')
  assert.match(retired.message, /Retention removed 1 older artifact/)
  assert.match(retired.message, new RegExp(`at most ${DEFAULT_TRASH_LIMIT}`))
  assert.deepEqual(JSON.parse(JSON.stringify(retired)), retired, 'the result stays lossless JSON')

  const roster = readRoster(table, 'lead-1')
  const oldest = roster.members.find((member) => member.memberId === 'seed-1')
  assert.equal(oldest.trashState, TRASH_STATE.pruned, 'the removed tombstone says its bytes are gone')
  assert.equal(typeof oldest.trashPath, 'string', 'the tombstone still says where the artifact went')
  assert.equal(roster.members.find((member) => member.memberId === 'seed-2').trashState, TRASH_STATE.done)
  assert.equal(roster.members.find((member) => member.memberId === 'fresh').trashState, TRASH_STATE.done)
  assert.equal(existsSync(join(trashRootOf(root), 'seed-1-1')), false)

  // A retirement that moved nothing does not prune: the cap is enforced only when the trash grew.
  const quiet = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: lead,
    dataDir: root,
    hooks: hooks(),
    target: 'fresh-2',
  })
  assert.equal(quiet.trashed, false)
  assert.equal(quiet.pruned, 0)
  assert.equal(readRoster(table, 'lead-1').members.find((member) => member.memberId === 'seed-2').trashState, TRASH_STATE.done)
})

test('the cap flips the record of a spawned member, whose memberId is not its child id', async () => {
  // A retirement names the trash directory after the *child Session id*, and the record it later flips
  // is keyed by `memberId`. `planMember` gives a spawned member two different uuids; only an adopted one
  // has them equal, and every cap test seeded that shape — which is why the mismatch survived the suite.
  const root = await scratch()
  const table = memoryTable()
  const seeded = []
  for (let index = 1; index <= DEFAULT_TRASH_LIMIT; index += 1) {
    const entry = await seedEntry(root, { memberId: `child-${index}`, stamp: index })
    seeded.push(record({
      memberId: `member-${index}`,
      name: `member-${index}`,
      childId: `child-${index}`,
      phase: PHASE.retired,
      retiredAt: new Date(0).toISOString(),
      trashPath: entry.trashPath,
      trashKind: 'directory',
      originalPath: join(root, 'sessions', `child-${index}`),
      trashState: TRASH_STATE.done,
      archived: false,
    }))
  }
  const artifact = join(root, 'sessions', 'fresh-child')
  await mkdir(artifact, { recursive: true })
  await writeFile(join(artifact, 'session.jsonl'), 'log')
  seeded.push(record({ memberId: 'fresh', name: 'fresh', childId: 'fresh-child' }))
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: seeded }))

  const ctx = retirementCtx({ artifactOf: (id) => (id === 'fresh-child' ? artifact : undefined) })
  const retired = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: lead,
    dataDir: root,
    hooks: hooks(),
    target: 'fresh',
  })
  assert.equal(retired.trashed, true)
  assert.equal(retired.pruned, 1, 'the cap removed the oldest artifact')

  // What the cap removed is a record, and a record is identified by `memberId` — not by the child id
  // the directory happens to be named after.
  const pruned = readRoster(table, 'lead-1').members.find((member) => member.memberId === 'member-1')
  assert.equal(pruned.trashState, TRASH_STATE.pruned, 'the tombstone whose bytes went says so')
  assert.equal(pruned.trashPath, join(trashRootOf(root), 'child-1-1'), 'and still says where they went')

  const restored = await restoreMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    target: 'member-1',
    hooks: hooks(),
    dataDir: root,
  })
  assert.equal(restored.restored, false)
  assert.equal(
    restored.reason,
    'pruned',
    'a record the cap emptied answers the typed reason the tool description promises, not trash-missing',
  )
  assert.match(restored.message, /pruned by the trash retention cap/)
})

test('a retirement that moved nothing leaves no trash destination on the record', async () => {
  const root = await scratch()
  const table = memoryTable()
  // A live record still carrying the absolute path an older release wrote. Whatever left it there, the
  // tombstone must not name a destination beside `archived: true`: `restore_member` would take the trash
  // branch for an artifact that was never moved, which is a defect PROGRESS records as fixed once before.
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [record({
      memberId: 'fresh',
      name: 'fresh',
      childId: 'fresh-child',
      trashPath: join(root, 'old-root', 'trash', 'lead-1', 'legacy-1'),
      trashDir: 'legacy-1',
    })],
  }))

  // No artifact to move, so the workspace archive is the branch that runs instead.
  const base = retirementCtx()
  const ctx = {
    ...base,
    get: (name) => (name === 'workspaceRegistry'
      ? { archiveSession: async () => {}, unarchiveSession: async () => {} }
      : base.get(name)),
  }
  const retired = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: lead,
    dataDir: root,
    hooks: hooks(),
    target: 'fresh',
  })
  assert.equal(retired.trashed, false)
  assert.equal(retired.archived, true, 'the archive fallback is the branch that ran')

  const tombstone = readRoster(table, 'lead-1').members[0]
  assert.equal(tombstone.trashState, TRASH_STATE.none)
  for (const field of ['trashPath', 'trashDir', 'trashRelPath']) {
    assert.equal(tombstone[field], undefined, `${field} is gone: the record names no destination`)
  }

  const restored = await restoreMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    target: 'fresh',
    hooks: hooks(),
    dataDir: root,
  })
  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'unarchived', 'no trash branch is entered for a move that never happened')
})

test('a configured cap is the one the retirement enforces and prints, not the default', async () => {
  const root = await scratch()
  const table = memoryTable()
  const seeded = []
  for (let index = 1; index <= 2; index += 1) {
    const memberId = `seed-${index}`
    const entry = await seedEntry(root, { memberId, stamp: index })
    seeded.push(record({
      memberId,
      name: memberId,
      childId: memberId,
      phase: PHASE.retired,
      retiredAt: new Date(0).toISOString(),
      trashPath: entry.trashPath,
      trashKind: 'directory',
      originalPath: join(root, 'sessions', memberId),
      trashState: TRASH_STATE.done,
      archived: false,
    }))
  }
  const artifact = join(root, 'sessions', 'fresh-child')
  await mkdir(artifact, { recursive: true })
  await writeFile(join(artifact, 'session.jsonl'), 'log')
  seeded.push(record({ memberId: 'fresh', name: 'fresh', childId: 'fresh-child' }))
  await updateRoster(table, 'lead-1', () => ({ leadSessionId: 'lead-1', members: seeded }))

  const ctx = retirementCtx({ artifactOf: (id) => (id === 'fresh-child' ? artifact : undefined) })
  const retired = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: lead,
    dataDir: root,
    hooks: hooks(),
    target: 'fresh',
    // What `apply` resolved out of the patch row; without it the retirement would enforce 20.
    trashLimit: 2,
  })

  assert.equal(retired.pruned, 1, 'the prune ran at the configured cap')
  assert.match(retired.message, /at most 2/, 'the operator reads the cap that was actually in force')
  assert.doesNotMatch(retired.message, new RegExp(`at most ${DEFAULT_TRASH_LIMIT}\\b`), 'the default is not what was applied')
  assert.equal(readRoster(table, 'lead-1').members.find((member) => member.memberId === 'seed-1').trashState, TRASH_STATE.pruned)
  assert.equal(existsSync(join(trashRootOf(root), 'seed-1-1')), false)
})

test('a pruned tombstone refuses restore and the workspace is never called', async () => {
  const table = memoryTable()
  const planned = planMember({ leadSessionId: 'lead-1', members: [] }, 'reviewer', 'Check the diff')
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [{
      ...planned,
      phase: PHASE.retired,
      retiredAt: new Date(0).toISOString(),
      archived: false,
      trashState: TRASH_STATE.pruned,
      trashPath: join(tmpdir(), 'dsh-team-gone', 'member-1-1'),
      trashKind: 'directory',
      originalPath: join(tmpdir(), 'dsh-team-sessions', 'member-1'),
    }],
  }))

  let unarchived = 0
  const ctx = {
    get: (name) => (name === 'workspaceRegistry'
      ? { unarchiveSession: async () => { unarchived += 1 } }
      : undefined),
  }
  const restored = await restoreMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    target: 'reviewer',
    hooks: hooks(),
  })

  assert.equal(restored.restored, false)
  assert.equal(restored.reason, 'pruned')
  assert.match(restored.message, /pruned by the trash retention cap/)
  assert.equal(unarchived, 0, 'restore never claims an unarchive for an artifact the cap removed')
  assert.equal(readRoster(table, 'lead-1').members[0].phase, PHASE.retired, 'the record stays retired')
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), restored, 'the refusal stays lossless JSON')
})

test('a pruned tombstone is a legal stored record and an unknown trash state is not', () => {
  const parse = parseRoster
  const stored = {
    leadSessionId: 'lead-1',
    members: [record({
      phase: PHASE.retired,
      trashPath: '/tmp/trash/lead-1/member-1-1',
      trashState: TRASH_STATE.pruned,
    })],
  }
  assert.equal(parse(stored), stored)
  stored.members[0].trashState = 'gone'
  assert.throws(() => parse(stored), /trashState "gone" is unknown/)
})

test('a retirement records the trash directory and a root-relative path, never an absolute one', async () => {
  const root = await scratch()
  const table = memoryTable()
  const artifact = join(root, 'sessions', 'fresh-child')
  await mkdir(artifact, { recursive: true })
  await writeFile(join(artifact, 'session.jsonl'), 'log')
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [record({ memberId: 'fresh', name: 'fresh', childId: 'fresh-child' })],
  }))

  const ctx = retirementCtx({ artifactOf: (id) => (id === 'fresh-child' ? artifact : undefined) })
  const retired = await retireMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    leadAgent: lead,
    dataDir: root,
    hooks: hooks(),
    target: 'fresh',
  })
  assert.equal(retired.trashed, true)

  const tombstone = readRoster(table, 'lead-1').members[0]
  // The recorded-absolute-path shape is gone: what is stored is the directory name and where it sits
  // under the data root. `originalPath` stays absolute on purpose — the sessions directory does not
  // move, so there is nothing to recompute it from.
  assert.equal(tombstone.trashPath, undefined, 'the record no longer carries an absolute trash path')
  assert.match(tombstone.trashDir, /^fresh-child-\d+$/, 'the record carries the directory name')
  assert.equal(tombstone.trashRelPath, ['trash', 'lead-1', tombstone.trashDir].join('/'), 'and a path relative to the data root, in forward slashes so a roster that travels still resolves')
  assert.equal(tombstone.trashRelPath.includes('\\'), false, 'the platform separator is not in the record')
  assert.equal(isAbsolute(tombstone.trashRelPath), false)

  // The absolute path is computed at read time from the data directory in effect, which is what makes
  // the root movable without rewriting a record.
  const computed = join(root, tombstone.trashRelPath)
  assert.equal(existsSync(computed), true, 'the computed absolute path is where the artifact actually is')
  assert.equal(retired.trash_path, computed, 'the result still reports one absolute path')
  // The original path is stored relative to the sessions root, so the record is portable: what it keeps is
  // where the artifact came from under whichever root is in effect, and the absolute this machine saw is
  // not in the file at all.
  assert.equal(tombstone.originalRelPath, ['sessions', 'fresh-child'].join('/'), 'the record carries where it came from, relative to the sessions root')
  assert.equal(tombstone.originalPath, undefined, 'and no machine-specific absolute path')

  // Acceptance for the relative record on the read side: restore moves the artifact back from it.
  const restored = await restoreMember({
    ctx,
    table,
    leadSessionId: 'lead-1',
    target: 'fresh',
    hooks: hooks(),
    dataDir: root,
  })
  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'moved-back')
  assert.equal(existsSync(computed), false)
  assert.equal(existsSync(artifact), true, 'the session is back where it came from')
})

test('the cap prunes entries that a root-relative tombstone accounts for', async () => {
  const root = await scratch()
  const entries = []
  for (const stamp of [1000, 2000, 3000]) {
    entries.push(await seedEntry(root, { memberId: `member-${stamp}`, stamp }))
  }
  // Two shapes a record written from this release can carry: the directory name, and the root-relative path
  // (whose last segment is the same name). Both must be matched to the directory on disk, because the
  // record no longer names an absolute path to compare against.
  const rows = entries.map((entry) => {
    const name = basename(entry.trashPath)
    return entry.memberId === 'member-1000'
      ? { memberId: entry.memberId, trashRelPath: join('trash', 'lead-1', name), trashState: TRASH_STATE.done }
      : { memberId: entry.memberId, trashDir: name, trashState: TRASH_STATE.done }
  })

  const outcome = await pruneLeadTrash({ trashRoot: trashRootOf(root), limit: 1, members: rows })

  assert.equal(outcome.pruned, 2)
  assert.deepEqual(outcome.removed.map((entry) => entry.memberId), ['member-1000', 'member-2000'])
  assert.deepEqual(await namesInTrash(root), ['member-3000-3000'])
})
