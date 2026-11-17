// dsh-turn-chime 的自检脚本：用真实的 cordis 事件总线跑一遍插件逻辑，
// 把「响」替换成写标记文件，验证主对话范围、历史回填、触发条件、音效分流与去抖。
import { Context } from 'file:///E:/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import { apply } from '../index.js'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const marker = 'C:\\Users\\Administrator\\.dsh\\cache\\turn-chime-test.txt'
const baseConfig = {
  // 走 shell 执行，重定向路径不能带空格。
  command: `echo chime >> ${marker}`,
  debug: true,
  debounceMs: 0,
}

if (existsSync(marker)) rmSync(marker)

const chimeCount = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split(/\r?\n/).length : 0

/** 起一个独立插件实例，返回事件上下文与日志。 */
const boot = (config = {}) => {
  const log = []
  const ctx = new Context()
  ctx.logger = { info: (m) => log.push(['info', m]), warn: (m) => log.push(['warn', m]) }
  apply(ctx.extend({ name: 'turn-chime' }), { ...baseConfig, ...config })
  return { ctx, log }
}

let nextId = 0
const rootSession = () => ({ id: `session-main-${++nextId}`, header: { delegationDepth: 0 } })
const subSession = () => ({ id: `session-sub-${++nextId}`, header: { origin: 'subagent', delegationDepth: 1 } })
const turnEnd = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } } })
const toolCall = (name) => ({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name, arguments: '{}' } })
const humanPrompt = () => ({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-1' }, content: [] } })
const injectedPrompt = (kind = 'subagent-settled') => ({ type: 'user/message', data: { source: { kind }, content: [] } })
const legacyPrompt = () => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [] } })

const cases = []
const check = (label, expected, got) => cases.push({ label, expected, got })

/** 跑一次 turn/end 并统计新增响铃次数。 */
const runEnd = async (ctx, session, kind = 'completed') => {
  const before = chimeCount()
  ctx.emit('session/event', session, turnEnd(kind))
  await sleep(600)
  return chimeCount() - before
}

/** 跑一次提问工具调用并统计新增响铃次数。 */
const runAsk = async (ctx, session, name = 'ask_user_question') => {
  const before = chimeCount()
  ctx.emit('session/event', session, toolCall(name))
  await sleep(600)
  return chimeCount() - before
}

// 主对话：有过主页真人消息的根会话
{
  const { ctx, log } = boot()

  let session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  check('主会话 completed', 1, await runEnd(ctx, session))

  session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  check('主会话 error', 1, await runEnd(ctx, session, 'error'))

  session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  check('主会话 aborted', 0, await runEnd(ctx, session, 'aborted'))

  session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  check('主会话 interrupted', 1, await runEnd(ctx, session, 'interrupted'))

  // 关键回归：长任务被后台通知续跑后结束，也应该响
  session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  await runEnd(ctx, session)
  ctx.emit('session/event', session, injectedPrompt('tool-jobs'))
  check('真人会话的后台续跑结束也响', 1, await runEnd(ctx, session))

  // 纯自动会话：没有真人消息，不响
  for (const kind of ['subagent-settled', 'tool-jobs', 'goal', 'model-selection', 'schedule']) {
    session = rootSession()
    ctx.emit('session/event', session, injectedPrompt(kind))
    check(`纯自动会话 ${kind} 不响`, 0, await runEnd(ctx, session))
  }

  // 没有 rpcId 的 user 消息（模型/插件自己塞的）不算主页真人消息
  session = rootSession()
  ctx.emit('session/event', session, legacyPrompt())
  check('无 rpcId 的 user 消息不响', 0, await runEnd(ctx, session))

  // 子代理会话即使有真人消息也不响
  session = subSession()
  ctx.emit('session/event', session, humanPrompt())
  check('子代理 completed 不响', 0, await runEnd(ctx, session))

  check('调试日志有记录', 1, log.length > 0 ? 1 : 0)
}

// 提问音：有人类消息的主对话里，模型反问用户
{
  const { ctx } = boot()
  let session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  check('主会话 ask_user_question 响', 1, await runAsk(ctx, session))

  session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  check('主会话 exit_plan_mode 响', 1, await runAsk(ctx, session, 'exit_plan_mode'))

  session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  check('主会话其他工具不响', 0, await runAsk(ctx, session, 'pwsh'))

  session = rootSession()
  ctx.emit('session/event', session, injectedPrompt('subagent-settled'))
  check('纯自动会话提问不响', 0, await runAsk(ctx, session))

  session = subSession()
  ctx.emit('session/event', session, humanPrompt())
  check('子代理提问不响', 0, await runAsk(ctx, session))
}

// 插件重载/重启后，从会话历史回填「有过真人消息」
{
  const { ctx } = boot()
  const session = {
    id: `session-history-${++nextId}`,
    header: { delegationDepth: 0 },
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-history' } } },
      { type: 'user/message', data: { source: { kind: 'time-context' } } },
    ],
  }
  check('历史里有真人消息，结束会响', 1, await runEnd(ctx, session))

  const noHuman = {
    id: `session-history-${++nextId}`,
    header: { delegationDepth: 0 },
    snapshotEvents: () => [
      { type: 'user/message', data: { source: { kind: 'schedule' } } },
    ],
  }
  check('历史里没有真人消息，结束不响', 0, await runEnd(ctx, noHuman))
}

// 多个真人会话各自结束都响，不做「最近一个会话」限制
{
  const { ctx } = boot()
  const a = rootSession()
  const b = rootSession()
  ctx.emit('session/event', a, humanPrompt())
  ctx.emit('session/event', b, humanPrompt())
  check('会话 A 结束响', 1, await runEnd(ctx, a))
  check('会话 B 结束也响', 1, await runEnd(ctx, b))
}

// 非主对话模式：关掉 mainConversationOnly 后，纯自动根会话也响；子代理仍然跳过
{
  const { ctx } = boot({ mainConversationOnly: false })
  check(
    'mainConversationOnly=false 纯自动会话响',
    1,
    await runEnd(ctx, rootSession()),
  )
  check(
    'mainConversationOnly=false 子代理仍不响',
    0,
    await runEnd(ctx, subSession()),
  )
}

// requireClientPrompt=false：没有 rpcId 的 user 消息也算真人
{
  const { ctx } = boot({ requireClientPrompt: false })
  const session = rootSession()
  ctx.emit('session/event', session, legacyPrompt())
  check('关闭 rpcId 要求后 legacy 消息也响', 1, await runEnd(ctx, session))
}

// 音效分流：提问走 2.wav（上行），结束走 1.wav（下行）
{
  const sounds = []
  const ctx = new Context()
  ctx.logger = { info: (m) => sounds.push(m), warn: (m) => sounds.push(m) }
  apply(ctx.extend(), { command: baseConfig.command, debug: true, debounceMs: 0 })
  rmSync(marker, { force: true })
  const session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  ctx.emit('session/event', session, toolCall('ask_user_question'))
  ctx.emit('session/event', session, turnEnd('completed'))
  await sleep(600)
  check('提问走 2.wav', 1, sounds.some((s) => s.includes('2.wav')) ? 1 : 0)
  check('完成走 1.wav', 1, sounds.some((s) => s.includes('1.wav')) ? 1 : 0)
}

// 配置里直接写数字（YAML 会把 1/2 解析成 number）也要认
{
  const numLogs = []
  const ctx = new Context()
  ctx.logger = { info: (m) => numLogs.push(m), warn: (m) => numLogs.push(m) }
  apply(ctx.extend(), { sound: 2, command: baseConfig.command, debug: true, debounceMs: 0 })
  const session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  await runEnd(ctx, session)
  check('数字配置 sound: 2', 1, numLogs.some((s) => s.includes('2.wav')) ? 1 : 0)
}

// 去抖：两个真人会话几乎同时结束只响一次
{
  rmSync(marker, { force: true })
  const { ctx } = boot({ debounceMs: 800 })
  const a = rootSession()
  const b = rootSession()
  ctx.emit('session/event', a, humanPrompt())
  ctx.emit('session/event', b, humanPrompt())
  ctx.emit('session/event', a, turnEnd('completed'))
  ctx.emit('session/event', b, turnEnd('completed'))
  await sleep(600)
  check('去抖 800ms', 1, chimeCount())
}

// 提问与结束各自去抖：同一时刻各响各的，互不吞音
{
  rmSync(marker, { force: true })
  const { ctx } = boot({ debounceMs: 800 })
  const session = rootSession()
  ctx.emit('session/event', session, humanPrompt())
  ctx.emit('session/event', session, toolCall('ask_user_question'))
  ctx.emit('session/event', session, turnEnd('completed'))
  await sleep(600)
  check('提问与结束各自去抖', 2, chimeCount())
}

let failed = 0
for (const c of cases) {
  const ok = c.got === c.expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.label}: expected ${c.expected}, got ${c.got}`)
}
console.log(`cases: ${cases.length}`)
if (failed) { console.log(`${failed} case(s) failed`); process.exit(1) }
console.log('all cases passed')
