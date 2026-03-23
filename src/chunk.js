/**
 * テキストのチャンク分割処理モジュール
 * 
 * @module chunk
 * @description テキストのチャンク分割処理
 * 
 * このファイルには以下が含まれています：
 * - splitTextIntoChunks: セマンティックチャンク分割
 * - normalizeTextForChunking: テキスト正規化
 * - analyzeTextStructure: テキスト構造解析
 * - semanticSplit: セマンティック分割
 * - postProcessChunks: チャンク後処理
 * 
 * @depends config
 * @exports splitTextIntoChunks, semanticSplit, basicSplit, splitLongChunkOnly, mergeSmallChunks, deduplicateChunks
 */

/**
 * セマンティックチャンク分割のメイン関数
 */
function splitTextIntoChunks(text) {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const config = CHUNK_CONFIG;
  const normalizedText = normalizeTextForChunking(text);
  const structure = analyzeTextStructure(normalizedText);

  let chunks;
  if (config.USE_SEMANTIC_SPLIT) {
    chunks = semanticSplit(normalizedText, structure, config);
  } else {
    chunks = basicSplit(normalizedText, config);
  }

  const processedChunks = postProcessChunks(chunks, config);
  return processedChunks.map(c => c.text);
}

/**
 * テキストの正規化（前処理）
 */
function normalizeTextForChunking(text) {
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  normalized = normalized.replace(/[ \t]+/g, ' ');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  return normalized;
}

/**
 * テキストの構造を解析
 */
function analyzeTextStructure(text) {
  const lines = text.split('\n');
  const structure = {
    lines: [],
    sections: [],
    headers: [],
    lists: []
  };

  let currentSection = { level: 0, title: '', startLine: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const lineInfo = {
      text: line,
      trimmed: trimmed,
      index: i,
      type: 'paragraph',
      headerLevel: 0,
      isListItem: false,
      sectionId: structure.sections.length
    };

    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      lineInfo.type = 'header';
      lineInfo.headerLevel = headerMatch[1].length;
      lineInfo.headerText = headerMatch[2];
      structure.headers.push({ line: i, level: lineInfo.headerLevel, text: headerMatch[2] });
      currentSection = { level: lineInfo.headerLevel, title: headerMatch[2], startLine: i };
      structure.sections.push(currentSection);
    } else if (trimmed.match(/^(\d+\.|\-|•|\*|\◦)\s+/)) {
      lineInfo.type = 'list';
      lineInfo.isListItem = true;
      structure.lists.push({ line: i, text: trimmed });
    } else if (trimmed === '') {
      lineInfo.type = 'empty';
    }

    structure.lines.push(lineInfo);
  }

  return structure;
}

/**
 * セマンティック分割
 */
function semanticSplit(text, structure, config) {
  const chunks = [];
  let currentChunk = {
    text: '',
    lines: [],
    importance: 0,
    sectionId: 0
  };

  const lines = structure.lines;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.type === 'empty') {
      continue;
    }

    const shouldStartNewChunk = shouldStartNewChunkSemantic(
      currentChunk, line, config, structure
    );

    if (shouldStartNewChunk) {
      if (currentChunk.text.trim().length > 0) {
        chunks.push(currentChunk);
      }

      let overlapText = '';
      if (config.CHUNK_OVERLAP > 0 && chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        overlapText = lastChunk.text.slice(-config.CHUNK_OVERLAP);
      }

      currentChunk = {
        text: overlapText + line.text,
        lines: [line],
        importance: calculateLineImportance(line, config),
        sectionId: line.sectionId
      };
    } else {
      currentChunk.text += '\n' + line.text;
      currentChunk.lines.push(line);
      currentChunk.importance = Math.max(
        currentChunk.importance,
        calculateLineImportance(line, config)
      );
    }
  }

  if (currentChunk.text.trim().length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * 新しいチャンクを開始すべきかを判断
 */
function shouldStartNewChunkSemantic(currentChunk, nextLine, config, structure) {
  const MIN_SIZE = config.MIN_CHUNK_SIZE || 200;
  const MAX_SIZE = config.MAX_CHUNK_SIZE || 1500;

  const currentLength = currentChunk.text.length;
  const nextLineLength = nextLine.text.length;

  if (config.PRIORITIZE_HEADERS && nextLine.type === 'header') {
    if (currentLength > MIN_SIZE) {
      return true;
    }
  }

  if (currentLength + nextLineLength > MAX_SIZE) {
    return true;
  }

  if (config.SENTENCE_AWARE && nextLine.type === 'paragraph') {
    if (currentLength >= MIN_SIZE) {
      const lastChar = currentChunk.text.trim().slice(-1);
      if (['。', '！', '？', '.', '!', '?'].includes(lastChar)) {
        return true;
      }
    }
  }

  if (config.CONTEXT_PRESERVATION && nextLine.isListItem) {
    const listCount = currentChunk.lines.filter(l => l.isListItem).length;
    if (listCount >= 10 && currentLength > MIN_SIZE) {
      return true;
    }
  }

  if (config.CONTEXT_PRESERVATION && nextLine.sectionId !== currentChunk.sectionId) {
    if (currentLength >= MIN_SIZE) {
      return true;
    }
  }

  return false;
}

/**
 * 行の重要度を計算
 */
function calculateLineImportance(line, config) {
  let importance = 1.0;

  if (config.BOOST_HEADERS && line.type === 'header') {
    importance *= (config.HEADER_BOOST_FACTOR || 2.0);
  }

  if (config.BOOST_LISTS && line.isListItem) {
    importance *= (config.LIST_BOOST_FACTOR || 1.5);
  }

  return importance;
}

/**
 * チャンクの後処理
 */
function postProcessChunks(chunks, config) {
  let processed = [...chunks];

  if (config.MERGE_SMALL_CHUNKS) {
    processed = mergeSmallChunks(processed, config);
  }

  if (config.SPLIT_LONG_CHUNKS) {
    processed = splitLongChunks(processed, config);
  }

  if (config.DEDUPLICATE_CHUNKS) {
    processed = deduplicateChunks(processed);
  }

  return processed;
}

/**
 * 小さいチャンクをマージ
 */
function mergeSmallChunks(chunks, config) {
  const MIN_SIZE = config.MIN_CHUNK_SIZE || 200;
  const MERGE_TARGET_SIZE = 500;

  const merged = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (merged.length === 0) {
      merged.push(chunk);
      continue;
    }

    if (chunk.text.length < MERGE_TARGET_SIZE && merged.length > 0) {
      const lastChunk = merged[merged.length - 1];
      lastChunk.text += '\n' + chunk.text;
      lastChunk.lines.push(...chunk.lines);
      lastChunk.importance = Math.max(lastChunk.importance, chunk.importance);
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

/**
 * 長いチャンクを分割
 */
function splitLongChunks(chunks, config) {
  const MAX_SIZE = config.MAX_CHUNK_SIZE || 1500;
  const CHUNK_SIZE = config.CHUNK_SIZE || 1000;
  const OVERLAP = config.CHUNK_OVERLAP || 100;

  const split = [];

  for (const chunk of chunks) {
    if (chunk.text.length <= MAX_SIZE) {
      split.push(chunk);
      continue;
    }

    const lines = chunk.text.split('\n');
    let currentText = '';
    let currentLines = [];

    for (const line of lines) {
      if (currentText.length + line.length > CHUNK_SIZE && currentText.length > 0) {
        split.push({
          text: currentText,
          lines: currentLines,
          importance: chunk.importance,
          sectionId: chunk.sectionId
        });

        const overlapText = currentText.slice(-OVERLAP);
        currentText = overlapText + '\n' + line;
        currentLines = [line];
      } else {
        currentText += (currentText ? '\n' : '') + line;
        currentLines.push(line);
      }
    }

    if (currentText.trim().length > 0) {
      split.push({
        text: currentText,
        lines: currentLines,
        importance: chunk.importance,
        sectionId: chunk.sectionId
      });
    }
  }

  return split;
}

/**
 * 重複チャンクを削除
 */
function deduplicateChunks(chunks) {
  const seen = new Set();
  const unique = [];

  for (const chunk of chunks) {
    const fingerprint = chunk.text.substring(0, 100).trim() + '|' +
      chunk.text.slice(-50).trim();

    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      unique.push(chunk);
    }
  }

  return unique;
}

/**
 * 基本的なチャンク分割
 */
function basicSplit(text, config) {
  const CHUNK_SIZE = config.CHUNK_SIZE || 1000;
  const CHUNK_OVERLAP = config.CHUNK_OVERLAP || 100;
  const MIN_CHUNK_SIZE = config.MIN_CHUNK_SIZE || 200;
  const MAX_CHUNK_SIZE = config.MAX_CHUNK_SIZE || 1500;

  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;

    if (currentChunk.length + trimmedParagraph.length <= CHUNK_SIZE) {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmedParagraph;
    } else {
      if (currentChunk) {
        chunks.push({ text: currentChunk, lines: [], importance: 1, sectionId: 0 });
      }

      if (chunks.length > 0 && CHUNK_OVERLAP > 0) {
        const lastChunk = chunks[chunks.length - 1];
        const overlapText = lastChunk.text.slice(-CHUNK_OVERLAP);
        currentChunk = overlapText + trimmedParagraph;
      } else {
        currentChunk = trimmedParagraph;
      }
    }
  }

  if (currentChunk) {
    chunks.push({ text: currentChunk, lines: [], importance: 1, sectionId: 0 });
  }

  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.text.length > MAX_CHUNK_SIZE) {
      const subChunks = splitLongChunkOnly(chunk.text, config);
      for (const sub of subChunks) {
        finalChunks.push({ text: sub, lines: [], importance: 1, sectionId: 0 });
      }
    } else if (chunk.text.length < MIN_CHUNK_SIZE && finalChunks.length > 0) {
      finalChunks[finalChunks.length - 1].text += '\n' + chunk.text;
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks;
}

/**
 * 長いチャンクのみを分割
 */
function splitLongChunkOnly(text, config) {
  const CHUNK_SIZE = config.CHUNK_SIZE || 1000;
  const CHUNK_OVERLAP = config.CHUNK_OVERLAP || 100;
  const MIN_CHUNK_SIZE = config.MIN_CHUNK_SIZE || 200;

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      const lastSpace = text.lastIndexOf(' ', end);
      const breakPoint = Math.max(lastNewline, lastSpace);
      if (breakPoint > start + MIN_CHUNK_SIZE) {
        end = breakPoint;
      }
    }

    const chunk = text.slice(start, end);
    chunks.push(chunk);
    start = end - CHUNK_OVERLAP;
    if (start < 0) start = 0;
  }

  return chunks;
}

// 後方互換性のための旧関数
function splitLargeChunk(text) {
  return splitLongChunkOnly(text, CHUNK_CONFIG);
}
