# Licenses shipped with Kifu

Kifu's own code is **Copyright (c) 2026 Liam**, licensed under MIT. Kifu brand artwork is separately licensed under the repository’s `TRADEMARKS.md` (also included beside `LICENSE` in release notice directories). Third-party copyrights and licenses remain with their respective owners.

`pnpm licenses:collect` writes `dist/licenses/` with Kifu's code license, brand/artwork policy, npm notices, the native source/notice locks, original notice texts and rebuild instructions. Server archives and desktop bundles include this directory. Collection is offline and verifies checked-in notice hashes and the reviewed Bun / Electrobun versions; a changed runtime version requires refreshing the materials.

The npm inventory intentionally includes installed production dependencies, including build tools and type packages. It is not a claim that every package is embedded. `bun-types@1.4.2` is explicitly recorded as `development-only-no-text`: it supplies MIT metadata without a license file and contains type declarations, not runtime code. Unknown packages without notices fail collection.

The desktop's inline Lucide icons are separate from npm. Their full ISC / Feather MIT notice is included in `upstream/lucide-LICENSE.txt`.

## Native components

The exact Bun 1.4.2 server runtime, Bun 1.3.13 desktop runtime, Electrobun 1.18.1 launcher/native wrapper, zig-asar, zig-zstd and bspatch are mapped to sources in `native/binaries.lock.json`. Native dependencies include JavaScriptCore/WebKit, TinyCC, ICU for Linux, zstd, Rust crates and other libraries. `native/sources.lock.json` records 231 source archives and hashes; `native/notices.lock.json` records collected notice hashes. The source archive is conservative and includes build/test/platform alternatives; presence is not proof of linkage.

`zig-asar` 0.2.2 supplies an MIT declaration in README and names Blackboard Technologies Inc. as author in package.json, but does not supply a separate copyright/license file. Both original declarations are preserved in its notice; `upstream/MIT-standard-template.txt` supplies the referenced standard MIT text without inventing an upstream year or substituting Kifu's author. Its placeholders are part of the standard template, not a claimed upstream copyright statement.

LLVM / C++ runtime and Rust toolchain notices are preserved separately under `upstream/`. Original per-file notices are also retained in the source archives. No CEF or Dawn binary is shipped in the current native-renderer app. System frameworks are OS dependencies.

## Source companion and verification

See [native/REBUILD.md](native/REBUILD.md) for exact source revisions, regeneration commands, source-companion delivery, LGPL library modification and runtime replacement instructions. `pnpm native:sources` creates an accompanying archive of Kifu's source and pinned native sources. **Publish that companion and its checksum alongside binary releases.** Do not commit the gigabyte-sized archives to Git.

`pnpm native:audit` checks actual packaged native binaries, notice inclusion, server archives, and that the companion matches the current source snapshot. It produces `dist/release/native-audit.json` and DMG checksums.

The local source/notice collection is complete for the recorded inventory, with the zig-asar declaration limitation stated above. It is not a legal certification or a claim that upstream Bun/WebKit were rebuilt here. A full modified-library rebuild remains a binary-release validation step, as do Linux native execution and the chosen signing/notarization process. See the repository's `docs/VERIFICATION.md` and `docs/RELEASING.md`.
