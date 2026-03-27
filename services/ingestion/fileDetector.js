/**
 * @module services/ingestion/fileDetector
 * @description Detects file type (DOCX, digital PDF, scanned PDF, image).
 */

const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger');
const {
  FILE_TYPES,
  SUPPORTED_EXTENSIONS,
  ALL_SUPPORTED_EXTENSIONS,
  MIN_CHARS_PER_PAGE,
  DIGITAL_PDF_PAGE_THRESHOLD,
} = require('../../utils/constants');

/**
 * Detect the file type of a given file.
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<string>} One of FILE_TYPES values
 */
async function detect(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (!ALL_SUPPORTED_EXTENSIONS.has(ext)) {
    return FILE_TYPES.UNKNOWN;
  }

  if (SUPPORTED_EXTENSIONS.DOCX.has(ext)) {
    return FILE_TYPES.DOCX;
  }

  if (SUPPORTED_EXTENSIONS.IMAGE.has(ext)) {
    return FILE_TYPES.IMAGE;
  }

  if (SUPPORTED_EXTENSIONS.PDF.has(ext)) {
    return _detectPdfType(filePath);
  }

  return FILE_TYPES.UNKNOWN;
}

/**
 * Check if a file extension is supported.
 * @param {string} filePath - Path to check
 * @returns {boolean}
 */
function isSupported(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ALL_SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Detect whether a PDF is digital (has selectable text) or scanned.
 * @param {string} filePath - Path to the PDF
 * @returns {Promise<string>} PDF_DIGITAL or PDF_SCANNED
 * @private
 */
async function _detectPdfType(filePath) {
  try {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);

    const totalPages = data.numpages || 1;
    const totalChars = (data.text || '').length;
    const avgCharsPerPage = totalChars / totalPages;

    if (avgCharsPerPage >= MIN_CHARS_PER_PAGE * DIGITAL_PDF_PAGE_THRESHOLD) {
      logger.debug(`PDF detected as digital: ${path.basename(filePath)} (${avgCharsPerPage} avg chars/page)`);
      return FILE_TYPES.PDF_DIGITAL;
    }

    logger.debug(`PDF detected as scanned: ${path.basename(filePath)} (${avgCharsPerPage} avg chars/page)`);
    return FILE_TYPES.PDF_SCANNED;
  } catch (err) {
    logger.warn(`PDF detection failed for ${filePath}, assuming scanned: ${err.message}`);
    return FILE_TYPES.PDF_SCANNED;
  }
}

module.exports = { detect, isSupported };
