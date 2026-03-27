/**
 * @module services/antiHallucination/confidenceScorer
 * @description Multi-factor weighted confidence scoring for RAG answers.
 */

const logger = require('../../config/logger');
const { CONFIDENCE_THRESHOLDS, CONFIDENCE_WEIGHTS } = require('../../utils/constants');

/** Maximum chunk count factor cap */
const MAX_CHUNK_FACTOR = 5;

/** Maximum source diversity factor cap */
const MAX_SOURCE_FACTOR = 3;

/** Maximum section coverage factor cap */
const MAX_SECTION_FACTOR = 2;

/** Citation warning penalty multiplier */
const CITATION_WARNING_PENALTY = 0.8;

/**
 * @typedef {Object} ConfidenceResult
 * @property {string} level - high, medium, low, or none
 * @property {number} score - 0.0 to 1.0
 * @property {string} reason
 * @property {Object} factors
 */

/**
 * Score confidence based on multiple weighted factors.
 * @param {Array} chunks - Retrieved chunks
 * @param {Object} citationResult - Result from CitationChecker
 * @param {string} answer - Generated answer
 * @returns {ConfidenceResult}
 */
function score(chunks, citationResult, answer) {
  const factors = _calculateFactors(chunks, citationResult);
  const weightedScore = _calculateWeightedScore(factors);
  const { level, reason } = _getLevelAndReason(weightedScore);

  logger.debug(`Confidence score: ${weightedScore.toFixed(3)} → ${level}`);

  return { level, score: Math.round(weightedScore * 100) / 100, reason, factors };
}

/**
 * Calculate individual scoring factors.
 * @param {Array} chunks
 * @param {Object} citationResult
 * @returns {Object}
 * @private
 */
function _calculateFactors(chunks, citationResult) {
  const similarities = chunks.map((c) => c.similarity);
  const uniqueFiles = new Set(chunks.map((c) => c.fileName));
  const uniqueSections = new Set(chunks.map((c) => c.section));

  const factors = {
    chunkCount: Math.min(chunks.length / MAX_CHUNK_FACTOR, 1.0),
    avgSimilarity: similarities.length > 0
      ? similarities.reduce((a, b) => a + b, 0) / similarities.length
      : 0,
    maxSimilarity: similarities.length > 0 ? Math.max(...similarities) : 0,
    sourceDiversity: Math.min(uniqueFiles.size / MAX_SOURCE_FACTOR, 1.0),
    sectionCoverage: Math.min(uniqueSections.size / MAX_SECTION_FACTOR, 1.0),
  };

  if (citationResult) {
    const total = citationResult.verifiedClaims + citationResult.unverifiedClaims;
    let citationFactor = total > 0 ? citationResult.verifiedClaims / total : 1.0;

    if (citationResult.warnings && citationResult.warnings.length > 0) {
      citationFactor *= CITATION_WARNING_PENALTY;
    }
    factors.citationCheck = citationFactor;
  }

  return factors;
}

/**
 * Calculate weighted average score from factors.
 * @param {Object} factors
 * @returns {number}
 * @private
 */
function _calculateWeightedScore(factors) {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const [key, weight] of Object.entries(CONFIDENCE_WEIGHTS)) {
    if (factors[key] !== undefined) {
      weightedSum += factors[key] * weight;
      totalWeight += weight;
    }
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Map score to confidence level and reason.
 * @param {number} weightedScore
 * @returns {{level: string, reason: string}}
 * @private
 */
function _getLevelAndReason(weightedScore) {
  if (weightedScore >= CONFIDENCE_THRESHOLDS.HIGH) {
    return { level: 'high', reason: 'Multiple highly relevant documents support this answer.' };
  }
  if (weightedScore >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    return { level: 'medium', reason: 'Relevant documents found but coverage is moderate. Verify key details.' };
  }
  if (weightedScore >= CONFIDENCE_THRESHOLDS.LOW) {
    return { level: 'low', reason: 'Limited relevant data found. Please verify in original documents.' };
  }

  return { level: 'low', reason: 'Very limited data. Please verify carefully against original documents.' };
}

module.exports = { score };
