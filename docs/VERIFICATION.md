# 开源准备验证记录

最新验证日期：2026-10-26。环境：macOS arm64、Node.js 22.22.1、pnpm 10.32.1、项目内 Bun 1.4.2。

| 检查 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通过，根包和 desktop 工作区锁文件一致 |
| `pnpm typecheck` | 通过 |
| `pnpm typecheck:desktop` | 通过；按既有规则排除 Electrobun 依赖源码的类型诊断 |
| `pnpm test` | 25 个测试文件、220 项测试全部通过（包含环境恢复、SSH 认证、双语与桌面打包回归测试） |
| `pnpm i18n:check` | 63 个源文件、1366 处文案引用检查通过 |
| 双语 UI | 浏览器与桌面实测切换、浏览器刷新持久化、桌面重启恢复、原生菜单、窗口标题及已打开工作区同步通过 |
| 最终 DMG 首次启动 | 挂载只读镜像、复制到全新临时目录、合成工作区首次启动成功 |
| `pnpm build:server` | 前端与 darwin-arm64、linux-x64、linux-arm64 服务端编译通过 |
| 编译后 Codex 服务端，TCP synthetic smoke | 17/17 通过 |
| 编译后 Claude 服务端，Unix socket synthetic smoke | 18/18 通过 |
| `pnpm e2e:local-sshd` | 手动主机／端口／用户名 + 真实 OpenSSH 加密私钥认证通过；原有 15/15 通过，包含指纹确认、多来源、重连、服务接管和断线回放 |
| `pnpm --filter kifu-desktop build` | 生成 Kifu.app、DMG、更新压缩包及元数据 |
| `pnpm audit:dependencies` | 官方 npm 接口未报告已知漏洞；准备前有 11 条记录 |
| Gitleaks 8.30.1 | 按 Git 忽略规则导出的待发布源码扫描未发现密钥泄露 |
| GitHub YAML / Markdown 本地链接 | 语法解析及本地链接检查通过 |
| Git 忽略规则 | 依赖、构建产物、环境文件、凭证目录和原始会话不在待发布文件中 |

## 验证范围

测试使用合成会话与假 agent，没有调用真实模型。桌面单实例测试所需的 `ps` 和 macOS `iconutil` / DMG 打包需要运行环境允许相应系统操作。

Linux 两种架构在本机只完成交叉编译，没有宣称已在 Linux 上执行二进制。GitHub CI 已配置 Linux x64 和 macOS arm64 原生冒烟测试，以及 Node.js 24 验证，需推送仓库后实际运行；Linux arm64 仍需在对应主机执行验证。

本次完成桌面编译、打包和上述双语 GUI 冒烟验收；尚未逐项人工验收所有功能。真实远端、真实模型账号与费用相关流程也未纳入本次测试。

## 已完成的开源准备

- MIT 许可证与包元数据；固定 pnpm、声明 Node.js 版本。
- 中英文 README、贡献指南、安全政策、依赖说明、变更记录、发布清单、第三方说明。
- GitHub CI、依赖定期审计、Dependabot、issue / PR 模板；Actions 固定 commit，工作流只读权限。
- 独立应用标识、自绘 Agent 图标、合成数据服务端 smoke、临时 SSH 测试目录。
- Electrobun CLI 的已知签名修复、退出状态校验与产物检查；构建时展开 macOS 应用，避免首次启动自解压失败。
- 本地 Git `main` 分支初始化；源码发布目标为 [ggminfan/kifu](https://github.com/ggminfan/kifu)。

## 首次发布还需在 GitHub 执行

发布目标为 [ggminfan/kifu](https://github.com/ggminfan/kifu)。首次推送后在 GitHub 核对分支保护、私密漏洞报告和可用的 secret scanning / push protection，并确认 [CI](https://github.com/ggminfan/kifu/actions/workflows/ci.yml) 通过。运行结果以 GitHub 实际状态为准。

源码可按 [发布清单](RELEASING.md) 准备首个提交。原生源码、通知与分发材料已按下文补齐。二进制公开 Release 还需执行完整修改库重建验证、GUI / 目标平台验证，以及所选发行方式对应的签名与公证。当前构建未做开发者签名或公证。

## 署名与内容复核（2026-10-25）

- 按项目所有者明确要求，将自有代码的署名统一为 **Liam**，同步 LICENSE、包作者、README、发布清单与桌面“关于”页。第三方版权未改写为 Liam。
- 发现桌面通用图标的 Lucide 注释误写 MIT；已更正并收录上游 ISC 与 Feather MIT 完整通知。
- 增加不含本机安装路径的 npm 通知收集与打包步骤；收录 188/189 个包的许可证文本，剩余 bun-types 为仅声明 MIT 但不附文本的类型包。原生运行时材料已在后续核对中补齐，见下文。
- 发布候选源文件未发现个人安装路径、工作站名或常见真实凭证模式。合成示例和兼容迁移名保留。
- 本轮署名复核时尚未创建 GitHub 仓库；后续已确定发布目标为 `ggminfan/kifu`，云端状态以实际仓库为准。

本轮署名复核验证：23 个测试文件、206 项测试通过；前端／桌面类型检查、1336 处文案引用检查、桌面与三个服务端构建通过。已逐包检查自有 LICENSE、Lucide / Feather 通知及不含本机路径的 inventory.json 确实存在于产物中。


## 原生分发材料复核（2026-10-25）

- 对应实际 Bun 1.4.2 / 1.3.13 修订号、两个 WebKit 修订号及六个 macOS 原生文件，建立源码与二进制 SHA-256 清单。
- 收集 231 份固定版本源码档案（约 1.1 GB），包括 Bun、WebKit、TinyCC、Linux ICU、Zig 工具及 zstd 子模块、Cargo.lock 依赖；保留原始通知并对注册表包校验上游 checksum。
- 补充 bspatch 的 Colin Percival / Yoav Givati BSD 通知，以及 LLVM / C++ runtime / Rust 通知。zig-asar 缺少独立许可证文件的上游事实单独说明，没有补写推测的版权年份。
- 源码伴随归档由 `pnpm native:sources` 生成，包含本项目可发布源文件和依赖源码；`pnpm native:audit` 校验运行时、包内通知与源码快照是否匹配，并生成分发校验值。
- 增加明确指定替换 Bun 的 `--runtime` 编译入口，以及 [重建／重新链接说明](../licenses/native/REBUILD.md)。本机使用原有 Bun 文件验证替换入口；没有声称已修改并从头编译 Bun / WebKit / TinyCC。
- 本轮 23 个测试文件、207 项测试通过；两项单实例测试需要在允许 `ps` 的环境运行，重跑通过。前端／桌面类型检查与 1336 处双语文案引用检查通过。

原生构建、包内通知与源码伴随材料的最终结果保存在构建目录的 `dist/release/native-audit.json`。此报告仅代表列出的本地检查，不代替 Linux 原生运行、上游运行时重建、签名、公证或法律认证。


## 登录环境独立重实现与连接表单（2026-10-26）

- 登录 Shell 通过私有 Unix socket 返回 JSON 环境快照，替代原有标准输出分隔符解析。独立处理 PATH 合并、特殊变量过滤、启动横幅、空行／Unicode 值、失败退出钩子、超时和继承环境回退。真实 sh / bash / zsh 与桌面 Bun 运行时通过验证。
- SSH 支持配置自动发现／刷新以及手动显示名称、主机／IP、用户名、端口、身份文件、密钥口令和密码。密码仅经短生命周期私有 IPC 交给 OpenSSH askpass，不进入 argv、环境变量或磁盘；保存的连接不含密码。原有主机指纹确认保持启用。
- 218 项测试通过，覆盖密码 IPC、掩码日志、取消连接、配置持久化不含凭证及环境恢复。真实 OpenSSH 测试覆盖加密私钥；密码服务器登录采用模拟 SSH 进程验证交互通道，未使用真实系统账户密码。额外 OTP / 多因素挑战暂不支持。
- 浏览器合成预览验证中英文表单、发现刷新、身份文件选择、密码遮罩、切换认证方式清空凭证、保存后的连接进度；修正表单滚动，确保语言栏和操作按钮可用。原生文件选择器使用 Electrobun 接口。
- 替换后将本项目 216 个 JS/TS 文件与先前选定修订的 766 个 JS/TS 文件对照：无相同源文件，无连续 40 token 精确匹配；降低到 25 token 后的三处精确匹配为通用测试初始化、文件读取容错、React 事件处理。将标识符／字面量归一化到 45 token 后，环境恢复模块也没有命中。归一化筛选中的配置表、类型声明和导入语句经人工抽查没有显示新的特定实现对应。
- 新环境模块不再保留先前识别的解析实现，因此移除仅针对已替换实现保留的保守归属通知。该结论仅覆盖当前代码和所选修订，不能证明全部开发历史或所有历史版本均无相似。第三方实际依赖的许可证及原作者署名保留。
- 许可证输出目录每次重新生成，防止旧通知残留；桌面、三个服务端与源码伴随材料同步重建并核对哈希。

## 发布候选最终检查（2026-10-26）

- 按 Git 忽略规则导出待发布文件后运行 Gitleaks 8.30.1；没有使用忽略规则跳过凭证命中。另检查项目自有文件中的旧归属名称、个人主目录、工作站名、邮箱／网络地址、私钥与访问令牌模式。批准公开的 Liam 署名、第三方版权人和合成示例保留。
- 发现并修复服务端和桌面更新包 tar 元数据泄露构建账号名称／UID／用户组的问题：归档统一空用户名、UID/GID 0、固定时间戳，不携带扩展属性。新增重复构建、可执行权限、文件内容和路径边界回归测试；原生审计新增归档元数据检查。
- 默认英文 README 与中文版本同步说明自动发现、手动 SSH、认证方式、凭证不落盘、Python 打包依赖和未签名状态；CHANGELOG 补充最新环境恢复与 SSH 功能。检查本地 Markdown / HTML 链接、GitHub YAML 和版本／作者一致性。
- 修正 zsh 专属测试在无 zsh 的平台运行的问题；该用例在缺少 zsh 时跳过，其他 shell 环境恢复测试仍执行。云端 CI 仍须在首次推送后确认。
- 本轮通过 `pnpm check`（220 项测试）、官方 npm 依赖审计、桌面／三个服务端重建、原生与归档核对。最终分发检查摘要在 `dist/release/final-release-check.json`，该文件为本地生成报告，不属于待提交源码。

以上是当前候选文件、实际构建产物和可见元数据的检查结果；未发现真实凭证泄露，不等于可穷尽证明不存在未知敏感信息。该轮检查发生在首次提交和推送之前，不能据此声称已检查 GitHub 云端设置或开发历史。

## Brand policy packaging (2026-10-26)

Software code remains MIT licensed. `TRADEMARKS.md` defines separate permissions for the Kifu name, wordmark and application artwork, with an English policy and Chinese translation. The artwork geometry is stored separately in `src/shared/brand-artwork.json`; its extraction was checked against the previous data and all four generated SVG variants byte-for-byte, with no visual change. The root MIT license and original third-party notices remain unchanged.

The release notice collector includes the policy beside `LICENSE`; `pnpm native:audit` requires matching policy files in the desktop and all three server notice trees and checks inclusion in server archives. The source companion includes the policy, bilingual READMEs and artwork source. Final DMG/update content comparison and fresh hashes are recorded in `dist/release/final-release-check.json`. This documents brand permissions, not trademark registration or clearance.
