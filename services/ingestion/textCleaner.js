/**
 * @module services/ingestion/textCleaner
 * @description Cleans extracted text — removes OCR artifacts, headers/footers, normalizes whitespace.
 */

const logger = require('../../config/logger');
const { OCR_ARTIFACT_PATTERNS, HEADER_FOOTER_PATTERNS } = require('../../utils/constants');

/**
 * Clean extracted text through multiple passes.
 * @param {string} text - Raw extracted text
 * @returns {string} Cleaned text
 */
function clean(text) {
  if (!text || text.trim().length === 0) {
    return '';
  }

  const originalLength = text.length;

  let cleaned = text;
  cleaned = _fixEncoding(cleaned);
  cleaned = _removeOcrArtifacts(cleaned);
  cleaned = _removeHeadersFooters(cleaned);
  cleaned = _normalizeWhitespace(cleaned);
  cleaned = _fixLegalOcrErrors(cleaned);
  cleaned = _removeNoiseLines(cleaned);

  logger.debug(`Text cleaned: ${originalLength} → ${cleaned.length} chars`);
  return cleaned.trim();
}

/**
 * Fix common encoding issues (smart quotes, dashes, etc.).
 * @param {string} text
 * @returns {string}
 * @private
 */
function _fixEncoding(text) {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
}

/**
 * Remove OCR-specific artifacts (pipes, underscores, equals, etc.).
 * @param {string} text
 * @returns {string}
 * @private
 */
function _removeOcrArtifacts(text) {
  let result = text;
  for (const pattern of OCR_ARTIFACT_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

/**
 * Remove common headers and footers (page numbers, confidential marks).
 * @param {string} text
 * @returns {string}
 * @private
 */
function _removeHeadersFooters(text) {
  let result = text;
  for (const pattern of HEADER_FOOTER_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result;
}

/**
 * Normalize whitespace — collapse multiple spaces/newlines.
 * @param {string} text
 * @returns {string}
 * @private
 */
function _normalizeWhitespace(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\s+$/gm, '');
}

/**
 * Fix common OCR errors in legal text.
 * @param {string} text
 * @returns {string}
 * @private
 */
function _fixLegalOcrErrors(text) {
  return text
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']');
}

/**
 * Remove noise lines (very short lines that are likely garbage).
 * @param {string} text
 * @returns {string}
 * @private
 */
function _removeNoiseLines(text) {
  const MIN_LINE_LENGTH = 3;
  return text
    .split('\n')
    .filter((line) => line.trim().length === 0 || line.trim().length >= MIN_LINE_LENGTH)
    .join('\n');
}

module.exports = { clean };
