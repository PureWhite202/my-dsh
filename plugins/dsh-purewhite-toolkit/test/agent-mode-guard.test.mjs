/**
 * agent-mode-guard 的单元测试：用假 ctx/session 验证
 *  1. 智能体模式 + 首轮 → 追加 team/mode { enabled: true }；
 *  2. 非智能体模式、非首轮、任务板已开、子代理会话 → 不追加；
 *  3. agentTeams 服务缺失 → 不追加且不抛错；
 *  4. 运行时上下文只在智能体模式会话里返回协调者规则（含「完成即汇报、时间接近合并、
 *     必须多个子智能齐活才等」的汇报时机规则）；
 *  5. 工具守卫拒绝写类工具、放行只读工具、不误伤其它预设。
 */

import assert from 'node:assert/strict'
import { apply } from '../agent-mode-guard.js'

/** 构造一次被测运行。 */
function setup(overrides = {}) {
  const state = {
    preset: 'agent-mode',
    lastTurn: 0,
    teamEnabled: false,
    origin: undefined,
    team: true,
    ...overrides,
  }
  const handlers = new Map()
  const contexts = []
  const appended = []
  const guards = []

  const session = {
    get header() {
      return { origin: state.origin }
    },
    append(type, data) {
      appended.push([type, data])
    },
  }
  const agentTeams = state.team ? { isEnabled: () => state.teamEnabled } : undefined

  const ctx = {
    effect: (fn) => fn(),
    on: (name, handler) => {
      handlers.set(name, handler)
    },
    inject: (deps, callback) => {
      const key = deps.join(',')
      if (key === 'tools') {
        callback({
          tools: {
            guard(fn) {
              guards.push(fn)
              return () => {}
            },
          },
        })
        return
      }
      throw new Error(`unexpected ctx.inject deps: ${key}`)
    },
    logger: { warn() {} },
    get: (name) => (name === 'agentTeams' ? agentTeams : undefined),
    systemPrompt: {
      context: (contribution) => {
        contexts.push(contribution)
        return () => {}
      },
      getContextOrder: () => 115,
    },
    agents: { turnBoundaryOf: () => ({ lastTurn: state.lastTurn }) },
    agentPresets: { presetForSession: () => state.preset },
  }

  apply(ctx, { preset: 'agent-mode' })
  return { state, handlers, contexts, appended, guards, session }
}

async function runPreStep(handlers, agent) {
  const handler = handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function', 'agent/pre-step listener must be registered')
  let nextCalled = 0
  const decision = await handler({ agent }, async () => {
    nextCalled++
    return 'decision'
  })
  assert.equal(nextCalled, 1, 'must call next()')
  return decision
}

const tests = []

tests.push({
  name: 'enables the team board on the first turn of the agent-mode preset',
  async run() {
    const { handlers, appended, session } = setup()
    const decision = await runPreStep(handlers, { session })
    assert.equal(decision, 'decision', 'must return the next decision unchanged')
    assert.deepEqual(appended, [['team/mode', { enabled: true }]])
  },
})

tests.push({
  name: 'does nothing for another preset',
  async run() {
    const { handlers, appended, session } = setup({ preset: 'standard' })
    await runPreStep(handlers, { session })
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'does nothing after the first turn',
  async run() {
    const { handlers, appended, session } = setup({ lastTurn: 3 })
    await runPreStep(handlers, { session })
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'is idempotent when the team board is already on',
  async run() {
    const { handlers, appended, session } = setup({ teamEnabled: true })
    await runPreStep(handlers, { session })
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'does nothing for a subagent session',
  async run() {
    const { handlers, appended, session } = setup({ origin: 'subagent' })
    await runPreStep(handlers, { session })
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'skips quietly when the agentTeams service is absent',
  async run() {
    const { handlers, appended, session } = setup({ team: false })
    const decision = await runPreStep(handlers, { session })
    assert.equal(decision, 'decision')
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'skips when there is no agent',
  async run() {
    const { handlers, appended } = setup()
    await runPreStep(handlers, undefined)
    assert.deepEqual(appended, [])
  },
})

tests.push({
  name: 'registers one runtime context that only speaks for agent-mode sessions',
  async run() {
    const { contexts, state } = setup()
    assert.equal(contexts.length, 1)
    const contribution = contexts[0]
    assert.equal(contribution.name, 'agent-mode:coordinator')
    assert.equal(contribution.order, 117)

    const text = contribution.text({ agent: { session: {} } })
    assert.ok(text.includes('Agent Mode'), 'notice must name Agent Mode')
    assert.ok(text.includes('work item'), 'notice must describe the work-item rule')
    assert.ok(text.includes('end your turn'), 'notice must forbid waiting in the dispatch turn')
    assert.ok(text.includes('the moment it is done'), 'notice must report each item as soon as it lands')
    assert.ok(text.includes('close together'), 'notice must merge reports of near-simultaneous finishes')
    assert.ok(text.includes('wait_agent'), 'notice must allow waiting only when several teammates are needed')
    assert.ok(text.includes('report once'), 'notice must ask for a single combined report in that case')
    assert.equal(contribution.text({}), '', 'no agent context yields no text')

    state.preset = 'standard'
    assert.equal(contribution.text({ agent: { session: {} } }), '', 'other presets stay silent')
  },
})

tests.push({
  name: 'registers one tool guard that denies write tools in agent-mode sessions',
  async run() {
    const { guards, session } = setup()
    assert.equal(guards.length, 1, 'one tool guard must be registered')
    const guard = guards[0]

    const denied = guard({ name: 'write', agent: { session } })
    assert.equal(typeof denied, 'string')
    assert.ok(denied.includes('write'))
    assert.ok(denied.includes('subagent'), 'denial must point at the subagent tool')

    assert.equal(guard({ name: 'read', agent: { session } }), undefined, 'read tools stay allowed')
    assert.equal(guard({ name: 'write' }), undefined, 'no agent means no denial')
  },
})

tests.push({
  name: 'the tool guard leaves other presets alone',
  async run() {
    const { guards, state, session } = setup()
    state.preset = 'standard'
    assert.equal(guards[0]({ name: 'write', agent: { session } }), undefined)
  },
})

tests.push({
  name: 'a custom deny list replaces the defaults',
  async run() {
    const guards = []
    const handlers = new Map()
    const ctx = {
      effect: (fn) => fn(),
      on: (name, handler) => handlers.set(name, handler),
      inject: (deps, callback) => {
        assert.deepEqual(deps, ['tools'])
        callback({
          tools: {
            guard(fn) {
              guards.push(fn)
              return () => {}
            },
          },
        })
      },
      logger: { warn() {} },
      get: () => ({ isEnabled: () => true }),
      systemPrompt: undefined,
      agents: { turnBoundaryOf: () => ({ lastTurn: 0 }) },
      agentPresets: { presetForSession: () => 'agent-mode' },
    }
    apply(ctx, { preset: 'agent-mode', denyTools: ['bash'] })
    assert.equal(guards.length, 1)
    const session = { append() {} }
    assert.equal(guards[0]({ name: 'write', agent: { session } }), undefined, 'custom list drops write')
    assert.equal(typeof guards[0]({ name: 'bash', agent: { session } }), 'string')
  },
})

let failed = 0
for (const test of tests) {
  try {
    await test.run()
    console.log('ok   -', test.name)
  } catch (error) {
    failed++
    console.error('FAIL -', test.name)
    console.error(error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
