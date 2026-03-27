/**
 * @module scripts/batchIngest
 * @description CLI batch ingestion tool for processing 3000+ case files.
 * Usage: node scripts/batchIngest.js --path C:/legal_cases [--dry-run] [--resume]
 */

require('dotenv').config();

const { program } = require('commander');
const cliProgress = require('cli-progress');
const fs = require('fs');
const path = require('path');
const { Document, sequelize } = require('../models');
const { initDb } = require('../models');
const textExtractor = require('../services/ingestion/textExtractor');
const textCleaner = require('../services/ingestion/textCleaner');
const chunker = require('../services/ingestion/chunker');
const metadataExtractor = require('../services/ingestion/metadataExtractor');
const fileDetector = require('../services/ingestion/fileDetector');
const embedder = require('../services/embedder');
const { Chunk } = require('../models');
const logger = require('../config/logger');

program
  .requiredOption('--path <dir>', 'Root cases folder or single case folder')
  .option('--dry-run', 'List files without processing', false)
  .option('--resume', 'Skip already-processed files', false)
  .parse();

const opts = program.opts();

/**
 * Find all supported files recursively.
 * @param {string} dirPath
 * @returns {Array<{filePath: string, caseFolder: string}>}
 */
function findAllFiles(dirPath) {
  const results = [];

  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (fileDetector.isSupported(fullPath)) {
        results.push({
          filePath: fullPath,
          caseFolder: path.basename(path.dirname(fullPath)),
        });
      }
    }
  };

  walk(dirPath);
  return results;
}

/**
 * Check if a file has already been ingested.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isAlreadyProcessed(filePath) {
  const doc = await Document.findOne({ where: { filePath } });
  return doc !== null;
}

/**
 * Process a single file through the ingestion pipeline.
 * @param {string} filePath
 * @param {string} caseName
 * @returns {Promise<{success: boolean, chunks: number, error: string|null}>}
 */
async function processFile(filePath, caseName) {
  const transaction = await sequelize.transaction();

  try {
    const extraction = await textExtractor.extract(filePath);
    if (!extraction.success) throw new Error(extraction.error);

    const cleaned = textCleaner.clean(extraction.text);
    if (!cleaned) throw new Error('No text after cleaning');

    let metadata = metadataExtractor.extract(filePath);
    metadata = metadataExtractor.extractFromContent(cleaned, metadata);
    metadata.caseName = caseName || metadata.caseName;

    const chunks = chunker.chunk(cleaned);
    if (chunks.length === 0) throw new Error('No chunks produced');

    const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));

    const doc = await Document.create({
      caseName: metadata.caseName,
      caseFolder: metadata.caseFolder,
      fileName: path.basename(filePath),
      filePath,
      fileType: extraction.fileType,
      documentType: metadata.documentType,
      totalPages: extraction.totalPages,
      totalChunks: chunks.length,
      extractionMethod: extraction.extractionMethod,
      isProcessed: true,
    }, { transaction });

    await Chunk.bulkCreate(chunks.map((c, idx) => ({
      documentId: doc.id,
      chunkText: c.text,
      chunkIndex: c.chunkIndex,
      tokenCount: c.tokenCount,
      section: c.section,
      pageNumber: c.pageNumber,
      embedding: embeddings[idx],
      metadataJson: metadata.extra,
    })), { transaction });

    await transaction.commit();
    return { success: true, chunks: chunks.length, error: null };
  } catch (err) {
    await transaction.rollback();
    return { success: false, chunks: 0, error: err.message };
  }
}

/**
 * Main batch ingestion runner.
 */
async function run() {
  const rootPath = opts.path;

  if (!fs.existsSync(rootPath)) {
    logger.error(`Path not found: ${rootPath}`);
    process.exit(1);
  }

  await initDb();

  const files = findAllFiles(rootPath);
  logger.info(`Found ${files.length} supported files in ${rootPath}`);

  if (opts.dryRun) {
    logger.info('DRY RUN — listing files only:');
    files.forEach((f) => logger.info(`  ${f.caseFolder}/${path.basename(f.filePath)}`));
    await sequelize.close();
    return;
  }

  const bar = new cliProgress.SingleBar({
    format: 'Ingesting [{bar}] {percentage}% | {value}/{total} | ok:{ok} skip:{skip} fail:{fail}',
  }, cliProgress.Presets.shades_classic);

  const stats = { ok: 0, skip: 0, fail: 0, totalChunks: 0 };
  bar.start(files.length, 0, stats);

  const errors = [];

  for (const file of files) {
    if (opts.resume && await isAlreadyProcessed(file.filePath)) {
      stats.skip++;
      bar.increment(1, stats);
      continue;
    }

    const result = await processFile(file.filePath, file.caseFolder);

    if (result.success) {
      stats.ok++;
      stats.totalChunks += result.chunks;
    } else {
      stats.fail++;
      errors.push({ file: file.filePath, error: result.error });
    }

    bar.increment(1, stats);
  }

  bar.stop();

  /* Print report */
  logger.info('\n' + '='.repeat(50));
  logger.info('  Batch Ingestion Report');
  logger.info('='.repeat(50));
  logger.info(`  Total files:    ${files.length}`);
  logger.info(`  Processed:      ${stats.ok}`);
  logger.info(`  Skipped:        ${stats.skip}`);
  logger.info(`  Failed:         ${stats.fail}`);
  logger.info(`  Total chunks:   ${stats.totalChunks}`);

  if (errors.length > 0) {
    const errorLog = path.join(__dirname, '..', 'logs', 'ingestion_errors.log');
    const errorContent = errors.map((e) => `${e.file}: ${e.error}`).join('\n');
    fs.writeFileSync(errorLog, errorContent);
    logger.info(`  Errors logged:  ${errorLog}`);
  }

  await sequelize.close();
}

run().catch((err) => {
  logger.error(`Batch ingestion failed: ${err.message}`);
  process.exit(1);
});
