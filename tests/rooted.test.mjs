/**
 * Every Session has a root, so no host storage domain is written, read or opened at all.
 *
 * The plugin used to answer `undefined` for a Session whose workspace could not be known, and everything
 * without a root fell through to the storage domain — which is why deleting that domain's file was not
 * stable: the next write from a rootless Session recreated it. Root resolution now ends at the frozen
 * `<home>/.dsh/team-roster`, the directory the plugin already owns and whose `trash/` every artifact chain
 * already treats as a leg. It is a real directory, a real file, and a person can open it — which the
 * storage domain never was.
 *
 * With a root always resolved the domain has no job left, so it is gone from the bundle entirely: the
 * source order is a seed, then nothing, and a root that cannot be created is a reported problem rather
 * than a fallback. A profile whose records lived only in a domain file points `DSH_TEAM_SEED` at it, which
 * accepts that shape (see `tests/seed.test.mjs` and `tests/store.test.mjs`).
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { spawnMember, retireMember } from '../actions.js'
import { PHASE, PROVENANCE_FILE_NAME, ROSTER_FILE_NAME, createRosterSource, readRoster } from '../roster.js'
import { TEAM_DIR, createRootBinder, frozenDataDir, resolveDataDir } from '../trash.js'

const LEAD = 'session-00000000-0000-4000-8000-00000000000b'
const scratch = () => mkdtemp(join(tmpdir(), 'dsh-team-rooted-'))

const record = (name = 'reviewer') => ({
  leadSessionId: LEAD,
  members: [{
    memberId: `member-${name}`,
    childId: `child-${name}`,
    name,
    label: 'Reviewer',
    generation: 1,
    phase: PHASE.active,
    ephemeral: true,
    startedAt: '2026-11-13T00:00:00.000Z',
  }],
})

/** The host-side effects a retirement refreshes, and the child a spawn starts. */
const hooks = () => ({ filter: { invalidate() {} }, slots: { refresh: async () => {} } })
function fakeCtx() {
  const lead = { id: LEAD, status: 'idle', session: { id: LEAD, header: {} } }
  return {
    agentTeams: { listMembers: () => [], tryMembership: () => undefined },
    subagents: {
      listDescendants: async () => [],
      startActivation: async (spec) => ({ childId: spec.childId }),
      drainChildren: async () => {},
    },
    agents: { get: () => undefined },
    get: () => undefined,
    lead,
  }
}

/** A home directory, and the paths a Session with no workspace resolves to under it. */
async function homeOnly() {
  const root = await scratch()
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return { root, home, frozen: frozenDataDir(home) }
}

test('a Session with no workspace and no override writes its roster into the frozen directory', async () => {
  const { home, frozen } = await homeOnly()
  const source = createRosterSource({ binder: createRootBinder({ env: {}, home }), home })

  assert.equal(resolveDataDir({}, home, undefined), frozen, 'the frozen directory is the last leg of resolution')
  assert.equal(source.bind(LEAD, undefined), frozen, 'and the root every Session gets when its workspace is unknown')
  await source.readyFor(LEAD)
  await source.table.put(LEAD, record())

  assert.equal(existsSync(join(frozen, ROSTER_FILE_NAME)), true, 'the roster is a file a person can open')
  assert.equal(source.report(LEAD).source, 'file')
  assert.equal(source.report(LEAD).path, join(frozen, ROSTER_FILE_NAME), 'the report names the frozen path')
})

test('a root with no seed starts empty and stays usable: a spawn and a retirement work', async () => {
  const { home, frozen } = await homeOnly()
  const source = createRosterSource({ binder: createRootBinder({ env: {}, home }), home })
  const ctx = fakeCtx()
  const call = (extra = {}) => ({
    ctx,
    table: source.table,
    leadSessionId: LEAD,
    leadAgent: ctx.lead,
    dataDir: frozen,
    hooks: hooks(),
    ...extra,
  })
  source.bind(LEAD, undefined)
  await source.readyFor(LEAD)

  assert.deepEqual(readRoster(source.table, LEAD).members, [], 'no seed, no domain: the root starts empty')

  const born = await spawnMember(call({ name: 'reviewer', label: 'Reviewer', prompt: 'Start.' }))
  assert.equal(born.phase, PHASE.active, 'a spawn works on an empty root')
  const retired = await retireMember(call({ target: 'reviewer' }))
  assert.equal(retired.retired, true, 'and so does a retirement')
  assert.equal(readRoster(source.table, LEAD).members[0].phase, PHASE.retired)
  assert.equal(existsSync(join(frozen, ROSTER_FILE_NAME)), true, 'the file was written the first time anything was')
})

test('a root that already has a file is the truth, and a seed does not touch it', async () => {
  const { root, home, frozen } = await homeOnly()
  const first = createRosterSource({ binder: createRootBinder({ env: {}, home }), home })
  first.bind(LEAD, undefined)
  await first.readyFor(LEAD)
  await first.table.put(LEAD, record('keeper'))

  // A second process on the same account, with a seed naming a different member: the file it finds wins.
  const seedPath = join(root, 'carried.json')
  await writeFile(seedPath, JSON.stringify({ version: 1, serial: 1, rosters: { [LEAD]: record('carried') } }, null, 2), 'utf8')
  const second = createRosterSource({ binder: createRootBinder({ env: {}, home }), home, seed: seedPath })
  second.bind(LEAD, undefined)
  await second.readyFor(LEAD)

  assert.deepEqual(readRoster(second.table, LEAD).members.map((member) => member.name), ['keeper'], 'read from the file, never re-seeded')
  assert.equal(second.report(LEAD).imported_at, undefined, 'nothing was imported')
  assert.equal(existsSync(join(frozen, PROVENANCE_FILE_NAME)), false, 'so no provenance was written')
  assert.equal(JSON.parse(await readFile(join(frozen, ROSTER_FILE_NAME), 'utf8')).rosters[LEAD].members[0].name, 'keeper')
})

test('a workspace still wins, and the override wins over both', async () => {
  const { root, home, frozen } = await homeOnly()
  const workspace = join(root, 'workspace')
  const override = join(root, 'override')

  const binder = createRootBinder({ env: {}, home })
  assert.equal(binder.bind('lead-workspace', workspace), join(workspace, TEAM_DIR), 'a working directory is still the workspace root')

  const configured = createRootBinder({ env: { DSH_TEAM_DATA_DIR: override }, home })
  assert.equal(configured.bind('lead-override', workspace), override, 'an override beats the workspace')
  assert.equal(configured.bind('lead-override-bare', undefined), override, 'and beats the frozen directory too, with no workspace at all')
  assert.notEqual(configured.bind('lead-override-bare', undefined), frozen)

  const frozenOnly = createRootBinder({ env: {}, home })
  assert.equal(frozenOnly.bind('lead-frozen', undefined), frozen)
})

test('the seed still applies to the frozen root, and the provenance records it', async () => {
  const { root, home, frozen } = await homeOnly()
  const seedPath = join(root, 'carried.json')
  await writeFile(seedPath, JSON.stringify({ version: 1, serial: 1, rosters: { [LEAD]: record('carried') } }, null, 2), 'utf8')

  const source = createRosterSource({ binder: createRootBinder({ env: {}, home }), home, seed: seedPath })
  source.bind(LEAD, undefined)
  await source.readyFor(LEAD)

  assert.deepEqual(readRoster(source.table, LEAD).members.map((member) => member.name), ['carried'], 'the frozen root is seeded like any other new root')
  const provenance = JSON.parse(await readFile(join(frozen, PROVENANCE_FILE_NAME), 'utf8'))
  assert.equal(provenance.source, 'seed')
  assert.equal(provenance.path, seedPath)
})

test('a frozen directory that cannot be created is a reported problem, not a throw', async () => {
  const root = await scratch()
  // `home` is a file, so `<home>/.dsh/team-roster` cannot be created: ENOTDIR, the shape of a read-only or
  // badly mounted account directory. The seed still has records to serve, so what is tested is that the
  // failure to keep them is reported rather than thrown, and that the root is not abandoned for it.
  const home = join(root, 'home')
  await writeFile(home, 'not a directory\n', 'utf8')
  const seedPath = join(root, 'carried.json')
  await writeFile(seedPath, JSON.stringify({ version: 1, serial: 1, rosters: { [LEAD]: record('carried') } }, null, 2), 'utf8')
  const source = createRosterSource({ binder: createRootBinder({ env: {}, home }), home, seed: seedPath })

  source.bind(LEAD, undefined)
  await source.readyFor(LEAD)

  const report = source.report(LEAD)
  assert.equal(report.source, 'file', 'the root is still resolved and named')
  assert.equal(report.path, join(frozenDataDir(home), ROSTER_FILE_NAME))
  assert.match(report.read_problem, /could not be written/, 'the failure is reported')
  assert.deepEqual(readRoster(source.table, LEAD).members.map((member) => member.name), ['carried'], 'and the records are still served')
})
