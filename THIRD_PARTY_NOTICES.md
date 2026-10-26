# Third-party notices and acknowledgments

Kifu's own code is [MIT licensed](LICENSE), **Copyright (c) 2026 Liam**. This does not relicense third-party code. Dependencies retain their original copyrights and license terms.

## Dependency notices

Kifu uses React, Hono, CodeMirror, TanStack Query / Virtual, Bun, Electrobun and other open-source packages. Generate the installed production dependency inventory and available license / NOTICE texts with:

```bash
pnpm licenses:collect
```

The output is `dist/licenses/`. The server build copies it into each server archive; the desktop build includes it at `Kifu.app/Contents/Resources/app/licenses`. It includes package names, versions and original notices, without local filesystem paths. The inventory is conservative and includes build/type dependencies that may not appear in the runtime bundle.

Native source revisions, archive hashes, original native notices, and rebuild/replacement instructions are included under `licenses/native/`. See [collection scope](licenses/README.md) and the [release checklist](docs/RELEASING.md). Binary releases must include the corresponding source companion; the local collection does not claim a completed upstream runtime rebuild or legal certification.

## Interface icons

Desktop interface icons in `desktop/src/shell/ui.tsx` are attributed to [Lucide](https://lucide.dev). They are separate from Kifu’s own brand artwork. The [full upstream notice](licenses/upstream/lucide-LICENSE.txt) preserves Lucide’s ISC terms and the MIT terms and copyright of the Feather-derived icons. The previous source comment saying only “MIT” was corrected. The original import revision was not recorded; the notice source is pinned in `licenses/upstream/sources.json`.

## Product names and assets

Codex and Claude Code are names of their respective products, used here to describe compatibility. Kifu is an independent project and is not an official OpenAI or Anthropic product.

Kifu's wordmark and app icon are project-created artwork with separate permissions in [TRADEMARKS.md](TRADEMARKS.md), outside the default MIT grant. Generic agent badges remain MIT licensed. No proprietary application icons or font files are bundled. See [asset provenance](docs/PROVENANCE.md) for the source files and demo screenshot origin.
