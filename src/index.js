import path from 'node:path';

import express from 'express';

import { config, validateConfig } from './config.js';
import { createApiRouter } from './routes/api.js';
import { startDiscordClient } from './services/discordService.js';
import { ensureStorage, rootDir } from './services/storage.js';
import { logger } from './utils/logger.js';

async function bootstrap() {
  validateConfig();
  await ensureStorage();
  await startDiscordClient();

  const app = express();
  const publicDir = path.join(rootDir, 'src', 'public');

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(publicDir));
  app.use('/api', createApiRouter());

  app.get('*', (_request, response) => {
    response.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(config.dashboardPort, config.dashboardHost, () => {
    logger.info(`Kuruma dashboard started on http://${config.dashboardHost}:${config.dashboardPort}`);
  });
}

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

bootstrap().catch((error) => {
  logger.error('Bootstrap failed', error);
  process.exit(1);
});
