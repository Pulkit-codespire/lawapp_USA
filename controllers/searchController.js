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
    attributes: ['id', 'caseName', 'fileName', 'fileType', 'documentType', 'totalChunks', 'isProcessed'],
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

module.exports = { searchDocuments, listDocuments, listCases, deleteDocument };
