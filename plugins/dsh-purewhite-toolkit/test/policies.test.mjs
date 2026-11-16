/**
 * policies 的单元测试：用假 ctx 验证
 *  1. 默认注入两节，节名 / 顺序 / interpolate=false 正确，正文非空且带核心规则；
 *  2. 「来源」小节确实没搬进来；
 *  3. evidence / writing 开关、order 覆盖、dir 缺失时的降级行为；
 *  4. 宿主没有 systemPrompt 服务时不抛错。
 */

import assert from 'node:assert/strict'
import { apply } from '../policies.js'

/** 构造一次被测运行。 */
function setup(config = {}, overrides = {}) {
  const sections = []
  const warns = []
  const disposers = []
  const systemPrompt =
    overrides.systemPrompt === null
      ? undefined
      : {
          section(definition) {
            sections.push(definition)
            const disposer = () => {}
            disposers.push(disposer)
            return disposer
          },
        }
  const ctx = {
    effect: (fn, label) => {
      const disposer = fn()
      disposer.label = label
      return disposer
    },
    logger: {
      warn(...args) {
        warns.push(args)
      },
    },
    systemPrompt,
  }
  apply(ctx, config)
  return { sections, warns, disposers }
}

/** 按节名取一节的注册定义。 */
function sectionNamed(sections, name) {
  return sections.find((definition) => definition.name === name)
}

const tests = []

tests.push({
  name: 'injects both policy sections with the documented names and orders',
  async run() {
    const { sections } = setup()
    assert.equal(sections.length, 2, 'two sections must be registered')

    const evidence = sectionNamed(sections, 'policy:evidence-first')
    const writing = sectionNamed(sections, 'policy:writing-style')
    assert.ok(evidence !== undefined, 'evidence-first section must exist')
    assert.ok(writing !== undefined, 'writing-style section must exist')
    assert.equal(evidence.order, 100)
    assert.equal(writing.order, 200)
    assert.ok(evidence.order < writing.order, 'evidence rules are read before the style rules')
    assert.equal(evidence.interpolate, false, 'prose must not be interpolated as a prompt template')
    assert.equal(writing.interpolate, false, 'prose must not be interpolated as a prompt template')
  },
})

tests.push({
  name: 'carries the evidence rules verbatim',
  async run() {
    const { sections } = setup()
    const text = sectionNamed(sections, 'policy:evidence-first').text
    assert.ok(text.startsWith('# 证据优先，减少幻觉'), 'heading is the first line')
    assert.ok(text.includes('## 1. 先验证，再下结论'))
    assert.ok(text.includes('## 9. 交付前自检：确认产物能跑'))
    assert.ok(text.includes('## 12. 来源与核对'))
    assert.ok(text.includes('## 网络搜索'))
    assert.ok(text.includes('## 读文档'))
    assert.ok(text.includes('每次声称「完成」「可用」时，附上实际执行的命令与输出摘要。'))
    assert.equal(text.endsWith('\n'), false, 'text is trimmed before injection')
  },
})

tests.push({
  name: 'carries both layers of the writing rules',
  async run() {
    const { sections } = setup()
    const text = sectionNamed(sections, 'policy:writing-style').text
    assert.ok(text.startsWith('# 写作规范（Humanizer-zh 分类版）'), 'heading is the first line')
    assert.ok(text.includes('## 一、通用层：去 AI 味（全局遵守）'))
    assert.ok(text.includes('#### 32. 缺衔接的流水句'))
    assert.ok(text.includes('### 完整示例'))
    assert.ok(text.includes('## 二、任务层：只在对应场景启用'))
    assert.ok(text.includes('### 场景 1：编辑他人文本'))
    assert.ok(text.includes('### 场景 4：改动文件'))
    assert.ok(text.includes('这些检查优先于风格偏好。'))
  },
})

tests.push({
  name: 'drops the 来源 subsection and its citations',
  async run() {
    const { sections } = setup()
    const writing = sectionNamed(sections, 'policy:writing-style').text
    const evidence = sectionNamed(sections, 'policy:evidence-first').text
    for (const text of [writing, evidence]) {
      assert.equal(text.includes('### 来源'), false, 'the 来源 heading must be gone')
    }
    for (const needle of ['blader/humanizer', 'op7418/Humanizer-zh', 'hardikpandya/stop-slop', 'wikipedia.org', 'SKILL.md']) {
      assert.equal(writing.includes(needle), false, `citation "${needle}" must be gone`)
    }
    // 删掉来源后，通用层直接接任务层，中间只隔一个空行。
    assert.ok(writing.includes('没有补写性能数字、发布时间或新的用户经历。\n\n## 二、任务层：只在对应场景启用'))
  },
})

tests.push({
  name: 'evidence: false skips only the evidence section',
  async run() {
    const { sections } = setup({ evidence: false })
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'policy:writing-style')
  },
})

tests.push({
  name: 'writing: false skips only the writing section',
  async run() {
    const { sections } = setup({ writing: false })
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'policy:evidence-first')
  },
})

tests.push({
  name: 'both switches off registers nothing',
  async run() {
    const { sections, warns } = setup({ evidence: false, writing: false })
    assert.equal(sections.length, 0)
    assert.equal(warns.length, 0, 'switched-off sections are not failures')
  },
})

tests.push({
  name: 'order overrides reach the registry',
  async run() {
    const { sections } = setup({ evidenceOrder: 42, writingOrder: 43 })
    assert.equal(sectionNamed(sections, 'policy:evidence-first').order, 42)
    assert.equal(sectionNamed(sections, 'policy:writing-style').order, 43)
  },
})

tests.push({
  name: 'a missing directory warns and injects nothing instead of throwing',
  async run() {
    const { sections, warns } = setup({ dir: 'no-such-dir-for-policies-test' })
    assert.equal(sections.length, 0)
    assert.equal(warns.length, 2, 'one warning per unreadable document')
    assert.ok(String(warns[0][0]).includes('cannot read'))
  },
})

tests.push({
  name: 'a host without systemPrompt is left alone',
  async run() {
    const { sections } = setup({}, { systemPrompt: null })
    assert.equal(sections.length, 0)
  },
})

tests.push({
  name: 'registers through ctx.effect so unloading removes the sections',
  async run() {
    const { disposers } = setup()
    assert.equal(disposers.length, 2)
    assert.ok(disposers.every((disposer) => typeof disposer.label === 'string' && disposer.label.includes('dsh-purewhite-toolkit')))
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
