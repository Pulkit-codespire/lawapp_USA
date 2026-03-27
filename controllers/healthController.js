/**
 * @module controllers/healthController
 * @description Health check and service info endpoints.
 */

const { checkConnection } = require('../models');
const { HTTP_STATUS } = require('../utils/constants');

const SERVICE_VERSION = '0.1.0';

/**
 * Health check — verifies database connectivity.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getHealth(req, res) {
  const dbConnected = await checkConnection();

  const status = dbConnected ? 'healthy' : 'unhealthy';
  const statusCode = dbConnected ? HTTP_STATUS.OK : HTTP_STATUS.INTERNAL_ERROR;

  return res.status(statusCode).json({
    status,
    database: dbConnected ? 'connected' : 'disconnected',
    version: SERVICE_VERSION,
  });
}

/**
 * Root endpoint — returns service metadata and available endpoints.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getRoot(req, res) {
  return res.status(HTTP_STATUS.OK).json({
    service: 'LawApp Server',
    version: SERVICE_VERSION,
    description: 'Legal research assistant with RAG pipeline',
    endpoints: {
      'POST /chat': 'Ask questions about your case files',
      'POST /ingest/file': 'Upload and process a document',
      'POST /ingest/folder': 'Batch process a folder of documents',
      'GET /ingest/status': 'Get ingestion statistics',
      'GET /search': 'Search across all documents',
      'GET /search/documents': 'List ingested documents',
      'GET /search/cases': 'List all cases',
      'GET /health': 'Health check',
    },
  });
}

module.exports = { getHealth, getRoot };
