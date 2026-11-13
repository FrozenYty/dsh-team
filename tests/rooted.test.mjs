/**
 * Every Session has a root, so the storage domain is never written again.
 *
 * The plugin used to answer `undefined` for a Session whose workspace could not be known, and everything
 * without a root fell through to the storage domain — which is why deleting that domain's file was not
 * stable: the next write from a rootless Session recreated it. Root resolution now ends at the frozen
 * `<home>/.dsh/team-roster`, the directory the plugin already owns and whose `trash/` every artifact chain
 * already treats as a leg. It is a real directory, a real file, and a person can open it — which the
 * storage domain never was. The domain survives only as the last leg of the source order.
 *
 * These tests measure the domain's *calls*, not just the presence of a file: "the domain was not written"
 * is the claim, and a file on disk does not prove it.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PHASE, PROVENANCE_FILE_NAME, ROSTER_FILE_NAME, createRosterSource, readRoster } from '../roster.js'
import { TEAM_DIR, createRootBinder, frozenDataDir, resolveDataDir } from '../trash.js'
import { memoryTable } from './memory-table.mjs'

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

/** A domain fake that records every call, so "not consulted" and "not written" are both checkable. */
function domainWith(records = {}) {
  const rows = new Map(Object.entries(records))
  const writes = []
  const asked = []
  return {
    writes,
    asked,
    get: (key) => {
      asked.push(key)
      return rows.get(key)
    },
    put: async (key, value) => { writes.push(['put', key]); rows.set(key, value) },
    update: async (key, mutate) => { writes.push(['update', key]); const next = mutate(rows.get(key)); rows.set(key, next); return next },
    entries: () => rows.entries(),
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
  const domain = domainWith({})
  const source = createRosterSource({ domainTable: domain, binder: createRootBinder({ env: {}, home }), home })

  assert.equal(resolveDataDir({}, home, undefined), frozen, 'the frozen directory is the last leg of resolution')
  assert.equal(source.bind(LEAD, undefined), frozen, 'and the root every Session gets when its workspace is unknown')
  await source.readyFor(LEAD)
  await source.table.put(LEAD, record())

  assert.equal(existsSync(join(frozen, ROSTER_FILE_NAME)), true, 'the roster is a file a person can open')
  assert.deepEqual(domain.writes, [], 'and the domain was not written')
  assert.deepEqual(domain.asked, [LEAD], 'the source order checks the legacy leg once, finds nothing, and moves on')
  assert.equal(source.report(LEAD).source, 'file')
  assert.equal(source.report(LEAD).path, join(frozen, ROSTER_FILE_NAME), 'the report names the frozen path')
})

test('that file is the record on the next load, so nothing is re-imported', async () => {
  const { home, frozen } = await homeOnly()
  const first = createRosterSource({ domainTable: domainWith({}), binder: createRootBinder({ env: {}, home }), home })
  first.bind(LEAD, undefined)
  await first.readyFor(LEAD)
  await first.table.put(LEAD, record('keeper'))

  // A second process on the same account: same root, and the file it finds is the truth.
  const domain = domainWith({ [LEAD]: record('from-the-domain') })
  const second = createRosterSource({ domainTable: domain, binder: createRootBinder({ env: {}, home }), home })
  second.bind(LEAD, undefined)
  await second.readyFor(LEAD)

  assert.deepEqual(readRoster(second.table, LEAD).members.map((member) => member.name), ['keeper'], 'read from the file, not re-imported')
  assert.deepEqual(domain.asked, [], 'and the domain was not even asked')
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
  const domain = domainWith({})

  const source = createRosterSource({ domainTable: domain, binder: createRootBinder({ env: {}, home }), home, seed: seedPath })
  source.bind(LEAD, undefined)
  await source.readyFor(LEAD)

  assert.deepEqual(readRoster(source.table, LEAD).members.map((member) => member.name), ['carried'], 'the frozen root is seeded like any other new root')
  const provenance = JSON.parse(await readFile(join(frozen, PROVENANCE_FILE_NAME), 'utf8'))
  assert.equal(provenance.source, 'seed')
  assert.equal(provenance.path, seedPath)
  assert.deepEqual(domain.asked, [], 'and the seed meant the domain was never asked')
})

test('the source order still reads a domain that has records, with no seed set', async () => {
  const { home, frozen } = await homeOnly()
  const domain = domainWith({ [LEAD]: record('legacy') })
  const source = createRosterSource({ domainTable: domain, binder: createRootBinder({ env: {}, home }), home })

  source.bind(LEAD, undefined)
  await source.readyFor(LEAD)

  assert.deepEqual(readRoster(source.table, LEAD).members.map((member) => member.name), ['legacy'], 'the legacy leg is demoted, not deleted')
  assert.deepEqual(domain.asked, [LEAD], 'it is read once, for the import')
  assert.deepEqual(domain.writes, [], 'and written never')
  assert.equal(JSON.parse(await readFile(join(frozen, PROVENANCE_FILE_NAME), 'utf8')).source, 'team_roster', 'the provenance names the domain')
})

test('a frozen directory that cannot be created is a reported problem, not a throw', async () => {
  const root = await scratch()
  // `home` is a file, so `<home>/.dsh/team-roster` cannot be created: ENOTDIR, the shape of a read-only or
  // badly mounted account directory.
  const home = join(root, 'home')
  await writeFile(home, 'not a directory\n', 'utf8')
  const domain = domainWith({ [LEAD]: record('legacy') })
  const source = createRosterSource({ domainTable: domain, binder: createRootBinder({ env: {}, home }), home })

  source.bind(LEAD, undefined)
  await source.readyFor(LEAD)

  const report = source.report(LEAD)
  assert.equal(report.source, 'file', 'the root is still resolved and named')
  assert.equal(report.path, join(frozenDataDir(home), ROSTER_FILE_NAME))
  assert.match(report.read_problem, /could not be written/, 'the failure is reported')
  assert.deepEqual(readRoster(source.table, LEAD).members.map((member) => member.name), ['legacy'], 'and the records are still served')
  assert.deepEqual(domain.writes, [], 'the domain did not become the destination just because the file could not be written')
})
