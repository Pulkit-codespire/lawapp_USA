/**
 * @module services/antiHallucination/retrievalGate
 * @description First defense against hallucination — blocks answers when no relevant data found.
 */

const config = require('../../config');
const logger = require('../../config/logger');

/**
 * @typedef {Object} GateResult
 * @property {boolean} passed - Whether the gate allows answer generation
 * @property {string} reason - Explanation
 * @property {number} numChunks - Number of relevant chunks
 * @property {number} avgSimilarity - Average similarity score
 * @property {number} maxSimilarity - Best similarity score
 */

/**
 * Check if retrieved chunks are sufficient to generate a grounded answer.
 * @param {Array} chunks - Retrieved chunks with similarity scores
 * @returns {GateResult}
 */
function check(chunks) {
  if (!chunks || chunks.length === 0) {
    logger.warn('Retrieval gate: BLOCKED — no chunks found');
    return _blocked('No relevant documents found in your case files.');
  }

  const { similarityThreshold } = config.rag;
  const relevantChunks = chunks.filter((c) => c.similarity >= similarityThreshold);
  const avgSimilarity = _average(chunks.map((c) => c.similarity));
  const maxSimilarity = Math.max(...chunks.map((c) => c.similarity));

  if (relevantChunks.length === 0) {
    logger.warn(`Retrieval gate: BLOCKED — all chunks below threshold (max: ${maxSimilarity.toFixed(3)})`);
    return {
      passed: false,
      reason: 'Some documents were found but relevance is too low to provide a reliable answer.',
      numChunks: 0,
      avgSimilarity,
      maxSimilarity,
    };
  }

  logger.info(`Retrieval gate: PASSED — ${relevantChunks.length} relevant chunks (avg: ${avgSimilarity.toFixed(3)})`);
  return {
    passed: true,
    reason: `Found ${relevantChunks.length} relevant document(s).`,
    numChunks: relevantChunks.length,
    avgSimilarity,
    maxSimilarity,
  };
}

/**
 * Generate a user-friendly response when no data is found.
 * @param {string} query - The user's original question
 * @returns {string}
 */
function getNoDataResponse(query) {
  return `I could not find relevant information about "${query}" in your case files.\n\n` +
    'Suggestions:\n' +
    '- Try rephrasing your question\n' +
    '- Check if the relevant documents have been uploaded\n' +
    '- Try searching for specific case names or section numbers\n' +
    '- Use the search page to browse available documents';
}

/**
 * Build a blocked gate result.
 * @param {string} reason
 * @returns {GateResult}
 * @private
 */
function _blocked(reason) {
  return { passed: false, reason, numChunks: 0, avgSimilarity: 0, maxSimilarity: 0 };
}

/**
 * Calculate average of an array of numbers.
 * @param {number[]} arr
 * @returns {number}
 * @private
 */
function _average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

module.exports = { check, getNoDataResponse };
