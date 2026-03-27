/**
 * @module services/ingestion/metadataExtractor
 * @description Extracts metadata from file paths and document content.
 */

const path = require('path');
const { DOCUMENT_TYPE_PATTERNS } = require('../../utils/constants');

/** Number of chars to scan for content metadata */
const CONTENT_SCAN_LENGTH = 3000;

/** Year range for extraction validation */
const MIN_YEAR = 1950;
const MAX_YEAR = 2030;

/**
 * @typedef {Object} DocumentMetadata
 * @property {string} caseName - Extracted case name
 * @property {string} caseFolder - Parent folder name
 * @property {string} fileName - File name
 * @property {string} filePath - Full file path
 * @property {string|null} documentType - Detected document type
 * @property {number|null} year - Extracted year
 * @property {Object} extra - Additional metadata (caseNumber, court, judge)
 */

/**
 * Extract metadata from file path and folder structure.
 * @param {string} filePath - Absolute path to file
 * @returns {DocumentMetadata}
 */
function extract(filePath) {
  const fileName = path.basename(filePath);
  const caseFolder = path.basename(path.dirname(filePath));

  return {
    caseName: _extractCaseName(caseFolder),
    caseFolder,
    fileName,
    filePath,
    documentType: _detectDocumentType(fileName),
    year: _extractYear(caseFolder) || _extractYear(fileName),
    extra: {},
  };
}

/**
 * Enhance metadata with information extracted from document content.
 * @param {string} text - Document text (first N chars scanned)
 * @param {DocumentMetadata} baseMetadata - Metadata from file path
 * @returns {DocumentMetadata} Enhanced metadata
 */
function extractFromContent(text, baseMetadata) {
  const scanText = text.slice(0, CONTENT_SCAN_LENGTH);
  const extra = { ...baseMetadata.extra };

  const caseNumber = _extractCaseNumber(scanText);
  if (caseNumber) extra.caseNumber = caseNumber;

  const court = _extractCourt(scanText);
  if (court) extra.court = court;

  const judge = _extractJudge(scanText);
  if (judge) extra.judge = judge;

  const year = baseMetadata.year || _extractYear(scanText);

  return { ...baseMetadata, year, extra };
}

/**
 * Extract case name from folder name.
 * @param {string} folderName
 * @returns {string}
 * @private
 */
function _extractCaseName(folderName) {
  return folderName
    .replace(/[_-]/g, ' ')
    .replace(/\b\d{4}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim() || folderName;
}

/**
 * Detect document type from file name.
 * @param {string} fileName
 * @returns {string|null}
 * @private
 */
function _detectDocumentType(fileName) {
  for (const { pattern, type } of DOCUMENT_TYPE_PATTERNS) {
    if (pattern.test(fileName)) {
      return type;
    }
  }
  return null;
}

/**
 * Extract a year (1950-2030) from text.
 * @param {string} text
 * @returns {number|null}
 * @private
 */
function _extractYear(text) {
  const match = text.match(/\b((?:19|20)\d{2})\b/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  return (year >= MIN_YEAR && year <= MAX_YEAR) ? year : null;
}

/**
 * Extract case number from content.
 * @param {string} text
 * @returns {string|null}
 * @private
 */
function _extractCaseNumber(text) {
  const patterns = [
    /case\s+no\.?\s*:?\s*([A-Z0-9\-/. ]+)/i,
    /cause\s+number\s*:?\s*([A-Z0-9\-/. ]+)/i,
    /criminal\s+case\s*:?\s*([A-Z0-9\-/. ]+)/i,
    /civil\s+suit\s*:?\s*([A-Z0-9\-/. ]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Extract court name from content.
 * @param {string} text
 * @returns {string|null}
 * @private
 */
function _extractCourt(text) {
  const patterns = [
    /(?:in\s+the\s+)?(supreme\s+court\s+of\s+[a-z ]+)/i,
    /(?:in\s+the\s+)?(high\s+court\s+of\s+[a-z ]+)/i,
    /(?:in\s+the\s+)?(district\s+court\s+of\s+[a-z ]+)/i,
    /(?:in\s+the\s+)?(court\s+of\s+[a-z ]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Extract judge name from content.
 * @param {string} text
 * @returns {string|null}
 * @private
 */
function _extractJudge(text) {
  const patterns = [
    /before\s+(?:hon\.?\s*)?justice\s+([a-z. ]+)/i,
    /(?:hon\.?\s*)?judge\s+([a-z. ]+)/i,
    /coram\s*:?\s*([a-z. ]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

module.exports = { extract, extractFromContent };
