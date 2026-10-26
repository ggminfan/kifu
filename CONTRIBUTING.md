# 参与 Kifu

欢迎提交问题报告、文档改进和代码贡献。中文、英文均可。

## 开发环境

- Node.js 22.22.1（见 `.nvmrc`）；也支持 Node.js 24。
- pnpm 10.32.1（由 `packageManager` 固定）。
- macOS / Linux；桌面应用目前仅支持 macOS Apple Silicon。
- Bun 由工作区依赖安装，不需要依赖全局 Bun。桌面构建还需要 Xcode Command Line Tools。

```bash
nvm use
npm install --global pnpm@10.32.1
pnpm install --frozen-lockfile
pnpm dev
```

没有本机会话或不想使用真实数据时，先运行 `pnpm build`，再运行 `pnpm demo:replay`，按终端提示打开演示页面。演示使用合成会话和假 agent，不调用模型。

## 提交前验证

```bash
pnpm check
pnpm audit:dependencies
pnpm build:server
# macOS Apple Silicon；Linux x64 改为 linux-x64
pnpm smoke:server dist/server/darwin-arm64/bin/kifu-server --synthetic
pnpm smoke:server dist/server/darwin-arm64/bin/kifu-server --synthetic --socket --agent claude
```

桌面改动另运行 `pnpm desktop:build`。SSH 改动可运行 `pnpm e2e:local-sshd`，需要可用的本机 OpenSSH 服务端和系统允许的 SSH 登录。它会创建临时测试密钥和合成数据；无需真实远端或模型账号。

单元测试使用临时 HOME，覆盖解析、回放、评测、认证、工作区和 SSH 行为。桌面单实例测试需要 `ps` 和向测试子进程发送信号；受限沙箱可能禁止这些操作。不要为绕过环境限制而跳过测试或放宽生产逻辑。

`pnpm smoke`、未带 `--synthetic` 的 `smoke:server` 会读取本机会话；真实远端的 `e2e:remote` 会安装服务端。它们属于自愿的本地验证，不用于公共 CI。

## 代码和 PR

- TypeScript 严格模式，两个空格缩进；沿用相邻代码风格。
- 解析与分析放在 `src/core`，API / 运行时放在 `src/server`，界面放在 `src/web`，桌面壳放在 `desktop`。
- Bug 修复应附能复现问题的合成 fixture / 回归测试。不要复制真实会话、提示词、密钥或私有代码。
- PR 描述说明问题、最终行为、验证结果和兼容性影响。保持改动范围集中。
- 依赖变更同时提交 `pnpm-lock.yaml`。安全版本 overrides 见 `docs/DEPENDENCIES.md`。
- 代码和普通文档仅提交有权按 [MIT](LICENSE) 许可贡献的内容；第三方代码和资源须保留其许可和来源。Kifu 品牌素材有单独的[使用政策](TRADEMARKS.md#简体中文)，涉及品牌素材的贡献请在 PR 中说明来源及可授予的权限。

安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要放入公开 issue。

## 界面翻译 / UI translations

See [Internationalization](docs/I18N.md) for message catalogs, language selection and validation. Keep the English and Chinese README pages aligned. New UI copy must support both languages; leave user transcripts and skill content unchanged. Run `pnpm i18n:check` before submitting.
