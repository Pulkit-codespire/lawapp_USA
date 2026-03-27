/**
 * @module scripts/setupDb
 * @description One-time database setup — creates pgvector extension and syncs all tables.
 * Usage: node scripts/setupDb.js
 */

require('dotenv').config();

const { initDb, checkConnection, sequelize } = require('../models');
const logger = require('../config/logger');

async function setup() {
  logger.info('='.repeat(50));
  logger.info('  LawApp — Database Setup');
  logger.info('='.repeat(50));

  /* Step 1: Check connection */
  logger.info('Step 1: Checking database connection...');
  const connected = await checkConnection();

  if (!connected) {
    logger.error('Cannot connect to database. Check DATABASE_URL in .env');
    process.exit(1);
  }
  logger.info('Database connection successful');

  /* Step 2: Create pgvector extension and tables */
  logger.info('Step 2: Creating pgvector extension and tables...');
  try {
    await initDb();
    logger.info('pgvector extension enabled');
    logger.info('All tables created');
  } catch (err) {
    logger.error(`Failed to create tables: ${err.message}`);
    _logPgvectorHelp(err);
    process.exit(1);
  }

  /* Step 3: Verify tables */
  logger.info('Step 3: Verifying tables...');
  const [tables] = await sequelize.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );

  const expected = ['documents', 'chunks', 'chat_history'];
  const found = tables.map((t) => t.table_name);

  for (const table of expected) {
    if (found.includes(table)) {
      logger.info(`  Table '${table}' exists`);
    } else {
      logger.error(`  Table '${table}' NOT found`);
    }
  }

  logger.info('='.repeat(50));
  logger.info('  Database setup complete!');
  logger.info('  Run: node server.js');
  logger.info('='.repeat(50));

  await sequelize.close();
}

/**
 * Log pgvector installation instructions if the extension is not available.
 * @param {Error} err
 */
function _logPgvectorHelp(err) {
  if (String(err.message).includes('not available')) {
    logger.error(
      '\npgvector extension is NOT installed on your PostgreSQL server.\n' +
      'Install it first:\n' +
      '  Ubuntu/WSL:  sudo apt install postgresql-16-pgvector\n' +
      '  Docker:      use pgvector/pgvector:pg16 image\n' +
      '  Windows:     download from github.com/pgvector/pgvector\n',
    );
  }
}

setup().catch((err) => {
  logger.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
