/**
 * gamebuddy-host-root.mjs — resolve the GameBuddy main-repo root for joint
 * gates that import host-built artifacts (voice-gateway-client.js,
 * voice-bootstrap.js, tavern browser-contract) and the deepseek-chan preset.
 *
 * After the voice split, this repo is standalone; the sibling `../host`
 * layout no longer exists. Gates therefore require the caller to point at a
 * GameBuddy checkout via GAMEBUDDY_HOST_ROOT. A missing root fails with a
 * clear hint instead of ERR_MODULE_NOT_FOUND.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @returns {{ hostRoot: string, presetRoot: string }}
 */
export function resolveGamebuddyHostRoot() {
  const envRoot = process.env.GAMEBUDDY_HOST_ROOT;
  if (typeof envRoot !== "string" || envRoot.trim().length === 0) {
    throw new Error(
      "GAMEBUDDY_HOST_ROOT is required: point it at the GameBuddy main checkout " +
        "(e.g. E:/projects/ai-game-companion) to run joint voice+host gates",
    );
  }
  const gamebuddyRoot = resolve(envRoot.trim());
  const hostRoot = resolve(gamebuddyRoot, "host");
  if (!existsSync(resolve(hostRoot, "package.json"))) {
    throw new Error(`GAMEBUDDY_HOST_ROOT=${gamebuddyRoot} has no host/package.json`);
  }
  return {
    hostRoot,
    presetRoot: resolve(gamebuddyRoot, "assets", "tavern", "presets", "deepseek-chan"),
  };
}

/**
 * Find the host dist directory that has the voice client and browser-contract
 * artifacts. Test builds live in host/dist-test*; a clean checkout may only
 * have host/dist. Fails with a setup hint instead of ERR_MODULE_NOT_FOUND.
 * @param {string} hostRoot
 * @param {string} [bootstrapFile] when set, the candidate must also contain it.
 * @returns {string}
 */
export function resolveHostDist(hostRoot, bootstrapFile) {
  const candidates = ["dist-test-voice4", "dist-test-voice3", "dist-test", "dist-test-voice", "dist"];
  for (const candidate of candidates) {
    if (existsSync(resolve(hostRoot, candidate, "voice-gateway-client.js")) === false) continue;
    if (existsSync(resolve(hostRoot, candidate, "tavern", "browser-contract", "index.js")) === false) continue;
    if (bootstrapFile !== undefined && existsSync(resolve(hostRoot, candidate, bootstrapFile)) === false) continue;
    return candidate;
  }
  throw new Error(
    "host_voice_artifact_missing: build host/src/voice-gateway-client.ts, voice-bootstrap.ts and " +
      "tavern/browser-contract into host/dist (pnpm --dir host build) before running this gate",
  );
}