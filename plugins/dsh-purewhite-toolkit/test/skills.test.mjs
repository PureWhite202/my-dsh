// 内置技能测试：frontmatter 解析、调用策略、注册透传。
// 运行：node test/skills.test.mjs
//
// 重点锁两件事：
//   1. create-in-purewhite 只能由用户 `/create-in-purewhite` 触发（modelInvocable=false）；
//   2. 没写调用开关的技能保持宿主默认（模型、用户都能调用），不能因为加了新技能把老的锁死。

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, readBundledSkill } from '../index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = join(ROOT, 'test', '.tmp-skills')

/** 在临时目录里写一个最小技能。 */
function writeSkill(dir, name, flags, body = '正文内容') {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'SKILL.md'),
    ['---', `name: ${name}`, 'description: "测试技能"', ...flags, '---', '', body, ''].join('\n'),
    'utf8',
  )
}

/** 假宿主：捕获 skills.register 的注册项与告警。 */
function fakeHost() {
  const registered = []
  const warns = []
  const skillsCtx = {
    skills: {
      register(spec) {
        registered.push(spec)
        return () => {}
      },
    },
    effect(factory) {
      return factory()
    },
    logger: {
      warn(message) {
        warns.push(String(message))
      },
    },
  }
  const host = {
    tools: { register() { return () => {} } },
    effect(factory) {
      return factory()
    },
    inject(services, callback) {
      if (Array.isArray(services) && services.includes('skills')) return callback(skillsCtx)
    },
  }
  return { host, registered, warns }
}

const tests = []

tests.push({
  name: 'create-in-purewhite 只允许用户手动触发',
  run() {
    const skill = readBundledSkill(join(ROOT, 'skills', 'create-in-purewhite', 'SKILL.md'))
    assert.ok(skill !== undefined, 'create-in-purewhite 必须能解析')
    assert.equal(skill.name, 'create-in-purewhite')
    assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: true })
    assert.ok(skill.description.includes('/create-in-purewhite'), '描述要写明唯一的触发方式')
    assert.ok(skill.content.includes('附属在'), '正文要包含收口规则')
    assert.ok(skill.content.includes('dsh-purewhite-toolkit'), '正文要写明落点仓库')
    assert.equal(skill.content.startsWith('---'), false, 'frontmatter 不能留在正文里')
  },
})

tests.push({
  name: 'sync-config 不带调用开关时保持默认',
  run() {
    const skill = readBundledSkill(join(ROOT, 'skills', 'sync-config', 'SKILL.md'))
    assert.ok(skill !== undefined)
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  },
})

tests.push({
  name: '布尔写法与 DSH skill-filesystem 一致',
  run() {
    rmSync(TMP, { recursive: true, force: true })
    writeSkill(TMP, 'yes-no', ['disable-model-invocation: yes', 'user-invocable: no'])
    writeSkill(TMP, 'quoted', ['disable-model-invocation: "true"', 'user-invocable: on # 行尾注释'])
    writeSkill(TMP, 'numbers', ['disable-model-invocation: 1', 'user-invocable: 0'])
    assert.deepEqual(readBundledSkill(join(TMP, 'yes-no', 'SKILL.md')).invocation, {
      modelInvocable: false,
      userInvocable: false,
    })
    assert.deepEqual(readBundledSkill(join(TMP, 'quoted', 'SKILL.md')).invocation, {
      modelInvocable: false,
      userInvocable: true,
    })
    assert.deepEqual(readBundledSkill(join(TMP, 'numbers', 'SKILL.md')).invocation, {
      modelInvocable: false,
      userInvocable: false,
    })
  },
})

tests.push({
  name: '写法不认识时抛错，不静默放开模型调用',
  run() {
    writeSkill(TMP, 'broken', ['disable-model-invocation: maybe'])
    assert.throws(
      () => readBundledSkill(join(TMP, 'broken', 'SKILL.md')),
      (error) => error instanceof TypeError && error.message.includes('disable-model-invocation'),
    )
    writeSkill(TMP, 'legacy', ['disableModelInvocation: true'])
    assert.throws(
      () => readBundledSkill(join(TMP, 'legacy', 'SKILL.md')),
      (error) => error instanceof TypeError && error.message.includes('disable-model-invocation'),
    )
  },
})

tests.push({
  name: 'apply 把 invocation 与资源目录传给 skills.register',
  run() {
    const { host, registered } = fakeHost()
    apply(host, {})
    // 不锁定技能总数：仓库会继续加技能，这里只确认本次新增的两个都在。
    const names = registered.map((spec) => spec.name)
    assert.ok(names.includes('create-in-purewhite'), '应注册 create-in-purewhite')
    assert.ok(names.includes('sync-config'), '不能漏掉原有技能')

    const manual = registered.find((spec) => spec.name === 'create-in-purewhite')
    assert.deepEqual(manual.invocation, { modelInvocable: false, userInvocable: true })
    assert.equal(manual.source, 'bundled')
    assert.ok(manual.path.endsWith(join('create-in-purewhite', 'SKILL.md')))
    assert.equal(manual.resourceBase.kind, 'directory')
    assert.equal(manual.resourceBase.path, resolve(ROOT), '资源目录应是插件根目录')
  },
})

tests.push({
  name: 'skills: false 时一个内置技能都不注册',
  run() {
    const { host, registered } = fakeHost()
    apply(host, { skills: false })
    assert.equal(registered.length, 0)
  },
})

let failed = 0
try {
  for (const test of tests) {
    try {
      await test.run()
      console.log('ok   -', test.name)
    } catch (error) {
      failed += 1
      console.error('FAIL -', test.name)
      console.error(error)
    }
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
