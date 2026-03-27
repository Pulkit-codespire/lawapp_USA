/**
 * @module controllers/ingestController
 * @description Handles document ingestion — file upload, folder batch, and status.
 */

const fs = require('fs');
const path = require('path');
const { Document, Chunk, sequelize } = require('../models');
const textExtractor = require('../services/ingestion/textExtractor');
const textCleaner = require('../services/ingestion/textCleaner');
const chunker = require('../services/ingestion/chunker');
const metadataExtractor = require('../services/ingestion/metadataExtractor');
const fileDetector = require('../services/ingestion/fileDetector');
const embedder = require('../services/embedder');
const logger = require('../config/logger');
const { HTTP_STATUS } = require('../utils/constants');
const { ExtractionError } = require('../utils/errors');

/**
 * Handle single file upload and ingestion.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function postFile(req, res) {
  const file = req.file;
  if (!file) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'No file uploaded' });
  }

  const caseName = req.body.case_name;

  try {
    const result = await _processSingleFile(file.path, caseName, file.originalname);

    return res.status(HTTP_STATUS.CREATED).json({
      document_id: result.documentId,
      file_name: file.originalname,
      file_type: result.fileType,
      total_chunks: result.totalChunks,
      status: 'success',
      message: `File processed successfully: ${result.totalChunks} chunks created`,
    });
  } catch (err) {
    logger.error(`Ingestion failed for ${file.originalname}: ${err.message}`);
    return res.status(HTTP_STATUS.UNPROCESSABLE).json({
      error: 'Ingestion failed',
      message: err.message,
    });
  } finally {
    _cleanupTempFile(file.path);
  }
}

/**
 * Handle batch folder ingestion.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function postFolder(req, res) {
  const { folder_path: folderPath, case_name: caseName } = req.body;

  if (!fs.existsSync(folderPath)) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: `Folder not found: ${folderPath}` });
  }

  const files = _findSupportedFiles(folderPath);
  const results = [];
  let totalChunks = 0;

  for (const filePath of files) {
    try {
      const fileName = path.basename(filePath);
      const caseNameToUse = caseName || path.basename(path.dirname(filePath));
      const result = await _processSingleFile(filePath, caseNameToUse, fileName);
      totalChunks += result.totalChunks;
      results.push({ file: fileName, status: 'success', chunks: result.totalChunks });
    } catch (err) {
      results.push({ file: path.basename(filePath), status: 'error', error: err.message });
    }
  }

  const processed = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'error').length;

  return res.status(HTTP_STATUS.OK).json({
    case_name: caseName || path.basename(folderPath),
    total_files: files.length,
    processed,
    failed,
    total_chunks: totalChunks,
    results,
  });
}

/**
 * Get ingestion statistics.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getStatus(req, res) {
  const totalDocuments = await Document.count();
  const totalChunks = await Chunk.count();
  const processedDocuments = await Document.count({ where: { isProcessed: true } });
  const failedDocuments = await Document.count({
    where: { isProcessed: false, processingError: { [require('sequelize').Op.ne]: null } },
  });

  return res.status(HTTP_STATUS.OK).json({
    total_documents: totalDocuments,
    total_chunks: totalChunks,
    processed_documents: processedDocuments,
    failed_documents: failedDocuments,
  });
}

/**
 * Process a single file through the full ingestion pipeline.
 * @param {string} filePath
 * @param {string} caseName
 * @param {string} originalName
 * @returns {Promise<{documentId: string, fileType: string, totalChunks: number}>}
 * @private
 */
async function _processSingleFile(filePath, caseName, originalName) {
  return sequelize.transaction(async (transaction) => {
    /* Extract text */
    const extraction = await textExtractor.extract(filePath);
    if (!extraction.success) {
      throw new ExtractionError(extraction.error || 'Text extraction failed');
    }

    /* Clean text */
    const cleanedText = textCleaner.clean(extraction.text);
    if (cleanedText.length === 0) {
      throw new ExtractionError('No text content after cleaning');
    }

    /* Extract metadata */
    let metadata = metadataExtractor.extract(filePath);
    metadata = metadataExtractor.extractFromContent(cleanedText, metadata);
    metadata.caseName = caseName || metadata.caseName;

    /* Chunk text */
    const chunks = chunker.chunk(cleanedText);
    if (chunks.length === 0) {
      throw new ExtractionError('No chunks produced from text');
    }

    /* Generate embeddings */
    const texts = chunks.map((c) => c.text);
    const embeddings = await embedder.embedBatch(texts, true);

    /* Save document */
    const document = await Document.create({
      caseName: metadata.caseName,
      caseFolder: metadata.caseFolder,
      fileName: originalName,
      filePath,
      fileType: extraction.fileType,
      documentType: metadata.documentType,
      totalPages: extraction.totalPages,
      totalChunks: chunks.length,
      extractionMethod: extraction.extractionMethod,
      isProcessed: true,
    }, { transaction });

    /* Save chunks with embeddings */
    const chunkRecords = chunks.map((c, idx) => ({
      documentId: document.id,
      chunkText: c.text,
      chunkIndex: c.chunkIndex,
      tokenCount: c.tokenCount,
      section: c.section,
      pageNumber: c.pageNumber,
      embedding: embeddings[idx],
      metadataJson: metadata.extra,
    }));

    await Chunk.bulkCreate(chunkRecords, { transaction });

    return { documentId: document.id, fileType: extraction.fileType, totalChunks: chunks.length };
  });
}

/**
 * Find all supported files in a directory recursively.
 * @param {string} dirPath
 * @returns {string[]}
 * @private
 */
function _findSupportedFiles(dirPath) {
  const files = [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(..._findSupportedFiles(fullPath));
    } else if (fileDetector.isSupported(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Clean up temporary uploaded file.
 * @param {string} filePath
 * @private
 */
function _cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    logger.warn(`Failed to cleanup temp file ${filePath}: ${err.message}`);
  }
}

module.exports = { postFile, postFolder, getStatus };
