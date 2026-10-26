<div align="center">
  <img src="desktop/assets/kifu-icon.svg" width="88" height="88" alt="Kifu icon" />
  <h1>Kifu</h1>
  <p><strong>See every step. Replay every move.</strong></p>
  <p>A local-first debugger and skill workbench for AI coding agents.</p>
  <p><a href="#try-it-in-two-minutes">Try the demo</a> · <a href="#what-you-can-do">Features</a> · <a href="#run-it-your-way">Get started</a> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="https://github.com/ggminfan/kifu/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ggminfan/kifu/actions/workflows/ci.yml/badge.svg" /></a>
    <a href="LICENSE"><img alt="Code license: MIT" src="https://img.shields.io/badge/code-MIT-4c977f" /></a>
    <img alt="Codex and Claude Code" src="https://img.shields.io/badge/sessions-Codex%20%2B%20Claude%20Code-7465b6" />
    <img alt="English and Simplified Chinese" src="https://img.shields.io/badge/UI-English%20%2F%20简体中文-447ab3" />
  </p>
</div>

Your agent missed a skill, repeated a failing command, or filled its context window. **Kifu helps you find the turn where it went wrong—and test whether your fix actually helps.**

Open a session, inspect the input and tool calls, replay a turn with a different skill, prompt or model, then evaluate the change across multiple cases. Keep the improvements with backup and undo.

*Kifu (棋谱) means a game record: a sequence of moves you can study and replay.*

![Kifu workflow: inspect a trace, replay a change, evaluate regressions, improve a skill](docs/assets/workflow.svg)

![Kifu session timeline and input context](docs/assets/session-en.jpg)

<sub>Synthetic demo, English UI. Session transcripts remain in their original language.</sub>

## What you can do

| Question | How Kifu helps |
| --- | --- |
| **Why did the agent do that?** | Follow turns, model calls, tool arguments and outputs. Inspect reconstructed context, token growth, cache hits and compaction. |
| **Why wasn’t my skill used?** | See which skills were listed, loaded, truncated or possibly missed. Inspect the evidence behind heuristic signals. |
| **Does this change help?** | Replay a Codex turn with edited input, skills or models. Compare repeated runs against an unchanged replay baseline, A′. |
| **What else did I break?** | Evaluate across positive, negative and control cases. Review regressions, trigger recall, false positives and optional model scores. |
| **Can I stop explaining this every time?** | Distill repeated workflows and clarifications into a skill draft. Validate, evaluate, install and undo. |

**One workbench, local and remote.** Browse Codex and Claude Code sessions. Open multiple workspaces in the macOS app, including development machines connected through SSH.

## Try it in two minutes

No agent account, private session data or paid model calls needed for the demo.

With **Node.js 22.22.1 or 24** and **pnpm 10.32.1**, clone or download this repository, then run:

```bash
git clone https://github.com/ggminfan/kifu.git
cd kifu
pnpm install --frozen-lockfile
pnpm build
pnpm demo:replay
```

Open **[127.0.0.1:7791](http://127.0.0.1:7791)**. The demo uses synthetic sessions and a fake agent. Try this workflow:

1. Open a session and inspect its **Input context** and **Skills** panels.
2. Choose **Debug this turn** and edit a skill variant.
3. Replay the unchanged baseline and your variant, then compare the results.
4. Open **Evaluations** to try the same change across more cases.

The demo is a product walkthrough; its simulated results are not performance claims about real models.

## Run it your way

### Browser

```bash
# Development: UI on 5173, API on 7788
pnpm dev

# Production web build: UI and API on 7788
pnpm build && pnpm start
```

By default Kifu reads Codex sessions from `~/.codex`. To browse Claude Code sessions:

```bash
KIFU_AGENT=claude pnpm start
```

`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `KIFU_ROOTS`, `CODEX_BIN`, `KIFU_HOME` and `KIFU_PORT` let you configure session discovery and runtime paths. Kifu stores its own data under `~/.kifu`.

### macOS desktop + SSH

On **Apple Silicon**, with Xcode Command Line Tools and **Python 3.9+** installed:

```bash
pnpm desktop:build
open desktop/build/stable-macos-arm64/Kifu.app
```

The app starts with local scanning disabled. Choose **Enable local**, discover hosts from `~/.ssh/config` and its `Include` files, or add a host manually with a name, username and port. Choose automatic/passwordless authentication, an identity file (with an optional passphrase), or a password. Passwords and passphrases stay in memory for the active connection; only connection settings are saved. First-time hosts still require fingerprint confirmation. SSH workspaces run on the remote machine using its agent installation and authentication. Linux x64 and arm64 server packages are included in the desktop build.

Build output includes `desktop/artifacts/stable-macos-arm64-Kifu.dmg`. Local builds do not have an Apple Developer signature or notarization.

### English or 简体中文

The app follows the primary system language on first launch: **Simplified Chinese → 简体中文; everything else → English**, including Traditional Chinese. Choose **System default**, **English** or **简体中文** in desktop Settings or the browser’s language selector. Your choice is remembered; desktop workspaces update together without restarting. Session transcripts, code and skill content stay in their original language.

## A workflow worth repeating

**“My weekly-report skill didn’t trigger.”**

Inspect the skill list for that turn. Was the description present? Were its trigger words truncated? Create a variant, move the relevant trigger earlier, and replay the turn against A′. Then evaluate nearby positive, negative and control cases before applying the change.

That last step matters: a skill that triggers more often can also trigger in the wrong places. Kifu makes those tradeoffs visible.

## Support and boundaries

| Capability | Codex | Claude Code |
| --- | :---: | :---: |
| Session and subagent browsing | ✓ | ✓ |
| Timeline, tools and context inspection | ✓ | ✓ |
| Skill catalog and variants | ✓ | ✓ |
| Turn replay and evaluations | ✓ | — |
| Skill-list preview and model-backed distillation | ✓ | — |

- Browsing is local. **Replay, analysis, grading and distillation invoke your configured Codex CLI**, which may send context to its model provider and consume your quota. “Ask why” in a Claude Code workspace also uses Codex.
- SSH session content travels through the tunnel for display on your computer.
- Historical context is reconstructed; it may differ from what the model actually received. Skill-trigger signals are heuristics, and replay outcomes vary. Use repeated A′ runs when comparing changes.
- Replay defaults to an isolated agent home and a read-only workspace. Enabling external tools, in-place writes or applying a skill changes what the agent can do.
- Kifu is a local tool for trusted machines, not a hosted multi-user service. See the [security policy](SECURITY.md).

## Build with us

Useful contributions include **synthetic parser fixtures**, **agent-version compatibility fixes**, **clearer diagnostics**, **translation improvements** and **reproducible bug reports**. Please keep real transcripts and credentials out of issues.

```bash
pnpm check                 # types, translation coverage, tests, web build
pnpm audit:dependencies    # known dependency vulnerabilities
pnpm build:server          # macOS arm64 + Linux x64 / arm64
```

[Contributing](CONTRIBUTING.md) · [Architecture & detailed guide (中文)](docs/guide.zh-CN.md) · [Internationalization](docs/I18N.md) · [Changelog](CHANGELOG.md) · [Release checklist](docs/RELEASING.md)

**If Kifu helps you understand or improve an agent run, consider giving the repository a star.** It helps other agent builders find the project. A small reproducible issue or a useful fixture helps make it better, too.

## License & acknowledgments

**Code: [MIT](LICENSE) © Liam.** Kifu’s name, wordmark and app icon follow the separate [brand and artwork policy](TRADEMARKS.md). Accurate references, local builds and clearly identified unmodified distributions are permitted; separately distributed modified applications need their own branding or written permission. The policy does not claim trademark registration.

Built with React, Hono, CodeMirror, Bun, Electrobun and other [open-source components](THIRD_PARTY_NOTICES.md).

Kifu is an independent project, not an official OpenAI or Anthropic product.
