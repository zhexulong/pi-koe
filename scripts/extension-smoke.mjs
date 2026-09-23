/**
 * extension-smoke.mjs — load the pi extension entry with a fake pi API and
 * assert the registered command works. This proves the package's extension
 * entry is loadable/registrable without a real pi process (jiti-compatible
 * TS, no compile step) and that the /voice command reports sane status.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// jiti is not installed here; use Node's native TS type-stripping instead (Node >= 24.13).
// extensions/index.ts uses type-only imports plus plain TS; strip-types handles it.
const entryUrl = pathToFileURL(resolve("extensions/index.ts")).href;

const commandHandlers = new Map();
const eventHandlers = new Map();

const fakePi = {
  registerCommand(name, opts) {
    commandHandlers.set(name, opts.handler);
  },
  on(event, handler) {
    eventHandlers.set(event, handler);
  },
};

const { default: registerExtension } = await import(entryUrl);
registerExtension(fakePi);

if (commandHandlers.size !== 1 || !commandHandlers.has("voice")) {
  console.error("expected exactly one /voice command to be registered");
  process.exit(1);
}
if (!eventHandlers.has("session_shutdown")) {
  console.error("expected session_shutdown handler");
  process.exit(1);
}

const status = await commandHandlers.get("voice")("", {
  ui: { notify() {} },
});
if (!status.startsWith("voice_gateway_not_running")) {
  console.error(`unexpected status output: ${status}`);
  process.exit(1);
}

// stop when nothing is running must be a no-op string, not a throw.
const stopped = await commandHandlers.get("voice")("stop", { ui: { notify() {} } });
if (stopped !== "voice_gateway_not_running") {
  console.error(`unexpected stop output: ${stopped}`);
  process.exit(1);
}

await eventHandlers.get("session_shutdown")();
console.log("extension smoke ok: /voice status + stop + session_shutdown");
process.exit(0);