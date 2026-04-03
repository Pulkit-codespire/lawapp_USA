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

const VALID_INTENTS = ['greeting', 'case_query', 'legal_advice', 'hybrid', 'general'];

const CLASSIFIER_PROMPT = `You are a legal query router for a UK law application. A lawyer is asking a question. Classify it into EXACTLY one of these categories:

- "greeting" — Casual greetings, small talk, thanks, or pleasantries that are NOT a legal question. Examples: "hi", "hello", "hey", "hii", "good morning", "thanks", "thank you", "bye", "how are you", "what's up"

- "case_query" — The lawyer is asking about specific facts, dates, names, evidence, or content that would be found in case documents. This includes questions about specific people, events, findings, or details from a case. Examples: "What was the coroner's conclusion for Balram Patel?", "What was the court order date?", "Show me the defense argument", "What evidence is in the bundle?", "Summarize the case files", "What did the witness say?"

- "legal_advice" — The lawyer wants general legal strategy, tactical advice, or guidance on a HYPOTHETICAL or GENERAL situation NOT tied to any specific person or case fact. They describe a situation and want to know what to DO. Examples: "My vehicle got impounded what to do?", "What are my chances of winning a fraud case?", "How to challenge evidence in general?", "My client was arrested what should I do?", "What strategy should I use for a personal injury claim?"

- "hybrid" — The lawyer wants UK legal analysis applied to their specific case facts. They ask how law applies to specific case details. Examples: "Based on my case, which UK Act applies?", "Does the evidence support a Section 18 charge?", "How does the Limitation Act affect the claim?"

- "general" — A general UK law question not tied to any specific case or situation. Pure legal knowledge. Examples: "What is Section 18 of the Offences Against the Person Act?", "Explain the CPR Part 36 offer process", "What are the sentencing guidelines for fraud?"

KEY DISTINCTION: If the question mentions a specific person's name (e.g., "Balram Patel"), specific case details, or asks about facts/evidence/findings, it is "case_query". If the question describes a general situation and asks "what to do" without referencing specific case facts or people, it is "legal_advice".

Reply with ONLY the category name. Nothing else.`;

/* Fast local greeting detection — bypasses LLM entirely */
const GREETING_PATTERNS = /^\s*(h{0,1}(i{1,5}|ello|ey|owdy)|yo\b|sup\b|good\s*(morning|afternoon|evening|night|day)|gm\b|thanks?(\s*you)?|thankyou|thx|bye|goodbye|see\s*ya|cheers|whats?\s*up|how\s*are\s*you|how\s*do\s*you\s*do|welcome|namaste|greetings?|hola)\s*[!?.]*\s*$/i;

/**
 * Classify a user query to determine the correct response pipeline.
 * @param {string} question - The user's question
 * @param {string} [chatModel] - Override model for classification (uses cheapest available by default)
 * @returns {Promise<{intent: string, model: string}>}
 */
async function classify(question, chatModel) {
  /* Fast-path: catch greetings locally without burning an LLM call */
  if (GREETING_PATTERNS.test(question)) {
    logger.info(`Query classified as "greeting" (model: local-regex)`);
    return { intent: 'greeting', model: 'local-regex' };
  }

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
