/**
 * @module controllers/chatController
 * @description Handles POST /chat — full RAG pipeline orchestration.
 */

const { v4: uuidv4 } = require('uuid');
const { ChatHistory, ChatSession } = require('../models');
const retriever = require('../services/rag/retriever');
const generator = require('../services/rag/generator');
const reranker = require('../services/rag/reranker');
const retrievalGate = require('../services/antiHallucination/retrievalGate');
const citationChecker = require('../services/antiHallucination/citationChecker');
const confidenceScorer = require('../services/antiHallucination/confidenceScorer');
const queryClassifier = require('../services/queryClassifier');
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

  /* ── Step 1: Classify intent ── */
  const { intent } = await queryClassifier.classify(question, model);
  logger.info(`Intent: ${intent}`);

  /* ── Step 2: Route based on intent ── */

  /* GREETING — casual hello/hi/thanks, no AI or document search needed */
  if (intent === 'greeting') {
    const greetings = [
      'Hello! How can I assist you with your legal research today?',
      'Hi there! Ready to help with your case. What would you like to know?',
      'Hey! I\'m here to help with your legal questions. What can I do for you?',
    ];
    const answer = greetings[Math.floor(Math.random() * greetings.length)];

    await _saveChatHistory(sessionId, question, answer, [], 0);
    await _updateSessionTitle(sessionId, question);

    return res.status(HTTP_STATUS.OK).json({
      answer,
      sources: [],
      confidence: 'greeting',
      confidence_score: 1,
      confidence_reason: 'Greeting response.',
      session_id: sessionId,
      tokens_used: 0,
      intent,
      warnings: [],
    });
  }

  /* LEGAL ADVICE — pure UK law strategy, no document search needed */
  if (intent === 'legal_advice') {
    const chatHistory = await _getChatHistory(sessionId);
    const generated = await generator.generateLegalAdvice(question, chatHistory, aiOverrides);

    await _saveChatHistory(sessionId, question, generated.answer, [], 0);
    await _updateSessionTitle(sessionId, question);

    return res.status(HTTP_STATUS.OK).json({
      answer: generated.answer,
      sources: [],
      confidence: 'advice',
      confidence_score: 0,
      confidence_reason: 'UK legal strategy advice based on AI knowledge of UK law.',
      session_id: sessionId,
      tokens_used: generated.tokensUsed,
      intent,
      warnings: ['This is AI-generated UK legal strategy guidance. Always verify with current legislation and consult the instructed lawyer.'],
    });
  }

  /* GENERAL — pure UK law knowledge question */
  if (intent === 'general') {
    const chatHistory = await _getChatHistory(sessionId);
    const generated = await generator.generateUKGeneral(question, chatHistory, aiOverrides);

    await _saveChatHistory(sessionId, question, generated.answer, [], 0);
    await _updateSessionTitle(sessionId, question);

    return res.status(HTTP_STATUS.OK).json({
      answer: generated.answer,
      sources: [],
      confidence: 'general',
      confidence_score: 0,
      confidence_reason: 'General UK law knowledge. Not from your case files.',
      session_id: sessionId,
      tokens_used: generated.tokensUsed,
      intent,
      warnings: ['This answer is based on AI knowledge of UK law, NOT your case files. Verify on legislation.gov.uk.'],
    });
  }

  /* CASE_QUERY or HYBRID — both need document search */
  const chunks = await retriever.search(question, { caseName, documentType, topK, similarityThreshold });

  /* Retrieval gate check */
  const gateResult = retrievalGate.check(chunks, similarityThreshold);

  if (!gateResult.passed) {
    /* No docs found — for hybrid, still give UK law advice; for case_query, fallback */
    if (intent === 'hybrid') {
      const chatHistory = await _getChatHistory(sessionId);
      const generated = await generator.generateHybrid(question, [], chatHistory, aiOverrides);

      await _saveChatHistory(sessionId, question, generated.answer, [], 0);
      await _updateSessionTitle(sessionId, question);

      return res.status(HTTP_STATUS.OK).json({
        answer: generated.answer,
        sources: [],
        confidence: 'general',
        confidence_score: 0,
        confidence_reason: 'No matching case files found. Answered with UK law knowledge only.',
        session_id: sessionId,
        tokens_used: generated.tokensUsed,
        intent,
        warnings: ['No relevant case documents found. This analysis uses UK law knowledge only — upload relevant documents for case-specific advice.'],
      });
    }
    /* case_query with no docs — original fallback */
    return _sendNoDataResponse(res, sessionId, question, gateResult, aiOverrides, intent);
  }

  /* Rerank */
  const reranked = reranker.rerank(chunks, question);

  /* Safety net: if best reranked chunk has very low vector similarity, the docs are likely irrelevant.
     Fall back to UK law advice instead of feeding garbage context to the LLM. */
  const bestScore = reranked.length > 0 ? reranked[0].similarity : 0;
  if (bestScore < 0.30) {
    logger.info(`Low relevance after rerank (best: ${bestScore.toFixed(3)}) — falling back to UK law answer`);
    const chatHistory = await _getChatHistory(sessionId);
    const generated = await generator.generateLegalAdvice(question, chatHistory, aiOverrides);

    await _saveChatHistory(sessionId, question, generated.answer, [], 0);
    await _updateSessionTitle(sessionId, question);

    return res.status(HTTP_STATUS.OK).json({
      answer: generated.answer,
      sources: [],
      confidence: 'advice',
      confidence_score: 0,
      confidence_reason: 'No closely matching case files found. Answered with UK law knowledge.',
      session_id: sessionId,
      tokens_used: generated.tokensUsed,
      intent,
      warnings: ['No closely relevant case documents found for this query. This answer uses general UK law knowledge.'],
    });
  }

  /* Load chat history */
  const chatHistory = await _getChatHistory(sessionId);

  /* Generate answer — hybrid uses UK law + docs, case_query uses docs only */
  const generated = intent === 'hybrid'
    ? await generator.generateHybrid(question, reranked, chatHistory, aiOverrides)
    : await generator.generate(question, reranked, chatHistory, aiOverrides);

  /* Verify citations */
  const citationResult = citationChecker.verify(generated.answer, reranked);

  /* Score confidence */
  const confidence = confidenceScorer.score(reranked, citationResult, generated.answer);

  /* Save to history */
  await _saveChatHistory(sessionId, question, generated.answer, generated.sources, confidence.score);
  await _updateSessionTitle(sessionId, question);

  /* Build response */
  const warnings = citationResult.warnings || [];

  return res.status(HTTP_STATUS.OK).json({
    answer: generated.answer,
    sources: generated.sources,
    confidence: confidence.level,
    confidence_score: confidence.score,
    confidence_reason: confidence.reason,
    session_id: sessionId,
    tokens_used: generated.tokensUsed,
    intent,
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
async function _sendNoDataResponse(res, sessionId, question, gateResult, aiOverrides = {}, intent = 'case_query') {
  const chatHistory = await _getChatHistory(sessionId);
  const generated = await generator.generateUKGeneral(question, chatHistory, aiOverrides);

  await _saveChatHistory(sessionId, question, generated.answer, [], 0);
  await _updateSessionTitle(sessionId, question);

  return res.status(HTTP_STATUS.OK).json({
    answer: generated.answer,
    sources: [],
    confidence: 'general',
    confidence_score: 0,
    confidence_reason: 'No matching case files found. Answered from UK law knowledge.',
    session_id: sessionId,
    tokens_used: generated.tokensUsed,
    intent,
    warnings: ['No relevant case documents found. This answer uses general UK law knowledge. Upload case files for case-specific answers.'],
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

/**
 * Update session title to the first question (if still default).
 * Also touch updated_at to keep recent order.
 * @param {string} sessionId
 * @param {string} question
 * @private
 */
async function _updateSessionTitle(sessionId, question) {
  try {
    const session = await ChatSession.findByPk(sessionId);
    if (!session) return;

    /* Set title from first question */
    if (session.title === 'New conversation') {
      const title = question.length > 80 ? question.slice(0, 80) + '...' : question;
      session.title = title;
    }

    /* Touch updated_at */
    session.changed('updatedAt', true);
    await session.save();
  } catch (err) {
    /* Non-critical — don't fail the chat response */
    logger.warn(`Failed to update session title: ${err.message}`);
  }
}

module.exports = { postChat };
