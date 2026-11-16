# 智能体模式（Agent Mode）方案

- 日期：2026-11-17
- 状态：已实现（落在 `dsh-purewhite-toolkit`，待新会话人工验收）
- 运行环境：DSH 0.2.2-rc.3，Desktop 打包版（`app.asar`），profile `desktop`

## 一句话

新增一个 Agent 预设「智能体模式」：主智能体只保留读、查、问、派活的工具，改文件和跑命令由子智能体完成；用户想到什么就发一条，主智能体在子智能体干活的同时继续接收、分析新问题并派活，派完就结束本轮，子智能体完成时自动把主智能体叫醒汇报。

## 1. 现状核对（以下都是在本机实装里查过的）

### 1.1 「模式」在 DSH 里就是 Agent 预设

- 预设 = 一份插件清单声明，字段 `id` / `name` / `description` / `order` / `plugins`。
  证据：`@deepseek-ai/dsh-agent-preset/src/index.ts:16-23`（Config schema）。
- 内置四个：`standard`(1)、`ptc`(2)、`minimal`(3)、`cordis`(4)。
  证据：`@deepseek-ai/dsh-web-app/presets/*.patch.yml`。
- 自定义预设会进设置里的「自定义」分组和新会话选择器，卡片上显示 `name`、`description`，标题旁显示预设 id。
  证据：`@deepseek-ai/dsh-client-ui-agent-preset/README.md:28-34`。

本机已有同样的先例：`dsh-purewhite-toolkit` 里的「只读模式」预设（`preset-readonly` 行 + `readonly-guard` 插件）。

### 1.2 工具是插件带来的，不给就是没有

预设的 `plugins` 列表决定这个模式能加载哪些工具插件。所以「主智能体不能改文件」最硬的实现方式是**根本不挂写工具**，而不是挂上之后再禁止。

### 1.3 会话一开始就不能换预设

选择预设会先检查会话边界：`boundary.lastTurn > 0` 直接报 `agent-preset/locked`。
证据：`@deepseek-ai/dsh-agent-preset-registry/src/index.ts:364-383`。

结论：「切换到智能体模式」实际是**新建会话时选它**，或者在还没发第一条消息的空白会话上选它。已经在跑的会话不能中途变成智能体模式。

### 1.4 子智能体可以指定自己的预设

`@deepseek-ai/dsh-tool-subagent` 支持 `agentPreset`：配了就用那份独立组合；不配则加入父级当前预设修订。
证据：`@deepseek-ai/dsh-tool-subagent/README.md:66-73`，实现见 `lib/index.js`（`SubagentPresetSelection`）。

限制：只有进程内 `spawn` 后端支持；`fork` 和外部后端（Codex/Claude/ACP）不支持。

这条很关键：主智能体没有写工具，子智能体必须靠 `agentPreset` 换一套完整能力，否则子智能体也只会读。

### 1.5 Agent Teams 是按根会话开关的，不是按预设

- Team 服务挂在 Host（`dsh-base` 的 `agent-team` 行），任务板工具 `team_task_*` 也是 Host 级。
- 工具是否可见由「当前调用者所属树的根会话是否开了 Team」决定。
  证据：`@deepseek-ai/dsh-tool-agent-team/src/index.ts:102-111`。
- 新会话默认关闭；`defaultEnabled: true` 只对 `source === 'startup'` 且非 subagent 的根会话生效。
  证据：`@deepseek-ai/dsh-agent-team/src/index.ts:79-86`。

结论：想让「只有智能体模式自动开任务板」，不能改全局 `defaultEnabled`（那会把标准模式一起打开），得按会话写一次开关事件。

### 1.6 空白会话切模式不会再触发 `agent/created`

这是 `readonly-guard.js:14-19` 里已经记过的实测结论：新任务页打开时 Agent 就建好了，之后在空白会话上换模式走的是「重新组合」，不再发 `agent/created`。所以守卫挂在 `agent/pre-step`，用「首轮」条件只钉一次。

### 1.7 一条条发消息、子智能体在跑时还能接活：运行时本来就支持

这一条决定了「想到就发」能不能成立，分四种情况：

1. **主智能体空闲时发消息**：直接开一轮新的。
2. **主智能体正忙（一轮还没结束）时发消息**：Web 用「繁忙时回车」的设置决定投递方式——
   - **Queue（排队）**：消息进 `next-turn`，当前轮结束后一条一轮、先到先处理；
   - **Steer（转向）**：消息进 `next-step`，插进正在跑的那一轮的下一步。
   Ctrl/Cmd+Enter 用另一种。证据：`@deepseek-ai/dsh-client-ui-conversation/README.md:139`、`@deepseek-ai/dsh-agent-loop/src/inbox.ts:80-113`（`next-turn` / `next-step` / `claim`）。
3. **子智能体在跑**：`subagent` 调用立刻返回名字，不等结果（`@deepseek-ai/dsh-tool-subagent/README.md:60`）；子智能体结束时给父级发完成通知，父级空闲则这条通知直接开一轮模型请求（同文件 `:170-178`）。
4. **并发上限**：每个 subagent 树共用一个池，`maxActiveSubagents` 默认 8；满了创建和冷恢复**直接拒绝**（`ACTIVATION_LIMIT_REACHED`），不排队（`@deepseek-ai/dsh-subagent/README.md:51-57`）。

结论：你要的「主智能体在子智能体干活时继续分析新问题、继续派活」是运行时天生支持的，不是要新造机制。真正要设计的是：**让主智能体保持短轮次、绝不空等**，并把在飞的活放到任务板上，这样一条条消息才不会互相覆盖。

## 2. 方案对比

| | 做法 | 能覆盖 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| A | 预设（无写工具）+ 守卫插件（自动开 Team） | 主智能体想改也改不了；任务板自动出现，多工单有地方记 | 一个 bundle、一个几十行的插件、一条单测 | **推荐** |
| B | 只做预设，不写插件 | 主智能体确实没写工具，多工单也能跑，但任务板要用户手动开 | 零代码 | 备选：先跑起来再说 |
| C | profile 里把 `agent-team.defaultEnabled` 设成 true，再配预设 | 省掉插件 | 所有模式的新会话都会被打开任务板 | 不推荐，污染标准模式 |
| D | 改 DSH 本体，给预设加「强制团队」字段 | 最贴语义 | 装的是 app.asar 打包版，改完要自己维护整棵源码树 | 不推荐 |

## 3. 推荐方案 A 的设计

### 3.1 组成

按用户要求，功能写在现有的 `dsh-purewhite-toolkit` 里（和「只读模式」同一个 bundle，方便随仓库同步），不另开包：

```
plugins/dsh-purewhite-toolkit/
  cordis.patch.yml              # 新增 preset-agent-mode 声明 + agent-mode-guard 行
  agent-mode-guard.js           # 守卫插件（Host 侧）
  test/agent-mode-guard.test.mjs
  README.md                     # 新增「智能体模式」一节
```

安装方式与其它插件一致：profile `package.json` 里已有 `link:` 指向本目录，bundle 关闭再打开（或重启 DSH）就会重新组合。

### 3.2 预设声明（示意，最终以实现为准）

```yaml
- insert:
    - id: preset-agent-mode
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: agent-mode
        name: 智能体模式
        description: 主智能体只做需求分析、事实核对和任务确认，改文件的活派给子智能体；可以边等边接新问题。
        order: 5
        plugins:
          - persona / agent-instructions / time-context
          - tool-fs（read + read_image，write/edit/applyPatch 全关）
          - tool-fs-search（glob/grep）
          - tool-web / tool-skill / tool-todo / tool-ask-user
          - tool-subagent（spawn，agentPreset: standard，modelSelection + modelDiscovery）
          - tool-subagent-control（send_message / list_agents / wait_agent）
          - compaction 组
```

### 3.3 工具目录

| 工具 | 去留 | 理由 |
| --- | --- | --- |
| `read`、`read_image` | 留 | 需求分析和事实核对靠它 |
| `glob`、`grep` | 留 | 找文件、找符号 |
| `web_search`、`web_fetch` | 留 | 事实核对要查外部资料 |
| `skill` | 留 | 选题、写计划这类技能要能加载 |
| `ask_user_question` | 留 | 需求澄清和任务确认 |
| `todo_write` | 留 | 主智能体自己的步骤进度 |
| `subagent` | 留 | 派活主通道，子智能体固定用标准模式 |
| `send_message` / `list_agents` | 留 | 追加信息、查在飞的子智能体 |
| `wait_agent` | 留，但限制用法 | 只在「必须拿到这条结果才能回答」时短等；默认不空等 |
| `team_task_*` | 留（Host 级，模式开了才有） | 多工单的看板与跨轮记忆 |
| `write`、`edit`、`apply_patch` | **去** | 硬约束核心：改文件必须派出去 |
| `bash`、`pwsh` | **去** | 有 shell 就等于什么都能改 |
| `job_*`、`terminal_*` | **去** | 都能间接执行命令 |
| `schedule_*`、`plugin_manager`、`plugin_market` | **去** | 都能产生副作用，协调者用不上 |
| goal 工具 | **去**（可选再加） | 自动续轮和多工单的节奏容易打架 |
| `exit_plan_mode`（plan mode） | **去**（可选再加） | 主智能体本来就不执行，多一层门禁只是噪音 |
| `workflow`、`ralph` | **去** | 它们派生的子智能体没有独立预设选项（`workflow-ptc` 包内未找到 `agentPreset`），在本模式下只会派出一堆没有写权限的智能体 |
| `subagent_fork` | **去** | fork 子智能体加入父级预设修订，继承受限组合，改不了文件 |
| `present` | 留（可选） | 交付物指向；不要也不影响主流程 |

### 3.4 多工单与异步派活（本模式的核心用法）

这是这次新增需求的重点。运行时已经支持「边跑边接」，所以设计重点是把主智能体的行为固定成下面这几条，写进 persona 和守卫插件的运行时说明：

1. **一条用户消息 = 一个工单。** 收到就先用一两句话回执：这条要做什么、派给谁、大概什么时候有结果。别静默吞掉，用户连发时最怕没回应。
2. **能自己答的先自己答。** 只读查证、解释、方案讨论不派活；只有需要改文件、跑命令、执行验证时才派。
3. **派完就结束本轮，不空等。** 不用 `wait_agent` 干等，不 sleep、不轮询；子智能体完成会自动叫醒主智能体。
4. **同一件事的补充信息走 `send_message`**，发给正在处理它的那个子智能体，不要再为同一件事开一个新子智能体。
5. **每条派出去的活都在任务板上留一条记录**（目标、范围、负责人、状态）。回合之间靠它恢复记忆，压缩之后也不丢。
6. **命名能看出工单**：子智能体用 `fix-login`、`write-docs` 这类短名，后面追问和指认都方便。
7. **同一文件不并发派两单**：写冲突不会自动拦，靠主智能体拆范围。
8. **并发满了不硬顶**：池子默认 8 个，满了派活会被拒绝（`ACTIVATION_LIMIT_REACHED`）。这时把工单留在板上，先做只读准备，或等已有子智能体结束再派。
9. **汇报要短**：每单完成后一两句话 + 改了哪些文件 + 验证结论，不把子智能体的长篇结果抄进主会话。

时间线（用户想到就发的情形）：

```
用户#1 ─→ 主：分析 + 派 A        → 结束本轮
用户#2 ─→ 主：分析 + 派 B        → 结束本轮     ← A、B 同时跑
A 完成 ─→ 通知 ─→ 主：汇报 A     → 结束本轮
用户#3 ─→ 主：分析 + 派 C        → 结束本轮
B 完成 ─→ 通知 ─→ 主：汇报 B     → 结束本轮
```

主智能体几乎一直处在「空闲」状态，所以用户下一条消息永远能立刻开新一轮；只有它恰好在分析时，消息才会按 Queue/Steer 走，也不会丢。

### 3.5 守卫插件做什么

插件只在「预设 id == agent-mode」的会话上工作，其余会话完全不管。

1. **首轮钉任务板**：在 `agent/pre-step` 里判断 `agentPresets.presetForSession(session) === 'agent-mode'` 且 `turnBoundaryOf(session).lastTurn === 0`，若 Team 未开则写一次 `team/mode { enabled: true }`。只写一次，后续轮次不覆盖用户手动关闭。
2. **补一段运行时说明**：`systemPrompt.context()` 给这些会话加协调者规则，内容是 3.4 的九条压缩版，重点是「不空等、每条消息先回执、派完结束本轮」。这条每步都会刷新，压缩之后也不会丢。
3. **兜底 guard**：`ctx.tools.guard()` 拦下主智能体对 `write/edit/apply_patch/str_replace_editor/bash/pwsh/terminal_open/terminal_send/job_output` 的调用，返回「请派给子智能体」。
   为什么必须有这层：预设清单只控制预设级工具。本机 profile 里的终端组合包、记忆插件、截图工具都是**宿主级**注册的，所有 Agent 都能看到；其中 `terminal_*` 等于能跑任意命令，所以必须拦。
   为什么用 `guard` 不用 `restrict`：`restrict()` 要求从 `agent.ctx` 调用（Host 级调用会直接报错），而且会校验工具名必须已存在、不存在就抛错；`guard` 只按名字拒绝，不受这两条限制。

首轮事件顺序：`agent/pre-step` → 写 `team/mode{enabled:true}` → 请求组装（工具可见性按新状态计算）→ 模型调用。

### 3.6 强制层级

| 层 | 手段 | 强度 |
| --- | --- | --- |
| L1 | 预设里没有写工具和 shell | 硬缺，模型想调都调不到 |
| L2 | 守卫首轮打开 Team | 自动开，不用用户记着点 |
| L3 | persona + 每步运行时说明 | 固定多工单行为，压缩后仍在 |
| L4 | 可选 tools.guard 兜底 | 防 Host 级/插件级写入工具 |

L1 是主要手段，L2 让「团队协作」真正落地，L3 保证「边等边接活」的节奏，L4 补强。

### 3.7 子智能体

- 固定 `agentPreset: standard`：子智能体拿到完整标准模式能力（写文件、跑命令、跑测试）。
- 深度：默认 `maxDepth` 是 1，主智能体（深度 0）派子智能体（深度 1）后就到底了，子智能体不能再派活。想留一级「小组长」就把 `maxDepth` 调到 2，代价是失控风险和执行成本。
- 并发：默认 8 个同时活着的子智能体，够「想到就发」的节奏；真不够可以调 Host 的 `maxActiveSubagents`。
- 子智能体仍然能看到 Team 工具（团队按根会话算），可以自己认领任务。

### 3.8 团队任务板

- 根会话首轮自动开，任务板出现在会话里。
- 主智能体标准流程：建任务（目标、依赖、写清可能改到哪些文件）→ 派子智能体时把任务 id 写进 prompt → 子智能体自己 claim → 完成后主智能体 `team_task_update` 收口 → 汇报。
- 写文件范围只是提示，不会阻塞，真正的保护靠主智能体拆范围。

### 3.9 不做的东西

- 不改 DSH 本体，不 fork 源码树。
- 不做「每轮强制把任务板抢回来」的激进模式（只钉首轮）。
- 不接管「繁忙时回车」的全局设置（那是 Web 的个人偏好，方案里只给建议：这个模式下用 Queue 更稳，Steer 适合中途纠正方向）。

## 4. 一个会话的时间线

1. 新建会话选「智能体模式」，提第一个需求。
2. 主智能体读文件、查资料、必要时用 `ask_user_question` 澄清；先给一句回执。
3. 要改东西就拆任务上板，派子智能体；派完结束本轮。
4. 用户随时补发新问题，每条都会开新一轮（或按 Queue/Steer 投递），主智能体逐条分析、逐条派活。
5. 子智能体陆续完成，通知把主智能体叫醒；主智能体按完成顺序汇报，并处理期间收到的补充信息。
6. 验收：再派子智能体跑测试、看改动（主智能体自己跑不了命令）。
7. 收尾：主智能体给出这批工单的总览——做了什么、改了哪些文件、验证结论、遗留风险。

## 5. 边界与风险

1. **主智能体跑不了命令**，测试和看 diff 只能派出去，验收环节绕不开。
2. **主智能体正忙时，新消息要等这一轮结束**（Queue），或者插进这一轮（Steer）。所以要把每轮做短，否则用户会觉得慢。
3. **宿主级工具不受预设约束**：终端、记忆、截图、远程控制这类工具由宿主插件注册，智能体模式里照样能看到。其中终端类已在兜底拦截名单里，其余是只读或非代码操作。
3. **并发上限 8**：满员时新派活直接报错，不会排队；需要主智能体把活留到板上等空位。
4. **完成顺序不等于派活顺序**：先派的后完成很正常，汇报按完成顺序来。
5. **并行写同一个文件**：不自动拦，靠拆任务 + 验收时核对。
6. **上下文膨胀**：每条消息、每份完成通知都进历史；靠压缩 + 短汇报控制。
7. **成本**：每个子智能体一份独立上下文，全局指令（AGENTS.md）重复计费；派活粒度要控制。
8. **不能中途切换模式**：会话开始后锁死，要换就新开对话。
9. **装完要重启**：宿主只在启动时组装插件树。
10. **卸载残留**：历史会话仍记录 `agent-mode`，菜单里会显示但不可用。

## 6. 实施与验证记录（2026-11-17）

落地位置按用户要求改成现有的 `dsh-purewhite-toolkit`，不另开包。

| 产物 | 位置 |
| --- | --- |
| 预设声明 | `plugins/dsh-purewhite-toolkit/cordis.patch.yml` 的 `preset-agent-mode` 行 |
| 守卫插件 | `plugins/dsh-purewhite-toolkit/agent-mode-guard.js` |
| 单元测试 | `plugins/dsh-purewhite-toolkit/test/agent-mode-guard.test.mjs` |
| 说明文档 | `plugins/dsh-purewhite-toolkit/README.md` 的「智能体模式」一节 |

已执行并确认的验证：

- `cordis.patch.yml` 用 PyYAML（自定义 loader 跳过 `!!js`）解析通过：行 id 唯一，`preset-agent-mode` 的 `config` 含完整 `id`/`name`/`description`/`order`/`plugins`，插件清单 16 项（含一个 `cordis:group`），`agent-mode-guard` 行的 `preset` 指向 `agent-mode`；
- `package.json` 解析通过，`exports` 含 `./agent-mode-guard`，`files` 含 `agent-mode-guard.js`，版本升到 0.6.0；
- 预设引用的 14 个 `@deepseek-ai/*` 包全部能从安装目录解析，`dsh-purewhite-toolkit/agent-mode-guard` 能从 profile 解析；
- `node --check agent-mode-guard.js` 通过；
- `node test/agent-mode-guard.test.mjs` 11/11 通过（首轮开任务板、非首轮不动、已是开启态幂等、子代理会话跳过、agentTeams 缺失不报错、运行时说明只对智能体模式生效、工具守卫拒绝写类工具、不误伤其它预设、自定义名单生效）；
- 在插件管理器里把 `dsh-purewhite-toolkit` 关一次再打开后，Loader 里 `include:preset-agent-mode` 与 `include:agent-mode-guard` 两行都是 `active`，总行数 231 → 233。

尚未验证（需要人工开一个新会话）：

- 模式下拉里出现「智能体模式」，能选中；
- 选中后工具列表里确实没有 `write`/`edit`/`bash`/`pwsh`；
- 首轮之后任务板自动出现；
- 子智能体能写文件、跑命令；
- 标准模式与只读模式行为不变。

## 7. 验收清单

- [ ] 新建会话能选到「智能体模式」，卡片上有名称和说明
- [ ] 工具列表 = 读/查/问/派活，没有写文件和 shell
- [ ] 根会话的 Team 自动打开，标准模式会话不受影响
- [ ] 连续发 3 条消息：每条都有回执，各自派出子智能体，互不覆盖
- [ ] 子智能体在跑时再发一条：不丢，且能立刻被分析（主智能体空闲时）
- [ ] 主智能体正忙时发一条：按 Queue/Steer 正常投递，轮末被处理
- [ ] 子智能体完成时主智能体自动被叫醒并汇报，不需要用户催
- [ ] 对同一件事的补充信息走 `send_message`，不开重复子智能体
- [ ] 并发满时主智能体把活留在板上，不当作失败收场
- [ ] 标准模式 / 只读模式行为不变；重启后配置仍在

## 8. 执行结论（按推荐默认落地）

1. 强制层级：预设里拿掉写工具和 shell（L1）+ 守卫首轮开任务板（L2）+ 每步运行时规则（L3）+ 可选 `tools.guard` 兜底（L4）。落成代码。
2. 子智能体：沿用 `standard` 预设，`maxDepth: 1`。
3. 任务板：首轮自动打开（`teamMode: true`）。
4. 命名：预设 id `agent-mode`，显示名「智能体模式」，`order: 5`。

改成别的取值只需要动两处：`cordis.patch.yml` 的预设清单，和 `agent-mode-guard` 行的 `config`。

## 附：证据索引

- 预设声明 schema：`@deepseek-ai/dsh-agent-preset/src/index.ts:16-23`
- 内置预设清单：`@deepseek-ai/dsh-web-app/presets/standard.patch.yml:4-137`（ptc/minimal/cordis 同目录）
- 预设选择锁：`@deepseek-ai/dsh-agent-preset-registry/src/index.ts:364-383`
- 子智能体预设选择：`@deepseek-ai/dsh-tool-subagent/README.md:66-73`、`lib/index.js`
- 派活立即返回、完成通知叫醒空闲父级：`@deepseek-ai/dsh-tool-subagent/README.md:60`、`:170-178`
- 子智能体并发上限：`@deepseek-ai/dsh-subagent/README.md:51-57`
- 队列与转向投递：`@deepseek-ai/dsh-client-ui-conversation/README.md:139`、`@deepseek-ai/dsh-agent-loop/src/inbox.ts:80-113`
- Team 默认与开关：`@deepseek-ai/dsh-agent-team/src/index.ts:79-118`
- Team 工具可见性：`@deepseek-ai/dsh-tool-agent-team/src/index.ts:102-111`
- 工具守卫 API：`@deepseek-ai/dsh-tools/src/index.ts:379-401`
- 工具名清单：`@deepseek-ai/dsh/docs/tool-catalog.zh.md:20-58`
- 本机先例：`plugins/dsh-purewhite-toolkit/cordis.patch.yml:16-152`、`readonly-guard.js:1-174`
