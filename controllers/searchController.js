/**
 * @module controllers/searchController
 * @description Handles search, document listing, and case listing endpoints.
 */

const { Op } = require('sequelize');
const { Document, Chunk, sequelize } = require('../models');
const retriever = require('../services/rag/retriever');
const logger = require('../config/logger');
const { HTTP_STATUS, SNIPPET_MAX_LENGTH } = require('../utils/constants');

/** Default pagination values */
const DEFAULT_SKIP = 0;
const DEFAULT_LIMIT = 50;

/**
 * Hybrid search across documents.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function searchDocuments(req, res) {
  const { q: query, case_name: caseName, document_type: documentType, top_k: topK } = req.query;

  logger.info(`Search: "${query}" (case: ${caseName || 'all'}, topK: ${topK || 'default'})`);

  const results = await retriever.search(query, { topK, caseName, documentType });

  const formatted = results.map((r) => ({
    chunk_text: r.text.slice(0, SNIPPET_MAX_LENGTH),
    case_name: r.caseName,
    file_name: r.fileName,
    document_type: r.documentType,
    section: r.section,
    page_number: r.pageNumber,
    relevance_score: Math.round(r.similarity * 100) / 100,
  }));

  return res.status(HTTP_STATUS.OK).json({
    query,
    total_results: formatted.length,
    results: formatted,
  });
}

/**
 * List ingested documents with optional filters and pagination.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function listDocuments(req, res) {
  const {
    case_name: caseName,
    file_type: fileType,
    skip = DEFAULT_SKIP,
    limit = DEFAULT_LIMIT,
  } = req.query;

  const where = {};
  if (caseName) where.caseName = { [Op.iLike]: `%${caseName}%` };
  if (fileType) where.fileType = fileType;

  const { count, rows } = await Document.findAndCountAll({
    where,
    offset: parseInt(skip, 10),
    limit: parseInt(limit, 10),
    order: [['ingested_at', 'DESC']],
    attributes: ['id', 'caseName', 'fileName', 'filePath', 'fileType', 'documentType', 'totalChunks', 'isProcessed'],
  });

  return res.status(HTTP_STATUS.OK).json({
    total: count,
    documents: rows.map((d) => ({
      id: d.id,
      case_name: d.caseName,
      file_name: d.fileName,
      file_type: d.fileType,
      document_type: d.documentType,
      total_chunks: d.totalChunks,
      is_processed: d.isProcessed,
      source: d.filePath?.startsWith('gdrive://') ? 'google_drive' : 'upload',
    })),
  });
}

/**
 * List all unique cases with document and chunk counts.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function listCases(req, res) {
  const cases = await Document.findAll({
    attributes: [
      'caseName',
      [sequelize.fn('COUNT', sequelize.col('id')), 'documentCount'],
      [sequelize.fn('SUM', sequelize.col('total_chunks')), 'totalChunks'],
    ],
    group: ['caseName'],
    order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']],
    raw: true,
  });

  return res.status(HTTP_STATUS.OK).json({
    total: cases.length,
    cases: cases.map((c) => ({
      case_name: c.caseName,
      document_count: parseInt(c.documentCount, 10),
      total_chunks: parseInt(c.totalChunks, 10) || 0,
    })),
  });
}

/**
 * Delete a document and all its chunks.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function deleteDocument(req, res) {
  const { id } = req.params;

  const document = await Document.findByPk(id);
  if (!document) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Document not found' });
  }

  const chunksDeleted = await Chunk.destroy({ where: { documentId: id } });
  await document.destroy();

  logger.info(`Deleted document ${document.fileName} (${id}) and ${chunksDeleted} chunks`);

  return res.status(HTTP_STATUS.OK).json({
    message: 'Document and chunks deleted',
    document_id: id,
    file_name: document.fileName,
    chunks_deleted: chunksDeleted,
  });
}

/**
 * Find and remove duplicate documents.
 * Duplicates are detected by matching total_chunks count and similar file names.
 * Keeps the first uploaded document and removes later duplicates.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function removeDuplicates(req, res) {
  const dryRun = req.query.dry_run === 'true';

  const documents = await Document.findAll({
    order: [['ingested_at', 'ASC']],
    attributes: ['id', 'caseName', 'fileName', 'fileType', 'totalChunks'],
  });

  const seen = new Map();
  const duplicates = [];

  for (const doc of documents) {
    /* Normalize file name: lowercase, remove [number] suffixes, trim spaces */
    const normalized = doc.fileName
      .toLowerCase()
      .replace(/\[\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const key = `${doc.caseName}::${normalized}::${doc.totalChunks}`;

    if (seen.has(key)) {
      duplicates.push({
        id: doc.id,
        file_name: doc.fileName,
        case_name: doc.caseName,
        total_chunks: doc.totalChunks,
        kept: seen.get(key),
      });
    } else {
      seen.set(key, doc.fileName);
    }
  }

  if (dryRun) {
    return res.status(HTTP_STATUS.OK).json({
      message: `Found ${duplicates.length} duplicate document(s). Use dry_run=false to delete.`,
      dry_run: true,
      duplicates_found: duplicates.length,
      duplicates: duplicates.map((d) => ({
        id: d.id,
        file_name: d.file_name,
        case_name: d.case_name,
        total_chunks: d.total_chunks,
        duplicate_of: d.kept,
      })),
    });
  }

  let totalChunksDeleted = 0;

  for (const dup of duplicates) {
    const chunksDeleted = await Chunk.destroy({ where: { documentId: dup.id } });
    await Document.destroy({ where: { id: dup.id } });
    totalChunksDeleted += chunksDeleted;
    logger.info(`Removed duplicate: ${dup.file_name} (${dup.id}) — ${chunksDeleted} chunks deleted`);
  }

  logger.info(`Duplicate removal complete: ${duplicates.length} documents, ${totalChunksDeleted} chunks deleted`);

  return res.status(HTTP_STATUS.OK).json({
    message: `Removed ${duplicates.length} duplicate document(s) and ${totalChunksDeleted} chunk(s).`,
    dry_run: false,
    documents_removed: duplicates.length,
    chunks_removed: totalChunksDeleted,
    removed: duplicates.map((d) => ({
      id: d.id,
      file_name: d.file_name,
      duplicate_of: d.kept,
    })),
  });
}

module.exports = { searchDocuments, listDocuments, listCases, deleteDocument, removeDuplicates };
