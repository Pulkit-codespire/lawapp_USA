/**
 * @module models
 * @description Sequelize instance initialization, model registration, and database setup.
 * Registers pgvector type and sets up all model associations.
 */

const { Sequelize } = require('sequelize');
const pg = require('pg');
const logger = require('../config/logger');

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/lawapp';
const nodeEnv = process.env.NODE_ENV || 'development';

const sequelize = new Sequelize(databaseUrl, {
  dialect: 'postgres',
  dialectModule: pg,
  logging: nodeEnv === 'development' ? (msg) => logger.debug(msg) : false,
  pool: {
    min: 2,
    max: 10,
    idle: 10000,
    acquire: 30000,
  },
  dialectOptions: nodeEnv === 'production' ? {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  } : {},
});

/* Register pgvector custom type with Sequelize */
try {
  const pgvectorSequelize = require('pgvector/sequelize');
  pgvectorSequelize.registerType(Sequelize);
  logger.info('pgvector Sequelize type registered');
} catch (err) {
  logger.warn(`pgvector type registration skipped: ${err.message}`);
}

/* Initialize models */
const Document = require('./Document')(sequelize);
const Chunk = require('./Chunk')(sequelize);
const ChatHistory = require('./ChatHistory')(sequelize);

/* Set up associations */
const models = { Document, Chunk, ChatHistory };

Object.values(models).forEach((model) => {
  if (typeof model.associate === 'function') {
    model.associate(models);
  }
});

/**
 * Initialize database: create pgvector extension and sync tables.
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - Drop and recreate all tables
 * @returns {Promise<void>}
 */
async function initDb({ force = false } = {}) {
  /* Try to enable pgvector — skip gracefully if not installed */
  try {
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS vector');
    logger.info('pgvector extension enabled');
  } catch (err) {
    logger.warn('pgvector extension not available — vector search disabled. Keyword search will still work.');
    logger.warn('Install pgvector later: sudo apt install postgresql-16-pgvector');
  }

  await sequelize.sync({ force });
  logger.info(`Database tables synced (force: ${force})`);

  /* Ensure embedding column is vector(1536) type if pgvector is available */
  try {
    await sequelize.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    const [results] = await sequelize.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'chunks' AND column_name = 'embedding'`
    );

    if (results.length === 0) {
      logger.info('Adding embedding column as vector(1536)...');
      await sequelize.query('ALTER TABLE chunks ADD COLUMN embedding vector(1536)');
      logger.info('Embedding column added');
    } else if (results[0].data_type !== 'USER-DEFINED') {
      logger.info('Converting embedding column to vector(1536)...');
      await sequelize.query('ALTER TABLE chunks DROP COLUMN embedding');
      await sequelize.query('ALTER TABLE chunks ADD COLUMN embedding vector(1536)');
      logger.info('Embedding column converted to vector(1536)');
    } else {
      logger.info('Embedding column already vector(1536)');
    }
  } catch (err) {
    logger.warn(`pgvector embedding column setup skipped: ${err.message}`);
  }
}

/**
 * Check if the database connection is alive.
 * @returns {Promise<boolean>}
 */
async function checkConnection() {
  try {
    await sequelize.authenticate();
    return true;
  } catch (err) {
    logger.error(`Database connection failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  sequelize,
  Sequelize,
  Document,
  Chunk,
  ChatHistory,
  initDb,
  checkConnection,
};
