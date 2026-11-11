import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  applyMemberTrash,
  decodeSegment,
  moveSessionArtifact,
  planMemberTrash,
  resolveDataDir,
  resolveSource,
  restoreSessionArtifact,
  sessionRootFromSibling,
  trashMemberSession,
} from '../trash.js'

const scratch = () => mkdtemp(join(tmpdir(), 'team-relay-test-'))

test('the data directory is overridable and defaults under the home directory', () => {
  assert.equal(resolveDataDir({ DSH_TEAM_RELAY_DATA_DIR: '/tmp/custom' }, '/home/x'), '/tmp/custom')
  assert.equal(resolveDataDir({ DSH_TEAM_RELAY_DATA_DIR: '   ' }, '/home/x'), join('/home/x', '.dsh', 'team-roster'))
})

test('the pre-rename data-directory variable still points at the same directory', () => {
  // The default directory and the old variable are frozen (ADR 0014), so a profile that set either one
  // keeps finding the trash it already has.
  assert.equal(resolveDataDir({ DSH_TEAM_ROSTER_DATA_DIR: '/tmp/legacy' }, '/home/x'), '/tmp/legacy')
  assert.equal(
    resolveDataDir({ DSH_TEAM_RELAY_DATA_DIR: '/tmp/new', DSH_TEAM_ROSTER_DATA_DIR: '/tmp/legacy' }, '/home/x'),
    '/tmp/new',
    'the current variable wins when both are set',
  )
})

test('the persistence path encoding is decoded before comparing a directory name', () => {
  // The backend encodes a non-safe character as `~` plus four hex digits.
  assert.equal(decodeSegment('sess~002d1~002e2'), 'sess-1.2')
  assert.equal(decodeSegment('plain'), 'plain')
})

test('a whole session directory is moved, not copied', async () => {
  const root = await scratch()
  const source = join(root, 'sessions', 'member-1')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'session.jsonl'), 'log')
  const trashRoot = join(root, 'trash', 'lead-1')

  const trashPath = await moveSessionArtifact({ sourcePath: source, isDirectory: true, trashRoot, dirName: 'member-1-1' })
  assert.equal(existsSync(source), false, 'the source directory is gone')
  assert.equal(await readFile(join(trashPath, 'session.jsonl'), 'utf8'), 'log')
})

test('a cross-device move falls back to copy plus remove', async () => {
  const root = await scratch()
  const source = join(root, 'artifact.jsonl')
  await writeFile(source, 'log')
  const trashRoot = join(root, 'trash')
  const renameFn = async () => {
    const error = new Error('cross-device')
    error.code = 'EXDEV'
    throw error
  }

  const trashPath = await moveSessionArtifact({ sourcePath: source, trashRoot, dirName: 'a-1', renameFn })
  assert.equal(existsSync(source), false)
  assert.equal(await readFile(join(trashPath, 'artifact.jsonl'), 'utf8'), 'log')
})

test('a file whose parent is the member directory becomes a directory move', async () => {
  const root = await scratch()
  const member = join(root, 'sessions', 'member-2')
  await mkdir(member, { recursive: true })
  const artifact = join(member, 'session.jsonl')
  await writeFile(artifact, 'log')

  const source = await resolveSource(artifact, 'member-2')
  assert.deepEqual(source, { path: member, isDirectory: true })
  assert.equal(await resolveSource(join(root, 'nope.jsonl'), 'member-3'), undefined)
})

test('trashMemberSession moves the reported artifact and reports where it went', async () => {
  const root = await scratch()
  const member = join(root, 'sessions', 'member-4')
  await mkdir(member, { recursive: true })
  await writeFile(join(member, 'session.jsonl'), 'log')
  const ctx = {
    get: (name) => (name === 'sessionPersistence'
      ? { stat: async (id) => (id === 'member-4' ? { location: { path: member } } : undefined) }
      : undefined),
  }
  const result = await trashMemberSession(ctx, {
    leadSessionId: 'lead-1',
    memberId: 'member-4',
    dataDir: join(root, 'data'),
    now: 1700000000000,
  })
  assert.equal(result.moved, true)
  assert.equal(result.trashPath, join(root, 'data', 'trash', 'lead-1', 'member-4-1700000000000'))
  assert.equal(result.kind, 'directory')
  assert.equal(result.originalPath, member)
  assert.equal(existsSync(member), false)
})

test('planning a move names the destination before anything moves', async () => {
  // Retirement writes its tombstone before the move, so the path has to be known first and the plan
  // must not touch the filesystem.
  const root = await scratch()
  const member = join(root, 'sessions', 'member-7')
  await mkdir(member, { recursive: true })
  await writeFile(join(member, 'session.jsonl'), 'log')
  const ctx = { get: () => ({ stat: async () => ({ location: { path: member } }) }) }

  const plan = await planMemberTrash(ctx, {
    leadSessionId: 'lead-1',
    memberId: 'member-7',
    dataDir: join(root, 'data'),
    now: 1700000000000,
  })
  assert.equal(plan.planned, true)
  assert.equal(plan.trashPath, join(root, 'data', 'trash', 'lead-1', 'member-7-1700000000000'))
  assert.equal(existsSync(member), true, 'planning moves nothing')
  assert.equal(existsSync(plan.trashPath), false)

  assert.deepEqual(await applyMemberTrash(plan), { moved: true })
  assert.equal(existsSync(member), false)
  assert.equal(await readFile(join(plan.trashPath, 'session.jsonl'), 'utf8'), 'log')
})

test('a plan that cannot name an artifact says why instead of pretending to move one', async () => {
  const noService = await planMemberTrash({ get: () => undefined }, { leadSessionId: 'l', memberId: 'm', dataDir: 'd' })
  assert.deepEqual(noService, { planned: false, reason: 'no-persistence' })
})

test('a trashed directory moves back to the path it came from', async () => {
  const root = await scratch()
  const member = join(root, 'sessions', 'member-5')
  await mkdir(member, { recursive: true })
  await writeFile(join(member, 'session.jsonl'), 'log')
  const ctx = {
    get: () => ({ stat: async () => ({ location: { path: member } }) }),
  }
  const trashed = await trashMemberSession(ctx, { leadSessionId: 'lead-1', memberId: 'member-5', dataDir: join(root, 'data') })
  assert.equal(trashed.moved, true)

  const restored = await restoreSessionArtifact({
    trashPath: trashed.trashPath,
    originalPath: trashed.originalPath,
    kind: trashed.kind,
  })
  assert.deepEqual(restored, { restored: true, path: member })
  assert.equal(await readFile(join(member, 'session.jsonl'), 'utf8'), 'log')
  assert.equal(existsSync(trashed.trashPath), false)
  assert.equal(existsSync(join(root, 'data', 'trash', 'lead-1')), false, 'an emptied lead trash directory is dropped')
})

test('restoring never overwrites an existing destination', async () => {
  const root = await scratch()
  const member = join(root, 'sessions', 'member-6')
  await mkdir(member, { recursive: true })
  await writeFile(join(member, 'session.jsonl'), 'log')
  const ctx = { get: () => ({ stat: async () => ({ location: { path: member } }) }) }
  const trashed = await trashMemberSession(ctx, { leadSessionId: 'lead-1', memberId: 'member-6', dataDir: join(root, 'data') })
  await mkdir(member, { recursive: true })
  await writeFile(join(member, 'other.jsonl'), 'newer')

  const restored = await restoreSessionArtifact({
    trashPath: trashed.trashPath,
    originalPath: trashed.originalPath,
    kind: trashed.kind,
  })
  assert.deepEqual(restored, { restored: false, reason: 'destination-exists' })
  assert.equal(await readFile(join(member, 'other.jsonl'), 'utf8'), 'newer')
})

test('a missing trash entry or unspecified path is reported', async () => {
  const root = await scratch()
  assert.deepEqual(await restoreSessionArtifact({ trashPath: join(root, 'nope'), originalPath: join(root, 'x') }), {
    restored: false,
    reason: 'trash-missing',
  })
  assert.deepEqual(await restoreSessionArtifact({ trashPath: undefined, originalPath: join(root, 'x') }), {
    restored: false,
    reason: 'no-recorded-path',
  })
})

test('the sessions root is derived from a sibling still on disk', async () => {
  const persistence = {
    stat: async (id) => {
      if (id === 'member-a') return { location: { path: '/root/key/member-a/session.jsonl' } }
      throw new Error('missing')
    },
  }
  assert.equal(
    await sessionRootFromSibling(persistence, ['member-a', 'member-b'], 'member-b'),
    '/root/key',
  )
  // The member being restored is never used as its own template.
  assert.equal(await sessionRootFromSibling(persistence, ['member-b'], 'member-b'), undefined)
  assert.equal(await sessionRootFromSibling(undefined, ['member-a'], 'member-b'), undefined)
})

test('a missing persistence service or artifact is reported, never thrown', async () => {
  const noService = await trashMemberSession({ get: () => undefined }, { leadSessionId: 'l', memberId: 'm', dataDir: 'd' })
  assert.deepEqual(noService, { moved: false, reason: 'no-persistence' })

  const noArtifact = await trashMemberSession(
    { get: () => ({ stat: async () => ({ location: {} }) }) },
    { leadSessionId: 'l', memberId: 'm', dataDir: 'd' },
  )
  assert.deepEqual(noArtifact, { moved: false, reason: 'no-artifact' })
})
