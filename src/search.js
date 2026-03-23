/**
 * 検索モジュール
 * 
 * このファイルには以下が含まれています：
 * - expandQuery: 辞書ベースクエリ拡張
 * - extractKeywords: キーワード抽出
 * - BM25関連関数（calculateBM25Score, computeIDFScores, searchByBM25）
 * - キーワード検索（searchByKeywords, calculateKeywordScore）
 * - ベクトル検索（searchRelevantDocumentsVector）
 * - ハイブリッド検索（hybridSearch, enhancedHybridSearch, combineResults）
 * - チャンク取得（fetchRelevantChunks）
 */

/**
 * 辞書ベースクエリを拡張
 */
function expandQuery(originalQuery) {
  const searchParams = getSearchParams();

  if (!searchParams.SEARCH_QUERY_EXPANSION_ENABLED || !searchParams.SEARCH_DICT_EXPANSION_ENABLED) {
    return { expanded: originalQuery, expansions: [] };
  }

  logTrace("[QUERY:EXPAND:DICT] 辞書ベース拡張開始:", originalQuery);

  const expansions = [];
  const queryLower = originalQuery.toLowerCase();

  const useSynonyms = userProps.getProperty("QUERY_EXPANSION_USE_SYNONYMS") !== 'false';
  const useRelated = userProps.getProperty("QUERY_EXPANSION_USE_RELATED") !== 'false';
  const maxWords = parseInt(userProps.getProperty("QUERY_EXPANSION_MAX_WORDS")) || 5;

  if (useSynonyms) {
    for (const [baseWord, synonyms] of Object.entries(SYNONYMS)) {
      if (queryLower.includes(baseWord)) {
        expansions.push(...synonyms);
        logTrace("[QUERY:EXPAND:DICT] 同義語追加:", synonyms.join(", "));
      }
    }
  }

  if (useRelated) {
    for (const [keyword, related] of Object.entries(RELATED_WORDS)) {
      if (queryLower.includes(keyword)) {
        expansions.push(...related);
      }
    }
  }

  const uniqueExpansions = [...new Set(expansions)].slice(0, maxWords);

  const expandedQuery = uniqueExpansions.length > 0
    ? `${originalQuery} ${uniqueExpansions.join(" ")}`
    : originalQuery;

  logTrace("[QUERY:EXPAND:DICT] 辞書ベース拡張完了:", expandedQuery);

  return {
    expanded: expandedQuery,
    expansions: uniqueExpansions
  };
}

/**
 * テキストからキーワードを抽出
 */
function extractKeywords(text) {
  const cleaned = text.trim().toLowerCase();

  let keywords = cleaned
    .split(/[\s,.!?。、！？「」『』（）()\[\]　]+/)
    .filter(word => !/^[ぁ-んァ-ン]$/.test(word))
    .filter(word => word.length > 1)
    .filter(word => !STOP_WORDS.includes(word))
    .slice(0, 10);

  keywords = [...new Set(keywords)];
  return keywords;
}

/**
 * BM25スコアを計算
 */
function calculateBM25Score(docText, queryKeywords, avgDocLen, docLen, idfScores) {
  const bm25K1 = parseFloat(userProps.getProperty("BM25_K1")) || 1.5;
  const bm25B = parseFloat(userProps.getProperty("BM25_B")) || 0.75;

  let score = 0;

  for (const keyword of queryKeywords) {
    if (!idfScores[keyword]) continue;

    const keywordLower = keyword.toLowerCase();
    const docLower = docText.toLowerCase();

    const tf = (docLower.match(new RegExp(keywordLower, 'g')) || []).length;

    if (tf > 0) {
      const idf = idfScores[keyword];
      const numerator = tf * (bm25K1 + 1);
      const denominator = tf + bm25K1 * (1 - bm25B + bm25B * docLen / avgDocLen);
      score += idf * numerator / denominator;
    }
  }

  return score;
}

/**
 * IDFスコアをキャッシュまたは計算
 */
function computeIDFScores(sheet, keywords) {
  if (BM25_CACHE_CONFIG.ENABLE_IDF_CACHE) {
    try {
      const cache = CacheService.getScriptCache();
      if (cache) {
        const data = sheet.getDataRange().getValues();
        const docCount = data.length - 1;
        const cacheKey = "bm25_idf_" + docCount;
        
        const cached = cache.get(cacheKey);
        if (cached) {
          logTrace("[BM25:IDF] IDFキャッシュヒット! docCount:", docCount);
          const cachedData = JSON.parse(cached);
          return cachedData.idfScores || computeIDFScoresInternal(sheet, keywords);
        }
      }
    } catch (e) {
      logWarn("[BM25:IDF] キャッシュ取得エラー:", e.message);
    }
  }
  
  return computeIDFScoresInternal(sheet, keywords);
}

/**
 * IDFスコアを内部で計算
 */
function computeIDFScoresInternal(sheet, keywords) {
  const data = sheet.getDataRange().getValues();
  const docCount = data.length - 1;

  const idfScores = {};

  for (const keyword of keywords) {
    const keywordLower = keyword.toLowerCase();
    let df = 0;

    for (let i = 1; i < data.length; i++) {
      const chunk = (data[i][3] || "").toString().toLowerCase();
      if (chunk.includes(keywordLower)) {
        df++;
      }
    }

    if (df > 0) {
      idfScores[keyword] = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    }
  }

  return idfScores;
}

/**
 * BM25検索を実行
 */
function searchByBM25(queryText, topK = 30) {
  logTrace("[BM25] BM25検索開始:", queryText.substring(0, 50));

  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      logTrace("[BM25] インデックスが空です");
      return [];
    }

    const keywords = extractKeywords(queryText);
    logTrace("[BM25] 抽出キーワード:", keywords);

    if (keywords.length === 0) {
      return [];
    }

    const idfScores = computeIDFScores(sheet, keywords);

    let totalLen = 0;
    for (let i = 1; i < data.length; i++) {
      totalLen += ((data[i][3] || "").toString().length);
    }
    const avgDocLen = totalLen / (data.length - 1);

    const results = [];
    const BM25_THRESHOLD = 0.1;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = (getIndexField(row, 'TEXT_CHUNK') || "").toString();
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');
      const keywordsStored = getIndexField(row, 'KEYWORDS') || "";

      const docLen = chunk.length;
      const score = calculateBM25Score(chunk, keywords, avgDocLen, docLen, idfScores);

      if (score > BM25_THRESHOLD) {
        results.push({
          fileId, fileName, chunk, mimeType, score, chunkIndex,
          keywords: keywordsStored, source: 'bm25'
        });
      }
    }

    const sorted = results.sort((a, b) => b.score - a.score).slice(0, topK);
    logTrace("[BM25] 検索結果:", sorted.length, "件");
    return sorted;

  } catch (error) {
    logError("[BM25] エラー:", error);
    return [];
  }
}

/**
 * キーワードスコアを計算（メタデータ使用）
 */
function calculateKeywordScoreWithMetadata(storedKeywords, queryKeywords) {
  if (!storedKeywords || !queryKeywords) return 0;

  const stored = storedKeywords.toLowerCase().split(",").map(k => k.trim()).filter(k => k);
  const query = queryKeywords.map(k => k.toLowerCase());

  let totalScore = 0;
  let matchCount = 0;

  for (const qKeyword of query) {
    for (const sKeyword of stored) {
      if (sKeyword.includes(qKeyword) || qKeyword.includes(sKeyword)) {
        totalScore += 1.0;
        matchCount++;
        break;
      }
    }
  }

  if (matchCount === 0) return 0;

  const score = (totalScore / query.length) * Math.min(matchCount / 2, 1);
  return Math.min(score, 1.0);
}

/**
 * キーワードベースの検索を実行
 */
function searchByKeywords(queryText, topK = 50) {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return [];
    }

    const keywords = extractKeywords(queryText);

    if (keywords.length === 0) {
      return [];
    }

    const results = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = getIndexField(row, 'TEXT_CHUNK');
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');
      const storedKeywords = getIndexField(row, 'KEYWORDS') || "";

      const keywordScore = calculateKeywordScoreWithMetadata(storedKeywords, keywords);

      if (keywordScore > 0) {
        results.push({
          fileId, fileName, chunk, mimeType,
          score: keywordScore, chunkIndex,
          source: 'keyword', keywords: storedKeywords
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);

  } catch (error) {
    logError("[HYBRID] キーワード検索エラー:", error);
    return [];
  }
}

/**
 * ベクトル検索を実行
 */
function searchRelevantDocumentsVector(queryText, topK = 50) {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return [];
    }

    const queryEmbedding = getEmbeddingWithCache(queryText);
    if (!queryEmbedding) {
      return [];
    }

    const results = [];
    const SIMILARITY_THRESHOLD = 0.2;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = getIndexField(row, 'TEXT_CHUNK');
      const embeddingJson = getIndexField(row, 'EMBEDDING');
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');
      const charCount = getIndexField(row, 'CHAR_COUNT');
      const totalChunks = getIndexField(row, 'TOTAL_CHUNKS');
      const keywords = getIndexField(row, 'KEYWORDS') || "";

      try {
        const embedding = JSON.parse(embeddingJson);
        const similarity = cosineSimilarity(queryEmbedding, embedding);

        if (similarity > SIMILARITY_THRESHOLD) {
          results.push({
            fileId, fileName, chunk, mimeType, similarity, chunkIndex,
            source: 'vector',
            charCount: charCount || chunk.length,
            totalChunks: totalChunks || 1,
            keywords
          });
        }
      } catch (e) {}
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);

  } catch (error) {
    logError("[HYBRID] ベクトル検索エラー:", error);
    return [];
  }
}

/**
 * ベクトル検索結果とキーワード検索結果を統合
 */
function combineResults(vectorResults, keywordResults, config) {
  const resultMap = new Map();

  const maxVectorScore = Math.max(...vectorResults.map(r => r.similarity), 1);
  for (const r of vectorResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    resultMap.set(key, {
      fileId: r.fileId, fileName: r.fileName, chunk: r.chunk,
      chunkIndex: r.chunkIndex, mimeType: r.mimeType,
      vectorScore: r.similarity / maxVectorScore,
      keywordScore: 0, combinedScore: 0
    });
  }

  const maxKeywordScore = Math.max(...keywordResults.map(r => r.score), 1);
  for (const r of keywordResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).keywordScore = r.score / maxKeywordScore;
    } else {
      resultMap.set(key, {
        fileId: r.fileId, fileName: r.fileName, chunk: r.chunk,
        chunkIndex: r.chunkIndex, mimeType: r.mimeType,
        vectorScore: 0, keywordScore: r.score / maxKeywordScore, combinedScore: 0
      });
    }
  }

  for (const [key, result] of resultMap) {
    result.combinedScore =
      (result.vectorScore * config.VECTOR_WEIGHT) +
      (result.keywordScore * config.KEYWORD_WEIGHT);
  }

  return Array.from(resultMap.values());
}

/**
 * ハイブリッド検索を実行
 */
function hybridSearch(queryText, options = {}) {
  const config = {
    TOP_K_VECTOR: parseInt(userProps.getProperty("HYBRID_TOP_K_VECTOR")) || 50,
    TOP_K_FINAL: parseInt(userProps.getProperty("HYBRID_TOP_K_FINAL")) || 10,
    VECTOR_WEIGHT: parseFloat(userProps.getProperty("HYBRID_VECTOR_WEIGHT")) || 0.7,
    KEYWORD_WEIGHT: parseFloat(userProps.getProperty("HYBRID_KEYWORD_WEIGHT")) || 0.3,
    ...options
  };

  console.log("[HYBRID] 検索開始:", queryText.substring(0, 50));

  const vectorResults = searchRelevantDocumentsVector(queryText, config.TOP_K_VECTOR);
  const keywordResults = searchByKeywords(queryText, config.TOP_K_VECTOR);
  const combinedResults = combineResults(vectorResults, keywordResults, config);

  return combinedResults
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, config.TOP_K_FINAL);
}

/**
 * 拡張ハイブリッド検索を実行（ベクトル＋キーワード＋BM25）
 */
function enhancedHybridSearch(queryText, options = {}) {
  const config = {
    TOP_K_VECTOR: parseInt(userProps.getProperty("HYBRID_TOP_K_VECTOR")) || 50,
    TOP_K_FINAL: parseInt(userProps.getProperty("HYBRID_TOP_K_FINAL")) || 10,
    ...options
  };
  
  const TOP_K = config.TOP_K_FINAL || 20;
  const keywordEnabled = options.keywordEnabled !== false;
  const bm25Enabled = options.bm25Enabled !== false;

  logTrace("[ENHANCED:HYBRID] 検索開始:", queryText.substring(0, 50));

  const WEIGHTS = { VECTOR: 0.4, KEYWORD: 0.3, BM25: 0.3 };

  logTrace("[ENHANCED:HYBRID] ベクトル検索を実行中...");
  const vectorResults = searchRelevantDocumentsVector(queryText, config.TOP_K_VECTOR);
  logTrace("[ENHANCED:HYBRID] ベクトル検索結果:", vectorResults.length, "件");

  let keywordResults = [];
  if (keywordEnabled) {
    logTrace("[ENHANCED:HYBRID] キーワード検索を実行中...");
    keywordResults = searchByKeywords(queryText, config.TOP_K_VECTOR);
    logTrace("[ENHANCED:HYBRID] キーワード検索結果:", keywordResults.length, "件");
  }

  let bm25Results = [];
  if (bm25Enabled) {
    logTrace("[ENHANCED:HYBRID] BM25検索を実行中...");
    bm25Results = searchByBM25(queryText, config.TOP_K_VECTOR);
    logTrace("[ENHANCED:HYBRID] BM25検索結果:", bm25Results.length, "件");
  }

  logTrace("[ENHANCED:HYBRID] スコア統合中...");
  const combined = combineThreeResults(vectorResults, keywordResults, bm25Results, WEIGHTS);

  return combined.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, TOP_K);
}

/**
 * 3つの検索結果を統合（ベクトル＋キーワード＋BM25）
 */
function combineThreeResults(vectorResults, keywordResults, bm25Results, weights) {
  const resultMap = new Map();

  const maxVector = Math.max(...vectorResults.map(r => r.similarity), 1);
  for (const r of vectorResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    resultMap.set(key, {
      fileId: r.fileId, fileName: r.fileName, chunk: r.chunk,
      chunkIndex: r.chunkIndex, mimeType: r.mimeType,
      vectorScore: r.similarity / maxVector,
      keywordScore: 0, bm25Score: 0, combinedScore: 0,
      keywords: r.keywords, totalChunks: r.totalChunks
    });
  }

  const maxKeyword = Math.max(...keywordResults.map(r => r.score), 1);
  for (const r of keywordResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).keywordScore = r.score / maxKeyword;
    } else {
      resultMap.set(key, {
        fileId: r.fileId, fileName: r.fileName, chunk: r.chunk,
        chunkIndex: r.chunkIndex, mimeType: r.mimeType,
        vectorScore: 0, keywordScore: r.score / maxKeyword,
        bm25Score: 0, combinedScore: 0, keywords: r.keywords
      });
    }
  }

  const maxBM25 = Math.max(...bm25Results.map(r => r.score), 1);
  for (const r of bm25Results) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).bm25Score = r.score / maxBM25;
    } else {
      resultMap.set(key, {
        fileId: r.fileId, fileName: r.fileName, chunk: r.chunk,
        chunkIndex: r.chunkIndex, mimeType: r.mimeType,
        vectorScore: 0, keywordScore: 0,
        bm25Score: r.score / maxBM25, combinedScore: 0, keywords: r.keywords
      });
    }
  }

  for (const [key, result] of resultMap) {
    result.combinedScore =
      (result.vectorScore * weights.VECTOR) +
      (result.keywordScore * weights.KEYWORD) +
      (result.bm25Score * weights.BM25);
  }

  return Array.from(resultMap.values());
}

/**
 * クエリに関連するチャンクを取得
 */
function fetchRelevantChunks(queryText, maxCandidates = 50) {
  logTrace("[RAG] fetchRelevantChunks 開始:", queryText.substring(0, 50));
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();
    logTrace("[RAG] シート読み込み完了。行数:", data.length);

    if (data.length < 2) {
      logWarn("[RAG] インデックスがありません（ヘッダーのみ）");
      return [];
    }

    logTrace("[RAG] Embedding 取得開始...");
    const queryEmbedding = getEmbeddingWithCache(queryText);
    if (!queryEmbedding) {
      logError("[RAG] Query Embedding 取得失敗");
      return [];
    }
    logTrace("[RAG] Embedding 取得成功。ディメンション:", queryEmbedding.length);

    const SIMILARITY_THRESHOLD = 0.3;
    const results = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = getIndexField(row, 'TEXT_CHUNK');
      const embeddingJson = getIndexField(row, 'EMBEDDING');
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');

      try {
        const embedding = JSON.parse(embeddingJson);
        const similarity = cosineSimilarity(queryEmbedding, embedding);

        if (similarity > SIMILARITY_THRESHOLD) {
          results.push({ fileId, fileName, chunk, mimeType, similarity, chunkIndex });
        }
      } catch (e) {}
    }

    const sorted = results.sort((a, b) => b.similarity - a.similarity);
    const filtered = sorted.slice(0, maxCandidates);
    logTrace("[RAG] fetchRelevantChunks 結果:", filtered.length, "件");
    return filtered;
  } catch (error) {
    logError("[RAG] fetchRelevantChunks エラー:", error);
    return [];
  }
}

function parseExpansionResponse(response) {
  if (!response || typeof response !== "string") {
    return { expansions: [] };
  }

  const lines = response.split(/\r?\n/);
  const expansions = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    line = line.replace(/^[-*・●○◆■\d\.\)\(]+\s*/, "");
    if (/^[\W_]+$/.test(line)) continue;
    if (/[。．、,.]/.test(line) && line.split(" ").length > 3) continue;
    if (/^[ぁ-んー]$/.test(line)) continue;
    const stopwords = ["the", "a", "an", "of", "in", "on", "to", "for"];
    if (stopwords.includes(line.toLowerCase())) continue;
    if (line.length < 2) continue;
    expansions.push(line);
  }

  return { expansions: [...new Set(expansions)] };
}
