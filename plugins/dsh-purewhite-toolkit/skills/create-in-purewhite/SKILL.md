---
name: create-in-purewhite
description: "只在用户显式输入 /create-in-purewhite 时使用：从这一轮开始，对话里要求新建或改写的功能、技能、skill、工具、提示词、Agent 预设，一律作为 dsh-purewhite-toolkit 的一部分实现并随插件打包，不再落到当前项目或用户技能目录。"
disable-model-invocation: true
user-invocable: true
---

# 在 dsh-purewhite-toolkit 里创建（create-in-purewhite）

## 调用后追加的规则

用户这次对话里要求写的**功能、技能、skill、工具、提示词、Agent 预设**，全部附属在 `dsh-purewhite-toolkit` 里，或者打包在 `dsh-purewhite-toolkit` 里。

- 落点是本插件仓库，不是当前工作目录的项目，也不是 `~/.agents/skills`、`~/.dsh/skills`、`~/.dsh/profiles`。
- 不新建独立插件包：新能力作为本插件里的文件或目录加入，随 `package.json` 的 `files` 一起发布。
- 只约束「新建或改写 DSH 能力」的请求。用户当前项目里的普通开发、读代码、改业务文件照常做，不要为了守规则把无关内容搬进工具集。
- 落点不用再问用户；只有需求本身（做什么、怎么触发、要不要开关）不清楚时才问一句。
- 只读或受限会话里写不了文件：先说明限制，不要假装写完。
- 用户明确指定「这个放到当前项目 / 别放进工具集」时，按用户说的落点做，并在报告里写明这是例外。

仓库根目录就是本技能 `<skill_resources>` 里给出的 `Base directory`（Windows 本机是 `D:\Document\Code\dsh-purewhite-toolkit`）。下面所有相对路径都从这个根算。

## 先判断属于哪一类

| 用户要的东西 | 落到 | 接法 |
|---|---|---|
| 技能 / skill | `skills/<kebab-case 名>/SKILL.md` | `index.js` 启动时扫描 `skills/*/SKILL.md` 自动注册；**不要**为每个技能改注册代码 |
| 工具 | `index.js` 里的 `ctx.tools.register` | 照 `createScreenshotTool` 的形状：description、parameters、output.schema、render、execute |
| 系统提示词 / 长期规则 | `prompts/<名字>.md` + `policies.js` 的 `DOCUMENTS` | `cordis.patch.yml` 的 `policies.config` 加开关 |
| Agent 预设 / 守卫 | `cordis.patch.yml` + `<名字>-guard.js` | 预设的 `plugins` 清单里挂守卫，参照 `readonly` / `agent-mode` |
| 测试 | `test/<名字>.test.mjs` | 假 ctx + 纯函数断言，直接 `node test/<名字>.test.mjs` |
| 文档 | `README.md` | 每个能力一节：触发方式、配置键、验证命令 |

跨类的需求拆成多项分别落位；不要把所有东西塞进一个文件。

## 技能（skill）

1. 建 `skills/<kebab-case 名>/SKILL.md`，目录名与 frontmatter 的 `name` 保持一致。
2. frontmatter 至少写 `name`、`description`。`description` 只写「什么时候用」，不写工作流程总结。
3. 正文只写怎么做这件事，不写「本技能由插件加载」这类实现说明。
4. 不需要在 `index.js` 里登记：`registerBundledSkills()` 会扫描整个 `skills/` 目录。

## 手动触发的技能（与本技能同类）

1. frontmatter 写 `disable-model-invocation: true`；`user-invocable` 缺省就是 `true`，可以省略。
2. 只写 frontmatter 就生效：本仓库的 `readBundledSkill()` 已经解析 `disable-model-invocation` / `user-invocable`，并映射成 DSH `skills.register` 需要的 `invocation: { modelInvocable, userInvocable }`。**不要**再重复加注册逻辑；只有当你确认这段解析不存在时，才先补 `index.js` 再继续。
3. 布尔写法与 DSH 的 skill-filesystem 对齐：`true/false`、`yes/no`、`on/off`、`1/0`（不区分大小写，可加引号）。写错会让该技能被跳过并告警，不会静默放开模型调用。
4. DSH 按空白边界识别用户消息里的 `/名字`：`/名字` 后面必须有空格或行尾，`/名字帮我…` 不会被识别。正文里要提醒用户这一点。
5. 正文第一段写清「只由 `/名字` 触发」，以及用户没输入手势时不要主动使用。
6. 加一条测试断言：`invocation.modelInvocable === false`、`userInvocable === true`。

## 工具

1. 加在 `index.js`：写 `createXxxTool(ctx, options)`，在 `apply()` 里 `ctx.tools.register`，配置项走 `normalizeConfig` 并给默认值。
2. 输入参数、输出 schema、`render` 都要写；失败统一返回 `{ ok: false, code, message }`，不要抛异常给模型。
3. 平台相关能力写清 fallback（参照截图工具的 Windows helper / PowerShell、macOS screencapture）。
4. 不引入第三方依赖；Node 内置模块和系统自带命令优先。

## 系统提示词 / 长期规则

1. 正文放 `prompts/<名字>.md`，只写规则本身。
2. `policies.js` 的 `DOCUMENTS` 加一项：`key`、`section`（`policy:<名字>`）、`file`、`order`。
3. `cordis.patch.yml` 的 `policies.config` 写出 `<key>: true`，方便一眼关掉。
4. 用 `ctx.systemPrompt.section()`，不要用 `context()`：稳定规则进系统提示词正文才吃前缀缓存，也不会每轮多一条消息。
5. 注册时保留 `interpolate: false`，避免正文里的 `{{...}}` 被当成提示词变量。

## Agent 预设 / 守卫

1. 预设写在 `cordis.patch.yml`，照 `readonly` / `agent-mode` 的结构：`id`、`name`、`description`、`order`、`plugins`。
2. 需要执行期约束时写 `<名字>-guard.js`，在预设的 `plugins` 里以 `dsh-purewhite-toolkit/<名字>-guard` 挂一条。
3. 预设改动要在插件管理器里把 `dsh-purewhite-toolkit` 关一次再开（或重启 DSH）才会进模式下拉；会话中途不能切预设。

## 改完怎么验证（必须真跑）

| 改了什么 | 跑什么 |
|---|---|
| 任意 JS | `node --check <文件>` |
| 技能解析 / 注册 | `node test/skills.test.mjs` |
| 截图或工具注册 | `node test/smoke.mjs` |
| 提示词注入 | `node test/policies.test.mjs` |
| 只读 / 智能体守卫 | `node test/readonly-guard.test.mjs`、`node test/agent-mode-guard.test.mjs` |
| 构建 + 注册 + 冒烟 | `npm test` |
| 全部单测 | 逐个跑 `test/*.test.mjs` |

配置（YAML）改动没有额外依赖可跑单测：重载插件后看实际效果，或让用户在新会话里确认。不要为了验证临时安装 YAML 依赖。

真实宿主里验证手动触发技能时，确认三件事：

1. 模型技能目录（`<available_skills>`）里**没有**这个技能；
2. 输入 `/名字` 后出现 `<skill_content name="名字">` 注入块；
3. 让模型用 `skill` 工具加载它，应报 `not available for model invocation`。

没做过的验证要写「未验证」，不要把命令写完就当跑过。

## 收尾前自检

- [ ] 所有新文件都在工具集仓库里，没有写到仓库外。
- [ ] 技能在 `skills/<名字>/SKILL.md`，frontmatter 有 `name` / `description`，手动触发的带 `disable-model-invocation: true`。
- [ ] `node test/skills.test.mjs` 能看到这个技能的 `invocation` 断言。
- [ ] 改了 `README.md`：触发方式、配置键、验证命令。
- [ ] 新测试进了 `package.json` 的 `npm test`（如果新增了测试文件）。
- [ ] 报告里写清改了哪些文件、怎么用、跑过什么、还有什么没验证。

## 常见错误

| 错误做法 | 正确做法 |
|---|---|
| 把技能写到 `<当前项目>/.dsh/skills/` 或 `~/.agents/skills/` | 写到工具集 `skills/<名字>/SKILL.md` |
| 只写 `disable-model-invocation: true`，不确认加载器解析 | 确认 `readBundledSkill()` 已解析，或先补 `index.js` |
| 每加一个技能就去 `index.js` 写注册 | 扫描目录自动注册，不用改 |
| 把手写笔记、业务代码、项目数据搬进工具集 | 只放 DSH 扩展能力；项目内容留在项目里 |
| 改完配置不重载就宣称生效 | 让用户关开插件或重启，再新开会话验证 |
| 只说「已完成」不跑测试 | 跑对应测试并把输出摘要写进报告 |
