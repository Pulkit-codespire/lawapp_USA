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
 *   - system_query:  User asks about their database stats (case count, doc count, etc.)
 */

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../config/logger');
const { trackUsage } = require('./usageTracker');

const openai = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
const geminiClient = config.gemini?.apiKey ? new GoogleGenerativeAI(config.gemini.apiKey) : null;

const VALID_INTENTS = ['greeting', 'system_query', 'case_query', 'legal_advice', 'hybrid', 'general'];

const CLASSIFIER_PROMPT = `Classify the user's question into exactly ONE category. Reply with ONLY the category name.

Categories:
- greeting: casual hello, thanks, bye, small talk
- system_query: asks about database stats, counts, or lists — how many cases, documents, files uploaded, what cases exist
- case_query: asks about specific facts, people, evidence, dates from uploaded case documents
- legal_advice: wants advice on what to do in a situation (not about their uploaded docs)
- hybrid: wants UK law applied to their specific uploaded case documents
- general: pure UK law knowledge question

Examples:
"hi" → greeting
"hello" → greeting
"thanks" → greeting
"How many cases do we have?" → system_query
"How many documents are uploaded?" → system_query
"List all my cases" → system_query
"What files have been uploaded?" → system_query
"How many total documents?" → system_query
"Show me all cases" → system_query
"What was the coroner's conclusion for Balram Patel?" → case_query
"What was the court order date?" → case_query
"Show me the defense argument" → case_query
"Summarize my case files" → case_query
"What did the witness say?" → case_query
"My vehicle got impounded what to do?" → legal_advice
"My client was arrested what should I do?" → legal_advice
"How to challenge evidence?" → legal_advice
"What strategy should I use?" → legal_advice
"Based on my case, which UK Act applies?" → hybrid
"Does the evidence in my files support a Section 18 charge?" → hybrid
"What is Section 18 of the Offences Against the Person Act?" → general
"What are the sentencing guidelines for fraud?" → general
"Explain the CPR Part 36 offer process" → general

Reply with ONLY one word: greeting, system_query, case_query, legal_advice, hybrid, or general.`;

/* Fast local greeting detection — bypasses LLM entirely */
const GREETING_PATTERNS = /^\s*(h{0,1}(i{1,5}|ello|ey|owdy)|yo\b|sup\b|good\s*(morning|afternoon|evening|night|day)|gm\b|thanks?(\s*you)?|thankyou|thx|bye|goodbye|see\s*ya|cheers|whats?\s*up|how\s*are\s*you|how\s*do\s*you\s*do|welcome|namaste|greetings?|hola)\s*[!?.]*\s*$/i;

/* Fast local system query detection — catches common stats/count questions */
const SYSTEM_QUERY_PATTERNS = /\b(how\s*many\s*(total\s*)?(cases?|documents?|files?|pages?|chunks?)|total\s*(number|count)\s*(of\s*)?(cases?|documents?|files?)|list\s*(all\s*)?(my\s*)?(cases?|documents?|files?)|show\s*(me\s*)?(all\s*)?(cases?|documents?|files?)|what\s*(cases?|documents?|files?)\s*(do\s*)?(we|i)\s*have|count\s*(of\s*)?(cases?|documents?|files?))\b/i;

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

  /* Fast-path: catch system/stats queries locally */
  if (SYSTEM_QUERY_PATTERNS.test(question)) {
    logger.info(`Query classified as "system_query" (model: local-regex)`);
    return { intent: 'system_query', model: 'local-regex' };
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
 * Prefers: gemini-2.5-flash (free) > gpt-4o-mini (cheap) > user's chat model
 * @param {string} [chatModel]
 * @returns {string}
 * @private
 */
function _pickClassifierModel(chatModel) {
  /* Prefer free Gemini Flash for classification (fast + free) */
  if (geminiClient) return 'gemini-2.5-flash';
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
  const intent = _parseIntent(raw);
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
    generationConfig: {
      maxOutputTokens: 100,
      temperature: 0,
      /* Disable thinking for 2.5 models — they burn tokens on reasoning */
      ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  });

  /* Send prompt + question together as a single user message —
     systemInstruction was returning empty responses */
  const fullPrompt = `${CLASSIFIER_PROMPT}\n\nQuestion: "${question}"\n\nCategory:`;
  const result = await geminiModel.generateContent(fullPrompt);

  /* Debug: log full response structure to find why it's empty */
  const candidates = result.response.candidates || [];
  const blockReason = result.response.promptFeedback?.blockReason || 'none';
  const finishReason = candidates[0]?.finishReason || 'unknown';
  console.log(`🔍 Gemini debug — blockReason: ${blockReason}, finishReason: ${finishReason}, candidates: ${candidates.length}`);

  const raw = (result.response.text() || '').trim().toLowerCase();
  console.log(`🔍 Gemini raw response: "${raw}"`);
  const intent = _parseIntent(raw);
  const tokensUsed = result.response.usageMetadata?.totalTokenCount || 0;

  return { intent, tokensUsed };
}

/**
 * Parse LLM response into a valid intent.
 * Handles cases where LLM returns extra text like "case_query." or "The answer is: case_query"
 * @param {string} raw - Raw LLM response (already trimmed & lowercased)
 * @returns {string} Valid intent
 * @private
 */
function _parseIntent(raw) {
  /* Direct match */
  if (VALID_INTENTS.includes(raw)) return raw;

  /* Common partial matches */
  if (raw === 'legal' || raw === 'advice') return 'legal_advice';
  if (raw === 'case' || raw === 'query') return 'case_query';
  if (raw === 'system' || raw === 'stats') return 'system_query';

  /* Try to find a valid intent anywhere in the response */
  for (const intent of VALID_INTENTS) {
    if (raw.includes(intent)) {
      console.log(`⚠️  Classifier returned "${raw}", extracted: "${intent}"`);
      return intent;
    }
  }

  /* Nothing matched — fallback */
  console.log(`⚠️  Classifier returned unexpected: "${raw}", defaulting to hybrid`);
  return 'hybrid';
}

module.exports = { classify, VALID_INTENTS };
