import path from 'node:path';
import Electrobun, { Utils } from 'electrobun/bun';
import packageJson from '../../package.json';
import { legacyHome, migrateLegacyHome } from '../../../src/shared/legacy-home';
import { ConnectionManager } from './app/connections';
import { claimInstance, endPreviousInstance, lockFileFor, releaseInstance } from './app/instance';
import { mainWindowOpen, openMainWindow, pushState, sendCommand, sendRestarted, sendToast, setWindowTitle } from './app/main-window';
import { installMenu } from './app/menu';
import { storePath } from './app/store';
import { hydrateShellEnv } from './env/hydrate';
import { watchWake } from './remote/reconnect';
import { fileLogger, logDir } from './transport/local';

// Builds from before the rename kept everything in ~/.trace-monitor: end one still running there,
// then move its data over before anything here writes to ~/.kifu (a scratch store leaves it alone).
const legacy = process.env.KIFU_DESKTOP_STORE || process.env.KIFU_AUTOTEST === '1' ? undefined : legacyHome();
const legacyTakeover = legacy ? await endPreviousInstance(lockFileFor(path.join(legacy, 'desktop', 'connections.json'))) : undefined;
const migrated = legacy ? migrateLegacyHome() : undefined;

// Finder-launched apps get launchd's minimal environment: restore PATH, SSH_AUTH_SOCK, KRB5CCNAME …
const env = await hydrateShellEnv();
const appLog = fileLogger('app');
appLog(`start v${packageJson.version} pid ${process.pid}; login env ${env?.ok ? 'ok' : 'unavailable'}: +${env?.added ?? 0} vars, PATH ${env?.pathEntries.join('→') ?? '?'} entries, ${Object.entries(env?.has ?? {}).map(([k, v]) => `${k}=${v ? 'set' : 'unset'}`).join(' ')}`);
if (legacyTakeover?.previous) appLog(`older build pid ${legacyTakeover.previous} ${legacyTakeover.killed ? 'did not quit in time: killed' : 'quit'}`);
if (migrated) {
  const what = migrated.moved.includes('.') ? 'the whole directory' : `${migrated.moved.length} entries`;
  const left = migrated.left.length ? `; left there (~/.kifu already has them): ${migrated.left.slice(0, 20).join(', ')}${migrated.left.length > 20 ? ' …' : ''}` : '';
  appLog(`moved ~/.trace-monitor to ~/.kifu: ${what}${left}`);
}

// One instance per store: an older one still running on the same connections.json quits first.
const lock = lockFileFor(storePath());
const takeover = await claimInstance(lock);
if (takeover.previous) appLog(`previous instance pid ${takeover.previous} ${takeover.killed ? 'did not quit in time: killed' : 'quit'}`);

const model: ConnectionManager = new ConnectionManager(
  {
    onChange: () => pushState(model),
    onRestarted: (id) => sendRestarted(id),
    onToast: (t) => sendToast(t),
    onActive: (title) => setWindowTitle(title),
  },
  packageJson.version,
);

const showWindow = () => openMainWindow(model);
installMenu({
  settings: () => (showWindow(), sendCommand({ name: 'openSettings' })),
  'add-host': () => (showWindow(), sendCommand({ name: 'openSettings', page: 'connections', adding: true })),
  'quick-open': () => (showWindow(), sendCommand({ name: 'quickOpen' })),
  'close-tab': () => sendCommand({ name: 'closeTab' }),
  'toggle-sidebar': () => sendCommand({ name: 'toggleSidebar' }),
  reload: () => sendCommand({ name: 'reload' }),
  'next-tab': () => sendCommand({ name: 'nextTab' }),
  'prev-tab': () => sendCommand({ name: 'prevTab' }),
  'show-window': showWindow,
  devtools: () => sendCommand({ name: 'devtools' }),
  'open-logs': () => Utils.openPath(logDir()),
});

// Local servers exit on stdin EOF; closing the pipes here lets them shut down
// cleanly even though we do not wait for them. Servers on SSH hosts run
// detached: they finish what they run and exit once idle.
Electrobun.events.on('before-quit', () => {
  model.killAll();
});
process.on('exit', () => {
  model.killAll();
  releaseInstance(lock);
});
Electrobun.events.on('reopen', () => {
  if (!mainWindowOpen()) showWindow();
});

watchWake(() => void model.onWake());

showWindow();
model.start();

if (process.env.KIFU_AUTOTEST === '1') void import('./app/autotest').then((m) => m.runAutotest(model));
