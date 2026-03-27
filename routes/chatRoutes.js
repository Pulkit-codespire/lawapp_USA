/**
 * @module routes/chatRoutes
 * @description Chat endpoint routes.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { chatValidation } = require('../validators/chatValidator');
const { handleValidationErrors } = require('../validators');
const chatController = require('../controllers/chatController');

const router = Router();

router.post('/chat', chatValidation, handleValidationErrors, asyncHandler(chatController.postChat));

module.exports = router;
