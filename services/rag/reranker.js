/**
 * @module services/rag/reranker
 * @description Heuristic re-ranking of retrieved chunks based on multiple factors.
 */

const config = require('../../config');
const logger = require('../../config/logger');
const {
  SECTION_KEYWORDS,
  SECTION_BOOST,
  KEYWORD_BOOST,
  MIN_KEYWORD_LENGTH,
  SHORT_CHUNK_THRESHOLDS,
  METADATA_BONUS,
} = require('../../utils/constants');

/**
 * Re-rank retrieved chunks using multi-factor heuristic scoring.
 * @param {Array} chunks - Retrieved chunks with similarity scores
 * @param {string} query - Original search query
 * @param {number} [topK] - Number of results to return
 * @returns {Array} Re-ranked chunks
 */
function rerank(chunks, query, topK) {
  const limit = topK || config.rag.rerankTopK;

  if (!chunks || chunks.length === 0) {
    return [];
  }

  const scored = chunks.map((chunk) => ({
    ...chunk,
    similarity: _calculateScore(chunk, query),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  const result = scored.slice(0, limit);

  logger.debug(`Reranked: ${chunks.length} → top ${result.length}`);
  return result;
}

/**
 * Calculate the final score for a chunk.
 * @param {Object} chunk
 * @param {string} query
 * @returns {number}
 * @private
 */
function _calculateScore(chunk, query) {
  let score = chunk.similarity || 0;

  score += _sectionRelevanceBoost(chunk.section, query);
  score *= _contentLengthPenalty(chunk.text);
  score += _metadataBonus(chunk.metadata);
  score += _keywordMatchBoost(chunk.text, query);

  return score;
}

/**
 * Boost score if the chunk's section matches query keywords.
 * @param {string} section
 * @param {string} query
 * @returns {number}
 * @private
 */
function _sectionRelevanceBoost(section, query) {
  if (!section || !query) return 0;

  const keywords = SECTION_KEYWORDS[section] || [];
  const queryLower = query.toLowerCase();
  const hasMatch = keywords.some((kw) => queryLower.includes(kw));

  return hasMatch ? SECTION_BOOST : 0;
}

/**
 * Penalize very short chunks.
 * @param {string} text
 * @returns {number} Multiplier (0.5 to 1.0)
 * @private
 */
function _contentLengthPenalty(text) {
  if (!text) return SHORT_CHUNK_THRESHOLDS.VERY_SHORT_PENALTY;

  const len = text.length;
  if (len < SHORT_CHUNK_THRESHOLDS.VERY_SHORT) return SHORT_CHUNK_THRESHOLDS.VERY_SHORT_PENALTY;
  if (len < SHORT_CHUNK_THRESHOLDS.SHORT) return SHORT_CHUNK_THRESHOLDS.SHORT_PENALTY;

  return 1.0;
}

/**
 * Small bonus for chunks with rich metadata.
 * @param {Object} metadata
 * @returns {number}
 * @private
 */
function _metadataBonus(metadata) {
  return metadata && Object.keys(metadata).length > 0 ? METADATA_BONUS : 0;
}

/**
 * Boost score for exact keyword matches in chunk text.
 * @param {string} text
 * @param {string} query
 * @returns {number}
 * @private
 */
function _keywordMatchBoost(text, query) {
  if (!text || !query) return 0;

  const textLower = text.toLowerCase();
  const queryWords = query.toLowerCase().split(/\s+/)
    .filter((w) => w.length > MIN_KEYWORD_LENGTH);

  const matches = queryWords.filter((w) => textLower.includes(w)).length;
  return matches * KEYWORD_BOOST;
}

module.exports = { rerank };
