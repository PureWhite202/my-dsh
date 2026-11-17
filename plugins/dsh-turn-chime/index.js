/**
 * dsh-turn-chime — 主页里有人类对话的会话结束时响一声，模型反问用户时另响一声。
 *
 * 宿主侧插件：订阅 DSH 的 `session/event`。处理这些事件：
 *   - `user/message`：记录这个会话出现过主页客户端提交的真人消息；
 *   - `tool/call` 里的询问工具：播提问音；
 *   - `turn/end`：这个会话的一轮结束时播结束音。
 *
 * 默认只对「主页主对话」响：
 *   - 子代理会话（`origin === 'subagent'` 或 `delegationDepth > 0`）不响；
 *   - 会话里必须出现过客户端提交的真人消息（`source.kind === 'user'` 且带 `rpcId`）；
 *     纯模型自测、定时任务、后台作业等没有真人消息的会话不响；
 *   - 不要求结束的这一轮正好由真人消息开头；长任务被后台通知续跑后结束也会响；
 *   - 用户自己取消（`aborted`）和 fork（`forked`）不响；
 *   - 结束音和提问音各自去抖：同一类 800ms 内只响一次，两类互不吞音。
 *
 * 播放走独立进程（Windows 上是 `powershell.exe` + `System.Media.SoundPlayer`），
 * 不阻塞宿主事件循环。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名，与 `cordis.patch.yml` 里的 `name` 一致。 */
export const name = 'dsh-turn-chime'

/** 插件自带音效所在目录。 */
const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url))

/** 内置音效名 → 文件名。只有两个：1 = 结束（下行），2 = 提问（上行）。 */
const BUILTIN_SOUNDS = new Map([
  ['1', '1.wav'],
  ['2', '2.wav'],
])

/** 结束音；不读 `C:\Windows\Media`，也不碰系统通知音。 */
const DEFAULT_SOUND = '1'

/** 默认提问音，和结束音方向相反。 */
const DEFAULT_ASK_SOUND = '2'

/**
 * 默认算作「模型在问用户」的工具：`ask_user_question` 弹问题卡片，
 * `exit_plan_mode` 弹计划评审，两者都会卡住等用户回答。
 */
const DEFAULT_ASK_TOOLS = ['ask_user_question', 'exit_plan_mode']

/** `turn/end` 的 reason.kind 里，默认值得响一声的那几种。 */
const DEFAULT_REASONS = ['completed', 'error', 'blocked', 'max-tokens', 'interrupted']

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 见 INSTALL.md 的配置表；全部可选。
 */
export function apply(ctx, config = {}) {
  const options = resolveConfig(config ?? {})
  if (!options.enabled) return

  /** 会话 id → 该会话是否出现过主页客户端的真人消息。 */
  const conversations = new Map()

  let lastTurnChimeAt = 0
  let lastAskChimeAt = 0

  // 启动时先响一次，用来确认加载的是哪个音效（默认关）。
  if (options.announce) {
    const timer = setTimeout(() => {
      play(options.sound, options.command, options.volume)
    }, 900)
    timer.unref?.()
  }

  /**
   * 会话是否出现过主页客户端的真人消息。
   * 没在内存里记过时回看一次历史，插件重载后也能识别正在进行的对话。
   * @param session 当前会话。
   * @returns 有过真人消息返回 true。
   */
  const isHumanConversation = (session) => {
    const id = session?.id
    if (typeof id !== 'string') return false
    const known = conversations.get(id)
    if (known !== undefined) return known
    const found = scanForClientPrompt(session, options)
    conversations.set(id, found)
    return found
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event === null || typeof event !== 'object') return

      // 子代理和（主对话模式下的）非根会话都不响。
      if (options.skipSubagents && isSubagentSession(session)) return
      if (options.mainConversationOnly && !isRootSession(session)) return

      // 只要这个会话里出现过主页客户端的真人消息，就把它算作主对话。
      if (event.type === 'user/message') {
        if (isClientPrompt(event.data, options) && typeof session?.id === 'string') {
          conversations.set(session.id, true)
        }
        return
      }

      // 提问音：模型调用询问用户的工具，和结束音分开。
      if (event.type === 'tool/call') {
        if (options.askSound === null) return
        if (options.mainConversationOnly && !isHumanConversation(session)) return

        const tool = event.data?.name
        if (typeof tool !== 'string' || !options.askTools.has(tool)) return

        const now = Date.now()
        if (now - lastAskChimeAt < options.debounceMs) return
        lastAskChimeAt = now

        chime(ctx, options, `ask:${tool}`, options.askSound, session)
        return
      }

      if (event.type !== 'turn/end') return
      if (options.mainConversationOnly && !isHumanConversation(session)) return

      const kind = event.data?.reason?.kind ?? 'completed'
      if (!options.reasons.has(kind)) return

      const now = Date.now()
      if (now - lastTurnChimeAt < options.debounceMs) return
      lastTurnChimeAt = now

      const sound = kind === 'error' && options.errorSound ? options.errorSound : options.sound
      chime(ctx, options, kind, sound, session)
    } catch (error) {
      // 提示音不能反过来把会话搞坏。
      ctx.logger?.warn?.(`dsh-turn-chime: chime failed: ${error?.message ?? error}`)
    }
  })
}

/**
 * 一条用户消息是不是主页客户端提交的真人消息。
 * @param message `user/message` 的 data。
 * @param options 归一化后的配置。
 * @returns 真人消息返回 true；注入的运行时上下文、子代理通知、目标推进等返回 false。
 */
function isClientPrompt(message, options) {
  const source = message?.source
  if (source === null || typeof source !== 'object' || source.kind !== 'user') return false
  if (!options.requireClientPrompt) return true
  // Web UI 提交的用户消息带 rpcId；模型/插件注入的消息没有。
  return typeof source.rpcId === 'string' && source.rpcId.trim() !== ''
}

/**
 * 回看会话历史，找有没有主页客户端的真人消息。
 * 插件重载后内存状态会丢，用它识别正在进行的对话。
 * @param session 当前会话。
 * @param options 归一化后的配置。
 * @returns 找到真人消息返回 true。
 */
function scanForClientPrompt(session, options) {
  if (typeof session?.snapshotEvents !== 'function') return false
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return false
  }
  if (!Array.isArray(events)) return false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && isClientPrompt(event.data, options)) return true
  }
  return false
}

/**
 * 是否是子代理会话。
 * @param session 当前会话。
 * @returns 子代理（含嵌套子代理）返回 true；无法读取 header 时按子代理处理。
 */
function isSubagentSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return true
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * 是否是主页根会话（非子代理）。
 * @param session 当前会话。
 * @returns 根会话返回 true。
 */
function isRootSession(session) {
  const header = session?.header
  return header !== null && typeof header === 'object' && !isSubagentSession(session)
}

/**
 * 播一声并记录日志：调试模式下写一行「触发原因 → 音效」。
 * @param ctx Cordis 上下文（取 logger）。
 * @param options 归一化后的配置。
 * @param label 触发原因，例如 `completed` 或 `ask:ask_user_question`。
 * @param sound 音效文件路径或自定义命令。
 * @param session 当前会话，仅用于日志。
 */
function chime(ctx, options, label, sound, session) {
  if (options.debug) {
    ctx.logger?.info?.(`dsh-turn-chime: ${label} → ${sound} (session ${session?.id ?? '?'})`)
  }
  if (!play(sound, options.command, options.volume)) {
    ctx.logger?.warn?.(`dsh-turn-chime: 音效文件不存在，跳过播放: ${sound}`)
  }
}

/**
 * 补齐默认值。
 * @param config 用户配置。
 * @returns 归一化后的配置。
 */
function resolveConfig(config) {
  const sound = resolveSound(config.sound, resolveSound(DEFAULT_SOUND))
  return {
    enabled: config.enabled !== false,
    sound,
    errorSound: config.errorSound === undefined || config.errorSound === null
      ? null
      : resolveSound(config.errorSound, sound),
    askSound: resolveAskSound(config.askSound),
    askTools: new Set(
      Array.isArray(config.askTools)
        ? config.askTools.filter((tool) => typeof tool === 'string' && tool.trim() !== '')
        : DEFAULT_ASK_TOOLS,
    ),
    reasons: new Set(Array.isArray(config.reasons) ? config.reasons : DEFAULT_REASONS),
    skipSubagents: config.skipSubagents !== false,
    mainConversationOnly: config.mainConversationOnly !== false,
    requireClientPrompt: config.requireClientPrompt !== false,
    debounceMs: Number.isFinite(config.debounceMs) ? Math.max(0, config.debounceMs) : 800,
    volume: Number.isFinite(config.volume) ? Math.min(100, Math.max(0, config.volume)) : 85,
    announce: config.announce === true,
    debug: config.debug === true,
    command: typeof config.command === 'string' && config.command.trim() ? config.command : null,
  }
}

/**
 * 解析提问音配置。
 * @param value 内置名或音频路径；`false` / `null` / 空串表示不响提问音。
 * @returns 音频路径，或 null（关闭）。
 */
function resolveAskSound(value) {
  if (value === false || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return resolveSound(value, resolveSound(DEFAULT_ASK_SOUND))
}

/**
 * 把配置里的 `sound` 解析成音频文件路径。
 * @param value 内置名（1/2）、数字 1/2（YAML 会解析成 number）或任意音频路径；空值用 fallback。
 * @param fallback 上一级默认值。
 * @returns 绝对路径。
 */
function resolveSound(value, fallback = '') {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || text.trim() === '') return fallback
  const name = text.trim().toLowerCase()
  const file = BUILTIN_SOUNDS.get(name)
  if (file !== undefined) return join(ASSETS, file)
  return text
}

/**
 * 播放提示音。`command` 存在时只跑它，不再自己拼播放器。
 * @param sound 音频文件路径。
 * @param command 自定义命令；为空时走平台播放器。
 * @param volume 0–100 的播放音量。
 * @returns 是否真的起了播放进程；文件不存在时返回 false（绝不退回系统提示音）。
 */
function play(sound, command, volume = 85) {
  if (command) {
    // 交给 shell（Windows 上是 cmd.exe /d /s /c），用户写的重定向、管道才生效。
    runQuiet({ file: command, args: [], shell: true })
    return true
  }

  if (typeof sound !== 'string' || sound === '' || !existsSync(sound)) return false

  if (process.platform === 'win32') {
    const quoted = sound.replace(/'/g, "''")
    // wav 走 SoundPlayer：起播快（约 0.5 秒），但它没有音量参数。
    // 其他格式走 Windows Media Player 的 COM：能调音量，起播慢一点。
    // （WPF 的 MediaPlayer 两者都行，但每次要 6~7 秒才出声，做提示音太迟。）
    const script = /\.wav$/i.test(sound)
      ? `$p = '${quoted}'; (New-Object System.Media.SoundPlayer $p).PlaySync()`
      : `$w = New-Object -ComObject WMPlayer.OCX; $w.settings.volume = ${Math.round(volume)}; $w.URL = '${quoted}'; $w.controls.play(); Start-Sleep -Milliseconds 3500; $w.controls.stop(); $w.close()`
    // 注意：Windows 上不能 detached——脱离进程组的 powershell 会直接空转退出，什么都不播。
    runQuiet({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      detached: false,
    })
    return true
  }

  if (process.platform === 'darwin') {
    runQuiet({ file: 'afplay', args: ['-v', String(volume / 100), sound] })
    return true
  }

  runQuiet({ file: 'paplay', args: [`--volume=${Math.round((volume / 100) * 65536)}`, sound] })
  return true
}

/**
 * 起一个短命进程，失败也不吭声（提示音不值得报错）。
 * @param spec `{ file, args, shell, detached }`；shell 为 true 时 file 就是命令行。
 */
function runQuiet({ file, args = [], shell = false, detached = true }) {
  try {
    const child = spawn(file, args, { detached, stdio: 'ignore', windowsHide: true, shell })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 忽略：播放器缺失时静默降级。
  }
}
