/**
 * @module routes/chatSessionRoutes
 * @description Chat session CRUD routes — list, create, load, update, delete.
 */

const { Router } = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { ChatSession, ChatHistory } = require('../models');
const logger = require('../config/logger');
const { HTTP_STATUS } = require('../utils/constants');

const router = Router();

/**
 * GET /sessions — List all sessions for the current user (most recent first).
 */
router.get('/sessions', asyncHandler(async (req, res) => {
  const sessions = await ChatSession.findAll({
    where: { userId: req.user.id },
    order: [['updated_at', 'DESC']],
    limit: 50,
  });

  res.json({ sessions });
}));

/**
 * POST /sessions — Create a new session.
 */
router.post('/sessions', asyncHandler(async (req, res) => {
  const { title, case_filter: caseFilter } = req.body;

  const session = await ChatSession.create({
    userId: req.user.id,
    title: title || 'New conversation',
    caseFilter: caseFilter || null,
  });

  logger.info(`Session created: ${session.id} by user ${req.user.id}`);

  res.status(HTTP_STATUS.CREATED).json({ session });
}));

/**
 * GET /sessions/:id — Load a session with its messages.
 */
router.get('/sessions/:id', asyncHandler(async (req, res) => {
  const session = await ChatSession.findOne({
    where: { id: req.params.id, userId: req.user.id },
  });

  if (!session) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Session not found' });
  }

  /* Load messages for this session */
  const messages = await ChatHistory.findAll({
    where: { sessionId: session.id },
    order: [['created_at', 'ASC']],
    attributes: ['id', 'role', 'content', 'sourceChunks', 'confidenceScore', 'created_at'],
  });

  res.json({
    session,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sources: m.sourceChunks,
      confidence_score: m.confidenceScore,
      timestamp: m.created_at,
    })),
  });
}));

/**
 * PUT /sessions/:id — Update session title or case_filter.
 */
router.put('/sessions/:id', asyncHandler(async (req, res) => {
  const session = await ChatSession.findOne({
    where: { id: req.params.id, userId: req.user.id },
  });

  if (!session) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Session not found' });
  }

  const { title, case_filter: caseFilter } = req.body;
  if (title !== undefined) session.title = title;
  if (caseFilter !== undefined) session.caseFilter = caseFilter;
  await session.save();

  res.json({ session });
}));

/**
 * DELETE /sessions/:id — Delete a session and its messages.
 */
router.delete('/sessions/:id', asyncHandler(async (req, res) => {
  const session = await ChatSession.findOne({
    where: { id: req.params.id, userId: req.user.id },
  });

  if (!session) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Session not found' });
  }

  /* Delete messages first, then session */
  await ChatHistory.destroy({ where: { sessionId: session.id } });
  await session.destroy();

  logger.info(`Session deleted: ${session.id}`);

  res.json({ message: 'Session deleted' });
}));

module.exports = router;
