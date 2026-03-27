/**
 * @module services/embedder
 * @description OpenAI embedding generation with batching, concurrency control, and retry logic.
 */

const OpenAI = require('openai');
const retry = require('async-retry');
const pLimit = require('p-limit');
const config = require('../config');
const logger = require('../config/logger');
const { RETRY_CONFIG, CONCURRENT_EMBED_LIMIT } = require('../utils/constants');
const { ExternalServiceError } = require('../utils/errors');

const openai = new OpenAI({ apiKey: config.openai.apiKey });
const limit = pLimit(CONCURRENT_EMBED_LIMIT);

/**
 * Generate embedding for a single text string.
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 * @throws {ExternalServiceError} If OpenAI API fails after retries
 */
async function embedText(text) {
  if (!text || text.trim().length === 0) {
    return new Array(config.embedding.dimensions).fill(0);
  }

  return retry(async () => {
    const response = await openai.embeddings.create({
      model: config.embedding.model,
      input: text.trim(),
      dimensions: config.embedding.dimensions,
    });
    return response.data[0].embedding;
  }, {
    retries: RETRY_CONFIG.retries,
    minTimeout: RETRY_CONFIG.minTimeout,
    maxTimeout: RETRY_CONFIG.maxTimeout,
    factor: RETRY_CONFIG.factor,
    onRetry: (err, attempt) => {
      logger.warn(`Embedding retry ${attempt}/${RETRY_CONFIG.retries}: ${err.message}`);
    },
  }).catch((err) => {
    throw new ExternalServiceError(`OpenAI embedding failed: ${err.message}`);
  });
}

/**
 * Alias for embedText — used for query embeddings.
 * @param {string} query - Query text
 * @returns {Promise<number[]>} Embedding vector
 */
async function embedQuery(query) {
  return embedText(query);
}

/**
 * Generate embeddings for a batch of texts with concurrency control.
 * @param {string[]} texts - Array of texts to embed
 * @param {boolean} [showProgress=false] - Whether to log progress
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
async function embedBatch(texts, showProgress = false) {
  if (!texts || texts.length === 0) {
    return [];
  }

  const { batchSize } = config.embedding;
  const batches = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const allEmbeddings = [];
  let processed = 0;

  const batchPromises = batches.map((batch, batchIndex) =>
    limit(async () => {
      const embeddings = await _processBatch(batch);
      processed += batch.length;

      if (showProgress) {
        const percent = Math.round((processed / texts.length) * 100);
        logger.info(`Embedding progress: ${percent}% (${processed}/${texts.length})`);
      }

      return { index: batchIndex, embeddings };
    }),
  );

  const results = await Promise.all(batchPromises);
  results.sort((a, b) => a.index - b.index);
  results.forEach((r) => allEmbeddings.push(...r.embeddings));

  return allEmbeddings;
}

/**
 * Process a single batch of texts through the OpenAI API.
 * @param {string[]} batch - Batch of texts
 * @returns {Promise<number[][]>} Batch of embeddings
 * @private
 */
async function _processBatch(batch) {
  return retry(async () => {
    const response = await openai.embeddings.create({
      model: config.embedding.model,
      input: batch.map((t) => t.trim()),
      dimensions: config.embedding.dimensions,
    });
    return response.data.map((d) => d.embedding);
  }, {
    retries: RETRY_CONFIG.retries,
    minTimeout: RETRY_CONFIG.minTimeout,
    maxTimeout: RETRY_CONFIG.maxTimeout,
    factor: RETRY_CONFIG.factor,
    onRetry: (err, attempt) => {
      logger.warn(`Batch embedding retry ${attempt}: ${err.message}`);
    },
  });
}

module.exports = { embedText, embedQuery, embedBatch };
