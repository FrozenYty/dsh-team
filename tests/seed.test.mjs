/**
 * `DSH_TEAM_SEED`: the file a new root is seeded from.
 *
 * The storage domain had two roles, and only one of them was obvious. The fallback — a Session with no
 * workspace serving the domain — is the one a reader notices. The other was the seed: a Lead that binds a
 * different workspace got its records refilled from the domain, and without it a new root starts empty,
 * which means no tombstones, which means `ensureAdopted` gives every child of that Lead a fresh live row.
 *
 * These tests are about the second role, in the form the user can see and carry: one file they name, read
 * once per new root, never written. A seed that cannot be used is loud, an existing root is untouched, and
 * nothing here reads the archive or the trash to decide anything.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { listMembers, restoreMember, retireMember } from '../actions.js'
import {
  PHASE,
  PROVENANCE_FILE_NAME,
  ROSTER_FILE_NAME,
  TRASH_STATE,
  createRosterSource,
  readRoster,
} from '../roster.js'
import { TEAM_DIR, createRootBinder } from '../trash.js'
import { memoryTable } from './memory-table.mjs'

const LEAD = 'session-00000000-0000-4000-8000-00000000000a'
const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-seed-'))

/** One live member and one tombstone: what a carried roster looks like. */
const carried = () => ({
  leadSessionId: LEAD,
  members: [
    {
      memberId: 'member-1',
      childId: 'child-1',
      name: 'reviewer',
      label: 'Reviewer',
      generation: 1,
      phase: PHASE.active,
      ephemeral: true,
      startedAt: '2026-11-13T00:00:00.000Z',
    },
    {
      memberId: 'member-2',
      childId: 'child-2',
      name: 'scribe',
      label: 'Scribe',
      generation: 1,
      phase: PHASE.retired,
      retiredAt: '2026-11-13T01:00:00.000Z',
      archived: false,
      trashState: TRASH_STATE.none,
    },
  ],
})

/** A domain fake that counts what was asked of it, so "did not consult the domain" is checkable. */
function domainWith(records = {}) {
  const rows = new Map(Object.entries(records))
  const asked = []
  return {
    asked,
    get: (key) => {
      asked.push(key)
      return rows.get(key)
    },
    put: async (key, value) => { rows.set(key, value) },
    update: async (key, mutate) => { const next = mutate(rows.get(key)); rows.set(key, next); return next },
    entries: () => rows.entries(),
  }
}

/** A context fake carrying what a roster read and a retirement touch. */
function fakeCtx() {
  const lead = { id: LEAD, status: 'idle', session: { id: LEAD, header: {} } }
  const ctx = {
    agentTeams: { listMembers: () => [], tryMembership: () => undefined },
    subagents: {
      listDescendants: async () => [],
      drainChildren: async () => {},
      sendMessage: async () => 'message-1',
      interrupt: () => {},
      startActivation: async (spec) => ({ childId: spec.childId }),
    },
    agents: { get: () => undefined },
    get: () => undefined,
  }
  return { ctx, lead }
}

const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })

/** A workspace to bind to, and a seed file written in the shape the caller asks for. */
async function present({ shape, records = carried(), seed = true } = {}) {
  const root = await scratch()
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const seedPath = join(root, 'carried.json')
  if (seed) {
    const value = shape === 'domain'
      ? { unit: 'storage', global: {}, tables: { rosters: { [LEAD]: records } } }
      : { version: 1, serial: 3, updatedAt: '2026-11-13T00:00:00.000Z', rosters: { [LEAD]: records } }
    await writeFile(seedPath, JSON.stringify(value, null, 2), 'utf8')
  }
  return {
    root,
    workspace,
    home,
    seedPath,
    dataDir: join(workspace, TEAM_DIR),
    rosterFile: join(workspace, TEAM_DIR, ROSTER_FILE_NAME),
    provenanceFile: join(workspace, TEAM_DIR, PROVENANCE_FILE_NAME),
    binder: createRootBinder({ env: {}, home }),
  }
}

test('a new root is seeded from a carried roster file, and the provenance says so', async () => {
  const f = await present({ shape: 'roster' })
  const domain = domainWith({})
  const source = createRosterSource({ domainTable: domain, binder: f.binder, seed: f.seedPath, home: f.home })
  source.bind(LEAD, f.workspace)
  await source.readyFor(LEAD)

  const roster = readRoster(source.table, LEAD)
  assert.deepEqual(roster.members.map((member) => member.name), ['reviewer', 'scribe'], 'the carried records arrived')
  assert.deepEqual(domain.asked, [], 'and the legacy domain was not asked at all')

  const provenance = JSON.parse(await readFile(f.provenanceFile, 'utf8'))
  assert.equal(provenance.source, 'seed', 'the provenance names the seed as the source')
  assert.equal(provenance.path, f.seedPath, 'and the path it was read from')
  assert.equal(provenance.leads[LEAD].members, 2)
  assert.equal(typeof provenance.leads[LEAD].importedAt, 'string')
  assert.equal(existsSync(f.rosterFile), true, 'the workspace now owns its records')
})

test('a storage-domain dump works as a seed too, because that is what some users have', async () => {
  const f = await present({ shape: 'domain' })
  const source = createRosterSource({ domainTable: domainWith({}), binder: f.binder, seed: f.seedPath, home: f.home })
  source.bind(LEAD, f.workspace)
  await source.readyFor(LEAD)

  assert.deepEqual(readRoster(source.table, LEAD).members.map((member) => member.name), ['reviewer', 'scribe'])
  assert.equal(JSON.parse(await readFile(f.provenanceFile, 'utf8')).source, 'seed')
})

test('a root that already has a roster is not touched by a seed', async () => {
  const f = await present({ shape: 'roster' })
  // A roster of its own, naming different members than the seed does.
  await mkdir(f.dataDir, { recursive: true })
  const own = { version: 1, serial: 7, updatedAt: 'x', rosters: { [LEAD]: { leadSessionId: LEAD, members: [{ memberId: 'own-1', childId: 'own-child', name: 'implementer', label: 'Implementer', generation: 1, phase: PHASE.active }] } } }
  await writeFile(f.rosterFile, JSON.stringify(own, null, 2), 'utf8')
  const before = await readFile(f.rosterFile, 'utf8')

  const source = createRosterSource({ domainTable: domainWith({}), binder: f.binder, seed: f.seedPath, home: f.home })
  source.bind(LEAD, f.workspace)
  await source.readyFor(LEAD)

  assert.deepEqual(readRoster(source.table, LEAD).members.map((member) => member.name), ['implementer'], 'the file is the truth')
  assert.equal(await readFile(f.rosterFile, 'utf8'), before, 'and the seed did not rewrite it')
  assert.equal(existsSync(f.provenanceFile), false, 'nothing was imported, so there is no provenance to write')

  // A file that exists but holds only another Lead's record: the rule is about the root, not about this
  // Lead's share of it, so the seed does not apply here either.
  const other = await present({ shape: 'roster' })
  await mkdir(other.dataDir, { recursive: true })
  await writeFile(other.rosterFile, JSON.stringify({ version: 1, serial: 2, updatedAt: 'x', rosters: { 'session-other': { leadSessionId: 'session-other', members: [] } } }, null, 2), 'utf8')
  const second = createRosterSource({ domainTable: domainWith({}), binder: other.binder, seed: other.seedPath, home: other.home })
  second.bind(LEAD, other.workspace)
  await second.readyFor(LEAD)
  assert.deepEqual(readRoster(second.table, LEAD).members, [], 'a root that has a file is established; the seed is for a new one')
  assert.equal(existsSync(other.provenanceFile), false)
})

test('a seed that cannot be used is loud, and does not fall back to the domain', async () => {
  const f = await present({ seed: false })
  const domain = domainWith({ [LEAD]: carried() })
  const source = createRosterSource({ domainTable: domain, binder: f.binder, seed: join(f.root, 'missing.json'), home: f.home })
  source.bind(LEAD, f.workspace)
  await source.readyFor(LEAD)

  const report = source.report(LEAD)
  assert.match(report.read_problem, /does not exist/, 'the problem names the seed')
  assert.deepEqual(readRoster(source.table, LEAD).members, [], 'the root stays empty rather than borrowing records')
  assert.deepEqual(domain.asked, [], 'and the domain — which does hold this Lead — was never asked')
})

test('a seed whose records the loader refuses is a problem rather than a silent skip', async () => {
  const f = await present({ shape: 'roster' })
  await writeFile(f.seedPath, JSON.stringify({ version: 1, serial: 1, rosters: { [LEAD]: { leadSessionId: LEAD, members: 'not an array' } } }), 'utf8')
  const source = createRosterSource({ domainTable: domainWith({}), binder: f.binder, seed: f.seedPath, home: f.home })
  source.bind(LEAD, f.workspace)
  await source.readyFor(LEAD)

  assert.match(source.report(LEAD).read_problem, /holds a record this plugin refuses/)
  assert.deepEqual(readRoster(source.table, LEAD).members, [])
})

test('a Session with no workspace and no records says so, with both ways out', async () => {
  const f = await present({ seed: false })
  // Never bound: the Lead's root cannot be resolved, and the legacy domain holds nothing for it. `storage`
  // is the block the tool wrapper copies out of `report`, which is where the source is decided.
  const source = createRosterSource({ domainTable: domainWith({}), binder: f.binder, home: f.home })
  const { ctx, lead } = fakeCtx()
  const listed = await listMembers({ ctx, table: source.table, leadSessionId: LEAD, leadAgent: lead, dataDir: f.dataDir, hooks: hooks() })
  const storage = source.report(LEAD)

  assert.equal(storage.source, 'none', 'an empty roster is the true answer, not someone else\u2019s records')
  assert.match(storage.message, /working directory/)
  assert.match(storage.message, /DSH_TEAM_DATA_DIR/)
  assert.deepEqual(listed.members, [])

  // The legacy leg still reports itself when it does hold records.
  const legacy = createRosterSource({ domainTable: domainWith({ [LEAD]: carried() }), binder: f.binder, home: f.home })
  const other = fakeCtx()
  const served = await listMembers({ ctx: other.ctx, table: legacy.table, leadSessionId: LEAD, leadAgent: other.lead, dataDir: f.dataDir, hooks: hooks() })
  assert.equal(legacy.report(LEAD).source, 'storage-domain')
  assert.deepEqual(served.members.map((member) => member.target), ['reviewer', 'scribe'])
})

test('a seeded root runs the ordinary lifecycle: the member retires and comes back', async () => {
  const f = await present({ shape: 'roster' })
  const source = createRosterSource({ domainTable: domainWith({}), binder: f.binder, seed: f.seedPath, home: f.home })
  source.bind(LEAD, f.workspace)
  await source.readyFor(LEAD)
  const { ctx, lead } = fakeCtx()

  const retired = await retireMember({
    ctx,
    table: source.table,
    leadSessionId: LEAD,
    leadAgent: lead,
    dataDir: f.dataDir,
    hooks: hooks(),
    target: 'reviewer',
  })
  assert.equal(retired.retired, true, 'a record that came from the seed retires like any other')
  assert.equal(readRoster(source.table, LEAD).members.find((member) => member.name === 'reviewer').phase, PHASE.retired)

  const restored = await restoreMember({
    ctx,
    table: source.table,
    leadSessionId: LEAD,
    target: 'reviewer',
    hooks: hooks(),
    dataDir: f.dataDir,
  })
  assert.equal(restored.restored, true)
  assert.equal(restored.reason, 'not-archived', 'a retirement that moved nothing comes back without the workspace')
  assert.equal(readRoster(source.table, LEAD).members.find((member) => member.name === 'reviewer').phase, PHASE.active)
})
