/**
 * @module routes/gdriveRoutes
 * @description Google Drive integration routes — scan, import files.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const googleDrive = require('../services/googleDrive');
const textExtractor = require('../services/ingestion/textExtractor');
const textCleaner = require('../services/ingestion/textCleaner');
const chunker = require('../services/ingestion/chunker');
const metadataExtractor = require('../services/ingestion/metadataExtractor');
const embedder = require('../services/embedder');
const reembedder = require('../services/reembedder');
const { Document, Chunk, sequelize } = require('../models');
const logger = require('../config/logger');
const { HTTP_STATUS } = require('../utils/constants');

const { Settings } = require('../models');

const router = Router();

/* ── Auto-Sync State ── */
let syncTimer = null;

/** Track import progress */
let importStatus = {
  running: false,
  totalFiles: 0,
  processedFiles: 0,
  failedFiles: 0,
  totalChunks: 0,
  currentFile: null,
  startedAt: null,
  completedAt: null,
  error: null,
  results: [],
};

/**
 * GET /gdrive/status — Check if Google Drive is configured.
 */
router.get('/gdrive/status', asyncHandler(async (req, res) => {
  const configured = googleDrive.isConfigured();
  const email = configured ? await googleDrive.getServiceAccountEmail() : null;

  res.json({
    configured,
    serviceAccountEmail: email,
  });
}));

/**
 * POST /gdrive/scan — Scan a Google Drive folder and list supported files.
 */
router.post('/gdrive/scan', asyncHandler(async (req, res) => {
  const { folder_url: folderUrl } = req.body;

  if (!folderUrl) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'folder_url is required' });
  }

  const folderId = googleDrive.extractFolderId(folderUrl);
  if (!folderId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid Google Drive folder URL' });
  }

  logger.info(`Scanning Google Drive folder: ${folderId}`);

  const files = await googleDrive.listFiles(folderId);

  /* Group by subfolder */
  const byFolder = {};
  for (const file of files) {
    const folder = file.folderName || 'Root';
    if (!byFolder[folder]) byFolder[folder] = [];
    byFolder[folder].push(file);
  }

  res.json({
    folderId,
    totalFiles: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    folders: byFolder,
    files,
  });
}));

/**
 * POST /gdrive/import — Import files from a Google Drive folder.
 * Runs in the background — poll /gdrive/import/status for progress.
 */
router.post('/gdrive/import', asyncHandler(async (req, res) => {
  if (importStatus.running) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Import already in progress',
      status: _getImportStatus(),
    });
  }

  const { folder_url: folderUrl, case_name: caseName } = req.body;

  if (!folderUrl) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'folder_url is required' });
  }

  const folderId = googleDrive.extractFolderId(folderUrl);
  if (!folderId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid Google Drive folder URL' });
  }

  /* Start import in background */
  _runImport(folderId, caseName).catch((err) => {
    logger.error(`Google Drive import failed: ${err.message}`);
  });

  /* Small delay to let status initialize */
  await new Promise((resolve) => setTimeout(resolve, 300));

  res.json({
    message: 'Import started',
    status: _getImportStatus(),
  });
}));

/**
 * GET /gdrive/import/status — Get current import progress.
 */
router.get('/gdrive/import/status', asyncHandler(async (req, res) => {
  res.json(_getImportStatus());
}));

/**
 * Get formatted import status.
 * @private
 */
function _getImportStatus() {
  const status = { ...importStatus };
  if (status.running && status.totalFiles > 0) {
    status.progress = Math.round(
      ((status.processedFiles + status.failedFiles) / status.totalFiles) * 100
    );
  } else {
    status.progress = status.completedAt ? 100 : 0;
  }
  return status;
}

/**
 * Run the full import pipeline for a Google Drive folder.
 * @param {string} folderId
 * @param {string} [caseName]
 * @private
 */
async function _runImport(folderId, caseName) {
  /* Reset status */
  importStatus = {
    running: true,
    totalFiles: 0,
    processedFiles: 0,
    failedFiles: 0,
    totalChunks: 0,
    currentFile: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    results: [],
  };

  try {
    /* List all files */
    const files = await googleDrive.listFiles(folderId);
    importStatus.totalFiles = files.length;

    if (files.length === 0) {
      importStatus.running = false;
      importStatus.completedAt = new Date().toISOString();
      importStatus.error = 'No supported files found in folder';
      return;
    }

    logger.info(`Google Drive import: ${files.length} files found`);

    /* Process each file */
    for (const file of files) {
      importStatus.currentFile = file.name;

      try {
        const fileCase = caseName || file.folderName || 'Google Drive';
        const chunks = await _processGDriveFile(file, fileCase);

        importStatus.processedFiles += 1;
        importStatus.totalChunks += chunks;
        importStatus.results.push({
          name: file.name,
          status: 'success',
          chunks,
          folder: file.folderName,
        });
      } catch (err) {
        logger.warn(`Failed to process ${file.name}: ${err.message}`);
        importStatus.failedFiles += 1;
        importStatus.results.push({
          name: file.name,
          status: 'error',
          error: err.message,
          folder: file.folderName,
        });
      }

      /* Log progress */
      const done = importStatus.processedFiles + importStatus.failedFiles;
      const progress = Math.round((done / files.length) * 100);
      logger.info(`GDrive import: ${progress}% (${done}/${files.length})`);
    }

    importStatus.running = false;
    importStatus.currentFile = null;
    importStatus.completedAt = new Date().toISOString();
    logger.info(
      `Google Drive import complete: ${importStatus.processedFiles} processed, ${importStatus.failedFiles} failed, ${importStatus.totalChunks} chunks`
    );
  } catch (err) {
    importStatus.running = false;
    importStatus.error = err.message;
    importStatus.completedAt = new Date().toISOString();
    logger.error(`Google Drive import failed: ${err.message}`);
  }
}

/**
 * Process a single file from Google Drive through the ingestion pipeline.
 * Downloads to temp → extract → chunk → embed → save → cleanup.
 * @param {Object} file - Drive file info
 * @param {string} caseName
 * @returns {Promise<number>} Number of chunks created
 * @private
 */
async function _processGDriveFile(file, caseName) {
  let tempPath = null;

  try {
    /* Step 1: Check if already imported (by file name + case) */
    const existing = await Document.findOne({
      where: { fileName: file.name, caseName },
    });
    if (existing) {
      logger.info(`Skipping duplicate: ${file.name}`);
      return 0;
    }

    /* Step 2: Download to temp file */
    const downloaded = await googleDrive.downloadToTemp(file.id, file.name, file.mimeType);
    tempPath = downloaded.tempPath;

    /* Step 3: Extract text */
    const extraction = await textExtractor.extract(tempPath);
    if (!extraction.success) {
      throw new Error(extraction.error || 'Text extraction failed');
    }

    /* Step 4: Clean text */
    const cleanedText = textCleaner.clean(extraction.text);
    if (cleanedText.length === 0) {
      throw new Error('No text content after cleaning');
    }

    /* Step 5: Extract metadata */
    let metadata = metadataExtractor.extract(tempPath);
    metadata = metadataExtractor.extractFromContent(cleanedText, metadata);
    metadata.caseName = caseName;

    /* Step 6: Chunk */
    const chunks = chunker.chunk(cleanedText);
    if (chunks.length === 0) {
      throw new Error('No chunks produced');
    }

    /* Step 7: Embed */
    const texts = chunks.map((c) => c.text);
    const embeddings = await embedder.embedBatch(texts, true);

    /* Step 8: Ensure vector column dimensions match */
    if (embeddings.length > 0 && embeddings[0].length > 0) {
      await reembedder.ensureColumnDimensions(embeddings[0].length);
    }

    /* Step 9: Save to DB (transaction only for DB writes) */
    const result = await sequelize.transaction(async (transaction) => {
      const document = await Document.create({
        caseName,
        caseFolder: file.folderName || null,
        fileName: file.name,
        filePath: `gdrive://${file.id}`,
        fileType: extraction.fileType,
        documentType: metadata.documentType,
        totalPages: extraction.totalPages,
        totalChunks: chunks.length,
        extractionMethod: extraction.extractionMethod,
        isProcessed: true,
      }, { transaction });

      const chunkRecords = chunks.map((c, idx) => ({
        documentId: document.id,
        chunkText: c.text,
        chunkIndex: c.chunkIndex,
        tokenCount: c.tokenCount,
        section: c.section,
        pageNumber: c.pageNumber,
        embedding: embeddings[idx],
        metadataJson: { ...metadata.extra, source: 'google_drive', driveFileId: file.id },
      }));

      const BATCH_SIZE = 50;
      for (let i = 0; i < chunkRecords.length; i += BATCH_SIZE) {
        await Chunk.bulkCreate(chunkRecords.slice(i, i + BATCH_SIZE), { transaction });
      }

      return chunks.length;
    });

    return result;
  } finally {
    /* Always cleanup temp file */
    if (tempPath) {
      googleDrive.cleanupTemp(tempPath);
    }
  }
}

/* ══════════════════════════════════════════════════════
   AUTO-SYNC — periodically poll Drive folder for new files
   ══════════════════════════════════════════════════════ */

const SYNC_SETTINGS_KEY = 'gdrive_auto_sync';

/**
 * GET /gdrive/sync — Get current auto-sync configuration.
 */
router.get('/gdrive/sync', asyncHandler(async (req, res) => {
  const config = await Settings.get(SYNC_SETTINGS_KEY, null);
  res.json({
    enabled: !!config?.enabled,
    folderUrl: config?.folderUrl || null,
    caseName: config?.caseName || null,
    intervalMinutes: config?.intervalMinutes || 30,
    lastSyncAt: config?.lastSyncAt || null,
    lastSyncNewFiles: config?.lastSyncNewFiles || 0,
    nextSyncAt: _getNextSyncTime(config),
    syncRunning: importStatus.running,
  });
}));

/**
 * POST /gdrive/sync — Save auto-sync config and start/stop scheduler.
 */
router.post('/gdrive/sync', asyncHandler(async (req, res) => {
  const { enabled, folder_url: folderUrl, case_name: caseName, interval_minutes: intervalMinutes } = req.body;

  if (enabled && !folderUrl) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'folder_url is required to enable sync' });
  }

  if (enabled) {
    const folderId = googleDrive.extractFolderId(folderUrl);
    if (!folderId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid Google Drive folder URL' });
    }
  }

  const mins = Math.max(5, Math.min(1440, intervalMinutes || 30));

  const existing = await Settings.get(SYNC_SETTINGS_KEY, {});
  const config = {
    enabled: !!enabled,
    folderUrl: folderUrl || existing.folderUrl || null,
    caseName: caseName !== undefined ? caseName : (existing.caseName || null),
    intervalMinutes: mins,
    lastSyncAt: existing.lastSyncAt || null,
    lastSyncNewFiles: existing.lastSyncNewFiles || 0,
  };

  await Settings.set(SYNC_SETTINGS_KEY, config);

  if (config.enabled) {
    _startSyncScheduler(config);
  } else {
    _stopSyncScheduler();
  }

  res.json({
    message: config.enabled ? `Auto-sync enabled (every ${mins} minutes)` : 'Auto-sync disabled',
    enabled: config.enabled,
    folderUrl: config.folderUrl,
    caseName: config.caseName,
    intervalMinutes: config.intervalMinutes,
    lastSyncAt: config.lastSyncAt,
    nextSyncAt: _getNextSyncTime(config),
  });
}));

/**
 * POST /gdrive/sync/now — Trigger an immediate sync.
 */
router.post('/gdrive/sync/now', asyncHandler(async (req, res) => {
  if (importStatus.running) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Import already in progress' });
  }

  const config = await Settings.get(SYNC_SETTINGS_KEY, null);
  if (!config?.folderUrl) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'No folder configured for sync' });
  }

  /* Run sync in background */
  _runSync(config).catch((err) => {
    logger.error(`Manual sync failed: ${err.message}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  res.json({
    message: 'Sync started',
    status: _getImportStatus(),
  });
}));

/**
 * Calculate next sync time.
 * @private
 */
function _getNextSyncTime(config) {
  if (!config?.enabled || !config.lastSyncAt) return null;
  const next = new Date(new Date(config.lastSyncAt).getTime() + (config.intervalMinutes || 30) * 60 * 1000);
  return next.toISOString();
}

/**
 * Start the periodic sync scheduler.
 * @private
 */
function _startSyncScheduler(config) {
  _stopSyncScheduler();
  const intervalMs = (config.intervalMinutes || 30) * 60 * 1000;

  logger.info(`Auto-sync scheduler started: every ${config.intervalMinutes} minutes`);

  syncTimer = setInterval(async () => {
    if (importStatus.running) {
      logger.info('Auto-sync skipped — import already running');
      return;
    }
    try {
      const latestConfig = await Settings.get(SYNC_SETTINGS_KEY, null);
      if (!latestConfig?.enabled) {
        _stopSyncScheduler();
        return;
      }
      await _runSync(latestConfig);
    } catch (err) {
      logger.error(`Auto-sync error: ${err.message}`);
    }
  }, intervalMs);
}

/**
 * Stop the sync scheduler.
 * @private
 */
function _stopSyncScheduler() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    logger.info('Auto-sync scheduler stopped');
  }
}

/**
 * Run a single sync cycle — scan folder, import only NEW files.
 * @private
 */
async function _runSync(config) {
  const folderId = googleDrive.extractFolderId(config.folderUrl);
  if (!folderId) return;

  logger.info(`Auto-sync: scanning folder ${folderId}`);

  /* List files from Drive */
  const driveFiles = await googleDrive.listFiles(folderId);

  /* Find which files are already in DB */
  const existingDocs = await Document.findAll({
    attributes: ['fileName', 'caseName'],
    where: { filePath: { [require('sequelize').Op.like]: 'gdrive://%' } },
    raw: true,
  });
  const existingSet = new Set(existingDocs.map((d) => `${d.caseName}::${d.fileName}`));

  /* Filter to only new files */
  const newFiles = driveFiles.filter((f) => {
    const cn = config.caseName || f.folderName || 'Google Drive';
    return !existingSet.has(`${cn}::${f.name}`);
  });

  if (newFiles.length === 0) {
    logger.info('Auto-sync: no new files found');
    /* Update last sync timestamp */
    await Settings.set(SYNC_SETTINGS_KEY, {
      ...config,
      lastSyncAt: new Date().toISOString(),
      lastSyncNewFiles: 0,
    });
    return;
  }

  logger.info(`Auto-sync: found ${newFiles.length} new file(s) — starting import`);

  /* Run import for new files only */
  importStatus = {
    running: true,
    totalFiles: newFiles.length,
    processedFiles: 0,
    failedFiles: 0,
    totalChunks: 0,
    currentFile: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    results: [],
  };

  try {
    for (const file of newFiles) {
      importStatus.currentFile = file.name;
      try {
        const fileCase = config.caseName || file.folderName || 'Google Drive';
        const chunks = await _processGDriveFile(file, fileCase);
        importStatus.processedFiles += 1;
        importStatus.totalChunks += chunks;
        importStatus.results.push({ name: file.name, status: 'success', chunks, folder: file.folderName });
      } catch (err) {
        logger.warn(`Auto-sync: failed to process ${file.name}: ${err.message}`);
        importStatus.failedFiles += 1;
        importStatus.results.push({ name: file.name, status: 'error', error: err.message, folder: file.folderName });
      }
    }
  } finally {
    importStatus.running = false;
    importStatus.currentFile = null;
    importStatus.completedAt = new Date().toISOString();

    /* Update sync config with results */
    await Settings.set(SYNC_SETTINGS_KEY, {
      ...config,
      lastSyncAt: new Date().toISOString(),
      lastSyncNewFiles: importStatus.processedFiles,
    });

    logger.info(`Auto-sync complete: ${importStatus.processedFiles} imported, ${importStatus.failedFiles} failed`);
  }
}

/**
 * Boot: restore sync scheduler if it was enabled.
 */
async function _restoreSyncOnBoot() {
  try {
    const config = await Settings.get(SYNC_SETTINGS_KEY, null);
    if (config?.enabled && config.folderUrl) {
      _startSyncScheduler(config);
    }
  } catch {
    /* Settings table may not exist yet during first migration */
  }
}

/* Restore sync after a small delay to let DB init complete */
setTimeout(_restoreSyncOnBoot, 5000);

module.exports = router;
