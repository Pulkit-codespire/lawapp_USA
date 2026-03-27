/**
 * @module config/database
 * @description Sequelize CLI database configuration.
 * Used by sequelize-cli for migrations and seeders.
 */

require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/lawapp';

/** @type {Object} Pool configuration shared across environments */
const poolConfig = {
  min: 2,
  max: 10,
  idle: 10000,
  acquire: 30000,
};

module.exports = {
  development: {
    use_env_variable: 'DATABASE_URL',
    url: DATABASE_URL,
    dialect: 'postgres',
    logging: false,
    pool: poolConfig,
  },
  test: {
    use_env_variable: 'DATABASE_URL',
    url: DATABASE_URL,
    dialect: 'postgres',
    logging: false,
    pool: poolConfig,
  },
  production: {
    use_env_variable: 'DATABASE_URL',
    url: DATABASE_URL,
    dialect: 'postgres',
    logging: false,
    pool: { ...poolConfig, min: 5, max: 20 },
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    },
  },
};
