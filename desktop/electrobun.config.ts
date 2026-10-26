import type { ElectrobunConfig } from 'electrobun';
import packageJson from './package.json';

// Local builds are unsigned (no Apple developer identity on this machine);
// locally built apps carry no quarantine flag, so Gatekeeper lets them run.
// Server packages come from `pnpm build:server` (repo root) and must exist before building.
// The icon set comes from `pnpm icons` (desktop/assets/kifu-icon*.svg → Kifu.iconset).
const remote = (target: string) => ({
  [`../dist/server/kifu-server-${target}.tar.gz`]: `remote/kifu-server-${target}.tar.gz`,
  [`../dist/server/kifu-server-${target}.tar.gz.sha256`]: `remote/kifu-server-${target}.tar.gz.sha256`,
  [`../dist/server/${target}/manifest.json`]: `remote/${target}.manifest.json`,
});

export default {
  app: {
    name: 'Kifu',
    identifier: 'dev.kifu.desktop',
    version: packageJson.version,
  },
  build: {
    bun: { entrypoint: 'src/bun/index.ts' },
    views: {
      shell: {
        entrypoint: 'src/shell/index.tsx',
        define: { 'process.env.NODE_ENV': '"production"' },
      },
    },
    copy: {
      '../dist/licenses': 'licenses',
      'src/shell/index.html': 'views/shell/index.html',
      'src/shell/shell.css': 'views/shell/shell.css',
      // Bun-compiled server + web UI for this Mac.
      '../dist/server/darwin-arm64': 'server',
      // Packages uploaded to SSH remotes.
      ...remote('linux-x64'),
      ...remote('linux-arm64'),
    },
    mac: {
      codesign: false,
      notarize: false,
      icons: 'assets/Kifu.iconset',
    },
  },
  scripts: { postWrap: '../scripts/unpack-desktop.mjs' },
  runtime: {
    exitOnLastWindowClosed: false,
  },
} satisfies ElectrobunConfig;
