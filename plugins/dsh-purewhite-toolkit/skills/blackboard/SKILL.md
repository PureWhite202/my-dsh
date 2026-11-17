---
name: blackboard
description: "Use ONLY when the user explicitly invokes /blackboard or explicitly names the University of Southampton Blackboard Ultra site (https://blackboard.soton.ac.uk/ultra/...) and asks to browse, download, verify or update course content; never auto-load it for general study, note-writing or revision work. 触发场景：用户输入 /blackboard，或明确说「去 Blackboard / 查我课程页 / 下载课程资料 / 看看有没有新公告」并指向南安普顿 Blackboard Ultra。"
---

# Blackboard（南安普顿 Ultra）操作

随 `dsh-purewhite-toolkit` 插件注册（`skills/blackboard`），用本机持久化 Chromium 打开
`https://blackboard.soton.ac.uk/ultra/…`，在已登录的会话里读取、下载、核对课程资料，
产物落在 `D:\Document\马来南安学习`。

## 一、触发边界（硬规则）

- **只在用户主动调用时使用**：用户输入 `/blackboard`，或明确点名 Blackboard / 课程页 /
  `blackboard.soton.ac.uk` 并要你去看、下载、核对。
- 用户只说「整理笔记 / 写报告 / 复习 / 做 lab」而没提网站 → **不加载、不打开浏览器**。
  这条判断的是「要不要启用本技能」；一旦启用，就按第三节先查登录态，「不打开浏览器」不再适用。
- 用户在其他任务里顺带问「Blackboard 上是怎么写的」→ 算明确点名，可以使用。
- 不要因为「这个任务大概和课程有关」就自动启用；不要在没有用户请求时浏览该站。

## 二、站点与登录

| 用途 | 地址 |
|---|---|
| 课程列表（入口） | `https://blackboard.soton.ac.uk/ultra/course` |
| 课程内容 | `/ultra/courses/<courseId>/outline` |
| 公告 | `/ultra/courses/<courseId>/announcements` |
| 日历 | `/ultra/calendar` |
| 作业 | `/ultra/courses/<courseId>/assessment/<id>/overview?courseId=<courseId>` |
| 文档 | `/ultra/courses/<courseId>/document/<id>?view=content&state=view` |
| 文件 | `/ultra/courses/<courseId>/file/<id>?courseId=<courseId>` |

已知课程 ID（2026-10 观测，可能变动，以课程列表实际为准）：
COMP1300 `_236845_1`、COMP1311 `_236848_1`、COMP1312 `_236851_1`、
COMP1313 `_236854_1`、COMP1314 `_236857_1`。

登录是学校 SSO（Microsoft），会话保存在浏览器 profile 里。**账号、密码、验证码一律由用户
本人在浏览器窗口输入**：不代填、不写进任何文件、不读取 `.credentials.yaml`、不翻浏览器密码库。

## 三、必须停下并告知用户的情况（最高优先级）

任务开始先查登录态；出现下列任一情况，**立刻停手**，不要重试、不要刷新、不要绕：

- 页面跳到 `login.microsoftonline.com`、学校 SSO 页、或出现 `Sign in`
- 出现 `Enter code`、`verification code`、Authenticator 批准、双因素确认
- 反复 401/403、会话过期提示、或页面卡在转圈超过约 60 秒
- Panopto 单独要求登录

处理顺序：
1. 一句话说清卡在哪一步。
2. 浏览器没开就先跑启动脚本（见下节）。
3. 请用户在那个窗口里自己完成登录／验证码，完成后回一句。
4. 用户确认后再继续原任务；若用户把验证码发在聊天里，建议他直接敲进浏览器窗口，不要留存。
5. 不要连续重试。

话术参考：「浏览器已经打开，页面卡在登录／验证码这一步。需要你在这个窗口里完成登录，
密码和验证码我这边看不到也不会保存。弄好跟我说一声，我接着做。」

## 四、浏览器与登录态（本机已核实）

- 技能目录：`<插件目录>\skills\blackboard`，本机是
  `D:\Document\Code\dsh-purewhite-toolkit\skills\blackboard`；技能加载时会给出
  Base directory，插件装在别处就按它换算。
- Chromium：`C:\Users\Administrator\AppData\Local\ms-playwright\chromium-1247\chrome-win64\chrome.exe`
  （Playwright 自带；本机没装 Chrome／Edge）
- Profile（保持 SSO cookie）：`C:\Users\Administrator\.dsh\browser-profiles\blackboard`
- CDP：`127.0.0.1:9222`

下面用 `BB` 代指技能目录下的 `scripts\bb.py`，本机完整路径是
`D:\Document\Code\dsh-purewhite-toolkit\skills\blackboard\scripts\bb.py`。
启动脚本 `scripts\open-blackboard.cmd` 与它同目录。

| 目的 | 命令 |
|---|---|
| 启动浏览器 | 双击或运行 `<技能目录>\scripts\open-blackboard.cmd`（带 `--no-sandbox --disable-gpu`） |
| 列出标签页 | `python BB pages` |
| 查登录态 | `python BB status --shot <png>` |
| 打开页面 | `python BB goto <url> --dump 4000` |
| 关闭浏览器 | `python BB close` |

`BB` 参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--page-index N` | 不传 | 驱动哪个标签页；不传时取**最后一个 Blackboard 标签**，没有 Blackboard 标签才取最后一个 |
| `--shot <png>` | 空 | 截图存到该路径，不给就不截 |
| `--dump N` | 3000 | 只返回正文前 N 个字符 |
| `--load-timeout N` | 25 | 等页面渲染的上限秒数（星号转圈的 SPA） |
| `--wait N` | 3 | 正文出现后再多等几秒 |
| `--port N` | 9222 | CDP 端口 |

`D:\Document\马来南安学习\COMP1300\打开Blackboard.cmd` 是早先留下的旧入口，仍然能用，但缺
`--no-sandbox` 与 `--disable-gpu` 两个 flag；优先用本技能脚本。别同时开两个，它们会争同一个
profile 和 9222 端口。

`close` 依赖 `websocket-client`（本机 1.9.0 已装）；缺包时改用第十节的 taskkill 方式。

本技能随插件注册（`source=bundled`），在技能管理器里不能单独禁用；要关掉全部自带技能，
改插件配置 `skills: false`（会连 `sync-config` 一起关）。

`status` 输出的 `state` 按表处理：

| state | 处理 |
|---|---|
| `logged_in` | 继续 |
| `login_required` / `code_required` | 停手，按第三节告知用户 |
| `loading` | 隔 5 秒再跑一次，累计约 60 秒；仍 `loading` 就带 `--shot` 看画面，告诉用户「页面没渲染出来」 |
| `unknown` | 先 `BB pages` 看标签页，再 `BB status --shot` 截图判断；最多重试两次，仍不确定就问用户，不要盲试 |

## 五、最小工作流

1. 启动浏览器（若 9222 未监听）。
2. `BB status` 确认 `logged_in`；否则按第三节处理。
3. 单步查看用 `BB goto`；多步操作写临时 Python 脚本放 `D:\Document\马来南安学习\.work\`。
4. 页面是 SPA：`goto` 后必须等正文渲染（`bb.py` 已内置最多 25 秒轮询）。
5. 结束看情况：用户还要继续就留着窗口；本次收尾可用 `BB close`。

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp("http://127.0.0.1:9222", timeout=15000)
    pages = b.contexts[0].pages
    for i, t in enumerate(pages):
        print(i, t.url)                       # 先确认有哪些标签页
    pg = [t for t in pages if "blackboard.soton.ac.uk" in t.url][-1]
    # 下面这条 url 只是示例：换课要改 courseId，别把 _236851_1 当通配
    pg.goto("https://blackboard.soton.ac.uk/ultra/courses/_236851_1/outline",
            wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(6000)                  # Ultra 前端渲染
    print(pg.title())
    print(pg.inner_text("body")[:4000])
```

## 六、常见操作配方

- **弹窗**：进课程常弹出公告框，先点 `Close new announcements modal` / `Close`。
- **公告 / 判断「有没有新公告」**：关掉弹窗后开 `/ultra/courses/<courseId>/announcements`
  看完整列表——弹窗只显示一部分，不能当全部。页签上的数字（如 `Announcements 3`）与列表的
  `3 Total` 对得上，可用来确认是否加载全。「新」要有基准：上次核对日期、用户给的日期，
  或页面上的未读标示；没有基准就先问「上次看到哪天」，不要自己定义一个「新」。
  站点日期常用 DD/MM/YYYY（英国格式），引用前核对，别把 `10/11/2026` 读成 10 月 11 日。
- **Panopto 录播**：课程 → `Resources and Support Materials`（学习模块，可能折叠，按钮名
  `Learning Module, Resources and Support Materials`）→ `Panopto Recorded Sessions`
  → 列表在 `#lti-launch-iframe` 里，条目链接形如
  `https://southampton.cloud.panopto.eu/Panopto/Pages/Viewer.aspx?id=<uuid>`。
- **下载文件**：`with pg.expect_download() as dl: link.click()`，再
  `dl.value.save_as(r"D:\Document\马来南安学习\COMP1312\<原名>")`（课程目录换成实际那门）；
  `/file/…` 链接通常直接下载，`document/…` 会先开在线预览。
- **文档预览转下载**：预览页工具栏一般有下载按钮；找不到就从页面里抽 `/file/` 链接——
  ```python
  links = pg.eval_on_selector_all("a[href*='/file/']", "els => els.map(a => a.href)")
  print(links[:10])   # 新标签打开后下载，或直接把链接当文件地址请求
  ```
  预览在 iframe 里时，先遍历 `pg.frames` 找含 `/file/` 的那个 frame 再抽。
  仍有拿不到的情况就截图留证，如实说「只拿到预览，没拿到原文件」，不要用 OCR 拼「下载成功」。
- **截图存证**：直接用 `BB ... --shot <png>`——它先试 `pg.screenshot()`，碰到字体等待超时就自动
  回退到 CDP `Page.captureScreenshot`；跨域视频画面普通截图是黑的，也走这条回退。
- 站点 UI 是英文、深色主题；课程名形如 `COMP1312-46136-26-27`，后半段是 26-27 学年的课程
  实例号，核对时认 `COMP1312` 和课程名，别把 `461xx` 当课程号。

## 七、目录约定（`D:\Document\马来南安学习`）

| 目录 | 用途 |
|---|---|
| `COMP1300`、`COMP1311`、`COMP1312`、`COMP1313`、`COMP1314` | 各课资料、笔记、作业产物 |
| `.work` | 临时脚本、下载中间产物、验证截图 |
| `.planning` | 任务计划与进度 |
| `.recording-work` | 录播抓取脚本、截图、字幕中间件 |
| `录播与笔记核对-<日期>.txt` | 阶段性核对记录 |

- 下载保持原文件名；同名不覆盖，先跟用户确认。
- 笔记命名沿用现有风格：`COMP1312-10.26.txt`、`COMP1300-重要事项-截至2026-10-19.txt`。
- 目录里不放 cookie、密码、token。

## 八、证据与准确性

- 结论附完整 URL + 访问日期；页面内容以实际抓取为准，不凭记忆补。
- 拿不到（未登录、无权限、页面未渲染）就写「未核实」，不脑补。
- 网页会更新，写「截至 <日期>」，不要写成永久事实。

## 九、禁止

- 代填／保存密码，读取浏览器密码库，绕过或伪造 MFA。
- 未实际执行就宣称「已登录 / 已下载 / 已核对」。
- 把课程资料、个人信息上传到第三方站点。

## 十、排错

| 现象 | 处理 |
|---|---|
| `ECONNREFUSED 127.0.0.1:9222` | 先跑启动脚本，等 5–10 秒 |
| 打开后长时间深色转圈 | 等 15–25 秒；仍空白用 `--shot` 看画面 |
| 401/403 或跳登录 | 会话失效，让用户重新登录（第三节） |
| 端口被占／旧进程残留 | 先 `BB close`；仍占用就 `netstat -ano \| findstr :9222` 找 PID，再用 `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` 看 CommandLine 是否含 `browser-profiles\blackboard`，确认后再 `taskkill /PID <pid> /T /F`；不确定就问用户，别乱杀进程 |
| Panopto 要求登录 | 属 SSO 场景，停下来告知用户 |
| iframe 读不到 | 用 `pg.frame_locator("#lti-launch-iframe")` |

## 十一、验证记录

2026-11-18 在插件目录实测：`node test/skills-register.test.mjs` 确认 `skills.register` 收到
`blackboard`（source=bundled，path=`skills/blackboard/SKILL.md`）与 `sync-config`；
从 `skills/blackboard/scripts/bb.py` 实跑，启动后 9222 监听、`status` 返回 `logged_in`
（标题 `Courses`）、`goto` COMP1312 `outline` 与 `announcements` 均返回正文（公告 3 条，
最新 `10/11/2026`）、`--shot` 经 CDP 回退 3.7 秒出图、`close` 后 9222 释放。
下载与 Panopto 内嵌页本次未复测，按第六节配方处理，首次使用先小步验证。

同日修订：加 `--page-index` 与按域名选标签页；截图失败不再吞掉已读正文；截图改用
`grab_screenshot()`（Playwright 超时自动回退 CDP）。
