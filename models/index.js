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
  logging: false,
  pool: {
    min: 0,
    max: 5,
    idle: 10000,
    acquire: 60000,
    evict: 10000,
  },
  retry: {
    max: 3,
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
const User = require('./User')(sequelize);
const Document = require('./Document')(sequelize);
const Chunk = require('./Chunk')(sequelize);
const ChatSession = require('./ChatSession')(sequelize);
const ChatHistory = require('./ChatHistory')(sequelize);
const Settings = require('./Settings')(sequelize);
const UsageLog = require('./UsageLog')(sequelize);

/* Set up associations */
const models = { User, Document, Chunk, ChatSession, ChatHistory, Settings, UsageLog };

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

  /* Ensure embedding column is vector type if pgvector is available */
  try {
    await sequelize.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");

    /* Determine target dimensions from saved settings */
    let targetDims = 1536;
    try {
      const saved = await Settings.findOne({ where: { key: 'ai_config' } });
      if (saved && saved.value && saved.value.embeddingModel) {
        const reembedder = require('../services/reembedder');
        targetDims = reembedder.getDimensions(saved.value.embeddingModel);
      }
    } catch {
      /* Settings table may not exist yet on first run */
    }

    const [results] = await sequelize.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'chunks' AND column_name = 'embedding'`
    );

    if (results.length === 0) {
      logger.info(`Adding embedding column as vector(${targetDims})...`);
      await sequelize.query(`ALTER TABLE chunks ADD COLUMN embedding vector(${targetDims})`);
      logger.info('Embedding column added');
    } else if (results[0].data_type !== 'USER-DEFINED') {
      logger.info(`Converting embedding column to vector(${targetDims})...`);
      await sequelize.query('ALTER TABLE chunks DROP COLUMN embedding');
      await sequelize.query(`ALTER TABLE chunks ADD COLUMN embedding vector(${targetDims})`);
      logger.info(`Embedding column converted to vector(${targetDims})`);
    } else {
      logger.info('Embedding column already exists as vector type');
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
  User,
  Document,
  Chunk,
  ChatSession,
  ChatHistory,
  Settings,
  UsageLog,
  initDb,
  checkConnection,
};
