/**
 * @module services/ingestion/chunker
 * @description Legal-aware text chunking with section detection and token counting.
 */

const { encodingForModel } = require('js-tiktoken');
const logger = require('../../config/logger');
const config = require('../../config');
const { SECTION_PATTERNS } = require('../../utils/constants');

const encoding = encodingForModel('gpt-4o');

/**
 * @typedef {Object} TextChunk
 * @property {string} text - Chunk text content
 * @property {number} chunkIndex - Position in sequence
 * @property {string} section - Detected section type
 * @property {number|null} pageNumber - Source page number
 * @property {number} tokenCount - Token count for this chunk
 */

/**
 * Split text into legal-aware chunks with overlap.
 * @param {string} text - Full document text
 * @param {number} [maxTokens] - Max tokens per chunk
 * @param {number} [overlap] - Token overlap between chunks
 * @returns {TextChunk[]} Array of text chunks
 */
function chunk(text, maxTokens, overlap) {
  const maxTok = maxTokens || config.ingestion.chunkSize;
  const overlapTok = overlap || config.ingestion.chunkOverlap;

  if (!text || text.trim().length === 0) {
    return [];
  }

  const pageSegments = _splitByPages(text);
  const sections = _detectSections(pageSegments);
  const chunks = [];

  for (const section of sections) {
    const sectionChunks = _splitToTokenChunks(section.text, maxTok, overlapTok);

    for (const chunkText of sectionChunks) {
      chunks.push({
        text: chunkText,
        chunkIndex: chunks.length,
        section: section.section,
        pageNumber: section.pageNumber,
        tokenCount: countTokens(chunkText),
      });
    }
  }

  logger.info(`Chunked text into ${chunks.length} chunks (max ${maxTok} tokens, ${overlapTok} overlap)`);
  return chunks;
}

/**
 * Count tokens in a text string using tiktoken.
 * @param {string} text - Text to count
 * @returns {number} Token count
 */
function countTokens(text) {
  if (!text) return 0;
  return encoding.encode(text).length;
}

/**
 * Split text by page markers (--- Page N ---).
 * @param {string} text
 * @returns {Array<{text: string, pageNumber: number}>}
 * @private
 */
function _splitByPages(text) {
  const pagePattern = /---\s*Page\s+(\d+)\s*---/gi;
  const parts = text.split(pagePattern);

  if (parts.length <= 1) {
    return [{ text: text.trim(), pageNumber: 1 }];
  }

  const segments = [];
  for (let i = 0; i < parts.length; i += 2) {
    const pageText = (parts[i] || '').trim();
    const pageNum = parts[i + 1] ? parseInt(parts[i + 1], 10) : segments.length + 1;

    if (pageText.length > 0) {
      segments.push({ text: pageText, pageNumber: pageNum });
    }
  }

  return segments.length > 0 ? segments : [{ text: text.trim(), pageNumber: 1 }];
}

/**
 * Detect legal sections within page segments.
 * @param {Array<{text: string, pageNumber: number}>} pageSegments
 * @returns {Array<{text: string, section: string, pageNumber: number}>}
 * @private
 */
function _detectSections(pageSegments) {
  const sections = [];

  for (const segment of pageSegments) {
    const lines = segment.text.split('\n');
    let currentSection = 'general';
    let currentText = [];

    for (const line of lines) {
      const detected = _identifySection(line);

      if (detected && currentText.length > 0) {
        sections.push({
          text: currentText.join('\n').trim(),
          section: currentSection,
          pageNumber: segment.pageNumber,
        });
        currentText = [];
      }

      if (detected) {
        currentSection = detected;
      }
      currentText.push(line);
    }

    if (currentText.length > 0) {
      sections.push({
        text: currentText.join('\n').trim(),
        section: currentSection,
        pageNumber: segment.pageNumber,
      });
    }
  }

  return sections.filter((s) => s.text.length > 0);
}

/**
 * Identify section type from a line of text.
 * @param {string} line
 * @returns {string|null} Section name or null
 * @private
 */
function _identifySection(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  for (const { pattern, section } of SECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return section;
    }
  }
  return null;
}

/**
 * Split text into token-sized chunks with overlap.
 * @param {string} text
 * @param {number} maxTokens
 * @param {number} overlapTokens
 * @returns {string[]} Array of chunk texts
 * @private
 */
function _splitToTokenChunks(text, maxTokens, overlapTokens) {
  const paragraphs = text.split(/\n\s*\n|\n/).filter((p) => p.trim().length > 0);
  const chunks = [];
  let currentParts = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraTokens = countTokens(para);

    if (paraTokens > maxTokens) {
      if (currentParts.length > 0) {
        chunks.push(currentParts.join('\n\n'));
        currentParts = _getOverlapParts(currentParts, overlapTokens);
        currentTokens = currentParts.reduce((sum, p) => sum + countTokens(p), 0);
      }
      const sentences = _splitBySentences(para, maxTokens);
      chunks.push(...sentences);
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && currentParts.length > 0) {
      chunks.push(currentParts.join('\n\n'));
      currentParts = _getOverlapParts(currentParts, overlapTokens);
      currentTokens = currentParts.reduce((sum, p) => sum + countTokens(p), 0);
    }

    currentParts.push(para);
    currentTokens += paraTokens;
  }

  if (currentParts.length > 0) {
    chunks.push(currentParts.join('\n\n'));
  }

  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Get trailing parts that fit within the overlap budget.
 * @param {string[]} parts
 * @param {number} targetTokens
 * @returns {string[]}
 * @private
 */
function _getOverlapParts(parts, targetTokens) {
  const overlap = [];
  let tokens = 0;

  for (let i = parts.length - 1; i >= 0; i--) {
    const partTokens = countTokens(parts[i]);
    if (tokens + partTokens > targetTokens) break;
    overlap.unshift(parts[i]);
    tokens += partTokens;
  }

  return overlap;
}

/**
 * Split a single paragraph into sentence-level chunks.
 * @param {string} paragraph
 * @param {number} maxTokens
 * @returns {string[]}
 * @private
 */
function _splitBySentences(paragraph, maxTokens) {
  const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence);

    if (currentTokens + sentenceTokens > maxTokens && current.length > 0) {
      chunks.push(current.join(' '));
      current = [];
      currentTokens = 0;
    }

    current.push(sentence.trim());
    currentTokens += sentenceTokens;
  }

  if (current.length > 0) {
    chunks.push(current.join(' '));
  }

  return chunks;
}

module.exports = { chunk, countTokens };
