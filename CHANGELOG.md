# Changelog

## Unreleased

- Keep software code under MIT and separate Kifu brand artwork permissions in a bilingual trademark policy; ship the policy with desktop, server and source packages.

- Reimplement login-shell environment restoration with private IPC and structured snapshots; preserve PATH and agent environment discovery with timeout fallback.
- Add SSH config discovery and manual host, username and port entry; support automatic/passwordless, identity-file/passphrase and password authentication with transient credentials.
- Remove obsolete attribution for the replaced environment module after source review; retain actual dependency licenses and copyrights.
- Normalize release archive ownership and timestamps, excluding local account names and extended attributes.

- Attribute Kifu-authored work to Liam; add desktop About-page copyright and independent-project notice.
- Preserve Lucide / Feather notices and collect available dependency license texts into server and desktop bundles; document remaining native-runtime release review.

- Package an expanded macOS app to avoid an Electrobun first-launch extraction failure.

- Add English and Simplified Chinese interfaces, system-language detection, persisted preferences, and live desktop/workspace switching.
- Redesign the English README with a Chinese counterpart, workflow illustration, and synthetic demo quickstart.

- 补充 MIT 许可、贡献指南、安全政策、GitHub CI 和 issue / PR 模板。
- 固定开发工具版本，更新已知有漏洞的依赖。
- 为服务端冒烟测试加入合成数据模式，支持无账号的 CI 验证。
- 使用独立桌面应用标识和自绘 Agent 图标。
- 修复 Electrobun 1.18.1 构建工具已知签名问题，构建失败正确返回非零状态，并核实实际产物。
- SSH 端到端测试改用独立临时数据目录，不复用用户的 Kifu 目录。

## 0.1.0

初始功能：Codex / Claude Code 会话查看、Codex 回放调试、评测、skill 提炼与编辑，以及 macOS 桌面和 SSH 远端工作区。此条目不表示已发布公开二进制版本。
