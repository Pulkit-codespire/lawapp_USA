/**
 * @module routes/ingestRoutes
 * @description Document ingestion endpoint routes.
 */

const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const asyncHandler = require('../utils/asyncHandler');
const { fileUploadValidation, folderIngestValidation } = require('../validators/ingestValidator');
const { handleValidationErrors } = require('../validators');
const ingestController = require('../controllers/ingestController');
const { MAX_UPLOAD_SIZE, ALL_SUPPORTED_EXTENSIONS } = require('../utils/constants');

const fs = require('fs');

const uploadDir = path.join(os.tmpdir(), 'lawapp-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const router = Router();

/** Multer storage — preserves file extension so detector works */
const storage = multer.diskStorage({
  destination: path.join(os.tmpdir(), 'lawapp-uploads'),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

/** Multer configuration for file uploads */
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALL_SUPPORTED_EXTENSIONS.has(ext)) {
      return cb(null, true);
    }
    return cb(new Error(`Unsupported file type: ${ext}`));
  },
});

router.post(
  '/ingest/file',
  upload.single('file'),
  fileUploadValidation,
  handleValidationErrors,
  asyncHandler(ingestController.postFile),
);

router.post(
  '/ingest/folder',
  folderIngestValidation,
  handleValidationErrors,
  asyncHandler(ingestController.postFolder),
);

router.get('/ingest/status', asyncHandler(ingestController.getStatus));

module.exports = router;
