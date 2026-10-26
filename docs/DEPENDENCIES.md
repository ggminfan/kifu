# 依赖维护

使用 pnpm 10.32.1 和 `pnpm-lock.yaml` 固定安装结果。CI 使用 `--frozen-lockfile`，不自动改写锁文件。根包和桌面包保留 `private: true`，避免误发 npm；这不影响 GitHub 开源。

2026-10-25 依据官方 npm audit 结果更新 Vite、Zod，并在根 `package.json` 中固定以下传递依赖安全版本：

| 依赖 | override | 原因 |
|---|---|---|
| basic-ftp | 6.2.1 | Electrobun → proxy-agent → get-uri 链中的目录解析拒绝服务；上游仍要求 5.x，需在上游升级后移除 override |
| source-map-js | 1.2.2 | 索引 source map 偏移导致事件循环阻塞 |
| shell-quote | 1.11.0 | comment token 后换行导致命令注入 |
| ip-address | 10.7.4 | IPv6 zone identifier 的二次复杂度解析 |
| rolldown | 1.2.11 | 保留项目既有的构建兼容版本固定 |

`basic-ftp` 跨主版本 override 需要关注 `get-uri` 的 FTP 路径兼容性；Kifu 自身连接远端使用 SSH，桌面构建下载使用 HTTPS。不要仅为了让 audit 通过而忽略后续构建和运行验证。

```bash
pnpm install --frozen-lockfile
pnpm audit:dependencies
pnpm check
pnpm desktop:build
```

审计是某一时点的已知漏洞检查，不是完整安全审查。Dependabot 每周检查 npm 和 GitHub Actions 更新，维护者应审查后合并。

## Electrobun 1.18.1 macOS CLI

该版本官方 arm64 CLI 的 ad-hoc 签名校验失败，macOS 会以 SIGKILL 终止它；上游 npm 启动器又将 signal 误报为退出码 0。`scripts/electrobun.mjs` 直接检查原生 CLI 的退出码 / signal，并只对与已核实官方 SHA-256 完全匹配的 1.18.1 CLI 重建本地 ad-hoc 签名。未知校验和直接失败，不修改系统 Gatekeeper 设置。

此处仅修复构建工具自身的签名，不是为 Kifu 提供开发者签名或公证。升级 Electrobun 后应移除该版本专用修复，并重新验证桌面 API、打包和启动。

## macOS first launch

The Electrobun 1.18.1 self-extracting launcher was observed to fail with `UnexpectedEndOfStream` after decompressing a valid generated archive. `scripts/unpack-desktop.mjs` runs as `postWrap`: macOS libarchive expands the generated payload during the build, validates required files, then replaces the generated wrapper before signing and DMG creation. The delivered app launches directly. This changes neither app permissions nor signing requirements. Verify first launch from a fresh DMG when upgrading Electrobun.
