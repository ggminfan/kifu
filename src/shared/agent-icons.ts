import type { AgentKind } from './agents';

// Original geometric badges; no artwork extracted from third-party apps.
const badge = (background: string, mark: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${background}"/><g fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${mark}</g></svg>`)}`;

export const AGENT_ICON: Record<AgentKind, string> = {
  codex: badge('#257565', '<path d="m12 10-6 6 6 6m8-12 6 6-6 6"/>'),
  claude: badge('#A45C3D', '<path d="M23 8H13a6 6 0 0 0-6 6v4a6 6 0 0 0 6 6h10M14 12h8m-8 5h5"/>'),
};
