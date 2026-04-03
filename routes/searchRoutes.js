/**
 * @module routes/searchRoutes
 * @description Search and document listing endpoint routes.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { searchValidation, documentsValidation } = require('../validators/searchValidator');
const { handleValidationErrors } = require('../validators');
const searchController = require('../controllers/searchController');

const router = Router();

router.get('/search', searchValidation, handleValidationErrors, asyncHandler(searchController.searchDocuments));
router.get('/search/documents', documentsValidation, handleValidationErrors, asyncHandler(searchController.listDocuments));
router.get('/search/cases', asyncHandler(searchController.listCases));
router.get('/search/documents/:id/preview', asyncHandler(searchController.getDocumentPreview));
router.delete('/search/documents/:id', asyncHandler(searchController.deleteDocument));
router.post('/search/remove-duplicates', asyncHandler(searchController.removeDuplicates));

module.exports = router;
