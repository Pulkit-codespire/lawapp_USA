/**
 * @module services/rag/retriever
 * @description Hybrid search (vector + keyword) with Reciprocal Rank Fusion.
 * Falls back to keyword-only search when pgvector is not available.
 */

const { Op } = require('sequelize');
const { Document, Chunk, sequelize } = require('../../models');
const embedder = require('../embedder');
const config = require('../../config');
const logger = require('../../config/logger');
const { RRF_K } = require('../../utils/constants');

/** Track whether pgvector is available */
let pgvectorAvailable = null;

/**
 * Check if pgvector extension is installed.
 * @returns {Promise<boolean>}
 */
async function _checkPgvector() {
  if (pgvectorAvailable !== null) return pgvectorAvailable;

  try {
    await sequelize.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    const [results] = await sequelize.query("SELECT count(*) as cnt FROM pg_extension WHERE extname = 'vector'");
    pgvectorAvailable = parseInt(results[0].cnt, 10) > 0;
  } catch {
    pgvectorAvailable = false;
  }

  if (!pgvectorAvailable) {
    logger.warn('pgvector not available — using keyword search only');
  }
  return pgvectorAvailable;
}

/**
 * @typedef {Object} RetrievedChunk
 * @property {string} chunkId
 * @property {string} documentId
 * @property {string} text
 * @property {string} section
 * @property {number|null} pageNumber
 * @property {number} similarity
 * @property {string} caseName
 * @property {string} fileName
 * @property {string|null} documentType
 * @property {Object} metadata
 */

/**
 * Perform hybrid search (vector + keyword) and merge results.
 * Falls back to keyword-only if pgvector is not installed.
 * @param {string} query - Search query
 * @param {Object} [options]
 * @param {number} [options.topK] - Max results to return
 * @param {string} [options.caseName] - Filter by case name
 * @param {string} [options.documentType] - Filter by document type
 * @returns {Promise<RetrievedChunk[]>}
 */
async function search(query, options = {}) {
  const topK = options.topK || config.rag.topKResults;
  const hasPgvector = await _checkPgvector();

  if (hasPgvector) {
    try {
      const [vectorResults, keywordResults] = await Promise.all([
        vectorSearch(query, topK, options.caseName, options.documentType),
        keywordSearch(query, topK, options.caseName, options.documentType),
      ]);
      const merged = _mergeResults(vectorResults, keywordResults, topK);
      logger.info(`Hybrid search: ${vectorResults.length} vector + ${keywordResults.length} keyword → ${merged.length} merged`);
      return merged;
    } catch (embeddingErr) {
      /* Embedding failed (invalid API key, quota exceeded, etc.) — fall back to keyword search */
      logger.warn(`Vector search failed (${embeddingErr.message}) — falling back to keyword-only search`);
    }
  }

  /* Keyword-only fallback */
  const results = await keywordSearch(query, topK, options.caseName, options.documentType);
  logger.info(`Keyword-only search: ${results.length} results`);
  return results;
}

/**
 * Vector similarity search using pgvector cosine distance.
 * @param {string} query
 * @param {number} topK
 * @param {string} [caseName]
 * @param {string} [documentType]
 * @returns {Promise<RetrievedChunk[]>}
 */
async function vectorSearch(query, topK, caseName, documentType) {
  const { toSql } = require('pgvector');
  const queryEmbedding = await embedder.embedQuery(query);
  const vectorLiteral = toSql(queryEmbedding);

  const where = { embedding: { [Op.ne]: null } };
  const includeWhere = _buildIncludeWhere(caseName, documentType);

  const chunks = await Chunk.findAll({
    attributes: {
      include: [
        [sequelize.literal(`1 - (embedding <=> '${vectorLiteral}'::vector)`), 'similarity'],
      ],
    },
    include: [{
      model: Document,
      as: 'document',
      attributes: ['caseName', 'fileName', 'documentType'],
      where: Object.keys(includeWhere).length > 0 ? includeWhere : undefined,
    }],
    where,
    order: sequelize.literal(`embedding <=> '${vectorLiteral}'::vector`),
    limit: topK,
    raw: false,
    nest: true,
  });

  return chunks.map(_mapChunkToResult);
}

/**
 * Full-text keyword search using PostgreSQL tsvector.
 * @param {string} query
 * @param {number} topK
 * @param {string} [caseName]
 * @param {string} [documentType]
 * @returns {Promise<RetrievedChunk[]>}
 */
async function keywordSearch(query, topK, caseName, documentType) {
  const STOP_WORDS = new Set([
    'the', 'and', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'whom',
    'this', 'that', 'these', 'those', 'have', 'has', 'had', 'been', 'being',
    'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
    'did', 'does', 'done', 'say', 'said', 'his', 'her', 'its', 'our', 'your',
    'they', 'them', 'their', 'are', 'for', 'from', 'with', 'about', 'into',
    'how', 'all', 'any', 'but', 'not', 'you', 'she', 'him', 'also', 'just',
    'get', 'got', 'give', 'gave', 'make', 'made', 'take', 'took', 'come',
    'tell', 'told', 'know', 'knew', 'think', 'thought', 'see', 'saw',
    'complete', 'please', 'show', 'find', 'list', 'summarize', 'explain',
  ]);

  const words = query
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));

  if (words.length === 0) {
    /* If all words were stop words, use original query with plainto_tsquery */
    const tsvector = sequelize.fn('to_tsvector', 'english', sequelize.col('Chunk.chunk_text'));
    const tsquery = sequelize.fn('plainto_tsquery', 'english', query);
    const rank = sequelize.fn('ts_rank', tsvector, tsquery);
    const where = sequelize.where(tsvector, '@@', tsquery);
    const includeWhere = _buildIncludeWhere(caseName, documentType);

    const chunks = await Chunk.findAll({
      attributes: { include: [[rank, 'rank']] },
      include: [{ model: Document, as: 'document', attributes: ['caseName', 'fileName', 'documentType'], where: Object.keys(includeWhere).length > 0 ? includeWhere : undefined }],
      where, order: [[sequelize.literal('rank'), 'DESC']], limit: topK, raw: false, nest: true,
    });

    return chunks.map((c, idx) => {
      const result = _mapChunkToResult(c);
      result.similarity = Math.min(0.75, Math.max(0.4, 0.75 - (idx * 0.03)));
      return result;
    });
  }

  const orQuery = words.map((w) => w.toLowerCase()).join(' | ');

  const tsvector = sequelize.fn('to_tsvector', 'english', sequelize.col('Chunk.chunk_text'));
  const tsquery = sequelize.fn('to_tsquery', 'english', orQuery);
  const rank = sequelize.fn('ts_rank', tsvector, tsquery);

  const where = sequelize.where(tsvector, '@@', tsquery);
  const includeWhere = _buildIncludeWhere(caseName, documentType);

  const chunks = await Chunk.findAll({
    attributes: {
      include: [[rank, 'rank']],
    },
    include: [{
      model: Document,
      as: 'document',
      attributes: ['caseName', 'fileName', 'documentType'],
      where: Object.keys(includeWhere).length > 0 ? includeWhere : undefined,
    }],
    where,
    order: [[sequelize.literal('rank'), 'DESC']],
    limit: topK,
    raw: false,
    nest: true,
  });

  return chunks.map((c, idx) => {
    const result = _mapChunkToResult(c);
    /* Cap keyword-only scores at 0.75 — they're not real vector similarity */
    result.similarity = Math.min(0.75, Math.max(0.4, 0.75 - (idx * 0.03)));
    return result;
  });
}

/**
 * Build where clause for Document include.
 * @param {string} [caseName]
 * @param {string} [documentType]
 * @returns {Object}
 * @private
 */
function _buildIncludeWhere(caseName, documentType) {
  const where = {};
  if (caseName) where.caseName = { [Op.iLike]: `%${caseName}%` };
  if (documentType) where.documentType = documentType;
  return where;
}

/**
 * Merge vector and keyword results using Reciprocal Rank Fusion.
 * @param {RetrievedChunk[]} vectorResults
 * @param {RetrievedChunk[]} keywordResults
 * @param {number} topK
 * @returns {RetrievedChunk[]}
 * @private
 */
function _mergeResults(vectorResults, keywordResults, topK) {
  const scoreMap = new Map();

  _addRrfScores(scoreMap, vectorResults);
  _addRrfScores(scoreMap, keywordResults);

  const merged = Array.from(scoreMap.values());
  merged.sort((a, b) => b.similarity - a.similarity);

  return merged.slice(0, topK);
}

/**
 * Add RRF scores for a set of ranked results.
 * @param {Map} scoreMap
 * @param {RetrievedChunk[]} results
 * @private
 */
function _addRrfScores(scoreMap, results) {
  results.forEach((chunk, rank) => {
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(chunk.chunkId);

    if (existing) {
      existing.similarity += rrfScore;
    } else {
      scoreMap.set(chunk.chunkId, { ...chunk, similarity: rrfScore });
    }
  });
}

/**
 * Map a Sequelize Chunk instance to a RetrievedChunk plain object.
 * @param {Object} chunk
 * @returns {RetrievedChunk}
 * @private
 */
function _mapChunkToResult(chunk) {
  const plain = chunk.get ? chunk.get({ plain: true }) : chunk;

  return {
    chunkId: plain.id,
    documentId: plain.documentId || plain.document_id,
    text: plain.chunkText || plain.chunk_text,
    section: plain.section || 'general',
    pageNumber: plain.pageNumber || plain.page_number,
    similarity: parseFloat(plain.similarity) || 0,
    caseName: plain.document?.caseName || plain.document?.case_name || '',
    fileName: plain.document?.fileName || plain.document?.file_name || '',
    documentType: plain.document?.documentType || plain.document?.document_type || null,
    metadata: plain.metadataJson || plain.metadata_json || {},
  };
}

module.exports = { search, vectorSearch, keywordSearch };
