import { cache } from "./cache";
import { config } from "./helpers/config";
import { app } from "./server";
import { browser } from "./instance";

const server = app.listen(config.port, () => {
  console.log(`web-io listening on http://localhost:${config.port} (${config.env})`);
});

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`received ${signal}, shutting down`);

  // Do not hang forever on a request that refuses to finish.
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  // A no-op when no request ever needed a browser.
  await browser.close();
  // A no-op when nothing was ever cached, or when the driver is memory or none.
  cache.close();

  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
