/**
 * Standalone build worker — split out of `apps/api` so the control-plane API
 * could move to Rust without needing `@avail/builder` (Node-only) in that
 * process. See docs/rust-api-migration-plan.md.
 *
 * Owns exactly what `apps/api`'s `services/{queue,poller,logs}.ts` used to:
 * running queued builds and polling connected repositories. It coordinates
 * with whichever API is inserting `QUEUED` deployment rows (the Node one
 * today, optionally the Rust one) purely through the shared SQLite database
 * — no HTTP surface, no IPC. Not started by `npm run dev`; run it by hand
 * (`npm run dev -w @avail/worker`) alongside `rust-api` to test that path
 * without touching the Node API you already have running.
 */
import { getDb, loginCodes, sessions } from '@avail/db';
import { config, dataDirIsNested } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import { poller } from './services/poller.ts';
import { queue } from './services/queue.ts';

const log = createLogger('worker');

async function start(): Promise<void> {
  getDb();

  queue.recoverOnBoot();
  queue.startPolling();
  poller.start();

  const cleanup = setInterval(() => {
    sessions.purgeExpired();
    loginCodes.purgeExpired();
  }, 60 * 60 * 1000);
  cleanup.unref();

  log.info('Build worker started');
  log.info(`Database: ${config.dbFile}`);
  log.info(`Build executor: ${config.build.executor}`);
  log.info(`Build workspace: ${config.workspaceDir} (${config.workspaceReason})`);
  log.info(
    `Picking up QUEUED deployments every 1s (from this process's own enqueue() calls immediately, ` +
      `from anything else — e.g. the Rust API — within that second)`
  );
  if (dataDirIsNested()) {
    log.warn(
      'AVAIL_DATA_DIR is inside the platform repository. Builds will inherit ' +
        "the platform's own node_modules and npm workspace — move it outside."
    );
  }

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    poller.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  log.error('Failed to start worker:', err);
  process.exit(1);
});
