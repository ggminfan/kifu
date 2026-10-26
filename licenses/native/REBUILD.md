# Native source and replacement materials

Kifu is MIT-licensed, Copyright (c) 2026 Liam. This does **not** replace the terms or copyrights of linked components. Original notices are in `notices/`; the source provenance and archive SHA-256 values are in `sources.lock.json`. No Kifu term prohibits modifying these libraries or reverse engineering for debugging such modifications.

## What is supplied

| Distributed component | Upstream source |
| --- | --- |
| Server runtime: Bun 1.4.2 | `oven-sh/bun` at `744846f844374847c902b5e7fd59b4342a51ef99` |
| Desktop runtime: Bun 1.3.13 | `oven-sh/bun` at `bf2e2cecf27e800962b1e7f03d66278f9d5d2e79` |
| Server JavaScriptCore / WTF / bmalloc | `oven-sh/WebKit` at `2e2aa2290fac856d6f451ceacb58f7f5b44dd057` |
| Desktop JavaScriptCore / WTF / bmalloc | `oven-sh/WebKit` at `4d5e75ebd84a14edbc7ae264245dcd77fe597c10` |
| `launcher`, `libNativeWrapper.dylib` | `blackboardsh/electrobun` 1.18.1 at `4eba723c85b97559e1d9e13439d9a92ede0832e8` |
| `libasar.dylib` | `blackboardsh/zig-asar` 0.2.2 |
| `bspatch` | `blackboardsh/zig-bsdiff` 0.1.20, including Colin Percival / Yoav Givati notices |
| `zig-zstd` | `blackboardsh/zig-zstd` 0.1.3 |

The lock also includes TinyCC, direct native dependencies, ICU sources, both Zig wrappers' pinned zstd submodules, Zig standard-library sources, and the Cargo.lock registry archives with their original checksums. Registry crates that omit workspace licenses have an additional source archive pinned by `.cargo_vcs_info.json`. This is a conservative source inventory including build/test/platform alternatives, **not** a claim that every archived source file is linked into every executable.

WebKit snapshots retain `Source/`, `Tools/`, libraries, build configurations, ICU patches/data-generation recipes, and the other paths explicitly listed in the lock. Unrelated browser test/website trees are excluded and listed there. Each snapshot is generated from the exact commit with `git archive`, with a deterministic gzip header. Per-file notices remain in the sources as well as the collected notice files.

macOS frameworks (including system WebKit, ICU and SQLite) are OS dependencies, not copied into Kifu. The separately embedded Bun JavaScriptCore is covered above. The native wrapper has an optional weak CEF reference; this build contains no CEF framework or Dawn library. Changing this renderer or adding frameworks requires a new inventory.

## Obtain and verify the companion

A binary release must provide **`kifu-VERSION-source-materials.tar.gz` and its `.sha256` next to the binaries**, with equivalent download access. Do not publish the binaries alone or replace the companion with only an upstream homepage link. The companion contains `kifu/` (the actual Kifu source snapshot, lockfile, scripts and notices), `native-sources/` (the pinned source archives) and `SHA256.json` (per-file hashes). Large source archives stay in ignored `dist/`, outside Git.

Maintainers can recreate it from the repository with Python 3.11+, Git, Node and pnpm:

```sh
pnpm native:fetch      # Network access; verifies every downloaded archive
pnpm native:verify     # Offline archive checks
pnpm native:notices   # Recreate checked-in notices from these exact sources
pnpm licenses:collect
pnpm native:sources   # Snapshot current Git-visible source, excluding local launch settings
pnpm native:audit     # After server + desktop builds; inspect package contents and write report
```

Keep the companion with every release, including old releases while their binaries remain available. Its inclusion is the chosen source-delivery method; this document does not make a separate three-year written source offer.

## Rebuild a modified Bun / JavaScriptCore / TinyCC

Both Bun archives contain upstream build scripts, dependency pins and patches. Start from the source for the runtime being replaced, not the other Bun version. Extract that archive and its matching WebKit archive into separate directories. For example, for the server runtime:

```sh
mkdir -p work/bun work/WebKit
tar -xzf native-sources/bun142-744846f844374847c902b5e7fd59b4342a51ef99.tar.gz -C work/bun --strip-components=1
tar -xzf native-sources/webkit142-2e2aa2290fac.tar.gz -C work/WebKit --strip-components=1
# Edit the desired library source before compiling.
export BUN_WEBKIT_PATH="$PWD/work/WebKit"
cd work/bun
bun install --frozen-lockfile
GIT_SHA=744846f844374847c902b5e7fd59b4342a51ef99 bun run build:release:local
```

Use a bootstrap Bun and the toolchains required by that source tree (`scripts/build/tools.ts`, build documentation, `rust-toolchain.toml` for 1.4.2; `scripts/build/zig.ts` for 1.3.13). LLVM 21.1.x, CMake/Ninja, platform SDKs and other upstream prerequisites are separate build tools. The local profile builds the supplied WebKit source rather than linking a prebuilt JSC. Upstream scripts may download tools/dependencies; the companion is a source archive, not a preinstalled offline SDK. Preserve the source tree's build configuration and dependency versions. Linux ICU build and patches are in the matching WebKit Dockerfile and `icu/` where present.

For TinyCC in Bun 1.4.2, unpack `tinycc-05f0fafaa3be.tar.gz` into a separate directory, apply the included Bun `patches/tinycc/tcc.h.patch` and your changes, and pass `--local-deps=tinycc=/absolute/path/to/modified/tinycc` to `bun scripts/build.ts --profile=release-local --build-dir=build/release-local`. The upstream `--local-deps` path deliberately skips archive fetching and automatic patches; this keeps your modified source intact. For Bun 1.3.13, first let its build fetch the pinned TinyCC into `vendor/tinycc`, then modify that source while retaining its matching `.ref` stamp and rebuild. Do not change the dependency revision/patch identity at the same time: the upstream fetcher replaces sources whose identity is stale. Both original TinyCC archives and Bun's patch files are included.

The expected native output for the command above is `build/release-local/bun` (or the platform executable suffix). See the upstream build output for the actual path. Validate the modified runtime with `--version` and its own upstream tests before using it with Kifu.

**Validation boundary:** the pinned source archives and their hashes have been verified locally. A full rebuild of upstream Bun/WebKit/TinyCC has not been executed in this workspace; these upstream build instructions are source-derived, not a claim of bit-for-bit reproducibility or a completed modified-library rebuild. Before a public binary release, run this rebuild/replacement exercise on the release platforms and retain its logs.

## Link Kifu to your modified runtime

Kifu's application source and build scripts are supplied, so no proprietary object files are needed. From the companion's `kifu/` directory:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsx scripts/build-server.ts --target darwin-arm64 --runtime /absolute/path/to/modified/bun
pnpm smoke:server dist/server/darwin-arm64/bin/kifu-server --synthetic
```

Use `linux-x64` or `linux-arm64` and the corresponding runtime binary for those targets. `--runtime` explicitly passes your file as Bun's `--compile-executable-path`; it does not silently use the normal pinned runtime. The host compiler remains the installed bootstrap Bun. The resulting server is under `dist/server/TARGET/`; copy the whole directory when testing, because it contains the web UI and notices. Kifu imposes no extra restriction on running or distributing a modified build subject to the original licenses.

For the desktop runtime, make a working copy of `Kifu.app`, replace `Contents/MacOS/bun` with your compatible modified Bun **1.3.13** binary, and retain `Contents/Resources/app/` and `Contents/Resources/main.js`. For the embedded local server, replace `Contents/Resources/app/server/` with the complete rebuilt darwin-arm64 server directory. Preserve executable permissions. Modifying an app invalidates any existing signature; developers can locally ad-hoc sign their working copy (`codesign --force --deep --sign - /path/to/working/Kifu.app`) and test it under their own system security settings. Kifu has no runtime signature or vendor lock preventing this replacement.

To rebuild the launcher/native wrapper or Zig tools, use the included Electrobun `package/build.ts`, the wrapper archives' `build.zig`, and their pinned submodules. Restore the zstd archive at each wrapper's `zstd/` submodule directory. Electrobun uses Zig 0.13.0 for these tools. Keep the upstream licenses and source modifications with your resulting distribution.
