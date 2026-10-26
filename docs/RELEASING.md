# GitHub 发布步骤

## 源码仓库

官方仓库：[ggminfan/kifu](https://github.com/ggminfan/kifu)。默认分支为 `main`，代码采用 MIT，版权署名为 Liam；品牌图形另按 [TRADEMARKS.md](../TRADEMARKS.md) 授权。

1. 提交前核对文件及许可；不要上传 `.kifu`、会话、凭证、本机工具配置、日志或构建目录。
2. 通过 PR 提交后续改动，检查 CI 结果，按仓库当前保护规则合并。不要绕过保护规则或强推。
3. 维护者在 **Settings → Security** 启用可用的 secret scanning、push protection、Dependabot alerts 和 private vulnerability reporting，并维护默认分支保护。
4. README 和 package.json 的 repository / bugs / homepage 使用上述实际地址。首次推送后的 CI 与安全设置须在 GitHub 验证，本地检查不能替代。

新开发环境可使用：

```bash
git clone https://github.com/ggminfan/kifu.git
cd kifu
pnpm install --frozen-lockfile
```

品牌政策不等同于商标注册；维护者仍需核查目标市场名称并决定是否注册。

## 发布前验证

打包依赖 Python 3.9+；服务端和桌面更新归档会移除本机所有者与扩展属性。不要直接压缩整个工作目录作为源码发布包。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit:dependencies
pnpm licenses:collect
pnpm build:server
pnpm smoke:server dist/server/darwin-arm64/bin/kifu-server --synthetic
pnpm smoke:server dist/server/darwin-arm64/bin/kifu-server --synthetic --socket --agent claude
pnpm desktop:build
```

在 Linux x64 / arm64 上分别执行对应二进制的 synthetic smoke；交叉编译通过不等于运行验证通过。SSH 变更还应运行 `pnpm e2e:local-sshd`。人工确认桌面启动、标签切换、合成会话展示和应用退出。

## 二进制 Release（独立于源码公开）

- 同步根包和 `desktop/package.json` 的版本号，更新 CHANGELOG，并为验证过的提交创建 tag。
- 收集 `dist/server/kifu-server-*.tar.gz`、`.sha256` 和 `desktop/artifacts` 中的安装包；不要把产物提交进 Git。
- 构建会随包附上自有 MIT、`TRADEMARKS.md` 品牌政策、npm 通知和核对过的原生通知。版本／源码／许可证哈希已锁定；升级 Bun、Electrobun 或原生组件后必须重新核对。
- 准备源码伴随材料：`pnpm native:fetch`（首次下载约 1.1 GB）→ `pnpm native:verify` → `pnpm native:sources` → `pnpm native:audit`。将 `dist/release/kifu-VERSION-source-materials.tar.gz`、其 `.sha256` 与 `native-audit.json` 随二进制一起上传，保证相同下载访问条件。源码有变更时必须重新生成，审计会拒绝过期快照。大文件不提交 Git。
- 阅读 [原生重建与替换说明](../licenses/native/REBUILD.md)，在发行平台完成修改库后重建 Bun / JavaScriptCore / TinyCC 的验证并保存日志。本地已准备对应源码与替换入口，但未执行完整上游运行时重建；不能将源文件校验通过写成重建通过。
- zig-asar 0.2.2 上游只有 MIT 声明及作者元数据，无单独版权文件；分发材料原样保留，并附标准 MIT 模板，未推定版权年份。详见 [材料范围](../licenses/README.md)。
- 为桌面安装包生成 SHA-256。Release notes 写明系统 / CPU 要求、已验证平台和已知限制。
- 当前桌面构建未配置开发者签名和公证；不要将其描述为已签名正式发行版。正式发行前配置并验证签名、公证、安装与升级流程。
- 先创建 draft release，下载校验实际上传的产物后再发布。

GitHub CI 当前提供构建验证产物，不自动创建公开 Release。
