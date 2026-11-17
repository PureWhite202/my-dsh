// 验证插件自带技能能被自动发现并注册：skills/ 下每个子目录一个技能。
// 用假 ctx 走 apply()，只关心 skills.register 收到什么。
import assert from 'node:assert/strict'

import { apply } from '../index.js'

const registered = []
const skillsCtx = {
  skills: { register: (skill) => registered.push(skill) },
  effect: (register) => register(),
}
const ctx = {
  tools: { register: () => {} },
  inject: (_deps, callback) => callback(skillsCtx),
}

apply(ctx, {})

const names = registered.map((skill) => skill.name).sort()
assert.deepEqual(names, ['blackboard', 'create-in-purewhite', 'sync-config'], `bundled skills: ${names}`)

for (const skill of registered) {
  assert.equal(skill.source, 'bundled', `${skill.name} source`)
  const normalized = String(skill.path).replaceAll('\\', '/')
  assert.ok(normalized.endsWith(`skills/${skill.name}/SKILL.md`), `${skill.name} path: ${skill.path}`)
  assert.ok(skill.description.length > 30, `${skill.name} description too short`)
  assert.ok(skill.content.length > 500, `${skill.name} content too short`)
}

console.log('skills-register ok:', names.join(', '))
