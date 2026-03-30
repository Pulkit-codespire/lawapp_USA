/**
 * @module services/reembedder
 * @description Re-embeds all chunks when the embedding model changes.
 * Handles vector column dimension changes and batch re-embedding.
 */

const { Chunk, Document, sequelize } = require('../models');
const embedder = require('./embedder');
const logger = require('../config/logger');

/** Known embedding dimensions by model (updated via auto-detection) */
const MODEL_DIMENSIONS = {
  /* OpenAI */
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  /* Gemini — auto-detected values will override these */
  'text-embedding-004': 768,
  'embedding-001': 3072,
};

/** Default fallback dimensions per provider */
const DEFAULT_DIMENSIONS = Object.freeze({
  openai: 1536,
  gemini: 768,
});

/** Cache for auto-detected dimensions */
const detectedDimensions = new Map();

/** Batch size for re-embedding */
const REEMBED_BATCH_SIZE = 20;

/** Track re-embedding progress */
let reembedStatus = {
  running: false,
  totalChunks: 0,
  processedChunks: 0,
  failedChunks: 0,
  currentModel: null,
  targetDimensions: null,
  startedAt: null,
  completedAt: null,
  error: null,
};

/**
 * Get the dimension count for a given embedding model (from cache/known list).
 * For accurate results, call detectDimensions() first.
 * @param {string} modelName - Embedding model name
 * @returns {number} Dimension count
 */
function getDimensions(modelName) {
  /* Check auto-detected cache first */
  if (detectedDimensions.has(modelName)) {
    return detectedDimensions.get(modelName);
  }

  if (MODEL_DIMENSIONS[modelName]) {
    return MODEL_DIMENSIONS[modelName];
  }

  /* Guess by provider prefix */
  if (modelName.startsWith('text-embedding')) {
    return DEFAULT_DIMENSIONS.openai;
  }
  if (modelName.startsWith('gemini') || modelName.includes('embedding')) {
    return DEFAULT_DIMENSIONS.gemini;
  }

  return DEFAULT_DIMENSIONS.openai;
}

/**
 * Auto-detect actual embedding dimensions by running a test embedding.
 * Caches the result for future use.
 * @param {string} modelName - Embedding model name
 * @returns {Promise<number>} Actual dimension count
 */
async function detectDimensions(modelName) {
  if (detectedDimensions.has(modelName)) {
    return detectedDimensions.get(modelName);
  }

  logger.info(`Auto-detecting dimensions for model: ${modelName}...`);

  try {
    const testEmbedding = await embedder.embedText('test');
    const dims = testEmbedding.length;

    detectedDimensions.set(modelName, dims);
    MODEL_DIMENSIONS[modelName] = dims;

    logger.info(`Detected ${dims} dimensions for ${modelName}`);
    return dims;
  } catch (err) {
    logger.warn(`Dimension detection failed for ${modelName}: ${err.message} — using known value`);
    return getDimensions(modelName);
  }
}

/**
 * Get current re-embed status.
 * @returns {Object} Status object
 */
function getStatus() {
  const status = { ...reembedStatus };

  if (status.running && status.totalChunks > 0) {
    status.progress = Math.round((status.processedChunks / status.totalChunks) * 100);
  } else {
    status.progress = status.completedAt ? 100 : 0;
  }

  return status;
}

/**
 * Re-embed all chunks with a new embedding model.
 * Runs in the background — poll getStatus() for progress.
 * @param {string} newModel - Target embedding model name
 * @returns {Promise<void>}
 */
async function reembedAll(newModel) {
  if (reembedStatus.running) {
    throw new Error('Re-embedding is already in progress');
  }

  /* Step 0: Auto-detect actual dimensions by running a test embedding */
  const targetDimensions = await detectDimensions(newModel);

  /* Reset status */
  reembedStatus = {
    running: true,
    totalChunks: 0,
    processedChunks: 0,
    failedChunks: 0,
    currentModel: newModel,
    targetDimensions,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };

  try {
    /* Count total chunks */
    const totalChunks = await Chunk.count();
    reembedStatus.totalChunks = totalChunks;

    if (totalChunks === 0) {
      reembedStatus.running = false;
      reembedStatus.completedAt = new Date().toISOString();
      logger.info('No chunks to re-embed');
      return;
    }

    logger.info(`Re-embedding ${totalChunks} chunks with ${newModel} (${targetDimensions} dims)`);

    /* Step 1: Alter the vector column dimension */
    await _alterVectorColumn(targetDimensions);

    /* Step 2: Re-embed all chunks in batches */
    await _reembedInBatches(newModel, totalChunks);

    reembedStatus.running = false;
    reembedStatus.completedAt = new Date().toISOString();
    logger.info(`Re-embedding complete: ${reembedStatus.processedChunks} succeeded, ${reembedStatus.failedChunks} failed`);
  } catch (err) {
    reembedStatus.running = false;
    reembedStatus.error = err.message;
    reembedStatus.completedAt = new Date().toISOString();
    logger.error(`Re-embedding failed: ${err.message}`);
    throw err;
  }
}

/**
 * Alter the embedding vector column to a new dimension.
 * Drops and recreates the column with the new vector size.
 * @param {number} dimensions - Target vector dimensions
 * @returns {Promise<void>}
 * @private
 */
async function _alterVectorColumn(dimensions) {
  logger.info(`Altering embedding column to vector(${dimensions})...`);

  await sequelize.query('ALTER TABLE chunks DROP COLUMN IF EXISTS embedding');
  await sequelize.query(`ALTER TABLE chunks ADD COLUMN embedding vector(${dimensions})`);

  /* Recreate HNSW index for fast similarity search */
  try {
    await sequelize.query('DROP INDEX IF EXISTS chunks_embedding_hnsw_idx');
    await sequelize.query(
      `CREATE INDEX chunks_embedding_hnsw_idx ON chunks
       USING hnsw (embedding vector_cosine_ops)
       WITH (m = 16, ef_construction = 64)`
    );
    logger.info('HNSW index recreated');
  } catch (err) {
    logger.warn(`HNSW index creation skipped: ${err.message}`);
  }

  logger.info(`Embedding column altered to vector(${dimensions})`);
}

/**
 * Re-embed all chunks in batches using the selected model.
 * @param {string} model - Embedding model name
 * @param {number} totalChunks - Total chunk count
 * @returns {Promise<void>}
 * @private
 */
async function _reembedInBatches(model, totalChunks) {
  let offset = 0;

  while (offset < totalChunks) {
    /* Fetch a batch of chunks (text only — embedding is null after column alter) */
    const chunks = await Chunk.findAll({
      attributes: ['id', 'chunkText'],
      order: [['created_at', 'ASC']],
      offset,
      limit: REEMBED_BATCH_SIZE,
      raw: true,
    });

    if (chunks.length === 0) break;

    /* Extract texts for batch embedding */
    const texts = chunks.map((c) => c.chunkText || c.chunk_text || '');

    try {
      const embeddings = await embedder.embedBatch(texts, false);

      /* Update each chunk with its new embedding using raw SQL */
      const { toSql } = require('pgvector');

      for (let i = 0; i < chunks.length; i++) {
        try {
          const vectorLiteral = toSql(embeddings[i]);
          await sequelize.query(
            `UPDATE chunks SET embedding = '${vectorLiteral}'::vector WHERE id = :id`,
            { replacements: { id: chunks[i].id } }
          );
          reembedStatus.processedChunks += 1;
        } catch (chunkErr) {
          logger.warn(`Failed to update chunk ${chunks[i].id}: ${chunkErr.message}`);
          reembedStatus.failedChunks += 1;
        }
      }
    } catch (batchErr) {
      /* If batch embedding fails, mark all chunks in batch as failed */
      logger.error(`Batch embedding failed at offset ${offset}: ${batchErr.message}`);
      reembedStatus.failedChunks += chunks.length;
    }

    offset += REEMBED_BATCH_SIZE;

    /* Log progress */
    const progress = Math.round(((reembedStatus.processedChunks + reembedStatus.failedChunks) / totalChunks) * 100);
    logger.info(`Re-embed progress: ${progress}% (${reembedStatus.processedChunks} done, ${reembedStatus.failedChunks} failed)`);
  }
}

module.exports = { reembedAll, getStatus, getDimensions, detectDimensions, MODEL_DIMENSIONS };
