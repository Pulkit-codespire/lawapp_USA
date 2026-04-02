/**
 * @module services/embedder
 * @description Multi-provider embedding generation (OpenAI + Gemini).
 * Reads the selected embedding model from the database settings.
 */

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const retry = require('async-retry');
const pLimit = require('p-limit');
const config = require('../config');
const logger = require('../config/logger');
const { RETRY_CONFIG, CONCURRENT_EMBED_LIMIT } = require('../utils/constants');
const { ExternalServiceError } = require('../utils/errors');
const { trackUsage } = require('./usageTracker');

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
const geminiClient = config.gemini?.apiKey ? new GoogleGenerativeAI(config.gemini.apiKey) : null;
const limit = pLimit(CONCURRENT_EMBED_LIMIT);

/**
 * Check if a model name belongs to Gemini.
 * @param {string} model
 * @returns {boolean}
 */
function _isGeminiModel(model) {
  return model && (model.startsWith('gemini') || model.includes('embedding-0'));
}

/**
 * Get the current embedding model from database settings.
 * Falls back to config default if settings not available.
 * @returns {Promise<string>}
 */
async function _getEmbeddingModel() {
  try {
    const { Settings } = require('../models');
    const saved = await Settings.get('ai_config');
    if (saved && saved.embeddingModel) {
      return saved.embeddingModel;
    }
  } catch (err) {
    logger.debug(`Could not read embedding model from settings: ${err.message}`);
  }
  return config.embedding.model;
}

/**
 * Generate embedding using OpenAI.
 * @param {string} text
 * @param {string} model
 * @returns {Promise<number[]>}
 */
async function _embedWithOpenAI(text, model) {
  if (!openai) {
    throw new ExternalServiceError('OpenAI API key not configured');
  }

  /* Use model-specific dimensions from reembedder mapping */
  let dimensions = config.embedding.dimensions;
  try {
    const reembedder = require('./reembedder');
    dimensions = reembedder.getDimensions(model);
  } catch {
    /* fallback to config default */
  }

  const response = await openai.embeddings.create({
    model,
    input: text.trim(),
    dimensions,
  });
  return response.data[0].embedding;
}

/**
 * Generate embedding using Gemini.
 * @param {string} text
 * @param {string} model
 * @returns {Promise<number[]>}
 */
async function _embedWithGemini(text, model) {
  if (!geminiClient) {
    throw new ExternalServiceError('Gemini API key not configured');
  }

  const geminiModel = geminiClient.getGenerativeModel({ model });
  const result = await geminiModel.embedContent(text.trim());
  return result.embedding.values;
}

/**
 * Get the correct dimensions for the current embedding model.
 * @returns {Promise<number>}
 */
async function _getEmbeddingDimensions() {
  const model = await _getEmbeddingModel();
  try {
    const reembedder = require('./reembedder');
    return reembedder.getDimensions(model);
  } catch {
    return config.embedding.dimensions;
  }
}

/**
 * Generate embedding for a single text string.
 * Automatically routes to OpenAI or Gemini based on saved settings.
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
async function embedText(text) {
  if (!text || text.trim().length === 0) {
    const dims = await _getEmbeddingDimensions();
    return new Array(dims).fill(0);
  }

  const model = await _getEmbeddingModel();
  const isGemini = _isGeminiModel(model);

  logger.debug(`Embedding with ${isGemini ? 'Gemini' : 'OpenAI'}: ${model}`);

  return retry(async () => {
    if (isGemini) {
      return _embedWithGemini(text, model);
    }
    return _embedWithOpenAI(text, model);
  }, {
    retries: RETRY_CONFIG.retries,
    minTimeout: RETRY_CONFIG.minTimeout,
    maxTimeout: RETRY_CONFIG.maxTimeout,
    factor: RETRY_CONFIG.factor,
    onRetry: (err, attempt) => {
      logger.warn(`Embedding retry ${attempt}/${RETRY_CONFIG.retries}: ${err.message}`);
    },
  }).catch((err) => {
    throw new ExternalServiceError(`Embedding failed (${model}): ${err.message}`);
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

  const model = await _getEmbeddingModel();
  const isGemini = _isGeminiModel(model);
  const { batchSize } = config.embedding;

  logger.info(`Batch embedding ${texts.length} texts with ${isGemini ? 'Gemini' : 'OpenAI'}: ${model}`);

  if (isGemini) {
    /* Gemini doesn't support batch embedding — process one at a time with concurrency */
    const geminiResults = await _batchWithConcurrency(texts, model, isGemini, showProgress);
    const estTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    trackUsage({
      operation: 'embedding',
      model,
      inputTokens: estTokens,
      totalTokens: estTokens,
      metadata: { textCount: texts.length, batchMode: 'gemini' },
    });
    return geminiResults;
  }

  /* OpenAI supports batch embedding */
  const batches = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const allEmbeddings = [];
  let processed = 0;

  const batchPromises = batches.map((batch, batchIndex) =>
    limit(async () => {
      const embeddings = await _processOpenAIBatch(batch, model);
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

  /* Track embedding usage — estimate ~4 tokens per text chunk avg */
  const estTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  trackUsage({
    operation: 'embedding',
    model,
    inputTokens: estTokens,
    totalTokens: estTokens,
    metadata: { textCount: texts.length, batchMode: 'openai' },
  });

  return allEmbeddings;
}

/**
 * Process texts with concurrency control (for Gemini or single-text APIs).
 * @param {string[]} texts
 * @param {string} model
 * @param {boolean} isGemini
 * @param {boolean} showProgress
 * @returns {Promise<number[][]>}
 * @private
 */
async function _batchWithConcurrency(texts, model, isGemini, showProgress) {
  let processed = 0;

  const promises = texts.map((text, idx) =>
    limit(async () => {
      const embedding = isGemini
        ? await _embedWithGemini(text, model)
        : await _embedWithOpenAI(text, model);

      processed += 1;
      if (showProgress && processed % 10 === 0) {
        const percent = Math.round((processed / texts.length) * 100);
        logger.info(`Embedding progress: ${percent}% (${processed}/${texts.length})`);
      }

      return { index: idx, embedding };
    }),
  );

  const results = await Promise.all(promises);
  results.sort((a, b) => a.index - b.index);
  return results.map((r) => r.embedding);
}

/**
 * Process a batch of texts through the OpenAI API.
 * @param {string[]} batch
 * @param {string} model
 * @returns {Promise<number[][]>}
 * @private
 */
async function _processOpenAIBatch(batch, model) {
  if (!openai) {
    throw new ExternalServiceError('OpenAI API key not configured');
  }

  /* Use model-specific dimensions */
  let dimensions = config.embedding.dimensions;
  try {
    const reembedder = require('./reembedder');
    dimensions = reembedder.getDimensions(model);
  } catch {
    /* fallback to config default */
  }

  return retry(async () => {
    const response = await openai.embeddings.create({
      model,
      input: batch.map((t) => t.trim()),
      dimensions,
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
