import { createDaemon } from "./server.js";

const args = new Set(process.argv.slice(2));
const portArgIndex = process.argv.indexOf("--port");
const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : 3737;

const daemon = await createDaemon({ port });
await daemon.start();

if (!args.has("--foreground")) {
  console.log(`SunPilot daemon running at http://127.0.0.1:${port}`);
}

const shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
