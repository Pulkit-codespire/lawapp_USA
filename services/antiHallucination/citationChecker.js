/**
 * @module services/antiHallucination/citationChecker
 * @description Verifies that AI-generated claims are grounded in source documents.
 */

const logger = require('../../config/logger');
const { HALLUCINATION_PHRASES } = require('../../utils/constants');

/** Minimum percentage of key terms that must match source text */
const CLAIM_MATCH_THRESHOLD = 0.5;

/**
 * @typedef {Object} CitationResult
 * @property {boolean} isGrounded
 * @property {number} verifiedClaims
 * @property {number} unverifiedClaims
 * @property {string[]} warnings
 */

/**
 * Verify that the answer's claims are grounded in the source chunks.
 * @param {string} answer - AI-generated answer
 * @param {Array} chunks - Source chunks used for generation
 * @returns {CitationResult}
 */
function verify(answer, chunks) {
  const warnings = [];
  const sourceText = chunks.map((c) => c.text).join(' ').toLowerCase();
  const sourceFiles = new Set(chunks.map((c) => c.fileName.toLowerCase()));

  const mentionedFiles = _extractMentionedFiles(answer);
  _checkFileReferences(mentionedFiles, sourceFiles, warnings);

  const claims = _extractClaims(answer);
  const { verified, unverified } = _checkClaims(claims, sourceText);

  _checkHallucinationPhrases(answer, warnings);

  const isGrounded = unverified === 0 && warnings.length === 0;
  logger.debug(`Citation check: ${verified} verified, ${unverified} unverified, ${warnings.length} warnings`);

  return { isGrounded, verifiedClaims: verified, unverifiedClaims: unverified, warnings };
}

/**
 * Extract file names mentioned in the answer.
 * @param {string} answer
 * @returns {string[]}
 * @private
 */
function _extractMentionedFiles(answer) {
  const pattern = /[\w\-. ]+\.(?:pdf|docx?|txt|jpg|png)/gi;
  return (answer.match(pattern) || []).map((f) => f.toLowerCase());
}

/**
 * Check if mentioned files exist in actual sources.
 * @param {string[]} mentioned
 * @param {Set<string>} actual
 * @param {string[]} warnings
 * @private
 */
function _checkFileReferences(mentioned, actual, warnings) {
  for (const file of mentioned) {
    if (!actual.has(file)) {
      warnings.push(`Referenced file "${file}" not found in source documents`);
    }
  }
}

/**
 * Extract key claims from the answer (sentences with specific data points).
 * @param {string} answer
 * @returns {string[]}
 * @private
 */
function _extractClaims(answer) {
  const sentences = answer.match(/[^.!?]+[.!?]+/g) || [];

  return sentences.filter((s) => {
    return /\b\d{4}\b/.test(s) ||
      /section\s+\d+/i.test(s) ||
      /\$[\d,]+/.test(s) ||
      /justice\s+\w+/i.test(s) ||
      /judge\s+\w+/i.test(s);
  });
}

/**
 * Check if claims are supported by source text.
 * @param {string[]} claims
 * @param {string} sourceText
 * @returns {{verified: number, unverified: number}}
 * @private
 */
function _checkClaims(claims, sourceText) {
  let verified = 0;
  let unverified = 0;

  for (const claim of claims) {
    const keyTerms = claim.toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !/^(?:the|that|this|with|from|were|have|been|also)$/.test(w));

    const matchCount = keyTerms.filter((term) => sourceText.includes(term)).length;
    const matchRatio = keyTerms.length > 0 ? matchCount / keyTerms.length : 1;

    if (matchRatio >= CLAIM_MATCH_THRESHOLD) {
      verified++;
    } else {
      unverified++;
    }
  }

  return { verified, unverified };
}

/**
 * Check for hallucination indicator phrases.
 * @param {string} answer
 * @param {string[]} warnings
 * @private
 */
function _checkHallucinationPhrases(answer, warnings) {
  const lowerAnswer = answer.toLowerCase();

  for (const phrase of HALLUCINATION_PHRASES) {
    if (lowerAnswer.includes(phrase)) {
      warnings.push(`Answer contains hallucination indicator: "${phrase}"`);
    }
  }
}

module.exports = { verify };
