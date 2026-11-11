/**
 * Team Roster — a team roster whose members can be retired, removed and replaced.
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
 * `restore_member`, `compact_member`. The operation bodies live in `actions.js`; this file keeps
 * argument validation, the Lead-only authority check, and the tool result schemas, and nothing else.
 * The plugin has no browser half: it is entirely model-facing (ADR 0008).
 *
 * `spawn_member` with `replace` is the whole replacement: it starts the successor from a short handoff
 * brief composed from the assignment recorded on the predecessor's record, then retires the
 * predecessor in the same call (ADR 0009). The work itself stays on the shipped team task board, which
 * this plugin does not own; the brief points the successor at it.
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
 */

import {
  ensureAdopted,
  listMembers,
  messageMember,
  pressureOf,
  retireMember,
  restoreMember,
  spawnMember,
  stopMember,
} from './actions.js'
import { installProjectionFilter, installSlotCredit } from './host-hooks.js'
import { ASSIGNMENT_MAX, PHASE, findByTarget, openRosterStore, targetOf } from './roster.js'
import { resolveDataDir } from './trash.js'

export const name = 'team-roster'

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

/** Refuse every caller that is not the Lead of its own Team. */
function requireLead(ctx, caller, toolName) {
  const membership = ctx.agentTeams.tryMembership(caller)
  if (membership === undefined || membership.role !== 'lead') {
    throw new Error(`${toolName} is available to the Team Lead only`)
  }
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
    status: { type: 'string', enum: ['running', 'idle', 'unloaded', 'unknown'] },
    resident: { type: 'boolean' },
    assignment: { type: 'string' },
    pressure_tokens: { type: 'integer' },
    context_window: { type: 'integer' },
    usage_ratio: { type: 'number' },
    compactable: { type: 'boolean' },
    note: { type: 'string' },
    replaced: { type: 'string' },
    predecessor_retired: { type: 'boolean' },
    message: { type: 'string' },
  },
}

const MEMBER_LIST_VALUE = {
  type: 'object',
  additionalProperties: false,
  required: ['members'],
  properties: { members: { type: 'array', items: MEMBER_ROW } },
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
    message_id: { type: 'string' },
    assignment: { type: 'string' },
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
    path: { type: 'string' },
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
    resident: { type: 'boolean' },
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
 * @returns a disposer that unwinds every registration in reverse order.
 */
function install(agent, ctx, store, hooks, dataDir) {
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
        if (typeof result.shadowedTokenCount === 'number') value.shadowed_tokens = result.shadowedTokenCount
        return value
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'spawn_member',
      description: 'Create one named team member as a continuable subagent, or replace an existing member in one call. Pass replace to retire that member and start its successor from a handoff brief: the successor is told what the predecessor was doing, that it is the successor, and where the unfinished work is; it is not given the predecessor\'s transcript. A successor keeps the base name with the next generation suffix unless you name it. Record an assignment so a later successor can take this member\'s work over.',
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
        },
      },
      output: { schema: MEMBER_ROW },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'spawn_member')
        requireLead(ctx, caller, 'spawn_member')
        if (typeof args.label !== 'string' || typeof args.prompt !== 'string') {
          throw new Error('spawn_member: label and prompt must be strings')
        }
        if (args.name !== undefined && typeof args.name !== 'string') {
          throw new Error('spawn_member: name must be a string')
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
          signal: exec.signal,
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_members',
      description: 'List every member and subagent this agent controls: members this plugin spawned, members the shipped team roster created, and children spawned with the shipped subagent or subagent_fork tools. Each row carries the target, the child session id, the lifecycle phase, the assignment recorded for it, live state and, while resident, context pressure. Unknown children are adopted on the first read, and retired members stay listed as retired.',
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
        return await listMembers({ ctx, table, leadSessionId: leadSessionIdOf(caller), leadAgent: caller })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'retire_member',
      description: 'Retire one member: stop it, release its capacity slot, hide it from the workspace, and tombstone its record. This is the removal operation the shipped team roster does not have, and it works on any member list_members reports, including an adopted subagent. Its assignment stays on the tombstone for a later successor. To retire a member and install its successor in the same call, use spawn_member with replace.',
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
        })
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'restore_member',
      description: 'Bring a retired member back: move its trashed session to the path it came from and return the record to active. It refuses when a live member already uses the target, and reports why when no artifact was recorded. A restored session may take one client refresh to reappear.',
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
      description: 'Send one message to a live member or adopted subagent from list_members, and optionally replace the assignment recorded for it. A running child receives the message at its next step; an unloaded continuable child is resumed from its own Session, while a one-shot subagent cannot be resumed. A retired member cannot be messaged. Success means the inbox accepted the message, not that the member has processed it.',
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
        if (typeof args.message !== 'string' || args.message.length === 0) {
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
 * @param ctx - plugin context.
 */
export function apply(ctx) {
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
    if (membership === undefined || membership.role !== 'lead') return
    installed.set(agent, install(agent, ctx, store, hooks, dataDir))
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
