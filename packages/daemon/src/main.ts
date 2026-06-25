import { createDaemon } from "./server.js";

const args = new Set(process.argv.slice(2));
const portArgIndex = process.argv.indexOf("--port");
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 3737;

const daemon = await createDaemon({ port });
await daemon.start();

if (!args.has("--foreground")) {
  console.log(`SunPilot daemon running at http://127.0.0.1:${port}`);
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // A19: Force-exit guard. If graceful shutdown hangs (e.g., a stuck DB
  // close or pending async work), force the process to exit after 10s so
  // the launcher/daemon supervisor can restart it cleanly.
  const forceExit = setTimeout(() => {
    console.error("[daemon] Graceful shutdown timed out after 10s — forcing exit.");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await daemon.stop();
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
