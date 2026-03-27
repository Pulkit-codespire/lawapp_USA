/**
 * @module services/ingestion/textExtractor
 * @description Extracts text from DOCX, PDF (digital), scanned PDFs, and images.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');
const { FILE_TYPES } = require('../../utils/constants');
const { ExtractionError } = require('../../utils/errors');
const fileDetector = require('./fileDetector');

/**
 * @typedef {Object} ExtractionResult
 * @property {string} text - Extracted text content
 * @property {number} totalPages - Number of pages
 * @property {string} extractionMethod - Method used (mammoth, pdf-parse, tesseract)
 * @property {string} fileType - Detected file type
 * @property {boolean} success - Whether extraction succeeded
 * @property {string|null} error - Error message if failed
 */

/**
 * Extract text from a file, routing to the appropriate extractor.
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<ExtractionResult>}
 */
async function extract(filePath) {
  const fileType = await fileDetector.detect(filePath);
  const fileName = path.basename(filePath);

  logger.info(`Extracting text from ${fileName} (type: ${fileType})`);

  const extractors = {
    [FILE_TYPES.DOCX]: _extractDocx,
    [FILE_TYPES.PDF_DIGITAL]: _extractPdfDigital,
    [FILE_TYPES.PDF_SCANNED]: _extractPdfScanned,
    [FILE_TYPES.IMAGE]: _extractImage,
  };

  const extractor = extractors[fileType];
  if (!extractor) {
    return _failResult(fileType, `Unsupported file type: ${fileType}`);
  }

  try {
    return await extractor(filePath, fileType);
  } catch (err) {
    logger.error(`Extraction failed for ${fileName}: ${err.message}`);
    return _failResult(fileType, err.message);
  }
}

/**
 * Extract text from a DOCX file using mammoth.
 * @param {string} filePath
 * @param {string} fileType
 * @returns {Promise<ExtractionResult>}
 * @private
 */
async function _extractDocx(filePath, fileType) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value || '';

  return {
    text,
    totalPages: Math.max(1, Math.ceil(text.length / 3000)),
    extractionMethod: 'mammoth',
    fileType,
    success: true,
    error: null,
  };
}

/**
 * Extract text from a digital PDF using pdf-parse.
 * @param {string} filePath
 * @param {string} fileType
 * @returns {Promise<ExtractionResult>}
 * @private
 */
async function _extractPdfDigital(filePath, fileType) {
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);

  return {
    text: data.text || '',
    totalPages: data.numpages || 1,
    extractionMethod: 'pdf-parse',
    fileType,
    success: true,
    error: null,
  };
}

/**
 * Extract text from a scanned PDF using OCR.
 * @param {string} filePath
 * @param {string} fileType
 * @returns {Promise<ExtractionResult>}
 * @private
 */
async function _extractPdfScanned(filePath, fileType) {
  const ocrProcessor = require('./ocrProcessor');
  const { text, totalPages } = await ocrProcessor.processScannedPdf(filePath);

  return {
    text,
    totalPages,
    extractionMethod: 'tesseract_ocr',
    fileType,
    success: true,
    error: null,
  };
}

/**
 * Extract text from an image using OCR.
 * @param {string} filePath
 * @param {string} fileType
 * @returns {Promise<ExtractionResult>}
 * @private
 */
async function _extractImage(filePath, fileType) {
  const ocrProcessor = require('./ocrProcessor');
  const { text } = await ocrProcessor.processImage(filePath);

  return {
    text,
    totalPages: 1,
    extractionMethod: 'tesseract_ocr',
    fileType,
    success: true,
    error: null,
  };
}

/**
 * Build a failed extraction result.
 * @param {string} fileType
 * @param {string} errorMsg
 * @returns {ExtractionResult}
 * @private
 */
function _failResult(fileType, errorMsg) {
  return {
    text: '',
    totalPages: 0,
    extractionMethod: 'none',
    fileType,
    success: false,
    error: errorMsg,
  };
}

module.exports = { extract };
