/**
 * @module services/queryClassifier
 * @description Classifies user queries to route them to the correct pipeline.
 * Uses a cheap/fast LLM call (GPT-4o-mini or Gemini Flash) to detect intent.
 *
 * Routes:
 *   - case_query:    User asks about facts in their uploaded documents
 *   - legal_advice:  User wants strategy, how to win, what to do next (UK Law)
 *   - hybrid:        Needs both case facts AND UK legal knowledge
 *   - general:       General UK law question, no case files needed
 */

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../config/logger');
const { trackUsage } = require('./usageTracker');

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
const geminiClient = config.gemini?.apiKey ? new GoogleGenerativeAI(config.gemini.apiKey) : null;

const VALID_INTENTS = ['case_query', 'legal_advice', 'hybrid', 'general'];

const CLASSIFIER_PROMPT = `You are a legal query router for a UK law application. A lawyer is asking a question. Classify it into EXACTLY one of these categories:

- "case_query" — The lawyer is asking about specific facts, dates, evidence, or content from their uploaded case documents. Examples: "What was the court order date?", "Show me the defense argument", "What evidence is in document X?"

- "legal_advice" — The lawyer wants legal strategy, tactical advice, or guidance on how to proceed. They want to know what to DO, not just what the documents SAY. Examples: "How should I argue this defense?", "What are my chances of winning?", "How to challenge this evidence?", "What strategy should I use?"

- "hybrid" — The lawyer needs BOTH their case document facts AND UK legal knowledge combined. They want to connect their case to applicable law. Examples: "Based on my case, which UK Act applies?", "Does the evidence in my files support a Section 18 charge?", "How does the Limitation Act affect my client's claim?"

- "general" — A general UK law question not tied to any specific case files. Examples: "What is Section 18 of the Offences Against the Person Act?", "Explain the CPR Part 36 offer process", "What are the sentencing guidelines for fraud?"

Reply with ONLY the category name. Nothing else.`;

/**
 * Classify a user query to determine the correct response pipeline.
 * @param {string} question - The user's question
 * @param {string} [chatModel] - Override model for classification (uses cheapest available by default)
 * @returns {Promise<{intent: string, model: string}>}
 */
async function classify(question, chatModel) {
  const model = _pickClassifierModel(chatModel);
  const isGemini = model.startsWith('gemini');

  try {
    let intent;
    let tokensUsed = 0;

    if (isGemini && geminiClient) {
      ({ intent, tokensUsed } = await _classifyWithGemini(question, model));
    } else if (openai) {
      ({ intent, tokensUsed } = await _classifyWithOpenAI(question, model));
    } else {
      /* No AI available — default to hybrid as safest fallback */
      logger.warn('No AI provider available for classification, defaulting to hybrid');
      return { intent: 'hybrid', model: 'fallback' };
    }

    /* Track usage */
    trackUsage({
      operation: 'classifier',
      model,
      inputTokens: Math.round(tokensUsed * 0.9),
      outputTokens: Math.round(tokensUsed * 0.1),
      totalTokens: tokensUsed,
      metadata: { question: question.slice(0, 100), intent },
    });

    logger.info(`Query classified as "${intent}" (model: ${model})`);
    return { intent, model };
  } catch (err) {
    logger.warn(`Classification failed: ${err.message} — defaulting to hybrid`);
    return { intent: 'hybrid', model: 'fallback' };
  }
}

/**
 * Pick the cheapest/fastest model for classification.
 * Prefers: gemini-2.0-flash (free) > gpt-4o-mini (cheap) > user's chat model
 * @param {string} [chatModel]
 * @returns {string}
 * @private
 */
function _pickClassifierModel(chatModel) {
  /* Prefer free Gemini Flash if available */
  if (geminiClient) return 'gemini-2.0-flash';
  /* Then cheap OpenAI mini */
  if (openai) return 'gpt-4o-mini';
  /* Fallback to whatever the user has */
  return chatModel || config.chat.model;
}

/**
 * Classify using OpenAI.
 * @private
 */
async function _classifyWithOpenAI(question, model) {
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: CLASSIFIER_PROMPT },
      { role: 'user', content: question },
    ],
    max_tokens: 10,
    temperature: 0,
  });

  const raw = (response.choices[0]?.message?.content || '').trim().toLowerCase();
  const intent = VALID_INTENTS.includes(raw) ? raw : 'hybrid';
  const tokensUsed = response.usage?.total_tokens || 0;

  return { intent, tokensUsed };
}

/**
 * Classify using Gemini.
 * @private
 */
async function _classifyWithGemini(question, model) {
  const geminiModel = geminiClient.getGenerativeModel({
    model,
    systemInstruction: CLASSIFIER_PROMPT,
    generationConfig: { maxOutputTokens: 10, temperature: 0 },
  });

  const result = await geminiModel.generateContent(question);
  const raw = (result.response.text() || '').trim().toLowerCase();
  const intent = VALID_INTENTS.includes(raw) ? raw : 'hybrid';
  const tokensUsed = result.response.usageMetadata?.totalTokenCount || 0;

  return { intent, tokensUsed };
}

module.exports = { classify, VALID_INTENTS };
