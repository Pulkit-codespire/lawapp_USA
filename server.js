/**
 * @module server
 * @description Application entry point.
 * Validates environment, initializes database, and starts the HTTP server.
 */

const config = require('./config');
const logger = require('./config/logger');
const { initDb, checkConnection } = require('./models');
const createApp = require('./app');

/**
 * Start the server.
 */
async function start() {
  logger.info('='.repeat(50));
  logger.info('  LawApp Server — Starting');
  logger.info('='.repeat(50));

  /* Step 1: Verify database connection */
  logger.info('Step 1: Checking database connection...');
  const dbConnected = await checkConnection();

  if (!dbConnected) {
    logger.error('Database connection failed. Check DATABASE_URL in .env');
    process.exit(1);
  }
  logger.info('Database connection successful');

  /* Step 2: Initialize database (create extension + sync tables) */
  logger.info('Step 2: Initializing database...');
  await initDb();
  logger.info('Database initialized');

  /* Step 3: Verify OpenAI API key */
  logger.info('Step 3: Checking OpenAI API key...');
  if (!config.openai.apiKey || config.openai.apiKey === 'sk-your-openai-api-key-here') {
    logger.warn('OpenAI API key not configured — chat and embedding will fail');
  } else {
    logger.info('OpenAI API key configured');
  }

  /* Step 4: Start HTTP server */
  const app = createApp();
  const { host, port } = config.server;

  app.listen(port, host, () => {
    logger.info('='.repeat(50));
    logger.info(`  LawApp Server running on http://${host}:${port}`);
    logger.info(`  Environment: ${config.server.nodeEnv}`);
    logger.info('='.repeat(50));
  });
}

/* Graceful shutdown */
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down gracefully');
  process.exit(0);
});

/* Handle uncaught errors */
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

start().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});
