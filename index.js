/**
 * dsh-team — a team roster whose members can be retired, removed and replaced.
 *
 * Host half. It owns the roster (`roster.js`), exposes it as Lead-scoped tools, compacts one member's
 * context in place, and applies host-side effects around retirement (`host-hooks.js`): retired members
 * are stripped from the session-list projections every client renders, this plugin's live members are
 * added to the built-in team panel at that same exit, and their budget is credited back to the shipped
 * roster. The member's persisted session is moved to a recoverable trash directory
 * (`trash.js`) rather than deleted. The bundle patch disables the shipped team tool row, whose tools
 * this plugin replaces; the roster *service* stays mounted so this plugin can adopt the members it
 * created and keep using its Lead membership test.
 *
 * Tools: `spawn_member`, `list_members`, `wait_members`, `message_member`, `stop_member`,
 * `retire_member`, `restore_member`, `compact_member`, `handoff_template` and `task_board` for the Lead;
 * `list_my_tasks` for a member. The operation bodies live in `actions.js`; this file keeps argument
 * validation, the Lead-or-member authority check, and the tool result schemas, and nothing else. The
 * plugin has no browser half: it is entirely model-facing (ADR 0008).
 *
 * The two scopes are deliberate (ADR 0022). Every roster and board write is Lead-scoped, because the
 * board has exactly one writer: a member reports that a task is finished and the Lead closes the row. The
 * one member-scoped tool is read-only — it returns the rows whose `owner` is that member's own target,
 * which is what lets a successor read the work it inherited from the board instead of from the plugin's
 * private storage file. A member never sees another member's rows, an unowned row, or the Lead's board.
 *
 * `spawn_member` with `replace` is the whole replacement: it starts the successor from a short handoff
 * brief composed from the assignment recorded on the predecessor's record, then retires the
 * predecessor in the same call (ADR 0009). The work itself is a task on this Lead's own board
 * (`task_board`, ADR 0017): the retirement half re-addresses the predecessor's open tasks to the
 * successor in the same write, and the brief names them by id and title. A Lead that replaces members
 * repeatedly can fix the brief's shape once with `handoff_template` (ADR 0015); the built-in shape is
 * what a Lead that never stores one gets. The shipped team *tool* row is disabled by the bundle patch
 * (P2-07), so the spawn, wait and task tools it published are gone; its *service* row stays mounted for
 * adoption and the projection filter, and that service is model-facing itself, so `list_agents`,
 * `send_message` and `interrupt_agent` remain in a Lead's tool list beside these tools. `wait_members`
 * restores the blocking wait the disabled row took with it: it observes the Harness's own `agent/status`
 * for the child Sessions on this Lead's roster, which the shipped service's `waitForChange` cannot see
 * (a member spawned through `ctx.subagents` is not in that service's journal).
 *
 * A member's *definition* can live on disk instead of in the call: `spawn_member.definition` reads the
 * flat-frontmatter markdown files found through a chain — `.agents/team/definitions/` in the workspace,
 * then `team/`, then the five templates this bundle ships — and every field the call also passes wins
 * over the file's, which the result reports field by field (`definitions.js`, ADR 0018). One field has a
 * third source: on a `replace` the predecessor's recorded assignment
 * outranks the file's, so a successor is briefed with the work rather than the role's standing sentence
 * (ADR 0009, ADR 0019). The *team* scope has a file too: `team/team.md`, whose body is the handoff
 * template. It wins over the template stored with `handoff_template` and over the built-in shape, the
 * read form reports which source is in effect, and a store or clear is refused while the file exists
 * (ADR 0021). The plugin reads those files and never writes one — version control and an editor are the
 * better tool — and the roster stays runtime state.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM THE HARNESS
 * A profile-installed bundle is linked from its workspace directory, so a bare import such as
 * `@deepseek-ai/dsh-tools` resolves from the bundle path and fails with ERR_MODULE_NOT_FOUND. Shipped
 * packages resolve only from inside the dsh installation, and the installed first-party market plugin
 * likewise imports no dsh package. Tool definitions are therefore built as plain canonical JSON Schema
 * objects, which is exactly the `ToolDefinition` shape the registry consumes (`ctx.tools.register`
 * checks `output.schema` + `output.render` and projects `parameters` straight to the model).
 *
 * The plugin writes no session events. Its durable state is the plugin's own `roster.json` under the
 * workspace root the Lead bound (`docs/roster-storage-en.md` §4); the `team_roster` storage domain is the
 * one-time import source and the rollback path, not the record (ADR 0003, superseded by ADR 0027).
 *
 * CONFIGURATION
 * The one tunable is the per-Lead session-trash cap, carried by the `trashLimit` field of this bundle's
 * patch row (`- id: team-roster`, `config: { trashLimit: <integer> }`). That row id is frozen at
 * `team-roster` while the package is `dsh-team`: it is the override target a profile writes, so
 * renaming it would silently stop an existing profile's cap from matching (ADR 0014). `apply` resolves it
 * with `resolveTrashLimit` before it registers anything, so an out-of-range value fails the load instead
 * of the first retirement; an absent value takes the documented `DEFAULT_TRASH_LIMIT` (20), which is what
 * keeps a profile that configures nothing behaving exactly as it did before (ADR 0012).
 */

import {
  ensureAdopted,
  handoffTemplate,
  listMembers,
  listMyTasks,
  messageMember,
  pressureOf,
  retireMember,
  restoreMember,
  spawnMember,
  stopMember,
  taskBoard,
  WAIT_TIMEOUT_DEFAULT,
  WAIT_TIMEOUT_MAX,
  waitMembers,
} from './actions.js'
import { createRetiredCache, installProjectionFilter, installRosterFilter, installSlotCredit } from './host-hooks.js'
import { DEFINITION_REFUSAL_REASONS } from './definitions.js'
import {
  ASSIGNMENT_MAX,
  HANDOFF_TEMPLATE_MAX,
  PHASE,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
  findByTarget,
  openRosterStore,
  readRoster,
  targetOf,
} from './roster.js'
import { createRootBinder, resolveDataDir, resolveTrashLimit } from './trash.js'

export const name = 'dsh-team'

export const inject = ['agents', 'agentTeams', 'tools', 'tokenMeter', 'storageDomain', 'subagents']

/** The stand-in for a hook that is not installed: calls the same shape, does nothing. */
const NOOP = () => {}

/** Build a registry-ready definition from canonical JSON Schemas. */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output.schema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: options.execute,
  }
}

/** Recover the exact caller that Agent-scoped tool discovery supplies. */
function callingAgent(agent, toolName) {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/**
 * Whether one agent is the root of its own Session tree.
 *
 * The shipped Team service answers `lead` for exactly this shape, but `tryMembership` returns
 * `undefined` both for a subagent it does not own and when its own projection cannot be read: it
 * swallows that failure. The parent Session is the discriminator — a spawned child always names its
 * parent, so an agent that names none and is still live in the Agent registry is a root. This is the
 * same test the shipped roster's own `liveChildrenByRoot` uses to find roots.
 */
function isRootAgent(ctx, agent) {
  return ctx.agents.get(agent.id) === agent && agent.session?.header?.parentSession === undefined
}

/**
 * Refuse every caller that is not the Lead of its own Team.
 *
 * A roster whose Team projection is in its documented permanent-failure state must still be usable:
 * otherwise `maybeInstall` never installs the tools and `requireLead` refuses every call — including
 * the retirement that exists to repair that team — behind "available to the Team Lead only". So when
 * membership cannot be read, a live root agent is accepted as the Lead.
 */
function requireLead(ctx, caller, toolName) {
  const membership = ctx.agentTeams.tryMembership(caller)
  if (membership !== undefined) {
    if (membership.role !== 'lead') throw new Error(`${toolName} is available to the Team Lead only`)
    return
  }
  if (!isRootAgent(ctx, caller)) throw new Error(`${toolName} is available to the Team Lead only`)
}

/**
 * Resolve the roster row that names this caller's Session, or undefined.
 *
 * The member scope is keyed by the Session id, not by a model-supplied target: a caller cannot ask for
 * someone else's work by naming it, and there is no second addressing mode to keep honest. The search is
 * across every Team because the roster table is keyed by Lead Session id while a member knows only its own
 * Session. It is a read: no adoption runs here, so a child the roster has never seen is refused instead of
 * being silently written into a Lead's record by a read (ADR 0022).
 * @param table - roster table.
 * @param caller - the calling Agent.
 * @returns {{roster: object, member: object}|undefined} the scope, or undefined.
 */
function memberScopeOf(table, caller) {
  const sessionId = String(caller.session.id)
  for (const [, roster] of table.entries()) {
    const member = roster.members.find((candidate) => candidate.childId === sessionId)
    if (member !== undefined) return { roster, member }
  }
  return undefined
}

/**
 * Refuse every caller that is not a member this board can place.
 *
 * A member owning no task is not refused — it gets an empty list — so this guard is about identity, not
 * about work. The Lead is named in the refusal because the two scopes are different tools, not two
 * permissions on one tool: the Lead reads the whole board with `task_board`, and an unknown child is
 * adopted the next time the Lead reads its roster (ADR 0022).
 * @param table - roster table.
 * @param caller - the calling Agent.
 * @param toolName - the tool whose authority is being checked.
 * @returns {{roster: object, member: object}} the caller's scope.
 */
function requireMember(table, caller, toolName) {
  const scope = memberScopeOf(table, caller)
  if (scope !== undefined) return scope
  throw new Error(
    `${toolName} is available to a Team member only. The Lead reads the whole board with task_board; a child this roster has not adopted appears after the Lead calls list_members or spawn_member.`,
  )
}

const COMPACT_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'compacted'],
  properties: {
    target: { type: 'string' },
    compacted: { type: 'boolean' },
    reason: { type: 'string', enum: ['done', 'nothing-to-compact', 'busy', 'not-resident', 'failed'] },
    shadowed_tokens: { type: 'integer' },
    before_tokens: { type: 'integer' },
    after_tokens: { type: 'integer' },
    message: { type: 'string' },
  },
}

/**
 * The `spawn_member.spawn_options.agent_options` value, used both as a parameter and as the report.
 *
 * This object reaches the host twice, and the second time is stricter: a result schema may only use
 * `type`, `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const` and
 * annotations. A validation keyword here — `minimum` was the first one — is rejected while the plugin
 * loads, which does not fail this tool: it stops every tool in the plugin from registering. Keep the
 * range in the description instead; `scripts/check.mjs` rejects a keyword outside that subset.
 *
 * Two narrower rules, both verified against the installed validator rather than assumed: a node cannot
 * declare `type` and `oneOf` together, and a result schema **may** be a root `oneOf` — the
 * object-root requirement applies to subagent and workflow structured outputs, not to a tool result,
 * which is why `spawn_member` ships one (`lib/types/json-schema.js:340-348`).
 */
const AGENT_OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', description: 'Provider id for the member\'s model requests. Omit to inherit the Lead\'s provider.' },
    model: { type: 'string', description: 'Model id for the member\'s model requests: the place a cheaper or larger model is chosen for delegated work. Omit to inherit the Lead\'s model.' },
    reasoning_effort: { type: 'string', description: 'Reasoning effort for the member\'s requests, where the model exposes one. Omit to inherit the Lead\'s effort, or let a changed provider or model resolve its own default.' },
    max_tokens: { type: 'integer', description: 'Output-token limit for the member\'s requests, a positive integer. Omit to inherit the Lead\'s limit.' },
  },
}

/** The live holder of a stale target's name, reported beside a refusal (ADR 0016). */
const CURRENT_HOLDER = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'generation'],
  properties: {
    target: { type: 'string' },
    generation: { type: 'integer' },
  },
}

/**
 * The route one member started on: the provider and model pair the child actually runs on, and where the
 * plugin got it.
 *
 * `source` is the field that keeps the two paths apart. `caller` means the spawn call named the route (or
 * a member definition did), `plugin` means the caller named a route but not these two fields and the
 * plugin completed them from the Lead's current route, and `inherited` means the plugin forwarded nothing
 * and the Harness resolved the route on its own — which is also the fallback whenever the route could not
 * be read or the provider cannot apply one. `select_reason` is present only on `inherited` and names which
 * of those two fallbacks ran, because "the Session had no route to read" and "the provider cannot apply
 * one" are different facts about a spawn and only one of them is worth investigating (ADR 0024).
 */
const ROUTE = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string', enum: ['caller', 'plugin', 'inherited'] },
    provider: { type: 'string' },
    model: { type: 'string' },
    select_reason: { type: 'string', enum: ['no-session-route', 'capability-absent'] },
  },
}

/**
 * One file the definition scan could not use, named by path and — when the problem is a line of that
 * file — by line. A row here never stops a spawn that names a definition the same scan did read, which
 * is why it is reported in a result rather than thrown (ADR 0018).
 */
const DEFINITION_PROBLEM = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'problem'],
  properties: {
    path: { type: 'string' },
    line: { type: 'integer' },
    problem: { type: 'string' },
  },
}

/**
 * What a spawn that used a member definition reports about it: which file, where each field came from,
 * and what the call overrode.
 *
 * This is the field that makes the precedence visible. A model that believes it overrode a definition's
 * model and did not is the failure this exists to prevent, so `from_file` and `overridden` name the
 * fields explicitly instead of leaving the caller to infer the merge from the result of a start.
 */
const DEFINITION_REPORT = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'path', 'prompt', 'from_file', 'overridden'],
  properties: {
    // The name the file declares, which is also the key that was looked up.
    name: { type: 'string' },
    path: { type: 'string' },
    // 'file' when the member starts on the definition's body alone, 'file+call' when this call's prompt
    // was appended to it. The body is never replaced, so there is no third value.
    prompt: { type: 'string', enum: ['file', 'file+call'] },
    // Which assignment the member starts with, and where it came from: the call's, the predecessor's
    // recorded one on a replace, or the file's standing sentence. Present only when one applies, so a
    // spawn that resolves no assignment has no winner to name. This is the field that makes the
    // replacement rule visible instead of an inference (ADR 0019).
    assignment: { type: 'string', enum: ['call', 'predecessor', 'file'] },
    from_file: { type: 'array', items: { type: 'string' } },
    overridden: { type: 'array', items: { type: 'string' } },
    // Present only when the same scan refused another file: a broken definition beside a usable one.
    problems: { type: 'array', items: DEFINITION_PROBLEM },
  },
}

/**
 * The answer to a spawn that named a definition this plugin could not use.
 *
 * It is a second branch of `spawn_member`'s result rather than a thrown error, because the model can act
 * on it — spell the name differently, fix the file, or pass label and prompt instead — and because the
 * alternative, a host error, is where this plugin's other refusals deliberately do not put that
 * instruction (ADR 0016). Nothing has been reserved when it is returned: no member record is written and
 * no child exists, so a retry after fixing the file reuses the same name.
 */
const DEFINITION_REFUSAL = {
  type: 'object',
  additionalProperties: false,
  required: ['started', 'reason', 'message'],
  properties: {
    started: { type: 'boolean', enum: [false] },
    reason: { type: 'string', enum: DEFINITION_REFUSAL_REASONS },
    // The name as the caller wrote it, absent only when the working directory itself could not be read.
    definition: { type: 'string' },
    // The `team` directory that was read, or the file that was refused.
    path: { type: 'string' },
    // The names the same scan could use, so a misspelling is correctable from this answer alone. It is
    // called `available` and not `definitions` because the repository check reads a bare `definitions:` as
    // the JSON Schema keyword; the id list mirrors the preset refusal's own `details.available`.
    available: { type: 'array', items: { type: 'string' } },
    // Every file the scan refused, by path and line.
    problems: { type: 'array', items: DEFINITION_PROBLEM },
    message: { type: 'string' },
  },
}

const MEMBER_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'child_id', 'phase', 'generation', 'label', 'status', 'resident', 'lifetime'],
  properties: {
    target: { type: 'string' },
    child_id: { type: 'string' },
    phase: { type: 'string', enum: ['provisioning', 'active', 'retired', 'failed'] },
    generation: { type: 'integer' },
    label: { type: 'string' },
    status: { type: 'string', enum: ['running', 'idle', 'unloaded'] },
    resident: { type: 'boolean' },
    assignment: { type: 'string' },
    pressure_tokens: { type: 'integer' },
    context_window: { type: 'integer' },
    usage_ratio: { type: 'number' },
    compactable: { type: 'boolean' },
    note: { type: 'string' },
    replaced: { type: 'string' },
    predecessor_retired: { type: 'boolean' },
    // The lifetime the spawn call declared: `standing` (a role, never retired automatically, and a
    // judgement call the person answers) or `one-shot` (created for one piece of work, retired by the
    // lazy sweep once it has run, stopped and owns nothing). Every row carries it, because "may this
    // member retire itself?" must be answerable from the read that shows the member (ADR 0026).
    lifetime: { type: 'string', enum: ['standing', 'one-shot'] },
    // The record's own field, reported beside `lifetime`: every stored record already carries it and
    // ADR 0013 named it. A message no longer clears it (ADR 0026).
    ephemeral: { type: 'boolean' },
    // Advice, never a conversion: a one-shot member handed work again and again is evidence of a standing
    // role, and only the Lead declares the new lifetime, at the next spawn (ADR 0026).
    retasked: { type: 'boolean' },
    retasked_note: { type: 'string' },
    // The route this member was started on, and where that route came from (ADR 0024). Absent only on a
    // record written before v0.22.0 or on one whose resolution produced nothing to record, which is a
    // member the plugin inherited the route for without ever knowing it.
    route: ROUTE,
    // Present only on a `list_members` row whose recorded route is not the one this Lead is on now: the
    // member is still being woken on the API it started on, which is what the owner's bill is made of.
    // The flag is the answer to "which of my members is still billing the old API"; the sentence names
    // the one call that fixes it.
    route_stale: { type: 'boolean' },
    route_note: { type: 'string' },
    // Present on a result whose sweep retired finished one-shot members; absent otherwise.
    swept: { type: 'integer' },
    swept_targets: { type: 'array', items: { type: 'string' } },
    // Present when the sweep wanted to retire a one-shot member that still owns open work: the board is a
    // veto, so the member stayed and the rows that stopped it are named, with the one call that clears
    // each (ADR 0026). `blocked` counts members, `blocking_tasks` lists the row ids.
    blocked: { type: 'integer' },
    blocking_tasks: { type: 'array', items: { type: 'string' } },
    blocking_note: { type: 'string' },
    // What a `replace` did to the predecessor's open tasks, and what a spawn-time sweep left unowned.
    // They are declared here because `spawn_member` answers with this row: a property the operation
    // returns but this schema does not declare is rejected by the host when the tool returns, which
    // loses the result after the side effect already happened (v0.13.0 did exactly that with
    // `transferred`). `tests/entry.test.mjs` now validates a real result against this schema.
    transferred: { type: 'integer' },
    transferred_tasks: { type: 'array', items: { type: 'string' } },
    unowned: { type: 'integer' },
    unowned_tasks: { type: 'array', items: { type: 'string' } },
    // A spawn the Harness refused: no child exists, the record is `failed`, and `reason` says what the
    // model can do about it. Absent on a start that happened.
    started: { type: 'boolean' },
    reason: {
      type: 'string',
      enum: ['unsupported-capability', 'preset-unavailable', 'preset-not-found', 'preset-invalid', 'unauthorized'],
    },
    // What the member was started with: only the `spawn_options` fields the caller supplied, so an
    // applied model is never invisible (ADR 0016), plus `route_source` — `caller`, `plugin` or
    // `inherited` — which says whether the route on this result came from the call or was resolved and
    // forwarded by the plugin (ADR 0024). It is present on every spawn, including one that forwarded
    // nothing, because that is the fact a roll-out has to be able to read back.
    started_with: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        agent_options: AGENT_OPTIONS_SCHEMA,
        agent_preset: { type: 'string' },
        route_source: { type: 'string', enum: ['caller', 'plugin', 'inherited'] },
      },
    },
    // Present only on a spawn that named a member definition: which parts came from the file and which
    // the call overrode (ADR 0018).
    definition: DEFINITION_REPORT,
    message: { type: 'string' },
  },
}

/**
 * One task on this Lead's board, as every `task_board` action that returns a row reports it.
 *
 * `body` is the task's own statement of what "done" means and where the predecessor stopped, present only
 * on a row that has one; the handover brief deliberately carries the id and title only, so the successor
 * reads the bodies from here — with `list_my_tasks` as a member, or `task_board` as the Lead (ADR 0020,
 * ADR 0022).
 *
 * `problem` is present only on a stored task whose content no longer passes the read rules — a title or a
 * body over the cap, or one that is not a non-empty string. The row is still served, because the storage
 * facility validates every record when the domain opens and a content rule enforced there would hide every
 * roster (ADR 0017).
 */
const TASK_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'status'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    // The task's own text: acceptance criteria and the point the predecessor stopped at. Bounded and
    // refused past the cap, never truncated; `update` with `body: null` clears it (ADR 0020).
    body: { type: 'string' },
    status: { type: 'string', enum: ['open', 'done'] },
    // The member target that owns this task. Moving a task's owner is how a handover is represented, and
    // the field is absent when nobody owns the task.
    owner: { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    problem: { type: 'string' },
  },
}

/**
 * What one member reads about the work it owns.
 *
 * The row is `TASK_ROW`, the same shape `task_board` `list` serves, because the member is looking at the
 * same rows and a second row vocabulary would let the two answers drift. `target` is the member's own
 * handle, so it can correlate the rows with the brief; `open` counts the rows still owed. When the member
 * owns nothing, `tasks` is empty and the message says so — no error, because owning no work is a state a
 * member is allowed to be in. The property names are declared here because the host rejects an undeclared
 * field after the tool has already returned (ADR 0022).
 */
const MY_TASKS_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'tasks', 'open'],
  properties: {
    target: { type: 'string' },
    tasks: { type: 'array', items: TASK_ROW },
    open: { type: 'integer' },
    message: { type: 'string' },
  },
}

/**
 * Every shape this one tool answers with.
 *
 * The tool carries five actions, and the host validates a result against this object, so the schema is
 * the union of the answers rather than a branch per action: the five actions differ in which fields are
 * present, not in what a field means, so one object with the union of the fields says the same thing as
 * five `oneOf` branches and is easier to keep honest. `additionalProperties: false` still holds, so an
 * action cannot quietly start returning a field this object does not name — which is the fault this shape
 * exists to catch.
 */
const TASK_BOARD_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['list', 'create', 'update', 'release', 'delete'] },
    // The board, on `list`: every task with its id, title, status, owner and timestamps.
    tasks: { type: 'array', items: TASK_ROW },
    // How many tasks are open after the call.
    open: { type: 'integer' },
    // How many of those open tasks nobody owns, and which — reported by `list` so orphaned work is
    // visible without a retirement result to read (P2-09, ADR 0017).
    unowned: { type: 'integer' },
    unowned_tasks: { type: 'array', items: { type: 'string' } },
    // The task after a write: present on create and update, and on release. A delete that found the row
    // changed since it read it reports the row it kept instead of a deletion (ADR 0020).
    task: TASK_ROW,
    // True when the board was written. False when the same status, owner and body were already recorded,
    // or when release/delete found the row no longer in the state the call read — so a repeat write and a
    // write overtaken by a handover are both visible as one.
    changed: { type: 'boolean' },
    // Present only on delete: the id that was removed.
    deleted: { type: 'string' },
    message: { type: 'string' },
  },
}

const TASK_LIST_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'open'],
  properties: {
    tasks: { type: 'array', items: TASK_ROW },
    open: { type: 'integer' },
    message: { type: 'string' },
  },
}

/**
 * What the host hooks did, reported by `list_members`.
 *
 * A hook that never installs is a silent no-op, and that is what hid a release: the shipped panel kept
 * a retired row, `list_agents` kept it too, and the model could see only an empty panel with no reason
 * given. The block names each hook as `installed` or `absent`, and, while any of them is stripping,
 * counts the tombstoned ids it is removing and says whether the last tombstone read failed (ADR 0025).
 */
const HOST_HOOKS_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['panel_filter', 'roster_filter', 'slot_credit'],
  properties: {
    // The host session-list filter: the shipped team panel and the subagent picker.
    panel_filter: { type: 'string', enum: ['installed', 'absent'] },
    // The shipped roster read: the `list_agents` tool.
    roster_filter: { type: 'string', enum: ['installed', 'absent'] },
    // The shipped member budget credit.
    slot_credit: { type: 'string', enum: ['installed', 'absent'] },
    // How many tombstoned child ids those filters are removing right now; only while one is installed.
    stripped_ids: { type: 'integer' },
    // True when the last tombstone read failed and the last good set is being used; only while installed.
    tombstone_read_failed: { type: 'boolean' },
    // Present when a hook is absent or a read failed: which one, and what it means for the two lists.
    message: { type: 'string' },
  },
}

/**
 * Where this Lead's roster lives, and what a reader has to know about it.
 *
 * `file` is this plugin's own `roster.json` under the Lead's bound root — a workspace root, an override, or
 * the frozen `<home>/.dsh/team-roster` for a Session with no workspace; every Session has one, and the
 * report names which. `none` is a Lead this process never bound, which is a read that arrived before the
 * binding rather than a state a person can reach. `foreign_write_at` is a writer this process did not
 * expect: the workspace is expected to have exactly one, and a second one is reported rather than locked
 * out.
 */
const STORAGE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string', enum: ['file', 'none'] },
    path: { type: 'string' },
    imported_at: { type: 'string' },
    foreign_write_at: { type: 'string' },
    read_problem: { type: 'string' },
    message: { type: 'string' },
  },
}

const MEMBER_LIST_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['members', 'host_hooks'],
  properties: {
    members: { type: 'array', items: MEMBER_ROW },
    host_hooks: HOST_HOOKS_VALUE,
    storage: STORAGE_VALUE,
    // How many tombstones this Lead has that are no longer in the roster, and where they went: past the
    // trash retention window the artifact is gone, so the record moves to an append-only archive and only
    // the newest `trashLimit` stay here. `archive_file` is present only when the count is not zero.
    archived_records: { type: 'integer' },
    archive_file: { type: 'string' },
    swept: { type: 'integer' },
    swept_targets: { type: 'array', items: { type: 'string' } },
    // On a result whose sweep retired a member that owned open work: how many tasks lost their owner, and
    // which (P2-09, ADR 0017). Both absent when nothing was swept or the swept members owned nothing.
    unowned: { type: 'integer' },
    unowned_tasks: { type: 'array', items: { type: 'string' } },
    // On a read whose sweep was stopped by the board veto: how many one-shot members stayed because they
    // still own open work, the row ids that blocked them, and the sentence naming the call that clears
    // each (ADR 0026). All three absent when the veto blocked nothing.
    blocked: { type: 'integer' },
    blocking_tasks: { type: 'array', items: { type: 'string' } },
    blocking_note: { type: 'string' },
  },
}

/**
 * The answer to one bounded wait.
 *
 * `target` and `status` are present only on the wake path and name the member whose transition ended
 * the wait; `no_progress` is present only when the wait refused to start. A timeout adds neither,
 * which is what lets the model tell "someone moved" from "I stopped looking" from "nothing could move".
 */
const WAIT_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['timed_out', 'waited_ms', 'message'],
  properties: {
    timed_out: { type: 'boolean' },
    waited_ms: { type: 'integer' },
    // True when the call returned immediately because no member was running or provisioning.
    no_progress: { type: 'boolean' },
    // The member that changed, and the live status it entered.
    target: { type: 'string' },
    status: { type: 'string', enum: ['running', 'idle'] },
    message: { type: 'string' },
  },
}

const RETIRE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'retired'],
  properties: {
    target: { type: 'string' },
    retired: { type: 'boolean' },
    drained: { type: 'boolean' },
    archived: { type: 'boolean' },
    trashed: { type: 'boolean' },
    trash_path: { type: 'string' },
    // How many older artifacts the per-Lead trash cap removed in this same call; 0 in every other case.
    pruned: { type: 'integer' },
    // The lifetime the member had. A retirement that happened answers it, and the consent refusal repeats
    // `standing` so the caller can see which rule stopped it (ADR 0026).
    lifetime: { type: 'string', enum: ['standing', 'one-shot'] },
    // Present only on the refusal a standing member's retirement answers with: the sentence to put to the
    // person, the open rows it still owns, and the assignment it carries — everything the question needs,
    // and nothing was retired when it is returned (ADR 0026).
    question: { type: 'string' },
    owns_tasks: { type: 'array', items: { type: 'string' } },
    // What the gate found on the member, as short phrases — the machine-readable form of the rule that
    // stopped this call ("a recorded assignment", "1 open task", "being re-tasked (2 messages)"). Present
    // on a refusal, and empty exactly when the member carries nothing, which is the statement the bare
    // refusal is making; so an empty array here is deliberate and not the absence of a check (ADR 0026).
    carries: { type: 'array', items: { type: 'string' } },
    assignment: { type: 'string' },
    // Present when another generation of the stale target's name is live now; names that holder.
    current_holder: CURRENT_HOLDER,
    // What the retirement did to the member's open tasks: `transferred` to the successor a replacement
    // named, or `unowned` when no successor took them. Both absent when the member owned no open task, so
    // a retirement on an empty board is the result it always was (P2-09, ADR 0017).
    transferred: { type: 'integer' },
    transferred_tasks: { type: 'array', items: { type: 'string' } },
    unowned: { type: 'integer' },
    unowned_tasks: { type: 'array', items: { type: 'string' } },
    // `already-retired` on the state matrix's no-op row, `needs-confirmation` on the standing-member
    // refusal; absent on the retirements that happened.
    reason: { type: 'string' },
    message: { type: 'string' },
  },
}

const MESSAGE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'sent'],
  properties: {
    target: { type: 'string' },
    sent: { type: 'boolean' },
    // The typed refusal: a tombstone, a failed member and a target that never existed are three
    // different answers, never the same sentence.
    reason: { type: 'string', enum: ['retired', 'failed', 'missing'] },
    message_id: { type: 'string' },
    assignment: { type: 'string' },
    // The lifetime the member still has. A message re-opens a one-shot member instead of re-declaring it,
    // so this field never changes because of a message (ADR 0026).
    lifetime: { type: 'string', enum: ['standing', 'one-shot'] },
    // True when the message re-opened a one-shot member: its finished-evidence was dropped, so the next
    // sweep leaves it alone until it has run and stopped again.
    reopened: { type: 'boolean' },
    // Present when another generation of the stale target's name is live now; names that holder.
    current_holder: CURRENT_HOLDER,
    message: { type: 'string' },
  },
}

const RESTORE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'restored'],
  properties: {
    target: { type: 'string' },
    restored: { type: 'boolean' },
    // Which branch actually ran: moved-back, never-moved, unarchived, not-archived, already-active,
    // pruned (the retention cap removed the artifact), archived (the tombstone is past the trash window
    // and lives in the archive now), or not-retired for a refusal.
    reason: { type: 'string' },
    path: { type: 'string' },
    // Present on a refusal when another generation of the stale target's name is live now.
    current_holder: CURRENT_HOLDER,
    // The open tasks nobody had taken over when this member retired or returned, and their ids. A
    // restore changes no owner, so this is what it reports instead of guessing (P2-09, ADR 0017).
    unowned: { type: 'integer' },
    unowned_tasks: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
}

const STOP_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'stopped'],
  properties: {
    target: { type: 'string' },
    stopped: { type: 'boolean' },
    reason: { type: 'string', enum: ['retired', 'failed', 'missing'] },
    resident: { type: 'boolean' },
    // Present on a refusal when another generation of the stale target's name is live now.
    current_holder: CURRENT_HOLDER,
    message: { type: 'string' },
  },
}

const HANDOFF_TEMPLATE_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['template', 'stored', 'valid', 'source', 'message'],
  properties: {
    // The effective template: the team file's body, the stored one, or '' when neither exists.
    template: { type: 'string' },
    stored: { type: 'boolean' },
    valid: { type: 'boolean' },
    // Which of the three sources is in effect: the team file, the stored template, or the built-in.
    source: { type: 'string', enum: ['file', 'stored', 'builtin'] },
    // The team file's path, present whenever one exists — usable or not — so a refusal a write answers
    // with names the file to edit.
    file: { type: 'string' },
    // Present only when a team file exists and is not a usable template: what is wrong, and its line.
    file_problem: { type: 'string' },
    // Present only on a stored template that fails validation: what is wrong, and which token.
    problem: { type: 'string' },
    message: { type: 'string' },
  },
}

/** The durable roster key for one Lead. */
function leadSessionIdOf(agent) {
  return String(agent.session.id)
}

/**
 * The rows the shipped team panel is overlaid with for one Lead: its live members that carry a recorded
 * child id, as the two fields the overlay reads.
 *
 * Only `active` counts. A `provisioning` record is a reservation whose child may not exist yet, a
 * `failed` one has no session to open, and a `retired` one must be *absent* from the panel rather than
 * present and marked — the wire member phase is closed at `provisioning | active | failed`, so
 * "retired" has no honest spelling there (ADR 0023). `name` is the model-facing target, the handle the
 * panel label and the click's conversation share; `id` is the child Session id the record holds, which
 * is what makes that click open the member's real chat (host-hooks.js).
 * @param {object} roster - one Lead's roster record.
 * @returns {Array<{id: string, name: string}>} panel rows, in roster order.
 */
export function livePanelMembers(roster) {
  return roster.members
    .filter((member) => member.phase === PHASE.active && typeof member.childId === 'string' && member.childId.length > 0)
    .map((member) => ({ id: member.childId, name: targetOf(member) }))
}

/**
 * Install every Lead-scoped tool.
 * @param agent - exact Team Lead whose model should receive the tools.
 * @param ctx - plugin context.
 * @param source - promise of the roster source; each tool call awaits the Lead's own root before reading.
 * @param hooks - host-side effects a retirement refreshes.
 * @param dataDirFor - the data directory this Lead's trash lives under, resolved from its bound root.
 * @param trashLimit - the effective per-Lead trash cap resolved from the plugin config (ADR 0012).
 * @returns a disposer that unwinds every registration in reverse order.
 */
function install(agent, ctx, source, hooks, dataDirFor, trashLimit) {
  const scoped = agent.ctx
  const disposers = []
  /** This Lead's roster table, once the root it is bound to has been loaded and imported. */
  const rosterTable = async () => {
    const roster = await source
    await roster.readyFor(leadSessionIdOf(agent))
    return roster.table
  }
  const register = (disposer) => {
    disposers.push(disposer)
  }

  try {
    register(scoped.tools.register(defineTool({
      name: 'compact_member',
      description: 'Force one context compaction on an in-place resident, idle member, keeping its identity and session. It costs one summarization model call and does nothing when no safe older range can be condensed. An idle child is normally unloaded, so this usually applies only while the member is still resident; to reduce a finished member\'s pressure, wake it with message_member and let its automatic compaction run.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: {
            type: 'string',
            description: 'Member target from list_members, such as reviewer or reviewer-g2.',
          },
        },
      },
      output: { schema: COMPACT_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'compact_member')
        requireLead(ctx, caller, 'compact_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('compact_member: target must be a non-empty string')
        }
        const table = await rosterTable()
        const leadSessionId = leadSessionIdOf(caller)
        const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
        const member = findByTarget(roster, args.target)
        if (member === undefined) throw new Error(`compact_member: no live member named "${args.target}"`)
        const memberTarget = targetOf(member)

        const compaction = ctx.get('compaction')
        if (compaction === undefined) throw new Error('compact_member: no compaction backend is mounted in this profile')

        const live = ctx.agents.get(member.childId)
        if (live === undefined) {
          return {
            target: memberTarget,
            compacted: false,
            reason: 'not-resident',
            message: 'This member is not resident: an idle child is unloaded, and a resumed member compacts itself automatically at its next step. Send it a message to wake it if its pressure needs reducing.',
          }
        }
        if (live.status === 'running') {
          return {
            target: memberTarget,
            compacted: false,
            reason: 'busy',
            message: 'The member is running a turn. Wait for it to go idle, or interrupt it, then retry.',
          }
        }

        // A member with no committed request has no measurable pressure; an `undefined` field would
        // make the tool result non-lossless JSON, so numbers are attached only when real.
        const tokensNow = () => {
          const current = pressureOf(ctx, live).pressureTokens
          return Number.isFinite(current) ? current : undefined
        }
        const numberField = (name, value) => (Number.isFinite(value) ? { [name]: value } : {})
        const before = tokensNow()
        let result
        try {
          result = await compaction.compactNow(live, exec.signal)
        } catch (error) {
          return {
            target: memberTarget,
            compacted: false,
            reason: 'failed',
            ...numberField('before_tokens', before),
            message: error instanceof Error ? error.message : String(error),
          }
        }
        if (result === null || result === undefined) {
          return {
            target: memberTarget,
            compacted: false,
            reason: 'nothing-to-compact',
            ...numberField('before_tokens', before),
            ...numberField('after_tokens', tokensNow()),
            message: 'No safely compactable range was found; the older history is likely one indivisible unit.',
          }
        }
        const value = {
          target: memberTarget,
          compacted: true,
          reason: 'done',
          ...numberField('before_tokens', before),
          ...numberField('after_tokens', tokensNow()),
          message: 'The member was compacted in place; its identity and session are unchanged.',
        }
        if (Number.isFinite(result.shadowedTokenCount)) value.shadowed_tokens = result.shadowedTokenCount
        return value
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'spawn_member',
      description: 'Create one named team member as a continuable subagent, or replace an existing member in one call. Pass definition to start it from a member definition committed with the project instead of describing it here. Pass replace to retire that member and start its successor from a handoff brief: the successor is told what the predecessor was doing, that it is the successor, and where the unfinished work is; it is not given the predecessor\'s transcript. A successor keeps the base name with the next generation suffix unless you name it. Record an assignment so a later successor can take this member\'s work over. Declare how long the member lives with lifetime: the default, standing, is a role you expect to use again and which is never retired automatically; one-shot is a member created for one piece of work, which the lazy sweep retires by itself once it has run, stopped and owns no open task. The declaration is made on this call only — never inherited from a predecessor or a definition file — and it is what stands in for the person\'s consent when a one-shot member leaves on its own, so declare one-shot deliberately. This call first sweeps members already in that state and reports the count.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: {
          name: { type: 'string', description: 'Lowercase base name: 1-32 letters, digits or hyphens, starting with a letter. Required unless replace or definition supplies one; with replace it defaults to the predecessor\'s base name, which yields the next generation, and with definition it defaults to the name the file declares.' },
          label: { type: 'string', description: 'Short responsibility text shown in the roster. Required unless definition supplies it.' },
          prompt: { type: 'string', description: 'Complete initial task for the member. With replace it is appended after the handoff brief, and with definition it is appended after the definition\'s own prompt. Required unless definition supplies one.' },
          assignment: {
            type: 'string',
            maxLength: ASSIGNMENT_MAX,
            description: `Optional, 1-${ASSIGNMENT_MAX} characters: what this member is responsible for, stated durably. A successor is briefed with it when this member is replaced, and message_member replaces it later. Passing it with replace overrides both the predecessor's recorded assignment and any definition's.`,
          },
          replace: {
            type: 'string',
            description: 'Target of an existing member to retire in the same call, such as reviewer. The successor starts first and the predecessor is retired second, so a failed start leaves the predecessor untouched; a failed retirement is reported as predecessor_retired: false. An already-retired target is accepted, and its tombstone supplies the brief.',
          },
          lifetime: {
            type: 'string',
            enum: ['standing', 'one-shot'],
            description: 'How long this member lives, declared once and only on this call. standing (the default) is a division of labour you expect to use again: it is never retired automatically, and retiring it needs the person\'s answer. one-shot is a member created for one piece of work in a parallel fan-out: a lazy sweep at the start of list_members or spawn_member retires it through the normal retirement path once it has run, stopped and owns no open task, with no retire_member call. A member that never started, one still running, and one that still owns an open task are never swept — the last is reported as blocked with the blocking row ids. The declaration is never inherited: a replace starts its successor as standing unless that call declares otherwise, and a definition file cannot declare a lifetime at all.',
          },
          ephemeral: {
            type: 'boolean',
            description: 'Default false. The pre-v0.25 spelling of lifetime, kept working: true means one-shot and false means standing, so pass ephemeral: true exactly when you would pass lifetime: "one-shot". Passing both is accepted when they agree and refused when they do not. A message no longer clears it: message_member re-opens a one-shot member without changing its lifetime.',
          },
          definition: {
            type: 'string',
            description: 'Name of a member definition to start from, instead of describing the member here. Definitions are the Lead\'s files, not this tool\'s: each one is a markdown file under .agents/team/definitions/ in your working directory — older profiles keep them in team/, and both are read — with a flat frontmatter block declaring name and label and optionally assignment, cwd, provider, model, reasoning_effort, max_tokens and agent_preset; the body below the frontmatter is the member\'s prompt. Five roles ship with this plugin — implementer, reviewer, researcher, scribe and verifier — and any file of your own with the same name outranks the shipped one, so they are a starting point rather than a cage. Write and version your own definitions with your own file tools. Those are exactly the accepted fields: a definition cannot declare a lifetime, because a file describes the role and a successor must not inherit one — a frontmatter \'lifetime\' or \'ephemeral\' is refused by name with the reason. Any field you also pass to this call overrides the file\'s, and the definition field of the result says which came from the file and which you overrode. One field has a third source: on a replace, the assignment recorded on the member being replaced outranks the file\'s, because a successor inherits the work and not the role\'s standing sentence; the file\'s assignment applies only when the predecessor recorded none, and definition.assignment in the result says which won (call, predecessor or file). A definition that is missing or malformed is answered as started: false with the file and the line, and it does not stop a valid definition beside it. Caps, refused rather than truncated: 16 KiB per file, 64 files per scan.',
          },
          spawn_options: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional settings the member starts with. Omit the object, or any field in it, to inherit the Lead: an omitted member runs in the Lead\'s working directory, on the Lead\'s model and route, and with the Lead\'s tool set. One exception: a changed provider or model without reasoning_effort lets the new route resolve its own default instead of inheriting the Lead\'s effort. A spawn that supplies no agent_options still runs on this Session\'s current route: the plugin resolves provider and model from this Session and forwards them, so a member keeps using the API of the Session that started it even after a later model switch, and started_with.route_source says whether the route came from this call (caller), was resolved by the plugin (plugin), or was inherited unresolved because nothing could be read or the provider cannot apply one (inherited). started_with reports back what the plugin forwarded, not what the child resolved: it echoes the supplied fields unresolved and unread, so it is a receipt for the request, never a confirmation that a chosen model took effect. With replace, the successor starts with these options and the predecessor\'s record is unaffected.',
            properties: {
              cwd: {
                type: 'string',
                description: 'Working-directory path for the member, such as "/repo/worktrees/feature" or "packages/api". It is passed to the Harness exactly as written: a relative path resolves against the Lead\'s working directory, an absolute path outside the session\'s permission roots stays denied, and nothing is expanded or validated here. Omit to use the Lead\'s working directory.',
              },
              agent_options: {
                ...AGENT_OPTIONS_SCHEMA,
                description: 'Model settings for the member\'s requests. Omit the object, or any field in it, to inherit the Lead\'s value; a provider or model change without reasoning_effort lets the new route resolve its own default.',
              },
              agent_preset: {
                type: 'string',
                description: 'Id of an Agent Preset declared in this profile. It selects the member\'s prompt, persona and tools, which is the only way to start a restricted or read-only member: there is no per-call tool allow/deny. A preset id is not a path and preset directories are not scanned, so it must be an id the profile\'s bundle patches declare. Omit to inherit the Lead\'s preset and tool set.',
              },
            },
          },
        },
      },
      output: { schema: { oneOf: [MEMBER_ROW, DEFINITION_REFUSAL] } },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'spawn_member')
        requireLead(ctx, caller, 'spawn_member')
        if (args.label !== undefined && (typeof args.label !== 'string' || args.label.trim().length === 0)) {
          throw new Error('spawn_member: label must be a non-empty string')
        }
        if (args.prompt !== undefined && (typeof args.prompt !== 'string' || args.prompt.trim().length === 0)) {
          throw new Error('spawn_member: prompt must be a non-empty string')
        }
        if (args.definition !== undefined && (typeof args.definition !== 'string' || args.definition.trim().length === 0)) {
          throw new Error('spawn_member: definition must be a non-empty string')
        }
        if (args.definition === undefined) {
          if (args.label === undefined) throw new Error('spawn_member: label is required unless definition is given')
          if (args.prompt === undefined) throw new Error('spawn_member: prompt is required unless definition is given')
        }
        if (args.name !== undefined && (typeof args.name !== 'string' || args.name.trim().length === 0)) {
          throw new Error('spawn_member: name must be a non-empty string')
        }
        if (args.replace !== undefined && (typeof args.replace !== 'string' || args.replace.length === 0)) {
          throw new Error('spawn_member: replace must be a non-empty string')
        }
        if (args.name === undefined && args.replace === undefined && args.definition === undefined) {
          throw new Error('spawn_member: name is required unless replace or definition supplies one')
        }
        if (args.assignment !== undefined && typeof args.assignment !== 'string') {
          throw new Error('spawn_member: assignment must be a string')
        }
        if (args.ephemeral !== undefined && typeof args.ephemeral !== 'boolean') {
          throw new Error('spawn_member: ephemeral must be a boolean')
        }
        if (args.lifetime !== undefined && args.lifetime !== 'standing' && args.lifetime !== 'one-shot') {
          throw new Error('spawn_member: lifetime must be "standing" or "one-shot"')
        }
        const options = args.spawn_options
        if (options !== undefined) {
          if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw new Error('spawn_member: spawn_options must be an object')
          }
          if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.trim().length === 0)) {
            throw new Error('spawn_member: spawn_options.cwd must be a non-empty string')
          }
          const model = options.agent_options
          if (model !== undefined) {
            if (model === null || typeof model !== 'object' || Array.isArray(model)) {
              throw new Error('spawn_member: spawn_options.agent_options must be an object')
            }
            for (const key of ['provider', 'model', 'reasoning_effort']) {
              if (model[key] !== undefined && (typeof model[key] !== 'string' || model[key].trim().length === 0)) {
                throw new Error(`spawn_member: spawn_options.agent_options.${key} must be a non-empty string`)
              }
            }
            if (model.max_tokens !== undefined && (!Number.isSafeInteger(model.max_tokens) || model.max_tokens < 1)) {
              throw new Error('spawn_member: spawn_options.agent_options.max_tokens must be a positive integer')
            }
            for (const key of Object.keys(model)) {
              if (!['provider', 'model', 'reasoning_effort', 'max_tokens'].includes(key)) {
                throw new Error(`spawn_member: spawn_options.agent_options has an unknown field "${key}"`)
              }
            }
          }
          if (options.agent_preset !== undefined && (typeof options.agent_preset !== 'string' || options.agent_preset.trim().length === 0)) {
            throw new Error('spawn_member: spawn_options.agent_preset must be a non-empty string')
          }
          for (const key of Object.keys(options)) {
            if (!['cwd', 'agent_options', 'agent_preset'].includes(key)) {
              throw new Error(`spawn_member: spawn_options has an unknown field "${key}"`)
            }
          }
        }
        const table = await rosterTable()
        return await spawnMember({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          dataDir: dataDirFor(),
          hooks,
          name: args.name,
          label: args.label,
          prompt: args.prompt,
          assignment: args.assignment,
          replace: args.replace,
          lifetime: args.lifetime,
          ephemeral: args.ephemeral,
          definition: args.definition,
          cwd: options?.cwd,
          agentOptions: options?.agent_options,
          agentPreset: options?.agent_preset,
          signal: exec.signal,
          trashLimit,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_members',
      description: 'List every member and subagent this agent controls: members this plugin spawned, members the shipped team roster created, and children spawned with the shipped subagent or subagent_fork tools. Each row carries the target, the child session id, the lifecycle phase, the assignment recorded for it, the lifetime its spawn declared (standing or one-shot), ephemeral: true on a one-shot member, live state and, while resident, context pressure. A one-shot member that has been re-tasked at least twice is flagged retasked: true with a note saying it is probably a standing role — the plugin only advises, it never converts one, and only you can declare the other lifetime at the next spawn. A row also carries the route that member was started on (provider, model, and whether the plugin resolved it or the call supplied it), and when that route is not the one this Session is on now the row is marked route_stale: true with a route_note naming the member and the one call that replaces it — a member started before a model switch keeps being billed to the API it began on until it is replaced. Unknown children are adopted on the first read, and retired members stay listed as retired. This read first sweeps one-shot members whose turn has ended and which own no open task — through the same retirement path as retire_member, which is why those members then appear as retired — and reports swept and swept_targets when it retired any. A one-shot member whose turn ended but which still owns an open task is left alone and reported instead: blocked counts them, blocking_tasks names the row ids, and blocking_note names the one call that clears each, because an open row is a veto and an empty board is never proof that anything finished. It always answers host_hooks: whether each host hook installed in this process — panel_filter (the shipped team panel and the subagent picker), roster_filter (the shipped list_agents tool) and slot_credit — plus stripped_ids, the number of tombstoned child ids the installed filters are removing, and tombstone_read_failed. A retired member still shown by the shipped panel or list_agents, or a panel that never lists a member this plugin owns, is explained there rather than guessed at. This list is the recent members, not everyone this Lead ever had: past the trash retention window a tombstone leaves the roster for an append-only archive, and archived_records counts those while archive_file names the file, so a target missing from here may still be in the archive rather than gone.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: { schema: MEMBER_LIST_VALUE },
      async execute(_args, exec) {
        const caller = callingAgent(exec.agent, 'list_members')
        requireLead(ctx, caller, 'list_members')
        const table = await rosterTable()
        const listed = await listMembers({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          dataDir: dataDirFor(),
          hooks,
          trashLimit,
        })
        return { ...listed, host_hooks: await hooks.report(), storage: (await source).report(leadSessionIdOf(caller)) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'wait_members',
      description: `Block inside this turn until one of this Lead's members changes live state (running or idle) or the timeout expires, then report which member changed and into what. It observes only changes after the call starts, wakes nobody, and returns no_progress at once when no member is running or provisioning, because nothing can change while the Lead is blocked. It does NOT wait for a task_board change, for a message to be processed, for a member to finish its whole assignment, or for a retired member's state; re-read list_members after it returns. timeout_ms defaults to ${WAIT_TIMEOUT_DEFAULT} and may not exceed ${WAIT_TIMEOUT_MAX} (one hour).`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeout_ms: {
            type: 'integer',
            description: `How long to wait in milliseconds: a positive integer up to ${WAIT_TIMEOUT_MAX}. Omit for ${WAIT_TIMEOUT_DEFAULT} (30 seconds), the default.`,
          },
        },
      },
      output: { schema: WAIT_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'wait_members')
        requireLead(ctx, caller, 'wait_members')
        if (args.timeout_ms !== undefined
          && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > WAIT_TIMEOUT_MAX)) {
          throw new Error(`wait_members: timeout_ms must be an integer from 1 through ${WAIT_TIMEOUT_MAX}`)
        }
        const table = await rosterTable()
        return await waitMembers({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          timeoutMs: args.timeout_ms,
          signal: exec.signal,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'retire_member',
      description: `Retire one member: stop it, release its capacity slot, hide it from the workspace, and tombstone its record. This is the removal operation the shipped team roster does not have, and it works on any member list_members reports, including an adopted subagent. A member is a division of labour, not a task: retirement answers "this role is not needed any more", never "this piece of work is finished" — a member that completed one piece of work may be needed again next round, and an idle member between rounds is not a candidate. The gate protects the person's decision to end a role, not every act of housekeeping, so it depends on what the member still carries. A standing member that carries something — a recorded assignment, an open task on this board, or evidence it was re-tasked (handed work at least twice) — is not retired by this call alone: it answers retired: false with reason "needs-confirmation", a question to put to the person, and the rows it still owns. Put that question to them, then call again with confirmed set to their answer, quoted verbatim — their sentence, not your summary and not a boolean, because the plugin has no surface of its own and the quoted words are the only consent it can check. A standing member that carries nothing is bare residue, and you may clear it yourself: pass a reason and it retires in one call, no confirmation needed, because asking a person about a probe left behind is ceremony. A call that omits the reason on such a member answers reason "needs-reason"; a confirmation does not substitute for it, because there is nobody whose words it could be. A one-shot member already had consent when you declared it one-shot, so it retires in one call; so does a successor started by spawn_member with replace, because a replacement continues the role rather than ending it; and so does a record that never became a role at all — one in failed never started, and one already retired has no life left to end. Its assignment stays on the tombstone for a later successor. The per-Lead trash keeps at most ${trashLimit} retired sessions, so a retirement that moves an artifact in removes the oldest ones and reports how many in pruned; a pruned member can no longer be restored. To retire a member and install its successor in the same call, use spawn_member with replace.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Member target from list_members, such as reviewer or reviewer-g2.' },
          reason: {
            type: 'string',
            description: 'Optional short reason, stored on the tombstone. Required when you retire a standing member that carries nothing (no recorded assignment, no open row, never re-tasked): that is housekeeping rather than a role-level decision, so the reason is what a later reader has instead of a question and an answer.',
          },
          confirmed: {
            type: 'string',
            description: 'The person\'s answer, quoted verbatim, required when the standing member you are retiring still carries something (a recorded assignment, an open row, or evidence it was re-tasked). Set it to the sentence they actually said, not to "yes" and not to a paraphrase: it is echoed back in the result and is what this plugin treats as the consent for ending a role. Omit it on the first call — that call answers reason "needs-confirmation" with the question to ask and names what the member carries. Omit it for a standing member that carries nothing (pass reason instead), for a one-shot member, for a successor a replacement installs, and for a record in failed or already retired.',
          },
        },
      },
      output: { schema: RETIRE_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'retire_member')
        requireLead(ctx, caller, 'retire_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('retire_member: target must be a non-empty string')
        }
        if (args.confirmed !== undefined && typeof args.confirmed !== 'string') {
          throw new Error('retire_member: confirmed must be a string carrying the person\'s words')
        }
        const table = await rosterTable()
        return await retireMember({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          dataDir: dataDirFor(),
          hooks,
          target: args.target,
          reason: args.reason,
          confirmed: args.confirmed,
          // This is the model's own decision to end a role, which is the one retirement the person has not
          // already consented to. A replacement continues the role and the sweep acts on a member declared
          // one-shot, so both leave this false (ADR 0026).
          consentRequired: true,
          trashLimit,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'restore_member',
      description: 'Bring a retired member back: move its trashed session to the path it came from and return the record to active. It refuses when a live member already uses the target, reports why when no artifact was recorded, and answers reason "pruned" when the trash retention cap already removed the artifact — a pruned member cannot be restored. A tombstone older than that cap\'s window is no longer in the roster at all: it answers reason "archived" and names the append-only archive that still holds the record. A restored session may take one client refresh to reappear.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Retired member target from list_members.' },
        },
      },
      output: { schema: RESTORE_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'restore_member')
        requireLead(ctx, caller, 'restore_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('restore_member: target must be a non-empty string')
        }
        const table = await rosterTable()
        return await restoreMember({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          target: args.target,
          hooks,
          // The data directory in effect, so a tombstone written from this release resolves without an
          // absolute path and an older one still finds its artifact.
          dataDir: dataDirFor(),
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'message_member',
      description: 'Send one message to a live member or adopted subagent from list_members, and optionally replace the assignment recorded for it. A running child receives the message at its next step; an unloaded continuable child is resumed from its own Session, while a one-shot subagent cannot be resumed. A retired member cannot be messaged. A message never changes the lifetime a spawn declared: messaging a one-shot member re-opens it — the evidence the sweep relies on is dropped, so the next sweep leaves it alone until it has run and stopped again — and the member stays one-shot. A one-shot member messaged at least twice is reported on its list_members row as probably standing, but nothing converts it: only the next spawn can declare another lifetime. Success means the inbox accepted the message, not that the member has processed it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'message'],
        properties: {
          target: { type: 'string', description: 'Member target from list_members.' },
          message: { type: 'string', description: 'Self-contained message for the member.' },
          assignment: {
            type: 'string',
            maxLength: ASSIGNMENT_MAX,
            description: `Optional, 1-${ASSIGNMENT_MAX} characters: replaces the assignment recorded for this member, and is stored only after the message is accepted. Use it when the member's work changes, so a later successor is briefed with the current work.`,
          },
        },
      },
      output: { schema: MESSAGE_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'message_member')
        requireLead(ctx, caller, 'message_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('message_member: target must be a non-empty string')
        }
        if (typeof args.message !== 'string' || args.message.trim().length === 0) {
          throw new Error('message_member: message must be a non-empty string')
        }
        if (args.assignment !== undefined && typeof args.assignment !== 'string') {
          throw new Error('message_member: assignment must be a string')
        }
        const table = await rosterTable()
        return await messageMember({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          target: args.target,
          message: args.message,
          assignment: args.assignment,
          signal: exec.signal,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'stop_member',
      description: 'Cancel one member or adopted subagent\'s current turn at once. The activation, its inbox and its record are kept, so a later message resumes it; use retire_member to end a member for good.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Member target from list_members.' },
        },
      },
      output: { schema: STOP_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'stop_member')
        requireLead(ctx, caller, 'stop_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('stop_member: target must be a non-empty string')
        }
        const table = await rosterTable()
        return await stopMember({ ctx, table, leadSessionId: leadSessionIdOf(caller), leadAgent: caller, target: args.target })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'handoff_template',
      description: 'Read, store or clear this Lead\'s handoff-brief template: the shape spawn_member with replace uses to brief a successor. Omit template to read back the effective template and its source; pass a template to validate and store it; pass an empty string to clear it and return to the built-in brief. Three sources are tried in order: the team file team/team.md in the Lead\'s working directory, the template stored on this Lead\'s roster record, and the built-in brief. The file wins while it exists, so a store or clear call is refused with the file\'s path and the instruction to edit it; delete the file to use this tool again. A Lead that has neither gets the built-in brief.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: {
            type: 'string',
            maxLength: HANDOFF_TEMPLATE_MAX,
            description: 'The template to store, or an empty string to clear it. Placeholders: {successor} and {predecessor} (their targets), {label} (the predecessor\'s role), {assignment} (what it was doing; required, or the successor is not told what it inherited) and {task_board} (the pointer to this Lead\'s own task board, which the member reads with list_my_tasks). An unknown placeholder is refused. The successor\'s own prompt is always appended after the rendered template.',
          },
        },
      },
      output: { schema: HANDOFF_TEMPLATE_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'handoff_template')
        requireLead(ctx, caller, 'handoff_template')
        if (args.template !== undefined && typeof args.template !== 'string') {
          throw new Error('handoff_template: template must be a string')
        }
        const table = await rosterTable()
        return await handoffTemplate({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          signal: exec.signal,
          template: args.template,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'task_board',
      description: 'This Lead\'s own work board: the tasks a replacement hands over. A task belongs to one Lead, lives on that Lead\'s roster record, and has an id, a title, a body, a status (open or done) and an optional member owner. `create` adds one; `list` reads the whole board; `update` sets status, owner and/or body; `release` clears the owner; `delete` removes the row. The board is what makes a handover hand over work rather than a description of it: spawn_member with replace moves every open task of the predecessor to the successor and the successor\'s brief names them by id and title, while retire_member without a successor leaves them unowned and reports their ids. The body is where the task states what "done" means and where the predecessor stopped; the brief stays short on purpose, so a successor reads the bodies from this board with list_my_tasks. A board write never rewrites a field the call did not name, and a `release` or `delete` whose row changed since the call read it answers `changed: false` with the row it found instead of overwriting a handover. A `done` task never moves. There are deliberately no priorities, dependencies, comments, sub-tasks or due dates: this is a handover channel, not a project tracker.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'update', 'release', 'delete'],
            description: 'What to do: list reads the board, create adds a task, update changes a task\'s status, owner or body, release clears its owner, delete removes it.',
          },
          title: {
            type: 'string',
            description: `create only: the task title, 1-${TASK_TITLE_MAX} characters. Refused past the cap, never truncated.`,
          },
          body: {
            type: 'string',
            description: `create or update: what "done" means for this task and where the work stopped — the acceptance criteria a successor cannot get from the title. 1-${TASK_BODY_MAX} characters, refused past the cap, never truncated. update accepts null to clear it.`,
          },
          owner: {
            type: 'string',
            description: 'create or update: a member target from list_members, such as reviewer-g2. It is the work\'s owner, and ownership is exactly what a handover moves. create refuses an id no member holds; update accepts null to leave the task unowned.',
          },
          task_id: {
            type: 'string',
            description: 'update, release and delete: the id of the task, as a list row reported it.',
          },
          status: {
            type: 'string',
            enum: ['open', 'done'],
            description: 'update only: open is work still owed and therefore still inherited; done is finished work, which no handover moves.',
          },
        },
      },
      output: { schema: TASK_BOARD_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'task_board')
        requireLead(ctx, caller, 'task_board')
        if (typeof args.action !== 'string' || args.action.length === 0) {
          throw new Error('task_board: action must be a non-empty string')
        }
        const actions = ['list', 'create', 'update', 'release', 'delete']
        if (!actions.includes(args.action)) {
          throw new Error(`task_board: action must be one of ${actions.join(', ')}`)
        }
        const needsId = ['update', 'release', 'delete'].includes(args.action)
        if (needsId && (typeof args.task_id !== 'string' || args.task_id.length === 0)) {
          throw new Error(`task_board: ${args.action} requires task_id`)
        }
        if (args.action === 'create' && (typeof args.title !== 'string' || args.title.trim().length === 0)) {
          throw new Error('task_board: create requires a non-empty title')
        }
        if (args.owner !== undefined && args.owner !== null && typeof args.owner !== 'string') {
          throw new Error('task_board: owner must be a member target or null')
        }
        if (args.body !== undefined && args.body !== null && typeof args.body !== 'string') {
          throw new Error('task_board: body must be a string or null')
        }
        if (args.status !== undefined && !['open', 'done'].includes(args.status)) {
          throw new Error('task_board: status must be "open" or "done"')
        }
        const table = await rosterTable()
        return await taskBoard({
          table,
          leadSessionId: leadSessionIdOf(caller),
          action: args.action,
          task_id: args.task_id,
          title: args.title,
          owner: args.owner,
          status: args.status,
          body: args.body,
        })
      },
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Install the one member-scoped tool on an Agent's own context.
 *
 * A member receives its tools the same way the Lead does — `agent.ctx.tools.register` on the exact Agent,
 * unwound when that Agent is disposed — so a member Session that is not the Lead's gets this tool while the
 * Lead's own list is unchanged (ADR 0022). The tool is read-only and takes no target: the caller's Session
 * is the selector, resolved at call time against the roster, which is why registration can be broad (every
 * non-root Agent) while the answer stays narrow (only the rows that Session owns).
 * @param agent - the member Agent whose model should receive the tool.
 * @param ctx - plugin context.
 * @param source - promise of the roster source; the member read waits for every bound root.
 * @returns a disposer that removes the registration.
 */
function installMember(agent, ctx, source) {
  return agent.ctx.tools.register(defineTool({
    name: 'list_my_tasks',
    description: 'Read the tasks you own on your Lead\'s work board: one row per task whose owner is your own target, each with its id, title, body, status and timestamps, and how many are still open. The body is what "done" means for the task and where the work stopped, so read it before starting or redoing anything. This is a read-only view: only the Lead writes the board, so when you finish a task say so in your reply and the Lead marks the row done. You cannot see another member\'s tasks, a task nobody owns, or the Lead\'s whole board.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: MY_TASKS_VALUE },
    async execute(_args, exec) {
      const caller = callingAgent(exec.agent, 'list_my_tasks')
      const roster = await source
      await roster.ready()
      return listMyTasks(requireMember(roster.table, caller, 'list_my_tasks'))
    },
  }))
}

/**
 * Every retired child Session id one Lead's record knows about.
 *
 * The record keeps the ids of the tombstones that moved to the archive, because the host hooks strip the
 * shipped panels by id: a member whose tombstone left the roster must not reappear there. A record written
 * before that field exists is read by scanning the tombstones it still holds, which is exactly the set the
 * hooks used to build, so nothing changes for a profile that has not written since the upgrade.
 * @param {object} roster - one Lead's record.
 * @returns {Set<string>} the ids, archived ones included.
 */
function retiredIdsOf(roster) {
  const ids = new Set(Array.isArray(roster?.retiredChildIds) ? roster.retiredChildIds : [])
  for (const member of roster?.members ?? []) {
    if (member?.phase !== PHASE.retired) continue
    if (typeof member.childId === 'string' && member.childId.length > 0) ids.add(member.childId)
  }
  return ids
}

/** The one tombstone set every host hook strips, and the one read they share. */
function retiredChildIds(table) {
  const ids = new Set()
  for (const [, roster] of table.entries()) {
    for (const id of retiredIdsOf(roster)) ids.add(id)
  }
  return ids
}

/**
 * Install the tools in every live and subsequently published Lead scope, and the one read-only tool in
 * every live and subsequently published member scope.
 *
 * The retention cap is resolved first, on purpose: an out-of-range `trashLimit` in the patch row must
 * fail the load before anything is registered or opened, so a bad config is a visible activation error
 * rather than a surprise on the first retirement (ADR 0012).
 * @param ctx - plugin context.
 * @param config - the plugin config the loader passes from the bundle patch row; `undefined` when the
 *   row declares none, and `{}` when it declares an empty one.
 */
export function apply(ctx, config) {
  const trashLimit = resolveTrashLimit(config)
  const installed = new Map()
  // Where each Lead's bytes go. A Lead binds once, on first use, so a `working_directory` call later in
  // the session cannot move its data root (see `createRootBinder`).
  const binder = createRootBinder()
  // The storage facility is the import source and the rollback path; a rejected open surfaces as a tool
  // error on first use instead of an unhandled rejection at load.
  const source = openRosterStore(ctx, binder, { trashLimit })
  source.catch(() => undefined)
  // The panel overlay reads the roster synchronously at each outgoing frame, so it takes whatever is
  // loaded at that moment rather than suspending a host stream on a promise this plugin does not own.
  let readySource
  source.then((value) => { readySource = value }, () => undefined)
  /** The data directory one Lead's trash lives under: its bound root, or the pre-move default. */
  const dataDirFor = (agent) => binder.rootOf(leadSessionIdOf(agent)) ?? resolveDataDir()
  /** Bind one Lead to its root, once. The binding decides where its roster and its trash live. */
  const bindLead = (agent) => binder.bind(leadSessionIdOf(agent), agent?.session?.header?.cwd)

  const log = (line) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
  }
  const readRetired = async () => {
    const roster = await source
    await roster.ready()
    return retiredChildIds(roster.table)
  }
  // The shipped roster read is synchronous — its caller maps the array directly — so it reads the same
  // set straight from the in-memory table. A live read cannot be stale, which is why it is one of the
  // three hooks that needs no invalidation. `undefined` means the source is not resolved yet.
  const readRetiredNow = () => (readySource === undefined ? undefined : retiredChildIds(readySource.table))
  const readRetiredByTeam = async () => {
    const roster = await source
    await roster.ready()
    const byTeam = new Map()
    for (const [leadSessionId, value] of roster.table.entries()) {
      // Every retired member, the archived ones included — the credit is for the slots a retirement freed,
      // and a tombstone that moved to the archive freed the same slot as one still in the roster.
      const count = retiredIdsOf(value).size
      if (count > 0) byTeam.set(leadSessionId, count)
    }
    return byTeam
  }
  // The built-in team panel renders the shipped fold, which never heard of a member started through
  // `ctx.subagents`. The same exit that hides a retired id adds this Lead's live members, in the shape
  // the wire schema requires (ADR 0023).
  const readLive = (leadSessionId) => (readySource === undefined ? [] : livePanelMembers(readRoster(readySource.table, leadSessionId)))
  const retired = createRetiredCache({ readRetired, log })

  // A hook must not be lost to load order: the row can activate before `sessionController` exists, and a
  // skip at that moment used to be permanent and silent. `ctx.inject` is Cordis's own dependency gate —
  // the callback runs when the named service is published, is unloaded and re-run when that service is
  // replaced, and its disposer unwinds the patch with this plugin's own fiber. No polling, no listener,
  // no retry loop of ours (ADR 0025).
  const hooks = {
    filter: { installed: false, invalidate: NOOP, dispose: NOOP },
    roster: { installed: false, dispose: NOOP },
    slots: { installed: false, refresh: async () => 0, dispose: NOOP },
  }
  /** What every installed hook is doing, for the `list_members` answer. */
  const hostHooksReport = async () => {
    const value = {
      panel_filter: hooks.filter.installed ? 'installed' : 'absent',
      roster_filter: hooks.roster.installed ? 'installed' : 'absent',
      slot_credit: hooks.slots.installed ? 'installed' : 'absent',
    }
    const notes = []
    if (hooks.filter.installed || hooks.roster.installed) {
      const reading = await retired.report()
      value.stripped_ids = reading.ids
      value.tombstone_read_failed = reading.failed
      if (reading.failed) {
        notes.push(`the tombstone read failed, so every installed filter keeps the last set it read (${reading.ids} ids) and a retired member may still be listed`)
      }
    }
    if (!hooks.filter.installed) {
      notes.push('the panel filter is absent: the host published no sessionController, so the shipped team panel keeps a retired row and never gains a member this plugin owns')
    }
    if (!hooks.roster.installed) {
      notes.push('the shipped roster read is absent: the host published no agentTeams.listMembers, so the shipped list_agents tool keeps a retired member')
    }
    if (!hooks.slots.installed) {
      notes.push('the slot credit is absent: the host published no agentTeams.roster, so a retirement does not free a shipped member slot')
    }
    if (notes.length > 0) value.message = `${notes.join('; ')}. This plugin's own tools are unaffected.`
    return value
  }
  hooks.report = hostHooksReport

  ctx.inject(['sessionController'], () => {
    const filter = installProjectionFilter(ctx, { cache: retired, readLive, log })
    hooks.filter = filter
    return () => {
      filter.dispose()
      hooks.filter = { installed: false, invalidate: NOOP, dispose: NOOP }
    }
  })
  ctx.inject(['agentTeams'], () => {
    const roster = installRosterFilter(ctx, { readRetiredNow })
    const slots = installSlotCredit(ctx, { readRetiredByTeam, log })
    hooks.roster = roster
    hooks.slots = slots
    if (slots.installed) void slots.refresh()
    return () => {
      roster.dispose()
      slots.dispose()
      hooks.roster = { installed: false, dispose: NOOP }
      hooks.slots = { installed: false, refresh: async () => 0, dispose: NOOP }
    }
  })

  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    const membership = ctx.agentTeams.tryMembership(agent)
    // Same rule as `requireLead`: `undefined` means "no readable membership", which is either a
    // subagent (refused) or a Team projection that cannot be read (a root is still the Lead).
    if (membership === undefined) {
      if (!isRootAgent(ctx, agent)) return
    } else if (membership.role !== 'lead') {
      return
    }
    // Bind before the tools exist: a Lead's data root is fixed for the life of its session, and the
    // first resolution is the one its working directory gives (see `createRootBinder`).
    bindLead(agent)
    installed.set(agent, install(agent, ctx, source, hooks, () => dataDirFor(agent), trashLimit))
  }

  // The member scope is the other half of the same shape: an Agent that is not a root is a child, and
  // a child gets the one read-only tool. Whether it is on a roster is decided at call time, not here,
  // so a member whose Lead Session is not this process's Lead still receives its tool (ADR 0022).
  const installedMembers = new Map()
  const maybeInstallMember = (agent) => {
    if (installedMembers.has(agent)) return
    if (isRootAgent(ctx, agent)) return
    installedMembers.set(agent, installMember(agent, ctx, source))
  }

  for (const agent of ctx.agents.list()) {
    maybeInstall(agent)
    maybeInstallMember(agent)
  }
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
    maybeInstallMember(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
    installedMembers.get(agent)?.()
    installedMembers.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    for (const dispose of installedMembers.values()) dispose()
    installedMembers.clear()
  }, 'team-roster.scopedTools()')
}
