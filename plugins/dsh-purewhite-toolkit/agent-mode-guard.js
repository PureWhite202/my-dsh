/**
 * agent-mode-guard — 「智能体模式」Agent 预设的执行守卫。
 *
 * 选了这个预设的会话，第一轮开始前做三件事：
 *   1. 把 Agent Teams 任务板自动打开（写一次 `team/mode { enabled: true }`）；
 *   2. 每步注入一段协调者规则：一条消息一个工单、先回执、派完结束本轮、不空等、
 *      补充信息发给正在做的人、完成即汇报（时间接近的合并；只有「一个大点拆给多个
 *      子智能、必须都齐才能验证」才等）。放在运行时上下文里，压缩后仍在；
 *   3. （可选）用工具守卫拦下写文件和跑命令的工具，防宿主级/插件级写入工具绕过预设清单。
 *
 * 为什么钉在 agent/pre-step 而不是 agent/created：
 *   新任务页的空白会话在打开时就已经建好 Agent，之后切换模式走的是 blank Session 的
 *   重新组合，不会再触发 agent/created。agent/pre-step 在 turn/start 之前、请求组装
 *   之前，是运行时唯一的追加点；用「首轮」条件（lastTurn === 0）只钉一次，就能同时
 *   覆盖创建和空白会话切换两条路径，而且不会在后续轮次覆盖用户手动关掉的任务板。
 *
 * 依赖：宿主服务 agents / agentPresets / systemPrompt；工具守卫额外需要 tools，
 * 任务板需要 agentTeams —— 后两者缺失时对应功能静默跳过，守卫本身照常工作。
 * 不导入任何 @deepseek-ai 包，事件按既有类型直接追加。
 */

export const name = 'agent-mode-guard'

/** 守卫必需的服务；tools / agentTeams 用 ctx.inject 和 ctx.get 按需取。 */
export const inject = ['agents', 'agentPresets', 'systemPrompt']

/** 默认的 Agent 预设 id。 */
const DEFAULT_PRESET = 'agent-mode'

/**
 * 默认拦下的工具名：全都是「能改文件 / 能跑命令」的能力。
 * 预设里本来就不挂这些工具，这里是给宿主级插件（例如以后的 MCP 文件工具）兜底。
 */
const DEFAULT_DENY_TOOLS = [
  'write',
  'edit',
  'apply_patch',
  'str_replace_editor',
  'bash',
  'pwsh',
  'terminal_open',
  'terminal_send',
  'job_output',
]

/** 模型可见的协调者规则，只在智能体模式的会话里出现。 */
const NOTICE = [
  'You are in Agent Mode (coordinator). You analyse the request, verify facts, confirm the plan with the user, and hand implementation to teammates. You have no tools that change files or run commands: do not attempt them and do not ask for permission to use them.',
  'Every user message is its own work item. Reply in one or two sentences first — what you will do and who handles it — then dispatch and end your turn. Do not idle-wait after dispatching: a finished teammate wakes you with a new request.',
  'Track each dispatched item on the shared task board, send extra details to the teammate already handling it instead of starting a second one, and never run two items against the same files at once.',
  'Report each work item the moment it is done, with what changed, which files, and how it was verified; dispatch a verifier when the check needs commands. Do not hold reports until the whole plan is finished — one finished point is already worth one report. If two items finish close together, merge them into a single report instead of sending two near-identical messages.',
  'The only reason to hold a report back is a work item you split across several teammates whose combined result is needed before anything can be verified: wait for the remaining ones (wait_agent), verify the combined result, then report once. In every other case report the finished point immediately and let the other items land in their own reports.',
].join(' ')

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 见 README 的配置表，全部可省略。
 */
export function apply(ctx, config = {}) {
  if (ctx === null || typeof ctx !== 'object') return
  const preset = stringOption(config, 'preset', DEFAULT_PRESET)
  const teamMode = booleanOption(config, 'teamMode', true)
  const guardWriteTools = booleanOption(config, 'guardWriteTools', true)
  const denyTools = new Set(listOption(config?.denyTools, DEFAULT_DENY_TOOLS))

  // 1) 每步刷新的协调者规则：只在智能体模式的会话里返回文本，其余会话返回空串。
  if (ctx.systemPrompt !== undefined && typeof ctx.systemPrompt.context === 'function') {
    const base =
      typeof ctx.systemPrompt.getContextOrder === 'function'
        ? ctx.systemPrompt.getContextOrder('APPROVAL_POLICY')
        : undefined
    const order = typeof base === 'number' && Number.isFinite(base) ? base + 2 : 117
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: 'agent-mode:coordinator',
          order,
          text: (context) => noticeFor(ctx, preset, context),
        }),
      'dsh-purewhite-toolkit: agent-mode prompt context',
    )
  }

  // 2) 首轮把任务板打开；用户之后手动关掉不抢回来。
  if (teamMode && typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async ({ agent } = {}, next) => {
      const decision = await next()
      try {
        pinTeamMode(ctx, agent, preset)
      } catch (error) {
        ctx.logger?.warn?.('agent-mode-guard: failed to enable team mode: %o', error)
      }
      return decision
    })
  }

  // 3) 兜底：智能体模式的会话里，写类工具即使存在也拒绝执行。
  if (guardWriteTools && typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      const tools = scope?.tools
      if (tools === undefined || typeof tools.guard !== 'function') return
      ctx.effect(
        () => tools.guard((execution) => denialFor(ctx, preset, denyTools, execution)),
        'dsh-purewhite-toolkit: agent-mode tool guard',
      )
    })
  }
}

/**
 * 会话属于智能体预设、且还在第一轮时，写一次 `team/mode { enabled: true }`。
 * 只在首轮生效，后续轮次与恢复会话都不再改写任务板开关。
 * @param ctx Cordis 上下文。
 * @param agent 当前调用的 Agent。
 * @param preset 智能体模式的预设 id。
 * @returns 是否真的写入了事件。
 */
function pinTeamMode(ctx, agent, preset) {
  const session = agent?.session
  if (session === undefined || session === null) return false
  if (session.header?.origin === 'subagent') return false
  if (presetFor(ctx, session) !== preset) return false

  const boundary =
    typeof ctx.agents?.turnBoundaryOf === 'function' ? ctx.agents.turnBoundaryOf(session) : undefined
  if (boundary === undefined || boundary === null || boundary.lastTurn !== 0) return false

  const team = serviceOf(ctx, 'agentTeams')
  if (team === undefined || team === null) return false
  if (typeof team.isEnabled === 'function') {
    let enabled = false
    try {
      enabled = team.isEnabled(agent) === true
    } catch {
      // 拿不到团队身份时按「未开启」处理，继续追加一次开关事件。
      enabled = false
    }
    if (enabled) return false
  }
  if (typeof session.append !== 'function') return false

  session.append('team/mode', { enabled: true })
  return true
}

/**
 * 生成运行时上下文里的一段协调者规则；非智能体模式的会话返回空串。
 * @param ctx Cordis 上下文。
 * @param preset 智能体模式的预设 id。
 * @param context 请求组装上下文。
 * @returns 模型可见文本。
 */
function noticeFor(ctx, preset, context) {
  const session = context?.agent?.session
  if (session === undefined || session === null) return ''
  return presetFor(ctx, session) === preset ? NOTICE : ''
}

/**
 * 工具守卫：智能体模式的会话里拒绝写文件和跑命令的工具。
 * @param ctx Cordis 上下文。
 * @param preset 智能体模式的预设 id。
 * @param denyTools 需要拦截的工具名集合。
 * @param execution 这次工具调用。
 * @returns 拒绝理由；不需要拦截时返回 undefined。
 */
function denialFor(ctx, preset, denyTools, execution) {
  const session = execution?.agent?.session
  if (session === undefined || session === null) return undefined
  if (presetFor(ctx, session) !== preset) return undefined

  const toolName = typeof execution?.name === 'string' ? execution.name : ''
  if (toolName === '' || !denyTools.has(toolName)) return undefined
  return `Agent Mode keeps file changes and commands with teammates: "${toolName}" is disabled in the coordinator session. Dispatch the work with the subagent tool instead.`
}

/**
 * 会话记录的 Agent 预设 id。
 * @param ctx Cordis 上下文。
 * @param session 目标会话。
 * @returns 预设 id；无法读取时为 null。
 */
function presetFor(ctx, session) {
  if (session === undefined || session === null) return null
  try {
    return typeof ctx.agentPresets?.presetForSession === 'function'
      ? ctx.agentPresets.presetForSession(session)
      : null
  } catch {
    return null
  }
}

/**
 * 取一个可选服务。优先走 ctx.get，取不到再退回属性访问，两条都失败就返回 undefined。
 * @param ctx Cordis 上下文。
 * @param serviceName 服务名。
 * @returns 服务实例或 undefined。
 */
function serviceOf(ctx, serviceName) {
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(serviceName)
      if (service !== undefined && service !== null) return service
    }
  } catch {
    // 忽略：继续尝试属性访问。
  }
  try {
    const service = ctx[serviceName]
    return service === undefined ? undefined : service
  } catch {
    return undefined
  }
}

/**
 * 读取字符串型配置，空值回退默认值。
 * @param config 插件配置。
 * @param key 字段名。
 * @param fallback 缺省值。
 * @returns 配置值或默认值。
 */
function stringOption(config, key, fallback) {
  const value = config?.[key]
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * 读取布尔型配置，缺省回退默认值。
 * @param config 插件配置。
 * @param key 字段名。
 * @param fallback 缺省值。
 * @returns 布尔值。
 */
function booleanOption(config, key, fallback) {
  const value = config?.[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 读取字符串数组配置；不是数组或为空时用默认名单。
 * @param value 配置值。
 * @param fallback 默认名单。
 * @returns 工具名数组。
 */
function listOption(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const names = value.filter((item) => typeof item === 'string' && item !== '')
  return names.length === 0 ? fallback : names
}
