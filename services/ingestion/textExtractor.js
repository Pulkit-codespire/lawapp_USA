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
 * Uses convertToHtml for full content extraction (captures text boxes, footnotes, etc.)
 * then falls back to extractRawText. Uses whichever yields more content.
 * @param {string} filePath
 * @param {string} fileType
 * @returns {Promise<ExtractionResult>}
 * @private
 */
async function _extractDocx(filePath, fileType) {
  const mammoth = require('mammoth');

  /* Try both extraction methods and use the one that produces more text */
  const [rawResult, htmlResult] = await Promise.all([
    mammoth.extractRawText({ path: filePath }),
    mammoth.convertToHtml({ path: filePath }),
  ]);

  const rawText = rawResult.value || '';

  /* Strip HTML tags to get plain text from the HTML conversion */
  let htmlText = '';
  if (htmlResult.value) {
    htmlText = htmlResult.value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/td>/gi, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* Use whichever method extracted more content */
  const text = htmlText.length > rawText.length ? htmlText : rawText;

  if (htmlText.length > rawText.length) {
    logger.info(`DOCX: HTML extraction yielded more content (${htmlText.length} vs ${rawText.length} chars)`);
  }

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
 * Extracts per-page text with page markers so the chunker can track page numbers.
 * @param {string} filePath
 * @param {string} fileType
 * @returns {Promise<ExtractionResult>}
 * @private
 */
async function _extractPdfDigital(filePath, fileType) {
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);

  /* Custom page renderer to capture per-page text with markers */
  const pageTexts = [];
  const options = {
    pagerender: async function (pageData) {
      const textContent = await pageData.getTextContent();
      const strings = textContent.items.map((item) => item.str);
      return strings.join(' ');
    },
  };

  const data = await pdfParse(buffer, options);
  const totalPages = data.numpages || 1;

  /*
   * pdf-parse concatenates all pages into data.text.
   * To get per-page text, we re-parse with a page-collecting renderer.
   */
  let textWithPages = '';
  try {
    const perPageOptions = {
      pagerender: async function (pageData) {
        const textContent = await pageData.getTextContent();
        const strings = textContent.items.map((item) => item.str);
        const pageText = strings.join(' ').trim();
        pageTexts.push(pageText);
        return pageText;
      },
    };
    await pdfParse(buffer, perPageOptions);

    if (pageTexts.length > 1) {
      textWithPages = pageTexts
        .map((text, idx) => `--- Page ${idx + 1} ---\n${text}`)
        .join('\n\n');
    } else {
      textWithPages = data.text || '';
    }
  } catch {
    /* Fallback to plain text if per-page extraction fails */
    textWithPages = data.text || '';
  }

  return {
    text: textWithPages,
    totalPages,
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
