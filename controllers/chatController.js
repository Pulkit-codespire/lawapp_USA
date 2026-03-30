/**
 * @module controllers/chatController
 * @description Handles POST /chat — full RAG pipeline orchestration.
 */

const { v4: uuidv4 } = require('uuid');
const { ChatHistory } = require('../models');
const retriever = require('../services/rag/retriever');
const generator = require('../services/rag/generator');
const reranker = require('../services/rag/reranker');
const retrievalGate = require('../services/antiHallucination/retrievalGate');
const citationChecker = require('../services/antiHallucination/citationChecker');
const confidenceScorer = require('../services/antiHallucination/confidenceScorer');
const logger = require('../config/logger');
const { HTTP_STATUS, MAX_CHAT_HISTORY } = require('../utils/constants');

/**
 * Handle a chat request through the full RAG pipeline.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function postChat(req, res) {
  const {
    question,
    case_name: caseName,
    document_type: documentType,
    model,
    temperature,
    max_tokens: maxTokens,
    top_k: topK,
    similarity_threshold: similarityThreshold,
  } = req.body;
  const sessionId = req.body.session_id || uuidv4();

  /* Build per-request AI config overrides */
  const aiOverrides = {
    ...(model && { model }),
    ...(temperature !== undefined && { temperature }),
    ...(maxTokens && { maxTokens }),
    ...(topK && { topK }),
    ...(similarityThreshold !== undefined && { similarityThreshold }),
  };

  logger.info(`Chat request: "${question.slice(0, 80)}..." (session: ${sessionId}, model: ${model || 'default'})`);

  /* Step 1: Hybrid search (with optional topK + threshold override) */
  const chunks = await retriever.search(question, { caseName, documentType, topK, similarityThreshold });

  /* Step 2: Retrieval gate check */
  const gateResult = retrievalGate.check(chunks, similarityThreshold);
  if (!gateResult.passed) {
    return _sendNoDataResponse(res, sessionId, question, gateResult, aiOverrides);
  }

  /* Step 3: Rerank */
  const reranked = reranker.rerank(chunks, question);

  /* Step 4: Load chat history */
  const chatHistory = await _getChatHistory(sessionId);

  /* Step 5: Generate answer (with optional model + temperature override) */
  const generated = await generator.generate(question, reranked, chatHistory, aiOverrides);

  /* Step 6: Verify citations */
  const citationResult = citationChecker.verify(generated.answer, reranked);

  /* Step 7: Score confidence */
  const confidence = confidenceScorer.score(reranked, citationResult, generated.answer);

  /* Step 8: Save to history */
  await _saveChatHistory(sessionId, question, generated.answer, generated.sources, confidence.score);

  /* Step 9: Build response */
  const warnings = citationResult.warnings || [];

  return res.status(HTTP_STATUS.OK).json({
    answer: generated.answer,
    sources: generated.sources,
    confidence: confidence.level,
    confidence_score: confidence.score,
    confidence_reason: confidence.reason,
    session_id: sessionId,
    tokens_used: generated.tokensUsed,
    warnings,
  });
}

/**
 * Fallback to OpenAI general knowledge when no case files match.
 * @param {import('express').Response} res
 * @param {string} sessionId
 * @param {string} question
 * @param {Object} gateResult
 * @private
 */
async function _sendNoDataResponse(res, sessionId, question, gateResult, aiOverrides = {}) {
  const chatHistory = await _getChatHistory(sessionId);
  const generated = await generator.generateGeneral(question, chatHistory, aiOverrides);

  await _saveChatHistory(sessionId, question, generated.answer, [], 0);

  return res.status(HTTP_STATUS.OK).json({
    answer: generated.answer,
    sources: [],
    confidence: 'general',
    confidence_score: 0,
    confidence_reason: 'No case files found. Answered from AI general legal knowledge.',
    session_id: sessionId,
    tokens_used: generated.tokensUsed,
    warnings: ['This answer is based on general AI knowledge, NOT your case files. Verify independently.'],
  });
}

/**
 * Load recent chat history for a session.
 * @param {string} sessionId
 * @returns {Promise<Array>}
 * @private
 */
async function _getChatHistory(sessionId) {
  const messages = await ChatHistory.findAll({
    where: { sessionId },
    order: [['created_at', 'ASC']],
    limit: MAX_CHAT_HISTORY * 2,
    attributes: ['role', 'content'],
  });

  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Save user question and assistant response to chat history.
 * @param {string} sessionId
 * @param {string} question
 * @param {string} answer
 * @param {Array} sources
 * @param {number} confidenceScore
 * @private
 */
async function _saveChatHistory(sessionId, question, answer, sources, confidenceScore) {
  await ChatHistory.bulkCreate([
    { sessionId, role: 'user', content: question },
    { sessionId, role: 'assistant', content: answer, sourceChunks: sources, confidenceScore },
  ]);
}

module.exports = { postChat };
