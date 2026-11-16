/**
 * policies — 把「证据优先」与「写作规范」两类长期规则注入系统提示词。
 *
 * 这两段原本写在 `~/.dsh/AGENTS.md` 里。搬进插件是因为：
 *   1. AGENTS.md 由 dsh-agent-instructions 以一条 user 消息插进对话，规则一改就多一条历史；
 *      这两段几乎不变，放系统提示词里能吃到前缀缓存，也不占 AGENTS.md 的 maxBytes 预算；
 *   2. 用系统的 order 排序占位，比夹在 AGENTS.md 的大段文字里更可控；
 *   3. 关掉配置键或卸载插件就整体消失，不会在会话里留下半截规则。
 *
 * 文本放在插件目录的 `prompts/*.md`，改文案不碰 JS：
 *   - `prompts/evidence-first.md` → 节名 `policy:evidence-first`，默认 order 100
 *   - `prompts/writing-style.md`  → 节名 `policy:writing-style`，默认 order 200
 *
 * 为什么用 `systemPrompt.section()` 而不是 `systemPrompt.context()`：
 *   context 会在每轮组装成「当前运行时上下文」快照塞进用户消息，适合随会话变化的说明
 *   （只读模式、协调者规则）；这两段是稳定指令，属于系统提示词正文。
 *
 * `interpolate: false`：正文里若出现 `{{...}}`，默认会被当成提示词变量，缺变量时整个组装抛错。
 *
 * 依赖：宿主服务 systemPrompt（缺失时整体跳过，不抛错）。
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'policies'

/** 只依赖系统提示词注册表；宿主没有这个服务时插件不激活。 */
export const inject = ['systemPrompt']

/** 插件根目录（解析默认的 prompts 目录用）。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** 默认的正文目录。 */
const DEFAULT_DIR = join(PLUGIN_DIR, 'prompts')

/**
 * 两份正文的注册表。`key` 同时是配置里开关与 order 的字段前缀
 * （`evidence` / `evidenceOrder`、`writing` / `writingOrder`）。
 */
const DOCUMENTS = [
  {
    key: 'evidence',
    section: 'policy:evidence-first',
    file: 'evidence-first.md',
    order: 100,
  },
  {
    key: 'writing',
    section: 'policy:writing-style',
    file: 'writing-style.md',
    order: 200,
  },
]

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 见 README 的配置表，全部可省略。
 */
export function apply(ctx, config = {}) {
  if (ctx === null || typeof ctx !== 'object') return
  const systemPrompt = ctx.systemPrompt
  if (systemPrompt === undefined || systemPrompt === null) return
  if (typeof systemPrompt.section !== 'function') return

  const dir = directoryOption(config, 'dir', DEFAULT_DIR)

  for (const document of DOCUMENTS) {
    if (!booleanOption(config, document.key, true)) continue

    const text = loadDocument(ctx, dir, document)
    if (text === '') continue

    const order = numberOption(config, `${document.key}Order`, document.order)
    ctx.effect(
      () =>
        systemPrompt.section({
          name: document.section,
          order,
          text,
          // 正文是散文/示例，不是提示词模板；关掉插值，避免 `{{...}}` 被当成变量。
          interpolate: false,
        }),
      `dsh-purewhite-toolkit: ${document.section} prompt section`,
    )
  }
}

/**
 * 读取一份正文；读不到时告警并返回空串，让插件照常加载其余部分。
 * @param ctx Cordis 上下文（取 logger）。
 * @param dir 正文目录。
 * @param document 注册表条目。
 * @returns 去掉首尾空白的正文；文件缺失或为空时返回空串。
 */
function loadDocument(ctx, dir, document) {
  const path = join(dir, document.file)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(
      'policies: cannot read %s (%s); section "%s" will not be injected',
      path,
      error?.message ?? String(error),
      document.section,
    )
    return ''
  }
  const text = raw.trim()
  if (text === '') {
    ctx.logger?.warn?.('policies: %s is empty; section "%s" will not be injected', path, document.section)
  }
  return text
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
 * 读取数字型配置，非有限数字回退默认值。
 * @param config 插件配置。
 * @param key 字段名。
 * @param fallback 缺省值。
 * @returns 数值。
 */
function numberOption(config, key, fallback) {
  const value = config?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 读取正文目录配置；相对路径按插件目录解析。
 * @param config 插件配置。
 * @param key 字段名。
 * @param fallback 默认目录。
 * @returns 绝对路径。
 */
function directoryOption(config, key, fallback) {
  const value = config?.[key]
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const trimmed = value.trim()
  return isAbsolute(trimmed) ? trimmed : resolve(PLUGIN_DIR, trimmed)
}
