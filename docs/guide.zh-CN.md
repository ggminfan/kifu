# Kifu（棋谱）

[English overview](../README.md) · [中文概览](../README.zh-CN.md) · [参与贡献](../CONTRIBUTING.md) · [安全政策](../SECURITY.md) · [代码 MIT 许可](../LICENSE) · [品牌政策](../TRADEMARKS.md#简体中文)

> 每一步都看得见，每一手都能重下。

本地工具，服务于 **Codex** 和 **Claude Code** 等 code agent 的开发。它把执行过程可视化，并把一次运行拆成可观察、可编辑、可重放的上下文：单个会话里调一轮（改 skill / 输入 / 模型后回放对比），在一批会话上评测 skill 的改动（提升和回归），以及把反复的澄清和共性的执行路径沉淀成新 skill。

Codex 和 Claude Code 的会话都能查看（时间线、上下文、技能、问题、问为什么）。**回放、评测、提炼 skill** 支持 Codex：本机的会话在本机运行，SSH 开发机上的会话在开发机上运行（用那台机器上的 agent 和登录）。

会话浏览和分析数据保存在本机，服务默认只监听 `127.0.0.1`。回放、问为什么、评测和提炼会调用你配置的 `codex`，它可能向模型提供方发送上下文并消耗额度。连接 SSH 远端时，会话内容经 SSH 隧道传到本机显示。Kifu 是独立项目，不代表 OpenAI 或 Anthropic 官方。

## 功能

| 模块 | 能做什么 |
|---|---|
| **会话工作台** | 读取 Codex、Claude Code 的全部会话（含子 agent 树）。一个 Agent 的会话在同一个列表里，来自多个 CODEX_HOME / 项目时按来源标注、可筛选。还在 agent 索引里、但记录文件已经被删除或移走的会话读不到内容，收在列表底部的“读取不到的会话”里，默认折叠，也不计入会话数、不会被拿去生成用例或评测集。<br>时间线展示轮次 / LLM 调用 / 工具调用，空闲时段会被压缩；最下一条是每一步的输入大小（深色部分是缓存命中，凹下去就是缓存失效）。<br>每个步骤（Step）一张卡片：推理、回答、工具调用和 code-mode 内部命令，输入比上一步涨了多少；上下文压缩、回滚、中断、请求错误在步骤之间标出位置（压缩前后的输入）。`j` / `k` 上下一步，`J` / `K` 上下一轮。<br>**输入上下文**：点任意一步，看当时模型看到的完整输入——按进入上下文的轮次分组，每条标出是哪一步写的、哪次工具调用的输出（点一下跳过去）；token 构成、上下文窗口占用和缓存命中；相比上一步新增了什么、被压缩掉了什么；全文搜索（不只是预览）、按大小排序。上方的"各步的输入构成"把整个会话每一步的输入按类别堆起来：上下文怎么涨满、被什么占满、压缩掉了什么，点一列跳到那一步。<br>**工具详情**：参数（JSON 缩进）、输出（可直接看末尾的报错）、执行事件，都可复制。**原始记录**：可以前后翻相邻的记录，一键跳到工具的调用 / 事件 / 输出那一行；字符串里的换行按行显示。 |
| **技能面板** | 列出模型看到的 skill 列表。被截断、模型看不到的描述尾部用红色删除线标出。<br>记录每个 skill 被加载的方式和所在步骤，并给出信号：可能漏触发、触发词被截断、部分读取、加载未遵循、描述已变更。 |
| **问题栏与相关度** | 会话头部列出这次会话里值得看的地方：失败的工具 / 命令、疑似循环、中断、请求错误（确定的），以及可能漏触发、触发词被截断、加载未遵循（启发式），可以上下跳转，步骤和轮次上也有标记。<br>选中一个工具调用后，"输入上下文"变成相关度视图：用 BM25 把上下文按与这次调用的相关度排列并高亮匹配的行（skill 正文、用户输入、工具输出、磁盘上的 SKILL.md……），看它最可能是被哪段上下文引导的。 |
| **调试（回放）**（Codex） | 在执行不对的那一轮点"调试这一轮"，生成一个**用例**：会话到这一轮为止的副本（APFS 克隆，几乎不占空间），加上从问题推导出的检查项。<br>**为什么**："问为什么"把会话摘要交给一个不带 skill 和插件的分析员（agent 自己的命令行），返回结构化结论，引用会校验锚点和原文；修改建议一键生成变体并加入改动。<br>**改什么**：改输入、改 skill 的描述 / 正文（变体，带截断标尺）、换模型和推理强度（来自 agent 自己的模型列表）、编辑检查项。<br>**回放**：用本机同一个 agent、它自己的登录和额度，从这一轮之前接着跑；每组改动和不改动的基线 A′ 各跑 N 次，可设步数上限，实时显示进度。<br>**对比**：每项检查在原始、A′、各组改动下的通过数，步数 / 失败命令 / token 的中位数，任意两次的工具调用对齐（标出第一个分歧）和回答 diff；每次回放还给出保真度（第一次请求覆盖了原上下文多少，agent 恢复时又插入了什么）。<br>**应用**：满意的变体写回真实 skill（先备份，可撤销）。<br>SSH 开发机上的会话就在开发机上调试。 |
| **评测**（Codex） | **评测集**：一组用例，每个用例对评测的 skill 有一个角色——正例（应该加载）、反例（不应该加载）、对照（描述相近的 skill 被加载的会话，改动后不能抢它们的触发）。可以按会话索引"从 skill 生成"，也可以在会话列表多选会话加入。<br>**运行**：用例 × 几组改动（A′、变体、新 skill、换模型）× 每格 N 次，在后台队列里排在交互操作之后；先给出用量预估，超过 20 格或 200 万 token 要再确认，单次最多 200 格；可以暂停、继续、取消；服务重启后暂停、等你手动继续；遇到限流退避重试。<br>**报告**：每组的通过率、步数和输入 token 的中位数，评测 skill 的召回 / 误触发 / 精确率；比基线差的用例置顶（两边都 ≥5 次时给出单侧 Fisher 检验的 p 值）；矩阵里点一格看每次运行、检查和对比，跳到回放会话。<br>**模型评分**（可选）：再调用一次 agent，按 2–6 条评分项打 1–5 分，可以人工改分。 |
| **提炼 skill**（Codex） | 在会话列表多选几个做同一类事情的会话（或一个反复澄清的会话），点"提炼 skill"：<br>**素材**（规则，不调模型）：几个会话共有的工具 / 命令路径、agent 反问后用户的回答和用户的纠正（跨会话聚类）、最相近的已有 skill，并建议"改已有的"还是"新建"。<br>**草稿**：agent 作为不带 skill 的分析员，按素材写出名称、描述（正 / 反触发词）、步骤、默认做法（不用再问）、注意事项；每条依据都核对原文。也可以自己写。<br>**校验**：名称合法、不重名；用 agent 自己的 skill 列表渲染（不调模型）看描述会不会被截断、触发词看不看得到、会不会挤掉其它 skill。<br>**评测**：保存成"新 skill 变体"（不写入 skills 目录），自动建评测集：来源会话的请求做正例（要求加载它、不再反问），几个无关的近期会话做反例，比较不加它和加上它。<br>**安装**：写入 agent 的 skills 目录，可撤销。 |
| **Skills** | 浏览当前 Agent 的 skill 目录（Codex、Claude Code），编辑变体（description + 正文），与原版做 diff。<br>**预览**（Codex）：离线渲染模型实际看到的 skill 列表，查看截断位置以及对其他 skill 的挤占。<br>**试跑**（Codex）：同一个 prompt 同时运行基线 A′ 和变体 B，可选只读 / 克隆 / 原地，支持重复多次；**对比**指标、工具序列对齐和最终回答 diff。<br>**相关会话**：索引里列出过、加载过、可能漏触发、描述被截断的会话；**评测**和**用例**：和这个 skill 有关的评测集、评测记录和用例。<br>**应用**：写回真实 skill，写之前自动备份，可以撤销；插件 skill 只导出补丁；新 skill 是安装。 |

## 快速开始

需要 **Node.js 22.22.1 或 24**、**pnpm 10.32.1**；支持 macOS / Linux。Bun 由项目依赖安装，不依赖全局版本。桌面构建目前需要 macOS Apple Silicon 和 Xcode Command Line Tools。

```bash
npm install --global pnpm@10.32.1
pnpm install --frozen-lockfile
```

```bash
pnpm dev
```

然后打开 http://127.0.0.1:5173 （API 在 7788 端口，Vite 会把 `/api` 代理过去）。

没有本机会话时，可运行 `pnpm demo:replay` 体验合成数据演示，不需要模型账号，也不会调用真实 agent。

生产模式：

```bash
pnpm build && pnpm start
```

然后打开 http://127.0.0.1:7788 。

环境变量（都可选）：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `KIFU_AGENT` | `codex` | 设为 `claude`，在浏览器里查看 Claude Code 的会话 |
| `CODEX_HOME` / `CLAUDE_CONFIG_DIR` | `~/.codex` / `~/.claude` | Codex / Claude Code 的数据目录 |
| `KIFU_ROOTS` | – | 逗号分隔的扫描目录：读取其中找到的全部 Codex home（或 Claude Code 配置目录） |
| `CODEX_BIN` | PATH 里的 `codex` | 回放、试跑和分析员用的 codex 可执行文件 |
| `KIFU_HOME` | `~/.kifu` | 本工具的数据目录 |
| `KIFU_PORT` | `7788` | API 端口 |
| `KIFU_NO_INDEX=1` | – | 关闭后台索引 |

## 桌面客户端（含 SSH 远端）

桌面端使用 Electrobun（Bun）做薄壳，只有一个主窗口。**工作区 = 一个连接上的一种 Agent**（Codex、Claude Code），每个工作区由各自的 `kifu-server` 进程提供界面，本机和远端用的是同一个编译好的服务端。

```bash
pnpm desktop:dev
```

先编译服务端，再启动开发版客户端。

```bash
pnpm desktop:build
```

产物在 `desktop/build/stable-macos-arm64/Kifu.app` 和 `desktop/artifacts/*.dmg`。应用图标是画出来的 Kifu 字标（i 的点是一颗星芒），图形数据定义在 `src/shared/brand-artwork.json`，由 `src/shared/brand.ts` 渲染：64 pt 及以上用整个字标，32 pt 及以下用 K 和星芒。改了以后运行 `pnpm icons`，它会重新生成 `desktop/assets/kifu-icon*.svg` 和打包用的 `desktop/assets/Kifu.iconset`；界面里的标志（标题栏右上角、网页头部、关于页、浏览器标签页图标）直接用同一份图形。

**窗口布局**

- **左侧栏**（⌘B 显示/隐藏，可拖动调宽）：按连接分组（本机 / SSH 主机），每个连接下列出找到的 Agent（Codex / Claude Code，用各自的图标），带会话数和来源数。点一个就在新标签里打开这个 Agent 的工作区：它的全部会话在一个列表里，按最近活动排序。已打开的带绿点。远端主机还没连接时，点它会先自动连接。
- **本机也是一个连接，按需开启**：新安装时是关的，欢迎页和 设置 → 连接 → 本机 里可以打开；关掉会关闭本机的标签、停掉它的服务端，侧栏里也不再显示。
- **每个连接扫描哪些 Agent、去哪里找，在 设置 → 连接 里按连接配置**。每种 Agent 一个开关和一组扫描目录（每行一个，支持 `~`、开头的 `$变量`（远端取登录 shell 里的值）和路径里的 `*`，最多向下找 3 层），找到的多个目录合在同一个工作区里，可按来源筛选：
  - **Codex**：找 CODEX_HOME（含 `state_5.sqlite` 或按日期归档的 `sessions/`）。默认 `~/.codex` 和 `$CODEX_HOME`。
  - **Claude Code**：找配置目录（含 `projects/`）。默认 `~/.claude` 和 `$CLAUDE_CONFIG_DIR`，每个项目一个来源，子 agent 显示在父会话下。
- **远端状态卡**：当前标签在远端时，侧栏底部显示"远端：主机名"、连接状态和"断开"按钮。
- **标签栏**（标题栏）：每个打开的工作区一个标签，可拖动排序，⌘W 关闭（同时停掉它的服务），⌥⌘←/→ 切换，⌘R 重新加载。切换标签时各自的页面状态保留；重连、关闭再打开窗口、重启应用后，每个标签都会回到原来的页面。"+" 或 ⌘T 打开快速搜索，可以搜所有连接上的 Agent 工作区（主机名或 Agent 名）。
- **设置**（⌘,）→ 连接：左边是全部连接（本机在最上面），"+" 添加 SSH 主机（从 `~/.ssh/config` 及 Include 自动发现，或手动填写显示名称、主机／IP、用户名和端口）。右边是这个连接的全部设置：本机的开关、连接 / 断开 / 移除、连接过程清单（读取 SSH 配置 → 建立连接 → 确认主机指纹 → 检测远端环境 → 安装服务端，失败时标红并给出处理建议，比如 Kerberos 过期提示先 `kinit`），以及每种 Agent 的开关和扫描目录。连接成功后自动关闭设置，并打开这台主机上最近活跃的 Agent 工作区。

**SSH 远端**

- 客户端调用的是系统 `ssh`，所以 ProxyCommand、GSSAPI / Kerberos、密钥和 ssh-agent 的行为都和终端里一样。「自动／免密」模式使用 SSH 配置、ssh-agent、已有密钥或 Kerberos，也接受服务器允许的无凭证连接；Kerberos 主机请先执行 `kinit`。手动添加还可选择身份文件（支持加密私钥口令）或密码认证。密码与口令不写入配置、日志或临时脚本，仅留在当前连接的内存中；手动断开或退出后清除，下次连接会重新询问。自动重连可复用当前连接的凭证。多因素认证中需要额外一次性验证码的交互暂不支持。
- 第一次连接会在窗口内弹窗确认主机指纹。指纹变化时必须勾选"已核对"才能替换。确认后写入 known_hosts，写之前先备份原文件。
- 第一次连接会自动上传服务端（Linux x64 / arm64，约 35MB）到远端 `~/.kifu/remote/versions/<buildId>`。以后直接复用，远端只保留最近 3 个版本。
- 每台主机每种 Agent 一个工作区，所以一台主机最多 2 个服务端进程。
- 断线后（休眠、切换网络、连接被杀）会自动重连，标签上方显示"正在重连"，恢复后自动回到原来的页面。认证或指纹问题不会反复重试，会停下来提示你处理。

| 方面 | 做法 |
|---|---|
| 认证 | 每次启动生成随机 token，经 stdin 传给服务端，不出现在命令行或 URL 里。窗口用一次性 nonce 换取按实例区分的 HttpOnly cookie。 |
| 远端监听 | 服务端监听 unix socket（目录 0700、socket 0600），经 SSH `-O forward` 映射到本机 `127.0.0.1`。远端禁止 socket 转发时改用远端 `127.0.0.1` 的 TCP 端口，仍然需要 token。 |
| 生命周期 | 服务端用 `setsid` 脱离 SSH 会话在后台运行（状态文件和控制 socket 在远端 0700 的 `run/` 目录里），所以开发机上的回放和评测在断线、关闭标签、退出或重启应用后继续跑。重新连接（或另一个客户端打开同一个工作区）时接管它：经控制 socket 换一个新 token（token 只在内存里，不落盘），旧的随即失效；版本不同且空闲时换成新版本。断开时空闲的服务端立即结束，还在跑回放的留着；没有任务、10 分钟无访问后自动退出。 |
| 回放 | 开发机上的会话就在开发机上回放和评测：用那台机器上的 agent 和它的登录，隔离方式和本机一样（隔离的 home、副本、等长路径）。 |
| 远端执行 | 只执行固定的 `/bin/sh -c` 脚本：探测环境、安装、启动服务、扫描 Agent 数据目录。 |

工作区界面运行在沙箱化的内嵌 webview 里：不能调用客户端的任何接口，只能访问它自己的服务端，外部链接交给系统浏览器打开。

出问题时，打开菜单 帮助 → 打开日志目录（`~/.kifu/desktop/logs`），里面有 `app.log`、`shell.log`、`local.log` 和 `ssh-<别名>.log`。

## 工作原理

### 数据来源（只读）

| Agent | 会话列表 | 会话记录 |
|---|---|---|
| Codex | `<CODEX_HOME>/state_5.sqlite`（`threads`、`thread_spawn_edges`：标题、首条消息、父子 agent）；还没有数据库的 home 从 rollout 的 `session_meta` 列出 | `<CODEX_HOME>/sessions/**/rollout-*.jsonl` |
| Claude Code | 扫描 `~/.claude/projects/<项目>/*.jsonl`，标题取 `custom-title`，按文件大小和修改时间缓存 | 同一个文件；子 agent 在 `<会话 ID>/subagents/agent-<id>.jsonl`，`.meta.json` 记录启动它的 Agent 调用 |

一个工作区的服务端可以有多个来源（Codex 的多个 home、Claude Code 的多个项目），各自缓存、只在文件变化时重读，会话列表是它们的合集。

### 解析器（`src/core`）

1. **扫描与剥离**：先按块扫描换行，记下每行的偏移和类型。再把超过 256KB 的行里的 base64 图片换成 `blob:` 引用。
2. **重建历史**：对话条目是一条条 `response_item`；`compacted` 用 `replacement_history` 开始新的上下文。每次 LLM 调用的输入用 epoch 表示，避免 O(n²) 的内存开销。
3. **切分 LLM 调用**：连续的输出条目（推理、回答、工具调用）合成一次调用，usage 取紧随其后的 `token_usage_record`（旧版本取 `token_count`）；按 `content_item_kinds` 区分用户输入和内部上下文。
4. **关联工具事件**：工具执行细节来自 `item_completed`；code-mode `exec` 的内部事件通过 `code-mode-nested:<n>:<外层 id>:…` 关联到外层调用，旧版本用裸 `exec-*` id，按位置关联。
5. **识别 skill**：解析 Codex 的 `<skills_instructions>` 列表和 Claude Code 的 skill 列表，对照磁盘上 SKILL.md 判断是否截断。加载方式识别四种：Skill 工具、`$` 提及、读取 SKILL.md（包括被 rtk 改写成 `rtk read` 的命令）、`skill://`。
6. **处理 fork**：fork 子 agent 开头那段父会话副本由 `subagent_history_start_ordinal` 确定（0.144–0.146 版本按父会话消息触发的那一轮确定），只用来重建上下文，不生成步骤。

**Claude Code**（`src/core/claude/parse.ts`）：一次 API 响应按内容块拆成多条 assistant 记录（同一个 `message.id`，中间可能夹着工具结果），合成一次调用，usage 取最后一块（`input` 含缓存读写）。工具结果按 `tool_use_id` 配对，`is_error` 记为失败；带 `rendered` 的 attachment 是注入给模型的上下文；`compact_boundary` 之后的上下文 = 摘要 + 被保留的消息；Skill 调用和 `/skill` 命令关联到随后注入的 skill 内容；Agent 调用关联到子 agent 的会话。

全量回归用 `pnpm smoke --agent …`（只输出汇总）：解析本机某个 Agent 的全部会话，统计崩溃、调用、工具、无主调用、token 对账和解析提示。

### Skills 页试跑的隔离（`src/server/replay/codex.ts`）

- **隔离的 home**：`CODEX_HOME` 指向 `/private/tmp/kf…`，路径长度和真实的 home 相同，因为 skill 列表里有这个路径、截断预算和路径长度有关。`config.toml` 复制一份并去掉 `notify`（回合结束时会运行程序）和 MCP 服务器；`auth.json` 和各个 skill 用软链，只有变体是真实目录，并在配置里停用原 skill。
- **默认设置**：运行时默认 `--disable hooks`，默认只读 sandbox。
- **写保护**：每次运行前后对真实的 CODEX_HOME 和 `~/.agents/skills` 做 lstat 清单比对，任何变化都会提示。
- **清理**：运行结束后删除隔离的 home（里面有配置副本），transcript 移到 `runs/<id>/`。

### 回放调试的隔离（`src/server/replay/`）

- **副本**：用例保存会话到第 K 轮结束的 APFS 克隆；回放续跑它前面到第 K 轮开始的部分，换一个等长的新会话 id，原地改掉 id 所在的块，其余块和原文件共享。原会话、原工作区都不写。
- **隔离的 home**：和试跑一样。
- **默认设置**：关闭 hooks；默认关闭 MCP 服务器（每次回放可以勾选允许）；工作区默认用原目录 + 只读 sandbox，也可以克隆 git 仓库或用空目录；回放用原那一轮的模型和推理强度，避免 agent 插入"切换模型"的消息。
- **检查**：回放前后对比原会话文件和真实 home 的清单；中断留下的隔离目录（带标记文件）每 10 分钟清理一次；没保存的用例 14 天后自动删除（加入评测集的用例自动保存）。
- **队列**：回放、评测的格子、模型评分共用一个执行队列（默认并发 2），页面上发起的回放排在评测前面；变体在入队时冻结，排队期间再改不影响结果。
- **保真度**：agent 恢复会话时会把当前设置和历史里的基线比较，变了就插入"更新"消息（权限、环境、AGENTS.md，以及技能集合变化后重发的整份 skill 列表），所以改动的效果要和同样方式回放的 A′ 比，原始那一轮只作参考。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm check` | 一次运行服务端 / 前端类型检查、桌面类型检查、单元测试和前端构建 |
| `pnpm audit:dependencies` | 使用官方 npm 审计接口检查依赖漏洞 |
| `pnpm test` | 单元测试，使用合成 fixture，不含任何用户数据；测试在一次性的 HOME 里运行，碰不到真实的 agent 目录 |
| `pnpm smoke [--agent claude]` | 解析本机某个 Agent 的全部会话（默认 Codex），只输出汇总统计（调用、工具、无主调用、token 对账、解析提示） |
| `pnpm smoke --cuts [--agent claude]` | 对本机全部会话检查回放切点：切点前没有这一轮的记录，副本解析结果和原会话一致 |
| `pnpm demo:replay [--port 7791]` | 用合成数据和假 agent 起一个演示服务（不调模型、不碰真实会话和 skill），浏览器打开即可试完整的调试、评测（Skills → report-writer → 相关会话 → 生成评测集）和提炼 skill（会话列表多选 → 提炼 skill）流程 |
| `pnpm typecheck` / `pnpm typecheck:desktop` | 类型检查（桌面端只统计我们自己的文件，Electrobun 自带的 TS 源码不计入） |
| `pnpm build:server` | 用 Bun 1.4 `--compile` 编译 darwin-arm64、linux-x64、linux-arm64 三个服务端并打包 |
| `pnpm icons` | 用 `src/shared/brand.ts` 渲染 `src/shared/brand-artwork.json` 的字标并生成 `desktop/assets/kifu-icon*.svg`，再渲染成 `desktop/assets/Kifu.iconset`（打包时转成 .icns）。只在 macOS 上用，需要 Google Chrome（用一次性的配置目录无头渲染，不碰你的浏览器配置） |
| `pnpm smoke:server <bin> [--socket] [--agent claude]` | 按桌面端的方式启动服务端，检查认证、SSE、worker 解析、上下文和惰性取文本，以及 stdin 关闭后退出 |
| `pnpm smoke:server <bin> --synthetic [--socket] [--agent claude]` | 使用临时合成会话进行服务端冒烟测试，适合公共 CI，无需真实 agent 数据 |
| `pnpm e2e:local-sshd` | 在本机起一个临时的无特权 sshd，先验证手动主机／端口／用户名与加密私钥口令，再完整走一遍 SSH 流程：指纹确认、安装、扫描、两个 Codex home 合并成一个工作区、合成的 Claude Code 工作区、socket 权限、杀掉 master 后重连、断开后无残留 |
| `pnpm e2e:remote --alias <别名> [--agents claude]` | 对真实远端做同样的检查。需要能免交互登录（Kerberos 主机先 kinit），会在远端 `~/.kifu` 安装服务端；`--agents` 额外打开这些 Agent 的工作区 |

## 数据目录 `~/.kifu`（权限 0700）

```
agents/<agent>/  每种 Agent 工作区的数据：
  kifu.sqlite    会话索引（含每个会话的 skill 信号）、变体、运行记录（试跑和回放）、用例、评测集、评测、模型评分、评价、应用记录
  cache/         解析缓存（brotli）
  skills/        变体（完整的 skill 目录副本）
  cases/<id>/    用例：会话到第 K 轮结束的副本（APFS 克隆）
  runs/<id>/     试跑和回放的 transcript、冻结的变体、克隆的工作区
  jobs/<id>/     "问为什么"、提炼 skill 草稿的输入和结果（评分的临时目录用完即删）
  backups/       应用变体前对原 SKILL.md 的备份
backups/         写 known_hosts 前的备份
run/             服务端的 unix socket
cm/              SSH ControlMaster 的 socket
desktop/         客户端保存的连接（connections.json，只有别名和路径）和日志
remote/          （远端）服务端程序，按 buildId 分版本
```

## 已知限制

- **历史会话的输入是重建的**：从 rollout 重建得到，不含工具定义（界面上显示为"工具定义/开销"）。
- **重建的上下文可能比 agent 实际发送的多**：比如换了模型提供方之后，agent 可能不再发送旧的工具输出，直到下一次压缩才和记录对上。重建比实际输入多 1.5 倍以上时，"输入上下文"会提示、"各步的输入构成"会遮住多出的部分；这时列出的条目不一定都发给了模型。
- **Claude Code 的上下文是估算的**：较新的 Claude Code 会记录系统提示（`prompt_snapshot`），旧版本没有；token 估算按会话校准，但工具定义仍只能显示为"工具定义/开销"。fork 出来的子 agent 继承父会话的上下文，这部分不在它自己的文件里。
- **Codex 的 token 汇总可能和 Codex 自己记录的不同**：我们按每次响应的 usage 求和；Codex 的累计值在压缩、回滚后会回落，fork 子 agent 还会带上父会话的累计值。
- **部分判断是启发式的**："可能漏触发""加载未遵循"等基于词法匹配，只能作为线索。
- **结果有随机性**：重跑时建议用基线 A′ 加多次重复来判断；评测里每格 ≥5 次才做显著性检验。
- **评测集的角色是启发式挑的**："从 skill 生成"按索引里的信号（加载 / 可能漏触发 / 只列出）挑正例和反例，难免挑错，生成后请在评测集里检查角色。
- **回放暂不支持 Claude Code**：它的登录存在钥匙串里并和配置目录绑定，隔离的配置目录下没有登录。Claude Code 工作区的"问为什么"借用本机的 codex。
- **回放和原来那一轮不会完全一样**：agent 恢复会话时会插入更新消息（尤其是技能有变化时的整份列表），旧会话的第一轮还会按今天的环境重建开头（skill 列表、插件）；工作区默认只读。每次回放会显示保真度和插入了什么。
- **回放按 token 计费，长会话的后面几轮很贵**：每一步都会重发整段上下文，长会话后面的轮次可能 20–60 万 token。评测前看用量预估，挑上下文小的轮次，用步数上限控制（判断是否触发 skill 一般 2–3 步就够；被上限截断时，"没有失败""没有加载"这类结论算作无法判断）。
- **桌面端目前只有 macOS arm64 包，且未签名**（ad-hoc）。第一次打开需要右键"打开"，或执行 `xattr -dr com.apple.quarantine "Kifu.app"`。
- **远端只支持 glibc ≥ 2.17 的 Linux**（x64 / arm64），Alpine 等 musl 系统暂不支持。

## 开源与发布

项目代码采用 [MIT License](../LICENSE)；Kifu 名称、字标和应用图标另遵守[品牌与图形政策](../TRADEMARKS.md#简体中文)。欢迎按 [贡献指南](../CONTRIBUTING.md) 提交问题和改进；第三方组件见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。GitHub 仓库设置、源码公开和二进制发布步骤见 [发布清单](../docs/RELEASING.md)。根包保留 `private: true` 以防误发 npm，不影响 GitHub 开源。
