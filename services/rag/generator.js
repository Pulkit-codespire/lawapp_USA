/**
 * @module services/rag/generator
 * @description Answer generation using OpenAI or Google Gemini with legal system prompt.
 */

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../config');
const logger = require('../../config/logger');
const { NO_DATA_PHRASES, MAX_CHAT_HISTORY } = require('../../utils/constants');
const { ExternalServiceError } = require('../../utils/errors');

const openai = new OpenAI({ apiKey: config.openai.apiKey });
const geminiClient = config.gemini?.apiKey
  ? new GoogleGenerativeAI(config.gemini.apiKey)
  : null;

/**
 * Check if a model name belongs to Gemini.
 * @param {string} model
 * @returns {boolean}
 */
function _isGeminiModel(model) {
  return model.startsWith('gemini');
}

/** Legal system prompt enforcing grounded answers */
const LEGAL_SYSTEM_PROMPT = `You are a legal research assistant. You help lawyers find information from their case files.

CRITICAL RULES:
1. ONLY answer based on the provided document excerpts below.
2. If the documents don't contain the answer, say "I could not find this information in your case files."
3. NEVER use your general knowledge to answer legal questions.
4. NEVER fabricate case names, section numbers, dates, or rulings.
5. Every claim MUST have a source citation in this format: 📄 [FileName] — Page X, Section Y
6. If you are unsure, recommend the lawyer verify in the original document.
7. This is a research tool, NOT legal advice. Always remind the user of this when relevant.`;

/**
 * @typedef {Object} GeneratedAnswer
 * @property {string} answer
 * @property {Array} sources
 * @property {string} confidence
 * @property {number} confidenceScore
 * @property {number} tokensUsed
 * @property {string} model
 */

/**
 * Generate an answer from retrieved chunks using GPT-4o.
 * @param {string} query - User's question
 * @param {Array} chunks - Retrieved and reranked chunks
 * @param {Array} [chatHistory=[]] - Previous conversation messages
 * @returns {Promise<GeneratedAnswer>}
 */
async function generate(query, chunks, chatHistory = [], aiOverrides = {}) {
  const context = _buildContext(chunks);
  const messages = _buildMessages(query, context, chatHistory);

  const model = aiOverrides.model || config.chat.model;
  const maxTokens = aiOverrides.maxTokens || config.chat.maxTokens;
  const temperature = aiOverrides.temperature !== undefined ? aiOverrides.temperature : config.chat.temperature;

  try {
    let answer;
    let tokensUsed = 0;

    if (_isGeminiModel(model)) {
      ({ answer, tokensUsed } = await _generateWithGemini(model, messages, maxTokens, temperature));
    } else {
      const response = await openai.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature });
      answer = response.choices[0]?.message?.content || 'Unable to generate a response.';
      tokensUsed = response.usage?.total_tokens || 0;
    }

    const sources = _extractSources(chunks);
    const { confidence, confidenceScore } = _assessConfidence(chunks, answer);

    logger.info(`Generated answer: ${answer.length} chars, ${tokensUsed} tokens, model: ${model}, confidence: ${confidence}`);

    return {
      answer,
      sources,
      confidence,
      confidenceScore,
      tokensUsed,
      model: config.chat.model,
    };
  } catch (err) {
    throw new ExternalServiceError(`LLM generation failed (${model}): ${err.message}`);
  }
}

/**
 * Build context string from retrieved chunks.
 * @param {Array} chunks
 * @returns {string}
 * @private
 */
function _buildContext(chunks) {
  return chunks.map((chunk, idx) => {
    const source = `[Source ${idx + 1}: ${chunk.fileName}, Page ${chunk.pageNumber || 'N/A'}, Section: ${chunk.section}]`;
    return `${source}\n${chunk.text}`;
  }).join('\n\n---\n\n');
}

/**
 * Build messages array for OpenAI API.
 * @param {string} query
 * @param {string} context
 * @param {Array} chatHistory
 * @returns {Array}
 * @private
 */
function _buildMessages(query, context, chatHistory) {
  const messages = [{ role: 'system', content: LEGAL_SYSTEM_PROMPT }];

  const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  const userMessage = context.length > 0
    ? `Based on the following document excerpts:\n\n${context}\n\nQuestion: ${query}`
    : `Question: ${query}\n\n(No relevant documents were found for this query.)`;

  messages.push({ role: 'user', content: userMessage });
  return messages;
}

/**
 * Extract unique source references from chunks.
 * @param {Array} chunks
 * @returns {Array}
 * @private
 */
function _extractSources(chunks) {
  const seen = new Set();

  return chunks
    .filter((chunk) => {
      const key = `${chunk.fileName}:${chunk.pageNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((chunk) => ({
      file_name: chunk.fileName,
      case_name: chunk.caseName,
      page_number: chunk.pageNumber,
      section: chunk.section,
      document_type: chunk.documentType,
      relevance_score: Math.min(1.0, Math.round(chunk.similarity * 100) / 100),
      snippet: chunk.text.slice(0, 200),
    }));
}

/**
 * Assess confidence level based on chunk quality and answer content.
 * @param {Array} chunks
 * @param {string} answer
 * @returns {{confidence: string, confidenceScore: number}}
 * @private
 */
function _assessConfidence(chunks, answer) {
  const lowerAnswer = answer.toLowerCase();
  const hasNoDataPhrase = NO_DATA_PHRASES.some((phrase) => lowerAnswer.includes(phrase));

  if (hasNoDataPhrase) {
    return { confidence: 'low', confidenceScore: 0.2 };
  }

  const avgSimilarity = chunks.length > 0
    ? chunks.reduce((sum, c) => sum + c.similarity, 0) / chunks.length
    : 0;

  const HIGH_SIM = 0.85;
  const MED_SIM = 0.75;
  const LOW_SIM = 0.65;
  const MIN_HIGH_CHUNKS = 3;
  const MIN_MED_CHUNKS = 2;

  if (avgSimilarity > HIGH_SIM && chunks.length >= MIN_HIGH_CHUNKS) {
    return { confidence: 'high', confidenceScore: Math.min(avgSimilarity, 0.95) };
  }
  if (avgSimilarity > MED_SIM && chunks.length >= MIN_MED_CHUNKS) {
    return { confidence: 'medium', confidenceScore: avgSimilarity };
  }
  if (avgSimilarity > LOW_SIM) {
    return { confidence: 'low', confidenceScore: avgSimilarity };
  }

  return { confidence: 'low', confidenceScore: Math.max(avgSimilarity, 0.1) };
}

/**
 * General knowledge system prompt — used when no case files are found.
 * Clearly states the answer is NOT from the user's documents.
 */
const GENERAL_SYSTEM_PROMPT = `You are a legal research assistant with general legal knowledge.

IMPORTANT CONTEXT:
- The user's case files database has NO matching documents for this query.
- You are answering from GENERAL legal knowledge, NOT from the user's case files.
- Always start your answer with: "⚠️ No matching case files found. Here is general legal guidance:"
- Provide helpful, accurate legal information.
- Remind the user this is general knowledge and NOT specific legal advice.
- Suggest they upload relevant case files for more specific answers.`;

/**
 * Generate an answer from OpenAI general knowledge (no documents).
 * @param {string} query - User's question
 * @param {Array} [chatHistory=[]] - Previous conversation messages
 * @returns {Promise<GeneratedAnswer>}
 */
async function generateGeneral(query, chatHistory = [], aiOverrides = {}) {
  const messages = [{ role: 'system', content: GENERAL_SYSTEM_PROMPT }];

  const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: query });

  const model = aiOverrides.model || config.chat.model;
  const maxTokens = aiOverrides.maxTokens || config.chat.maxTokens;
  const temperature = aiOverrides.temperature !== undefined ? aiOverrides.temperature : config.chat.temperature;

  try {
    let answer;
    let tokensUsed = 0;

    if (_isGeminiModel(model)) {
      ({ answer, tokensUsed } = await _generateWithGemini(model, messages, maxTokens, temperature));
    } else {
      const response = await openai.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature });
      answer = response.choices[0]?.message?.content || 'Unable to generate a response.';
      tokensUsed = response.usage?.total_tokens || 0;
    }

    logger.info(`General answer: ${answer.length} chars, ${tokensUsed} tokens, model: ${model}`);

    return {
      answer,
      sources: [],
      confidence: 'general',
      confidenceScore: 0,
      tokensUsed,
      model: config.chat.model,
    };
  } catch (err) {
    throw new ExternalServiceError(`LLM generation failed (${model}): ${err.message}`);
  }
}

/**
 * Generate an answer using Google Gemini API.
 * Converts OpenAI-style messages array to Gemini format.
 * @param {string} model - Gemini model name
 * @param {Array} messages - OpenAI-style messages array
 * @param {number} maxTokens
 * @param {number} temperature
 * @returns {Promise<{answer: string, tokensUsed: number}>}
 * @private
 */
async function _generateWithGemini(model, messages, maxTokens, temperature) {
  if (!geminiClient) {
    throw new ExternalServiceError('GEMINI_API_KEY is not configured. Add it to your .env file.');
  }

  /* Separate system prompt from conversation */
  const systemMsg = messages.find((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');

  const geminiModel = geminiClient.getGenerativeModel({
    model,
    systemInstruction: systemMsg?.content || '',
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  });

  /* Convert OpenAI message format to Gemini history format */
  let history = conversation.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  /* Gemini requires first message to be 'user' — drop leading model messages */
  while (history.length > 0 && history[0].role === 'model') {
    history.shift();
  }

  /* Gemini requires alternating user/model — merge consecutive same-role messages */
  history = history.reduce((acc, msg) => {
    if (acc.length > 0 && acc[acc.length - 1].role === msg.role) {
      acc[acc.length - 1].parts[0].text += '\n\n' + msg.parts[0].text;
    } else {
      acc.push(msg);
    }
    return acc;
  }, []);

  const lastMessage = conversation[conversation.length - 1]?.content || '';

  const chat = geminiModel.startChat({ history });
  const result = await chat.sendMessage(lastMessage);
  const answer = result.response.text() || 'Unable to generate a response.';
  const tokensUsed = result.response.usageMetadata?.totalTokenCount || 0;

  return { answer, tokensUsed };
}

module.exports = { generate, generateGeneral };
