/**
 * dsh-team — a team roster whose members can be retired, removed and replaced.
 *
 * Host half. It owns the roster (`roster.js`), exposes it as Lead-scoped tools, compacts one member's
 * context in place, and applies two host-side effects on retirement (`host-hooks.js`): retired members
 * are stripped from the session-list projections every client renders, and their budget is credited back
 * to the shipped roster. The member's persisted session is moved to a recoverable trash directory
 * (`trash.js`) rather than deleted. The shipped team tool row stays enabled because it owns the shared
 * task board; the roster *service* stays mounted so this plugin can adopt the members it created before
 * the switch, and can keep using its Lead membership test.
 *
 * Tools: `spawn_member`, `list_members`, `message_member`, `stop_member`, `retire_member`,
 * `restore_member`, `compact_member`, `handoff_template`. The operation bodies live in `actions.js`;
 * this file keeps argument validation, the Lead-only authority check, and the tool result schemas, and
 * nothing else. The plugin has no browser half: it is entirely model-facing (ADR 0008).
 *
 * `spawn_member` with `replace` is the whole replacement: it starts the successor from a short handoff
 * brief composed from the assignment recorded on the predecessor's record, then retires the
 * predecessor in the same call (ADR 0009). The work itself stays on the shipped team task board, which
 * this plugin does not own; the brief points the successor at it. A Lead that replaces members
 * repeatedly can fix the brief's shape once with `handoff_template` (ADR 0015); the built-in shape is
 * what a Lead that never stores one gets.
 *
 * WHY THIS FILE IMPORTS NOTHING FROM THE HARNESS
 * A profile-installed bundle is linked from its workspace directory, so a bare import such as
 * `@deepseek-ai/dsh-tools` resolves from the bundle path and fails with ERR_MODULE_NOT_FOUND. Shipped
 * packages resolve only from inside the dsh installation, and the installed first-party market plugin
 * likewise imports no dsh package. Tool definitions are therefore built as plain canonical JSON Schema
 * objects, which is exactly the `ToolDefinition` shape the registry consumes (`ctx.tools.register`
 * checks `output.schema` + `output.render` and projects `parameters` straight to the model).
 *
 * The plugin writes no session events. Its durable state lives in one storage domain (ADR 0003).
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
  messageMember,
  pressureOf,
  retireMember,
  restoreMember,
  spawnMember,
  stopMember,
} from './actions.js'
import { installProjectionFilter, installSlotCredit } from './host-hooks.js'
import {
  ASSIGNMENT_MAX,
  HANDOFF_TEMPLATE_MAX,
  PHASE,
  findByTarget,
  openRosterStore,
  targetOf,
} from './roster.js'
import { resolveDataDir, resolveTrashLimit } from './trash.js'

export const name = 'dsh-team'

export const inject = ['agents', 'agentTeams', 'tools', 'tokenMeter', 'storageDomain', 'subagents']

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

const MEMBER_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'child_id', 'phase', 'generation', 'label', 'status', 'resident'],
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
    // True on a one-shot member that will retire itself once its turn ends (P4-01, ADR 0013).
    ephemeral: { type: 'boolean' },
    // Present on a result whose sweep retired finished ephemeral members; absent otherwise.
    swept: { type: 'integer' },
    swept_targets: { type: 'array', items: { type: 'string' } },
    // A spawn the Harness refused: no child exists, the record is `failed`, and `reason` says what the
    // model can do about it. Absent on a start that happened.
    started: { type: 'boolean' },
    reason: {
      type: 'string',
      enum: ['unsupported-capability', 'preset-unavailable', 'preset-not-found', 'preset-invalid', 'unauthorized'],
    },
    // What the member was started with: only the `spawn_options` fields the caller supplied, so a
    // plain spawn's result is unchanged and an applied model is never invisible (ADR 0016).
    started_with: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string' },
        agent_options: AGENT_OPTIONS_SCHEMA,
        agent_preset: { type: 'string' },
      },
    },
    message: { type: 'string' },
  },
}

const MEMBER_LIST_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['members'],
  properties: {
    members: { type: 'array', items: MEMBER_ROW },
    swept: { type: 'integer' },
    swept_targets: { type: 'array', items: { type: 'string' } },
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
    // Present when another generation of the stale target's name is live now; names that holder.
    current_holder: CURRENT_HOLDER,
    // `already-retired` on the state matrix's no-op row; absent on the retirements that happened.
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
    // false when this message cleared an ephemeral member's one-shot flag (P4-01).
    ephemeral: { type: 'boolean' },
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
    // pruned (the retention cap removed the artifact), or not-retired for a refusal.
    reason: { type: 'string' },
    path: { type: 'string' },
    // Present on a refusal when another generation of the stale target's name is live now.
    current_holder: CURRENT_HOLDER,
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
  required: ['template', 'stored', 'valid', 'message'],
  properties: {
    // The stored template, or '' when this Lead has none.
    template: { type: 'string' },
    stored: { type: 'boolean' },
    valid: { type: 'boolean' },
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
 * Install every Lead-scoped tool.
 * @param agent - exact Team Lead whose model should receive the tools.
 * @param ctx - plugin context.
 * @param store - promise of the roster table; resolved lazily by each roster tool.
 * @param hooks - host-side effects a retirement refreshes.
 * @param dataDir - plugin data directory the trash lives under.
 * @param trashLimit - the effective per-Lead trash cap resolved from the plugin config (ADR 0012).
 * @returns a disposer that unwinds every registration in reverse order.
 */
function install(agent, ctx, store, hooks, dataDir, trashLimit) {
  const scoped = agent.ctx
  const disposers = []
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
        const table = await store
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
      description: 'Create one named team member as a continuable subagent, or replace an existing member in one call. Pass replace to retire that member and start its successor from a handoff brief: the successor is told what the predecessor was doing, that it is the successor, and where the unfinished work is; it is not given the predecessor\'s transcript. A successor keeps the base name with the next generation suffix unless you name it. Record an assignment so a later successor can take this member\'s work over. Pass ephemeral: true for one-shot work: the member retires itself through the normal retirement path once it has run and stopped, so a parallel fan-out leaves the roster without one retire_member call per member. This call first sweeps members already in that state and reports the count.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'prompt'],
        properties: {
          name: { type: 'string', description: 'Lowercase base name: 1-32 letters, digits or hyphens, starting with a letter. Required unless replace is given; with replace it defaults to the predecessor\'s base name, which yields the next generation.' },
          label: { type: 'string', description: 'Short responsibility text shown in the roster.' },
          prompt: { type: 'string', description: 'Complete initial task for the member. With replace it is appended after the handoff brief.' },
          assignment: {
            type: 'string',
            maxLength: ASSIGNMENT_MAX,
            description: `Optional, 1-${ASSIGNMENT_MAX} characters: what this member is responsible for, stated durably. A successor is briefed with it when this member is replaced, and message_member replaces it later.`,
          },
          replace: {
            type: 'string',
            description: 'Target of an existing member to retire in the same call, such as reviewer. The successor starts first and the predecessor is retired second, so a failed start leaves the predecessor untouched; a failed retirement is reported as predecessor_retired: false. An already-retired target is accepted, and its tombstone supplies the brief.',
          },
          ephemeral: {
            type: 'boolean',
            description: 'Default false. True marks this member as one-shot: a lazy sweep at the start of list_members or spawn_member retires it through the normal retirement path once it has run and stopped, without a retire_member call. A member that never started, and one still running, are never swept. Message it again and the flag is cleared, because that message is a declaration it is not one-shot. list_members reports ephemeral: true on such a member.',
          },
          spawn_options: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional settings the member starts with. Omit the object, or any field in it, to inherit the Lead: an omitted member runs in the Lead\'s working directory, on the Lead\'s model and route, and with the Lead\'s tool set. What was applied is reported back in started_with, so a model chosen for a delegated task is never invisible. With replace, the successor starts with these options and the predecessor\'s record is unaffected.',
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
      output: { schema: MEMBER_ROW },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'spawn_member')
        requireLead(ctx, caller, 'spawn_member')
        if (typeof args.label !== 'string' || args.label.trim().length === 0) {
          throw new Error('spawn_member: label must be a non-empty string')
        }
        if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
          throw new Error('spawn_member: prompt must be a non-empty string')
        }
        if (args.name !== undefined && (typeof args.name !== 'string' || args.name.trim().length === 0)) {
          throw new Error('spawn_member: name must be a non-empty string')
        }
        if (args.replace !== undefined && (typeof args.replace !== 'string' || args.replace.length === 0)) {
          throw new Error('spawn_member: replace must be a non-empty string')
        }
        if (args.name === undefined && args.replace === undefined) {
          throw new Error('spawn_member: name is required unless replace is given')
        }
        if (args.assignment !== undefined && typeof args.assignment !== 'string') {
          throw new Error('spawn_member: assignment must be a string')
        }
        if (args.ephemeral !== undefined && typeof args.ephemeral !== 'boolean') {
          throw new Error('spawn_member: ephemeral must be a boolean')
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
        const table = await store
        return await spawnMember({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          dataDir,
          hooks,
          name: args.name,
          label: args.label,
          prompt: args.prompt,
          assignment: args.assignment,
          replace: args.replace,
          ephemeral: args.ephemeral,
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
      description: 'List every member and subagent this agent controls: members this plugin spawned, members the shipped team roster created, and children spawned with the shipped subagent or subagent_fork tools. Each row carries the target, the child session id, the lifecycle phase, the assignment recorded for it, ephemeral: true on a one-shot member that will retire itself, live state and, while resident, context pressure. Unknown children are adopted on the first read, and retired members stay listed as retired. This read first retires every ephemeral member whose turn has ended — through the same retirement path as retire_member, which is why those members then appear as retired — and reports swept and swept_targets when it retired any.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: { schema: MEMBER_LIST_VALUE },
      async execute(_args, exec) {
        const caller = callingAgent(exec.agent, 'list_members')
        requireLead(ctx, caller, 'list_members')
        const table = await store
        return await listMembers({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          dataDir,
          hooks,
          trashLimit,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'retire_member',
      description: `Retire one member: stop it, release its capacity slot, hide it from the workspace, and tombstone its record. This is the removal operation the shipped team roster does not have, and it works on any member list_members reports, including an adopted subagent. Its assignment stays on the tombstone for a later successor. The per-Lead trash keeps at most ${trashLimit} retired sessions, so a retirement that moves an artifact in removes the oldest ones and reports how many in pruned; a pruned member can no longer be restored. To retire a member and install its successor in the same call, use spawn_member with replace.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: 'Member target from list_members, such as reviewer or reviewer-g2.' },
          reason: { type: 'string', description: 'Optional short reason, stored on the record.' },
        },
      },
      output: { schema: RETIRE_VALUE },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'retire_member')
        requireLead(ctx, caller, 'retire_member')
        if (typeof args.target !== 'string' || args.target.length === 0) {
          throw new Error('retire_member: target must be a non-empty string')
        }
        const table = await store
        return await retireMember({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          leadAgent: caller,
          dataDir,
          hooks,
          target: args.target,
          reason: args.reason,
          trashLimit,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'restore_member',
      description: 'Bring a retired member back: move its trashed session to the path it came from and return the record to active. It refuses when a live member already uses the target, reports why when no artifact was recorded, and answers reason "pruned" when the trash retention cap already removed the artifact — a pruned member cannot be restored. A restored session may take one client refresh to reappear.',
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
        const table = await store
        return await restoreMember({
          ctx,
          table,
          leadSessionId: leadSessionIdOf(caller),
          target: args.target,
          hooks,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'message_member',
      description: 'Send one message to a live member or adopted subagent from list_members, and optionally replace the assignment recorded for it. A running child receives the message at its next step; an unloaded continuable child is resumed from its own Session, while a one-shot subagent cannot be resumed. A retired member cannot be messaged. Messaging an ephemeral member clears its one-shot flag, so it will not be swept — use that when the work is not over after all. Success means the inbox accepted the message, not that the member has processed it.',
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
        const table = await store
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
        const table = await store
        return await stopMember({ ctx, table, leadSessionId: leadSessionIdOf(caller), leadAgent: caller, target: args.target })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'handoff_template',
      description: 'Read, store or clear this Lead\'s handoff-brief template: the shape spawn_member with replace uses to brief a successor. Omit template to read back what is stored; pass a template to validate and store it; pass an empty string to clear it and return to the built-in brief. The template belongs to this Lead\'s own roster record, so it does not affect another Lead, and a Lead that never stores one keeps the built-in brief.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: {
            type: 'string',
            maxLength: HANDOFF_TEMPLATE_MAX,
            description: 'The template to store, or an empty string to clear it. Placeholders: {successor} and {predecessor} (their targets), {label} (the predecessor\'s role), {assignment} (what it was doing; required, or the successor is not told what it inherited) and {task_board} (the pointer to the shared team task board). An unknown placeholder is refused. The successor\'s own prompt is always appended after the rendered template.',
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
        const table = await store
        return await handoffTemplate({ table, leadSessionId: leadSessionIdOf(caller), template: args.template })
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
 * Install the tools in every live and subsequently published Lead scope.
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
  const dataDir = resolveDataDir()
  // The storage facility is the readiness barrier for the roster; a rejected open surfaces as a tool
  // error on first use instead of an unhandled rejection at load.
  const store = openRosterStore(ctx)
  store.catch(() => undefined)

  const log = (line) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
  }
  const readRetired = async () => {
    const table = await store
    const ids = new Set()
    for (const [, roster] of table.entries()) {
      for (const member of roster.members) if (member.phase === PHASE.retired) ids.add(member.childId)
    }
    return ids
  }
  const readRetiredByTeam = async () => {
    const table = await store
    const byTeam = new Map()
    for (const [leadSessionId, roster] of table.entries()) {
      const count = roster.members.filter((member) => member.phase === PHASE.retired).length
      if (count > 0) byTeam.set(leadSessionId, count)
    }
    return byTeam
  }
  const filter = installProjectionFilter(ctx, { readRetired, log })
  const slots = installSlotCredit(ctx, { readRetiredByTeam, log })
  if (slots.installed) void slots.refresh()
  const hooks = { filter, slots }
  ctx.effect(() => () => {
    filter.dispose()
    slots.dispose()
  }, 'team-roster.hostHooks()')

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
    installed.set(agent, install(agent, ctx, store, hooks, dataDir, trashLimit))
  }

  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'team-roster.scopedTools()')
}
