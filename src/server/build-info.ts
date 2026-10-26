// Replaced at compile time by scripts/build-server.ts (bun build --define).
declare const __KIFU_BUILD_ID__: string | undefined;
declare const __KIFU_VERSION__: string | undefined;
declare const __KIFU_COMPILED__: boolean | undefined;

export const BUILD_ID: string = typeof __KIFU_BUILD_ID__ !== 'undefined' ? __KIFU_BUILD_ID__ : 'dev';
export const VERSION: string = typeof __KIFU_VERSION__ !== 'undefined' ? __KIFU_VERSION__ : '0.1.0-dev';
/** True inside a `bun build --compile` executable. */
export const IS_COMPILED: boolean = typeof __KIFU_COMPILED__ !== 'undefined' && __KIFU_COMPILED__;
