/**
 * pi-voice-gateway — pi extension entry
 *
 * Registers a `/voice` command family that manages the local GameBuddy Voice
 * Gateway child process (status / start / stop) and cleans up the child on
 * session shutdown. The factory itself never starts background resources
 * (docs/extensions.md: defer process/socket/timer startup to commands or
 * session lifecycle); the gateway is started only on explicit `/voice start`.
 *
 * Requires a local build first: `pnpm build` (or `npm run build`). Without
 * the built `dist/`, `start` reports the missing artifact instead of
 * pretending the gateway is ready.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Child owned by this extension instance; one gateway per extension. */
let gatewayChild: ChildProcessWithoutNullStreams | undefined;

function gatewayEntry(): string {
  return resolve(repoRoot, "dist", "main.js");
}

function envConfig(): { port: string; token: string } {
  const port = process.env.GAMEBUDDY_VOICE_PORT ?? "49780";
  const token = process.env.GAMEBUDDY_VOICE_TOKEN ?? `voice_pi_${process.pid}`;
  return { port, token };
}

function spawnGateway(): ChildProcessWithoutNullStreams {
  const { port, token } = envConfig();
  const child = spawn(process.execPath, ["--use-env-proxy", gatewayEntry()], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GAMEBUDDY_VOICE_PORT: port,
      GAMEBUDDY_VOICE_TOKEN: token,
      // Cloud TTS stays off unless a real product-owned admission exists:
      // environment credentials alone are not player consent.
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

function waitForListening(child: ChildProcessWithoutNullStreams, timeoutMs = 20_000): Promise<{ ok: boolean; line: string }> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;
    let buffer = "";
    const onData = (chunk: string) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.includes("listening on 127.0.0.1"));
      if (line !== undefined) {
        child.stdout.off("data", onData);
        resolvePromise({ ok: true, line: line.trim() });
      } else if (Date.now() > deadline) {
        child.stdout.off("data", onData);
        resolvePromise({ ok: false, line: "gateway_listen_timeout" });
      }
    };
    child.stdout.on("data", onData);
  });
}

export default function registerVoiceGatewayExtension(pi: ExtensionAPI) {
  pi.registerCommand("voice", {
    description:
      "Manage the local GameBuddy Voice Gateway: `voice status`, `voice start`, `voice stop`. Requires a built dist/ (pnpm build).",
    handler: async (args, ctx) => {
      const [action] = (args ?? "").trim().split(/\s+/);
      const { port, token } = envConfig();

      if (action === "start") {
        if (gatewayChild !== undefined) {
          ctx.ui.notify(`Voice gateway already running (pid ${gatewayChild.pid})`, "info");
          return;
        }
        if (gatewayChild?.exitCode !== undefined) gatewayChild = undefined;
        const child = spawnGateway();
        gatewayChild = child;
        child.stderr.on("data", (_c) => { /* kept on stderr; not surfaced to transcript */ });
        const result = await waitForListening(child);
        if (result.ok) {
          ctx.ui.notify(`Voice gateway ready on 127.0.0.1:${port}`, "info");
          return `voice_gateway_started pid=${child.pid} port=${port}\n${result.line}`;
        }
        gatewayChild = undefined;
        child.kill();
        return `voice_gateway_failed_to_ready: ${result.line}`;
      }

      if (action === "stop") {
        if (gatewayChild === undefined) {
          ctx.ui.notify("Voice gateway not running", "info");
          return "voice_gateway_not_running";
        }
        const pid = gatewayChild.pid;
        gatewayChild.kill();
        gatewayChild = undefined;
        ctx.ui.notify("Voice gateway stopped", "info");
        return `voice_gateway_stopped pid=${pid}`;
      }

      // Default: status.
      if (gatewayChild !== undefined && gatewayChild.exitCode === null) {
        return `voice_gateway_running pid=${gatewayChild.pid} port=${port} admission=${process.env.GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION !== undefined}`;
      }
      return `voice_gateway_not_running port=${port} built=${gatewayEntry()} source_path=${gatewayEntry()} admission_env=${process.env.GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION !== undefined}`;
    },
  });

  pi.on("session_shutdown", async () => {
    if (gatewayChild !== undefined && gatewayChild.exitCode === null) {
      gatewayChild.kill();
    }
    gatewayChild = undefined;
  });
}