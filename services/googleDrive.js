/**
 * @module services/googleDrive
 * @description Google Drive integration using Service Account.
 * Lists files from shared folders and streams their content.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../config/logger');

const TEMP_DIR = path.join(os.tmpdir(), 'lawapp-gdrive');

/** Supported MIME types and their file extensions */
const SUPPORTED_MIME_TYPES = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
  /* Google Docs can be exported as DOCX */
  'application/vnd.google-apps.document': '.docx',
};

/** Google Docs export MIME type */
const GOOGLE_DOCS_EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let driveClient = null;

/**
 * Initialize the Google Drive client using a Service Account key file.
 * @returns {Object|null} Google Drive API client
 */
function _getDriveClient() {
  if (driveClient) return driveClient;

  const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyFilePath) {
    logger.warn('GOOGLE_SERVICE_ACCOUNT_KEY not set — Google Drive integration disabled');
    return null;
  }

  try {
    let auth;

    /* Support both file path and inline JSON */
    if (keyFilePath.startsWith('{')) {
      /* Inline JSON (for deployment environments) */
      const credentials = JSON.parse(keyFilePath);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
    } else {
      /* File path */
      auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
    }

    driveClient = google.drive({ version: 'v3', auth });
    logger.info('Google Drive client initialized');
    return driveClient;
  } catch (err) {
    logger.error(`Failed to initialize Google Drive client: ${err.message}`);
    return null;
  }
}

/**
 * Extract folder ID from a Google Drive URL.
 * @param {string} url - Google Drive folder URL or ID
 * @returns {string} Folder ID
 */
function extractFolderId(url) {
  if (!url) return null;

  /* Already a plain ID */
  if (/^[a-zA-Z0-9_-]{10,}$/.test(url)) return url;

  /* URL formats:
   * https://drive.google.com/drive/folders/FOLDER_ID
   * https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
   * https://drive.google.com/drive/u/0/folders/FOLDER_ID
   */
  const match = url.match(/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * List all supported files in a Google Drive folder (recursive).
 * @param {string} folderId - Google Drive folder ID
 * @returns {Promise<Array>} List of files with id, name, mimeType, size
 */
async function listFiles(folderId) {
  const drive = _getDriveClient();
  if (!drive) throw new Error('Google Drive not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in .env');

  const allFiles = [];
  await _listFilesRecursive(drive, folderId, allFiles);

  return allFiles;
}

/**
 * Recursively list files in a folder and its subfolders.
 * @private
 */
async function _listFilesRecursive(drive, folderId, results, folderName = '') {
  let pageToken = null;

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: 100,
      pageToken,
    });

    const files = response.data.files || [];

    for (const file of files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        /* Recurse into subfolders */
        const subFolderName = folderName ? `${folderName}/${file.name}` : file.name;
        await _listFilesRecursive(drive, file.id, results, subFolderName);
      } else if (SUPPORTED_MIME_TYPES[file.mimeType]) {
        results.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: parseInt(file.size || '0', 10),
          modifiedTime: file.modifiedTime,
          folderName: folderName || 'Root',
        });
      }
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);
}

/**
 * Download a file from Google Drive to a temp path.
 * For Google Docs, exports as DOCX.
 * @param {string} fileId - Google Drive file ID
 * @param {string} fileName - Original file name
 * @param {string} mimeType - File MIME type
 * @returns {Promise<{tempPath: string, extension: string}>}
 */
async function downloadToTemp(fileId, fileName, mimeType) {
  const drive = _getDriveClient();
  if (!drive) throw new Error('Google Drive not configured');

  /* Ensure temp directory exists */
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  const isGoogleDoc = mimeType === 'application/vnd.google-apps.document';
  const extension = SUPPORTED_MIME_TYPES[mimeType] || '.bin';
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempPath = path.join(TEMP_DIR, `${Date.now()}_${safeName}${isGoogleDoc ? '.docx' : ''}`);

  /* Ensure the temp file has the correct extension */
  const finalPath = tempPath.endsWith(extension) ? tempPath : `${tempPath}${extension}`;

  const dest = fs.createWriteStream(finalPath);

  let response;
  if (isGoogleDoc) {
    /* Export Google Docs as DOCX */
    response = await drive.files.export(
      { fileId, mimeType: GOOGLE_DOCS_EXPORT_MIME },
      { responseType: 'stream' }
    );
  } else {
    /* Download regular files */
    response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
  }

  return new Promise((resolve, reject) => {
    response.data
      .pipe(dest)
      .on('finish', () => resolve({ tempPath: finalPath, extension }))
      .on('error', (err) => {
        /* Clean up on error */
        try { fs.unlinkSync(finalPath); } catch {}
        reject(err);
      });
  });
}

/**
 * Clean up a temp file.
 * @param {string} tempPath
 */
function cleanupTemp(tempPath) {
  try {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch (err) {
    logger.warn(`Failed to cleanup temp file: ${err.message}`);
  }
}

/**
 * Check if Google Drive is configured.
 * @returns {boolean}
 */
function isConfigured() {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
}

/**
 * Get the service account email (for sharing instructions).
 * @returns {Promise<string|null>}
 */
async function getServiceAccountEmail() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyPath) return null;

  try {
    let credentials;
    if (keyPath.startsWith('{')) {
      credentials = JSON.parse(keyPath);
    } else {
      credentials = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    }
    return credentials.client_email || null;
  } catch {
    return null;
  }
}

module.exports = {
  listFiles,
  downloadToTemp,
  cleanupTemp,
  extractFolderId,
  isConfigured,
  getServiceAccountEmail,
  SUPPORTED_MIME_TYPES,
};
