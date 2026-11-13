import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { restoreMember } from '../actions.js'
import { PHASE, TRASH_STATE, planMember, readRoster, updateRoster } from '../roster.js'
import {
  artifactIsMissing,
  frozenDataDir,
  locateTrashedArtifact,
  recordedTrashDir,
  recordedTrashPath,
  trashPathCandidates,
} from '../trash.js'
import { memoryTable } from './memory-table.mjs'

const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-paths-'))
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

/** One retired record, with the trash fields the caller supplies. */
function tombstone(fields) {
  const planned = planMember({ leadSessionId: 'lead-1', members: [] }, 'reviewer', 'Check the diff')
  return {
    ...planned,
    phase: PHASE.retired,
    retiredAt: new Date(0).toISOString(),
    archived: false,
    trashKind: 'directory',
    ...fields,
  }
}

test('the trash directory name is read from either stored shape', () => {
  assert.equal(recordedTrashDir({ trashDir: 'member-1-1' }), 'member-1-1')
  assert.equal(recordedTrashDir({ trashRelPath: join('trash', 'lead-1', 'member-1-1') }), 'member-1-1')
  assert.equal(recordedTrashDir({ trashPath: join('/old', 'trash', 'lead-1', 'member-1-1') }), 'member-1-1')
  // A tombstone from the archive branch names no destination at all.
  assert.equal(recordedTrashDir({ archived: true }), undefined)
  assert.equal(recordedTrashDir({}), undefined)
})

test('a recorded path with no last segment names no destination', async () => {
  // `basename('/')` is the empty string, not undefined, so a corrupt record used to answer '' and be
  // treated as a real directory name: restore resolved the root itself — the Lead's trash directory, or
  // the filesystem root — and failed to move it.
  assert.equal(recordedTrashDir({ trashPath: '/' }), undefined)
  assert.equal(recordedTrashDir({ trashRelPath: join('/') }), undefined)
  assert.equal(recordedTrashDir({ trashDir: '' }), undefined)
  // A path whose last segment is real still names it.
  assert.equal(recordedTrashDir({ trashPath: join('/', 'trash') }), 'trash')

  // End to end: a record whose only recorded path is a bare root is not sent into the trash branch at
  // all. It was retired through the archive fallback, so reactivating it is the whole recovery; with the
  // empty segment it tried to move the filesystem root and answered `restore-failed: EBUSY`.
  const root = await scratch()
  const table = memoryTable()
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [
      tombstone({
        trashState: TRASH_STATE.done,
        trashPath: join('/'),
        originalPath: join(root, 'sessions', 'member-1'),
      }),
    ],
  }))
  const restored = await restoreMember({
    ctx: { get: () => undefined },
    table,
    leadSessionId: 'lead-1',
    target: 'reviewer',
    hooks: hooks(),
    dataDir: root,
  })
  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'not-archived', 'a record naming no destination never enters the trash branch')
})

test('a tombstone that claims a landed move with no artifact behind it is the one a migration flips', async () => {
  const root = await scratch()
  const home = join(root, 'home')
  const present = join(root, 'trash', 'lead-1', 'member-1-1')
  await mkdir(present, { recursive: true })
  const ask = (record) => artifactIsMissing({ record, leadSessionId: 'lead-1', dataDir: root, home })
  const destination = join('trash', 'lead-1', 'member-1-1')

  assert.equal(
    await ask({ trashState: TRASH_STATE.done, trashDir: 'member-1-1', trashRelPath: destination }),
    false,
    'the bytes are where the record says they are',
  )
  assert.equal(
    await ask({ trashState: TRASH_STATE.done, trashDir: 'member-2-2', trashRelPath: join('trash', 'lead-1', 'member-2-2') }),
    true,
    'a landed move with nothing on any leg of the chain is what the cap left behind',
  )
  assert.equal(
    await ask({ trashState: TRASH_STATE.pending, trashDir: 'member-2-2', trashRelPath: join('trash', 'lead-1', 'member-2-2') }),
    false,
    'a move in flight may not have landed, so it is not called lost',
  )
  assert.equal(await ask({ trashState: TRASH_STATE.pruned, trashDir: 'member-1-1' }), false, 'a pruned record is not asked again')
  assert.equal(await ask({ trashState: TRASH_STATE.none }), false, 'a record that names no destination moved nothing')
})

test('the chain is the root in effect, then the recorded absolute path, then the frozen default', () => {
  const dataDir = join(tmpdir(), 't1-root-in-effect')
  const home = join(tmpdir(), 't1-home')
  const recorded = join(tmpdir(), 't1-legacy-root', 'trash', 'lead-1', 'artifact-1')

  // A legacy record: an absolute path, and the name that path ends in.
  const legacy = { trashPath: recorded, trashDir: 'artifact-1' }
  assert.deepEqual(trashPathCandidates({ record: legacy, leadSessionId: 'lead-1', dataDir, home }), [
    { path: join(dataDir, 'trash', 'lead-1', 'artifact-1'), leg: 'root' },
    { path: recorded, leg: 'legacy' },
    { path: join(frozenDataDir(home), 'trash', 'lead-1', 'artifact-1'), leg: 'frozen' },
  ])

  // A record written from this release has no absolute path of its own, so the middle leg is simply absent.
  const relative = { trashDir: 'artifact-1', trashRelPath: join('trash', 'lead-1', 'artifact-1') }
  assert.deepEqual(trashPathCandidates({ record: relative, leadSessionId: 'lead-1', dataDir, home }), [
    { path: join(dataDir, 'trash', 'lead-1', 'artifact-1'), leg: 'root' },
    { path: join(frozenDataDir(home), 'trash', 'lead-1', 'artifact-1'), leg: 'frozen' },
  ])

  // When the root in effect is the frozen directory, the two legs are one directory: it is tried once.
  const sameRoot = trashPathCandidates({ record: legacy, leadSessionId: 'lead-1', dataDir: frozenDataDir(home), home })
  assert.deepEqual(sameRoot.map((candidate) => candidate.leg), ['root', 'legacy'])
})

test('the reported absolute path is the recorded one, or the first path the chain resolves', () => {
  const dataDir = join(tmpdir(), 't1-reported')
  const recorded = join(tmpdir(), 't1-old', 'trash', 'lead-1', 'artifact-1')
  assert.equal(recordedTrashPath({ record: { trashPath: recorded }, leadSessionId: 'lead-1', dataDir }), recorded)
  assert.equal(
    recordedTrashPath({
      record: { trashDir: 'artifact-1', trashRelPath: join('trash', 'lead-1', 'artifact-1') },
      leadSessionId: 'lead-1',
      dataDir,
    }),
    join(dataDir, 'trash', 'lead-1', 'artifact-1'),
  )
  assert.equal(recordedTrashPath({ record: {}, leadSessionId: 'lead-1', dataDir }), undefined)
})

test('the artifact is found on whichever leg of the chain still holds it', async () => {
  const root = await scratch()
  const dataDir = join(root, 'new-root')
  const home = join(root, 'home')
  const recorded = join(root, 'old-root', 'trash', 'lead-1', 'artifact-1')
  const record = { trashPath: recorded, trashDir: 'artifact-1' }
  const ask = () => locateTrashedArtifact({ record, leadSessionId: 'lead-1', dataDir, home })

  const inEffect = join(dataDir, 'trash', 'lead-1', 'artifact-1')
  await mkdir(inEffect, { recursive: true })
  assert.deepEqual(await ask(), { path: inEffect, leg: 'root' })

  await rm(inEffect, { recursive: true })
  await mkdir(recorded, { recursive: true })
  assert.deepEqual(await ask(), { path: recorded, leg: 'legacy' })

  await rm(recorded, { recursive: true })
  const frozen = join(frozenDataDir(home), 'trash', 'lead-1', 'artifact-1')
  await mkdir(frozen, { recursive: true })
  assert.deepEqual(await ask(), { path: frozen, leg: 'frozen' })

  // None of the three holds it: there is nothing to find, and nothing is thrown.
  await rm(frozen, { recursive: true })
  assert.equal(await ask(), undefined)
})

test('a tombstone carrying only the old absolute path still restores, with nothing migrated', async () => {
  // This is the shape of all 94 tombstones already on disk; the run must not need a migration first.
  const root = await scratch()
  const artifact = join(root, 'old-root', 'trash', 'lead-1', 'member-1-1')
  await mkdir(artifact, { recursive: true })
  await writeFile(join(artifact, 'session.jsonl'), 'log')
  const original = join(root, 'sessions', 'member-1')

  const table = memoryTable()
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [tombstone({
      trashState: TRASH_STATE.done,
      trashPath: artifact,
      originalPath: original,
    })],
  }))

  const restored = await restoreMember({
    ctx: { get: () => undefined },
    table,
    leadSessionId: 'lead-1',
    target: 'reviewer',
    hooks: hooks(),
    dataDir: join(root, 'new-root'),
  })

  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'moved-back')
  assert.equal(restored.path, original)
  assert.equal(await readFile(join(original, 'session.jsonl'), 'utf8'), 'log')
})

test('a tombstone whose artifact is gone on every leg refuses with trash-missing, never throws', async () => {
  const root = await scratch()
  const table = memoryTable()
  await updateRoster(table, 'lead-1', () => ({
    leadSessionId: 'lead-1',
    members: [tombstone({
      trashState: TRASH_STATE.done,
      trashPath: join(root, 'old-root', 'trash', 'lead-1', 'member-1-1'),
      originalPath: join(root, 'sessions', 'member-1'),
    })],
  }))

  const restored = await restoreMember({
    ctx: { get: () => undefined },
    table,
    leadSessionId: 'lead-1',
    target: 'reviewer',
    hooks: hooks(),
    dataDir: join(root, 'new-root'),
  })

  assert.equal(restored.restored, false)
  assert.match(restored.message, /trash-missing/)
  assert.equal(readRoster(table, 'lead-1').members[0].phase, PHASE.retired, 'the record stays retired')
})

test('a record written with backslashes resolves where the chain expects it', () => {
  // A tombstone written on Windows carries `trash\lead-1\<dir>`. Read on a platform that treats `\` as a
  // literal character, passing that string to `resolve` once produced `<root>/trash\lead-1\<dir>` — a path
  // that exists nowhere, so the chain fell through to the legs that are only there for older records. The
  // field is written with forward slashes now and read tolerantly, which is why this holds on either side.
  const dataDir = join(tmpdir(), 'dsh-team-paths-data')
  const expected = join(dataDir, 'trash', 'lead-1', 'member-1-1')
  for (const stored of ['trash/lead-1/member-1-1', 'trash\\lead-1\\member-1-1', 'trash/lead-1\\member-1-1']) {
    const record = { trashState: TRASH_STATE.done, trashDir: 'member-1-1', trashRelPath: stored }
    assert.equal(trashPathCandidates({ record, leadSessionId: 'lead-1', dataDir })[0].path, expected, `the root leg resolves "${stored}"`)
    assert.equal(recordedTrashPath({ record, leadSessionId: 'lead-1', dataDir }), expected)
  }
  // Without `trashDir`, the directory name is the last segment from either spelling.
  for (const stored of ['trash/lead-1/member-2-2', 'trash\\lead-1\\member-2-2']) {
    assert.equal(recordedTrashDir({ trashRelPath: stored }), 'member-2-2', `the name is the last segment of "${stored}"`)
  }
})
