/**
 * Team roster — the Settings panel, browser half.
 *
 * The bundle declares `dsh.client` (`platform: web`) and the host composes this file into the page under
 * `/plugins`; the registration id must equal the package name. `settings.section` is a list slot owned by
 * the settings shell, so this panel is one page beside General, Models and Plugins.
 *
 * The panel renders the durable roster the Host owns and calls the same operations the model tools call,
 * through the HTTP bridge in `routes.js`. It polls that bridge while open, so a change made by a tool or
 * another tab appears here without a page reload.
 *
 * React (and only React) comes from the browser module table, so there is no build step. Visible text is
 * registered as a Client locale namespace: the slot receives `locale: 'team-roster'` and the framework
 * injects the `t` seat. The bundle's `locale/*.json` is Host-side plugin-catalog metadata, not a Client
 * dictionary source; the browser artifact cannot read files from the bundle directory.
 */

window.__ModuleLoader__.load({
  id: 'dsh-team-roster',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The bridge prefix registered by the Host half. */
    const API_BASE = '/api/team-roster'
    /** Client locale namespace owned by this panel. */
    const NS = 'team-roster'
    /** How often the panel re-reads the roster while it is open. */
    const POLL_MS = 3000
    /** Slot order: after General (0), Models (10) and before shell-only sections. */
    const SECTION_ORDER = 25

    /** Both built-in locales, because the locale service requires a complete pair. */
    const DICTIONARIES = {
      en: {
        nav: 'Team roster',
        title: 'Team roster',
        subtitle: 'Every roster this profile owns. Retiring drains a member and moves its session to the trash; restoring moves it back.',
        refresh: 'Refresh',
        loading: 'Loading rosters…',
        empty: 'No team roster has been recorded in this profile yet.',
        leadSession: 'Lead session',
        leadLive: 'live',
        leadOffline: 'not live',
        leadOfflineHint: 'This Lead session is not open, so its members cannot be retired right now.',
        members: 'members',
        noMembers: 'No members recorded.',
        generation: 'gen',
        context: 'Context pressure',
        resident: 'resident',
        notResident: 'not resident',
        phaseProvisioning: 'provisioning',
        phaseActive: 'active',
        phaseFailed: 'failed',
        phaseRetired: 'retired',
        statusRunning: 'running',
        statusIdle: 'idle',
        statusUnloaded: 'unloaded',
        retire: 'Retire',
        restore: 'Restore',
        confirmRetire: 'Retire "{}"? This drains the member, moves its session to the trash, and hides it from every client.',
        confirmRestore: 'Restore "{}"? Its session moves back to where it came from.',
        confirm: 'Confirm',
        cancel: 'Cancel',
        actionFailed: 'The operation failed.',
        requestFailed: 'The request failed',
      },
      zh: {
        nav: '团队花名册',
        title: '团队花名册',
        subtitle: '本 profile 内的全部花名册。退役会排空成员并把会话移入回收站；恢复会把它移回去。',
        refresh: '刷新',
        loading: '正在读取花名册…',
        empty: '本 profile 还没有任何团队花名册。',
        leadSession: 'Lead 会话',
        leadLive: '在线',
        leadOffline: '未在线',
        leadOfflineHint: '该 Lead 会话未打开，成员暂时无法退役。',
        members: '名成员',
        noMembers: '暂无成员。',
        generation: '代次',
        context: '上下文压力',
        resident: '驻留',
        notResident: '未驻留',
        phaseProvisioning: '创建中',
        phaseActive: '活跃',
        phaseFailed: '失败',
        phaseRetired: '已退役',
        statusRunning: '运行中',
        statusIdle: '空闲',
        statusUnloaded: '已卸载',
        retire: '退役',
        restore: '恢复',
        confirmRetire: '退役 “{}”？这会排空该成员、把会话移入回收站，并让所有客户端不再显示它。',
        confirmRestore: '恢复 “{}”？它的会话会被移回原路径。',
        confirm: '确认',
        cancel: '取消',
        actionFailed: '操作失败。',
        requestFailed: '请求失败',
      },
    }

    /** Phase key to dictionary key. */
    const PHASE_TEXT = {
      provisioning: 'phaseProvisioning',
      active: 'phaseActive',
      failed: 'phaseFailed',
      retired: 'phaseRetired',
    }
    /** Member status key to dictionary key. */
    const STATUS_TEXT = {
      running: 'statusRunning',
      idle: 'statusIdle',
      unloaded: 'statusUnloaded',
    }

    /** Locale fallback when the slot does not deliver a `t` seat. */
    const PREFERRED_LANGUAGE = typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string'
      ? navigator.language.toLowerCase()
      : 'en'
    const FALLBACK_TEXT = PREFERRED_LANGUAGE.startsWith('zh') ? DICTIONARIES.zh : DICTIONARIES.en
    const fallbackTranslate = (key) => FALLBACK_TEXT[key] ?? DICTIONARIES.en[key] ?? key

    /** The panel stylesheet: theme tokens only for colours, rendered by the component so unmounting drops it. */
    const CSS = [
      '.tr-panel{display:flex;flex-direction:column;gap:14px;max-width:760px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}',
      '.tr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.tr-title{margin:0;font-size:15px;font-weight:600;line-height:22px}',
      '.tr-sub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.tr-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}',
      '.tr-note{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.tr-empty{margin:0;padding:10px 14px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.tr-group{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2)}',
      '.tr-group-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}',
      '.tr-lead{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.tr-lead-id{color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:12px}',
      '.tr-badge{padding:1px 7px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.tr-badge--live{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.tr-head-right{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '.tr-count{color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}',
      '.tr-hint{padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.tr-rows{margin:0;padding:0;list-style:none}',
      '.tr-item+.tr-item{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.tr-row{display:flex;align-items:center;gap:10px;padding:9px 14px}',
      '.tr-main{display:flex;flex-direction:column;flex:1;min-width:0}',
      '.tr-target{overflow:hidden;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}',
      '.tr-label{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap}',
      '.tr-phase{padding:1px 7px;border:.5px solid currentColor;border-radius:999px;font-size:11px;line-height:16px;white-space:nowrap}',
      '.tr-phase--active{color:var(--dsw-alias-state-success-primary)}',
      '.tr-phase--provisioning{color:var(--dsw-alias-state-warn-primary)}',
      '.tr-phase--failed{color:var(--dsw-alias-state-error-primary)}',
      '.tr-phase--retired{color:var(--dsw-alias-label-tertiary)}',
      '.tr-meta{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}',
      '.tr-status--running{color:var(--dsw-alias-state-success-primary)}',
      '.tr-status--idle{color:var(--dsw-alias-state-business-primary)}',
      '.tr-status--unloaded{color:var(--dsw-alias-label-tertiary)}',
      '.tr-dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.tr-pressure{font-variant-numeric:tabular-nums}',
      '.tr-btn{padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.tr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.tr-btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.tr-btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.tr-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.tr-btn--primary{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.tr-confirm{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.tr-confirm-text{flex:1;min-width:0}',
    ].join('')

    /** One human-readable sentence from one already-localized template. */
    function fill(template, value) {
      return template.replace('{}', value)
    }

    /** Turn any thrown value into display text. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** A Session id short enough for a header, with the full value kept in `title`. */
    function shortId(id) {
      return id.length <= 12 ? id : `${id.slice(0, 8)}…`
    }

    /** Compact token counts: 1234 → 1.2k, 1048576 → 1.0M. */
    function formatTokens(tokens) {
      if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
      if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
      return String(tokens)
    }

    /** Read one JSON response, turning a non-2xx answer into an Error carrying the server's reason. */
    async function readJson(response, t) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : `${t('requestFailed')} (${String(response.status)})`)
      }
      return body
    }

    /**
     * The settings page: the roster grouped by Lead Session, with one action per member.
     * @param props - slot owner props `{ close }` plus the framework `t` seat and `renderSlot`.
     * @returns the panel element tree.
     */
    function TeamRosterPanel(props) {
      const t = typeof props?.t === 'function' ? props.t : fallbackTranslate
      const tRef = React.useRef(t)
      tRef.current = t

      const [status, setStatus] = React.useState('loading')
      const [rosters, setRosters] = React.useState([])
      const [readError, setReadError] = React.useState(undefined)
      const [actionError, setActionError] = React.useState(undefined)
      const [confirming, setConfirming] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)
      const alive = React.useRef(true)

      const load = React.useCallback(async () => {
        try {
          const body = await readJson(await fetch(`${API_BASE}/state`, { headers: { accept: 'application/json' } }), tRef.current)
          if (!alive.current) return
          setRosters(Array.isArray(body.rosters) ? body.rosters : [])
          setReadError(undefined)
          setStatus('ready')
        } catch (error) {
          if (!alive.current) return
          setReadError(messageOf(error))
          setStatus('ready')
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => {
          void load()
        }, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const run = async (kind, leadSessionId, target) => {
        setBusy(target)
        setActionError(undefined)
        try {
          const body = await readJson(await fetch(`${API_BASE}/${kind}`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ leadSessionId, target }),
          }), tRef.current)
          const refused = kind === 'retire' ? body.retired === false : body.restored === false
          if (refused) {
            setActionError(typeof body.message === 'string' ? body.message : tRef.current('actionFailed'))
          }
          setConfirming(undefined)
          await load()
        } catch (error) {
          setActionError(messageOf(error))
        } finally {
          setBusy(undefined)
        }
      }

      const startConfirm = (leadSessionId, target, kind) => {
        setActionError(undefined)
        setConfirming({ leadSessionId, target, kind })
      }

      const memberRow = (leadSessionId, member) => {
        const retired = member.phase === 'retired'
        const pending = confirming !== undefined && confirming.leadSessionId === leadSessionId && confirming.target === member.target
        const statusText = STATUS_TEXT[member.status] ?? 'statusUnloaded'
        const pressure = member.resident && typeof member.pressure_tokens === 'number' && typeof member.context_window === 'number'
          ? `${formatTokens(member.pressure_tokens)} / ${formatTokens(member.context_window)}${typeof member.usage_ratio === 'number' ? ` · ${String(Math.round(member.usage_ratio * 100))}%` : ''}`
          : undefined
        return h('li', { className: 'tr-item', key: member.target },
          h('div', { className: 'tr-row' },
            h('div', { className: 'tr-main' },
              h('span', { className: 'tr-target', title: member.target }, member.target),
              member.label === undefined ? null : h('span', { className: 'tr-label', title: member.label }, member.label)),
            h('span', { className: `tr-phase tr-phase--${member.phase}` }, t(PHASE_TEXT[member.phase] ?? member.phase)),
            h('span', { className: 'tr-meta', title: t('generation') }, `${t('generation')} ${String(member.generation)}`),
            retired ? null : h('span', {
              className: `tr-meta tr-status tr-status--${member.status}`,
              title: member.resident ? t('resident') : t('notResident'),
            }, h('span', { className: 'tr-dot' }), t(statusText)),
            pressure === undefined ? null : h('span', { className: 'tr-meta tr-pressure', title: t('context') }, pressure),
            h('div', { className: 'tr-actions' },
              retired
                ? h('button', {
                  type: 'button',
                  className: 'tr-btn',
                  disabled: busy !== undefined,
                  onClick: () => startConfirm(leadSessionId, member.target, 'restore'),
                }, t('restore'))
                : h('button', {
                  type: 'button',
                  className: 'tr-btn tr-btn--danger',
                  disabled: busy !== undefined,
                  onClick: () => startConfirm(leadSessionId, member.target, 'retire'),
                }, t('retire')))),
          pending
            ? h('div', { className: 'tr-confirm' },
              h('span', { className: 'tr-confirm-text' }, fill(
                t(pending.kind === 'retire' ? 'confirmRetire' : 'confirmRestore'),
                member.target,
              )),
              h('button', { type: 'button', className: 'tr-btn', disabled: busy !== undefined, onClick: () => setConfirming(undefined) }, t('cancel')),
              h('button', {
                type: 'button',
                className: 'tr-btn tr-btn--primary',
                disabled: busy !== undefined,
                onClick: () => void run(pending.kind, leadSessionId, member.target),
              }, busy === member.target ? '…' : t('confirm')))
            : null)
      }

      const group = (roster) => h('section', { className: 'tr-group', key: roster.leadSessionId },
        h('div', { className: 'tr-group-head' },
          h('span', { className: 'tr-lead' }, t('leadSession')),
          h('code', { className: 'tr-lead-id', title: roster.leadSessionId }, shortId(roster.leadSessionId)),
          h('span', { className: `tr-badge${roster.leadLive ? ' tr-badge--live' : ''}` }, roster.leadLive ? t('leadLive') : t('leadOffline')),
          h('span', { className: 'tr-head-right' },
            h('span', { className: 'tr-count' }, `${String(roster.members.length)} ${t('members')}`))),
        roster.leadLive ? null : h('div', { className: 'tr-hint' }, t('leadOfflineHint')),
        roster.members.length === 0
          ? h('div', { className: 'tr-empty' }, t('noMembers'))
          : h('ul', { className: 'tr-rows' }, roster.members.map((member) => memberRow(roster.leadSessionId, member))))

      return h('div', { className: 'tr-panel' },
        h('style', null, CSS),
        h('div', { className: 'tr-head' },
          h('div', null,
            h('h2', { className: 'tr-title' }, t('title')),
            h('p', { className: 'tr-sub' }, t('subtitle'))),
          h('div', { className: 'tr-actions' },
            h('button', {
              type: 'button',
              className: 'tr-btn',
              disabled: status === 'loading',
              onClick: () => void load(),
            }, t('refresh')))),
        actionError === undefined ? null : h('p', { className: 'tr-note', role: 'alert' }, actionError),
        readError === undefined ? null : h('p', { className: 'tr-note', role: 'alert' }, readError),
        status === 'loading' && rosters.length === 0
          ? h('p', { className: 'tr-empty' }, t('loading'))
          : rosters.length === 0
            ? h('p', { className: 'tr-empty' }, t('empty'))
            : rosters.map(group))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'team-roster: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'team-roster',
          order: SECTION_ORDER,
          label: () => t('nav'),
          locale: NS,
        }, TeamRosterPanel))
      },
    }
  },
})
