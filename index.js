/**
 * Team Control — a team roster whose members can be retired, removed and replaced.
 *
 * Host half. It owns the roster (`roster.js`), exposes it as Lead-scoped tools, and compacts one
 * member's context in place. The shipped team tool row is disabled by the bundle patch so only one
 * roster answers the model; the shipped roster *service* stays mounted so this plugin can adopt the
 * members it created before the switch, and can keep using its Lead membership test.
 *
 * Tools: `spawn_member`, `list_members`, `message_member`, `stop_member`, `retire_member`,
 * `compact_member`.
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
  PHASE,
  adoptMember,
  findByTarget,
  liveStateOf,
  openRosterStore,
  planMember,
  readRoster,
  targetOf,
  updateRoster,
  withMember,
  writeRoster,
} from './roster.js'

export const name = 'team-control'

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

/** Read live context pressure for one resident member. */
function pressureOf(ctx, agent) {
  const { pressureTokens, contextWindow } = ctx.tokenMeter.contextPressure(agent.session)
  const ratio = contextWindow > 0 ? pressureTokens / contextWindow : undefined
  return { pressureTokens, contextWindow, ratio }
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
  required: ['target', 'phase', 'generation', 'label', 'status', 'resident'],
  properties: {
    target: { type: 'string' },
    phase: { type: 'string', enum: ['provisioning', 'active', 'retired', 'failed'] },
    generation: { type: 'integer' },
    label: { type: 'string' },
    status: { type: 'string', enum: ['running', 'idle', 'unloaded', 'unknown'] },
    resident: { type: 'boolean' },
    pressure_tokens: { type: 'integer' },
    context_window: { type: 'integer' },
    usage_ratio: { type: 'number' },
    compactable: { type: 'boolean' },
    note: { type: 'string' },
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

/** Project one stored member into its model-facing row. */
function memberRow(ctx, member) {
  const live = liveStateOf(ctx, member)
  const compactor = ctx.get('compaction') !== undefined
  const row = {
    target: targetOf(member),
    phase: member.phase,
    generation: member.generation,
    label: member.label,
    status: live.status,
    resident: live.resident,
    compactable: compactor && live.status === 'idle',
  }
  if (live.resident) {
    const agent = ctx.agents.get(member.childId)
    if (agent !== undefined) {
      try {
        const { pressureTokens, contextWindow, ratio } = pressureOf(ctx, agent)
        // A child that has not issued a model request yet has no measurable window. Assigning
        // `undefined` would make the tool result non-lossless JSON, which the registry rejects.
        if (Number.isFinite(pressureTokens)) row.pressure_tokens = pressureTokens
        if (Number.isFinite(contextWindow)) row.context_window = contextWindow
        if (typeof ratio === 'number') row.usage_ratio = ratio
      } catch (error) {
        row.note = 'Context pressure is not measurable for this member yet.'
      }
    }
  }
  return row
}

/**
 * Adopt members the shipped roster created before this plugin owned the roster, so retirement and
 * messaging apply to them too. Idempotent: a member is adopted at most once, matched by child Session id.
 * @returns the roster, including any newly adopted members.
 */
async function ensureAdopted(ctx, caller, table, leadSessionId) {
  const roster = readRoster(table, leadSessionId)
  const known = new Set(roster.members.map((member) => member.childId))
  const shipped = ctx.agentTeams.listMembers(caller).filter(
    (member) => member.role === 'teammate' && !known.has(member.id),
  )
  if (shipped.length === 0) return roster
  let next = roster
  for (const row of shipped) {
    const adopted = adoptMember(next, row)
    if (adopted !== undefined) next = withMember(next, adopted)
  }
  return await writeRoster(table, leadSessionId, next)
}

/**
 * Install every Lead-scoped tool.
 * @param agent - exact Team Lead whose model should receive the tools.
 * @param ctx - plugin context.
 * @param store - promise of the roster table; resolved lazily by each roster tool.
 * @returns a disposer that unwinds every registration in reverse order.
 */
function install(agent, ctx, store) {
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
      description: 'Create one named team member. The member runs as a continuable subagent, reports back through a completion notice, and can be retired later. A successor reuses the same base name with the next generation suffix.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'label', 'prompt'],
        properties: {
          name: { type: 'string', description: 'Lowercase base name: 1-32 letters, digits or hyphens, starting with a letter.' },
          label: { type: 'string', description: 'Short responsibility text shown in the roster.' },
          prompt: { type: 'string', description: 'Complete initial task for the member.' },
        },
      },
      output: { schema: MEMBER_ROW },
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'spawn_member')
        requireLead(ctx, caller, 'spawn_member')
        if (typeof args.name !== 'string' || typeof args.label !== 'string' || typeof args.prompt !== 'string') {
          throw new Error('spawn_member: name, label and prompt must be strings')
        }
        const table = await store
        const leadSessionId = leadSessionIdOf(caller)
        const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
        const planned = planMember(roster, args.name, args.label)
        // Persist the reservation before starting anything: a crash must leave a visible member,
        // never an invisible child.
        await writeRoster(table, leadSessionId, withMember(roster, planned))
        let started
        try {
          started = await ctx.subagents.startActivation({
            delivery: 'parent',
            childId: planned.childId,
            provider: 'spawn',
            label: args.label,
            request: { prompt: [{ type: 'text', text: args.prompt }], parent: caller },
            signal: exec.signal,
          })
        } catch (error) {
          const failed = {
            ...planned,
            phase: PHASE.failed,
            note: error instanceof Error ? error.message : String(error),
          }
          await updateRoster(table, leadSessionId, (roster) => withMember(roster, failed))
          throw error
        }
        const active = { ...planned, childId: started.childId ?? planned.childId, phase: PHASE.active }
        await updateRoster(table, leadSessionId, (roster) => withMember(roster, active))
        return memberRow(ctx, active)
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'list_members',
      description: 'List every member of this roster with its lifecycle phase, live state and, while resident, its context pressure. Retired members stay listed as retired. Members the shipped roster created before this plugin existed are adopted on first use.',
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
        const leadSessionId = leadSessionIdOf(caller)
        const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
        return { members: roster.members.map((member) => memberRow(ctx, member)) }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'retire_member',
      description: 'Retire one member: stop it, release its capacity slot, hide it from the workspace, and tombstone its record. This is the removal operation the shipped team roster does not have. A successor can then reuse the base name at the next generation.',
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
        const leadSessionId = leadSessionIdOf(caller)
        const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
        const member = findByTarget(roster, args.target)
        if (member === undefined) throw new Error(`retire_member: no live member named "${args.target}"`)

        let drained = false
        try {
          await ctx.subagents.drainChildren(caller, [member.childId])
          drained = true
        } catch (error) {
          // A child that never published, or already settled, has nothing to drain. Retirement is a
          // lifecycle fact owned by the record, so it proceeds.
        }

        let archived = false
        const workspace = ctx.get('workspaceRegistry')
        if (workspace !== undefined) {
          try {
            await workspace.archiveSession(member.childId, { stopActivity: true })
            archived = true
          } catch (error) {
            // Archiving is presentation only; it must never block retirement.
          }
        }

        const retired = { ...member, phase: PHASE.retired, retiredAt: new Date().toISOString() }
        if (typeof args.reason === 'string' && args.reason.length > 0) retired.retireReason = args.reason
        await updateRoster(table, leadSessionId, (roster) => withMember(roster, retired))
        return {
          target: targetOf(member),
          retired: true,
          drained,
          archived,
          message: 'Member retired: drained, tombstoned, and archived when the workspace service is available.',
        }
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'message_member',
      description: 'Send one message to a live member. A running member receives it at its next step; an unloaded member is resumed from its own Session. A retired member cannot be messaged. Success means the inbox accepted the message, not that the member has processed it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'message'],
        properties: {
          target: { type: 'string', description: 'Member target from list_members.' },
          message: { type: 'string', description: 'Self-contained message for the member.' },
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
        const table = await store
        const leadSessionId = leadSessionIdOf(caller)
        const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
        const member = findByTarget(roster, args.target)
        if (member === undefined) throw new Error(`message_member: no live member named "${args.target}"`)
        let messageId
        try {
          messageId = await ctx.subagents.sendMessage(
            caller,
            member.childId,
            [{ type: 'text', text: args.message }],
            { signal: exec.signal },
          )
        } catch (error) {
          throw new Error(`message_member: the subagent service rejected the message: ${error instanceof Error ? error.message : String(error)}`)
        }
        const value = {
          target: targetOf(member),
          sent: true,
          message: 'Message accepted. A running member sees it at its next step; an unloaded one is resumed.',
        }
        if (typeof messageId === 'string') value.message_id = messageId
        return value
      },
    })))

    register(scoped.tools.register(defineTool({
      name: 'stop_member',
      description: 'Cancel one member\'s current turn immediately. The activation, its inbox and its record are kept, so a later message resumes it; use retire_member to end a member for good.',
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
        const leadSessionId = leadSessionIdOf(caller)
        const roster = await ensureAdopted(ctx, caller, table, leadSessionId)
        const member = findByTarget(roster, args.target)
        if (member === undefined) throw new Error(`stop_member: no live member named "${args.target}"`)
        if (ctx.agents.get(member.childId) === undefined) {
          return {
            target: targetOf(member),
            stopped: true,
            resident: false,
            message: 'The member was not resident; nothing to stop.',
          }
        }
        ctx.subagents.interrupt(member.childId, { kind: 'ancestor', agent: caller })
        return {
          target: targetOf(member),
          stopped: true,
          resident: true,
          message: 'Its current turn was cancelled. The activation and its inbox are kept; message_member wakes it again.',
        }
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
  // The storage facility is the readiness barrier for the roster; a rejected open surfaces as a tool
  // error on first use instead of an unhandled rejection at load.
  const store = openRosterStore(ctx)
  store.catch(() => undefined)

  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined || membership.role !== 'lead') return
    installed.set(agent, install(agent, ctx, store))
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
  }, 'team-control.scopedTools()')
}
