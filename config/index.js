/**
 * @module config
 * @description Centralized application configuration with Joi validation.
 * Loads environment variables from .env and validates required values on startup.
 */

const Joi = require('joi');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const envSchema = Joi.object({
  OPENAI_API_KEY: Joi.string().required().description('OpenAI API key'),
  GEMINI_API_KEY: Joi.string().optional().allow('').description('Google Gemini API key (optional)'),
  JWT_SECRET: Joi.string().min(16).default('lawapp-dev-secret-change-in-production').description('JWT signing secret'),
  GOOGLE_SERVICE_ACCOUNT_KEY: Joi.string().optional().allow('').description('Google Service Account key file path or JSON'),
  DATABASE_URL: Joi.string().uri().required().description('PostgreSQL connection URL'),
  CASE_FILES_ROOT: Joi.string().default('C:/legal_cases'),
  CHUNK_SIZE: Joi.number().integer().min(100).max(4000).default(800),
  CHUNK_OVERLAP: Joi.number().integer().min(0).max(500).default(150),
  EMBEDDING_MODEL: Joi.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: Joi.number().integer().default(1536),
  EMBEDDING_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(100),
  CHAT_MODEL: Joi.string().default('gpt-4o'),
  CHAT_MAX_TOKENS: Joi.number().integer().min(100).max(8000).default(2000),
  CHAT_TEMPERATURE: Joi.number().min(0).max(2).default(0.1),
  TOP_K_RESULTS: Joi.number().integer().min(1).max(100).default(10),
  SIMILARITY_THRESHOLD: Joi.number().min(0).max(1).default(0.35),
  RERANK_TOP_K: Joi.number().integer().min(1).max(50).default(5),
  HOST: Joi.string().default('0.0.0.0'),
  PORT: Joi.number().integer().default(8000),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
}).unknown(true);

const { error, value: env } = envSchema.validate(process.env, { abortEarly: false });

if (error) {
  const messages = error.details.map((d) => `  - ${d.message}`).join('\n');
  throw new Error(`Environment validation failed:\n${messages}`);
}

/**
 * @typedef {Object} AppConfig
 * @property {Object} openai - OpenAI configuration
 * @property {Object} database - Database configuration
 * @property {Object} ingestion - Ingestion pipeline settings
 * @property {Object} embedding - Embedding generation settings
 * @property {Object} chat - Chat LLM settings
 * @property {Object} rag - RAG pipeline settings
 * @property {Object} server - Server settings
 */
const config = Object.freeze({
  openai: {
    apiKey: env.OPENAI_API_KEY,
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY || null,
  },
  database: {
    url: env.DATABASE_URL,
  },
  ingestion: {
    caseFilesRoot: env.CASE_FILES_ROOT,
    chunkSize: env.CHUNK_SIZE,
    chunkOverlap: env.CHUNK_OVERLAP,
  },
  embedding: {
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    batchSize: env.EMBEDDING_BATCH_SIZE,
  },
  chat: {
    model: env.CHAT_MODEL,
    maxTokens: env.CHAT_MAX_TOKENS,
    temperature: env.CHAT_TEMPERATURE,
  },
  rag: {
    topKResults: env.TOP_K_RESULTS,
    similarityThreshold: env.SIMILARITY_THRESHOLD,
    rerankTopK: env.RERANK_TOP_K,
  },
  server: {
    host: env.HOST,
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    isDev: env.NODE_ENV === 'development',
  },
});

module.exports = config;
