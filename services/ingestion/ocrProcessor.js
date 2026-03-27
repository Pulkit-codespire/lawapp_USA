/**
 * @module services/ingestion/ocrProcessor
 * @description Tesseract.js OCR for scanned PDFs and images.
 * Converts PDF pages to images before OCR since Tesseract cannot read PDFs directly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWorker } = require('tesseract.js');
const logger = require('../../config/logger');
const { ExtractionError } = require('../../utils/errors');

/**
 * Process a scanned PDF by converting each page to an image and running OCR.
 * @param {string} filePath - Path to scanned PDF
 * @returns {Promise<{text: string, totalPages: number}>}
 */
async function processScannedPdf(filePath) {
  logger.info(`OCR processing scanned PDF: ${filePath}`);

  try {
    const { convert } = await import('pdf-to-img');
    const pageTexts = [];
    let pageNum = 0;

    const pdfBuffer = fs.readFileSync(filePath);
    const pages = await convert(pdfBuffer, { scale: 2.0 });

    const worker = await createWorker('eng');

    try {
      for await (const pageImage of pages) {
        pageNum++;
        logger.debug(`OCR processing page ${pageNum}...`);

        /* Save page image to temp file */
        const tempImagePath = path.join(os.tmpdir(), `lawapp-ocr-page-${Date.now()}-${pageNum}.png`);
        fs.writeFileSync(tempImagePath, pageImage);

        try {
          const { data: { text } } = await worker.recognize(tempImagePath);
          if (text && text.trim().length > 0) {
            pageTexts.push(text.trim());
          }
        } finally {
          _cleanupFile(tempImagePath);
        }
      }
    } finally {
      await worker.terminate();
    }

    const fullText = pageTexts.join('\n\n');
    logger.info(`OCR extracted ${fullText.length} chars from ${pageNum} pages`);

    return { text: fullText, totalPages: pageNum };
  } catch (err) {
    throw new ExtractionError(`OCR failed for scanned PDF: ${err.message}`);
  }
}

/**
 * Process a single image file with OCR.
 * @param {string} filePath - Path to image file
 * @returns {Promise<{text: string, totalPages: number}>}
 */
async function processImage(filePath) {
  logger.info(`OCR processing image: ${filePath}`);

  try {
    const text = await _runOcrOnImage(filePath);
    logger.info(`OCR extracted ${text.length} chars from image`);
    return { text, totalPages: 1 };
  } catch (err) {
    throw new ExtractionError(`OCR failed for image: ${err.message}`);
  }
}

/**
 * Run Tesseract OCR on an image file.
 * @param {string} imagePath - Path to image file (PNG, JPG, etc.)
 * @returns {Promise<string>} Extracted text
 * @private
 */
async function _runOcrOnImage(imagePath) {
  const worker = await createWorker('eng');

  try {
    const { data: { text } } = await worker.recognize(imagePath);
    return text || '';
  } finally {
    await worker.terminate();
  }
}

/**
 * Safely delete a temporary file.
 * @param {string} filePath
 * @private
 */
function _cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    logger.warn(`Failed to cleanup temp file ${filePath}: ${err.message}`);
  }
}

/**
 * Check if tesseract.js is available.
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  try {
    require.resolve('tesseract.js');
    return true;
  } catch {
    return false;
  }
}

module.exports = { processScannedPdf, processImage, isAvailable };
