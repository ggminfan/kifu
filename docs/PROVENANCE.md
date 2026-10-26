# Ownership and asset provenance

Reviewed on 2026-10-26.

| Material | Source and attribution |
| --- | --- |
| Kifu-authored code and documentation | Copyright (c) 2026 Liam; MIT. Brand artwork is the explicit exception described below. User-confirmed public attribution is “Liam”; the authorized publishing account is `ggminfan`. |
| Wordmark and app icon | Project-created geometry in `src/shared/brand-artwork.json`, separately licensed under [TRADEMARKS.md](../TRADEMARKS.md). The renderer in `src/shared/brand.ts` remains MIT; `scripts/build-icons.ts` produces `desktop/assets/kifu-icon*.svg` and the PNG iconset. No bundled font file. |
| Agent badges | Project-created generic geometry in `src/shared/agent-icons.ts`; descriptive product names do not imply official affiliation. |
| Desktop interface icons | Lucide paths in `desktop/src/shell/ui.tsx`; ISC and Feather-derived MIT notices retained in `licenses/upstream/lucide-LICENSE.txt`. Original import revision was not recorded; upstream notice snapshot is pinned in `sources.json`. |
| Workflow illustration | Project-created `docs/assets/workflow.svg`. It is a diagram, not a product screenshot. |
| Session screenshot | `docs/assets/session-en.jpg`, captured from the local `scripts/demo-replay.ts` synthetic demo. No real session, credential or private repository was used. |
| npm dependencies and bundled runtimes | Original authors retain their rights. See `THIRD_PARTY_NOTICES.md` and `licenses/README.md`; Kifu's MIT license does not replace these terms. |

## Publication content audit

The candidate Git file set was checked for personal installation paths, workstation names, private-key headers and common access-token patterns. No personal home-directory paths or matching real credentials were found. `demo`, `/Users/someone`, `/Users/x`, example hosts and fixture keys are synthetic test data. Keep the `.trace-monitor` references used for legacy-data migration; they are compatibility code, not stale public branding.

This is a pattern-based source review, not a guarantee that all sensitive content or all historical provenance can be inferred from code. The initial pre-publication audit was performed before the first Git commit; it did not cover earlier development history. The login-shell environment module was replaced with a new private-socket / JSON-snapshot implementation. A post-replacement comparison and manual review found no remaining correspondence requiring the conservative notice attached to the replaced implementation, so that notice was removed from the current source and distribution. This is a bounded technical review of the selected source revision, not a clean-room or full-history provenance claim. Actual dependency notices remain in `THIRD_PARTY_NOTICES.md`.

The authorized public repository is [ggminfan/kifu](https://github.com/ggminfan/kifu), maintained under the `ggminfan` GitHub account. “Liam” remains the requested public copyright attribution. Brand permissions and artwork licensing are set out in [TRADEMARKS.md](../TRADEMARKS.md). No trademark clearance has been completed; the policy does not claim registration or worldwide exclusive rights to “Kifu” or “棋谱”.
