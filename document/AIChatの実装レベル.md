# LINE-GAS-AI 実装レベル詳細解説

---

## 🔧 コア実装ポイント

### 1. Embeddingとコサイン類似度

```javascript
// 1-1: OpenAI Embedding API呼び出し
function getEmbedding(text) {
  const payload = {
    model: EMBEDDING_MODEL,  // "text-embedding-3-small"
    input: text.substring(0, 8000)  // 8000トークン制限
  };
  
  const response = UrlFetchApp.fetch("https://api.openai.com/v1/embeddings", {
    method: "post",
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY
    },
    payload: JSON.stringify(payload)
  });
  
  return JSON.parse(response.getContentText()).data[0].embedding;
}

// 1-2: キャッシュ付きEmbedding（6時間TTL）
function getEmbeddingWithCache(text) {
  const normalizedText = normalizeTextForCache(text);
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, normalizedText);
  const cacheKey = "emb_" + Utilities.base64Encode(hash).substring(0, 20);
  
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  const embedding = getEmbedding(text);
  cache.put(cacheKey, JSON.stringify(embedding), 21600); // 6時間
  return embedding;
}

// 1-3: コサイン類似度計算
function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return (magA && magB) ? dotProduct / (magA * magB) : 0;
}
```

---

### 2. BM25検索の実装

```javascript
// 2-1: BM25スコア計算
function calculateBM25Score(docText, queryKeywords, avgDocLen, docLen, idfScores) {
  const bm25K1 = parseFloat(userProps.getProperty("BM25_K1")) || 1.5;
  const bm25B = parseFloat(userProps.getProperty("BM25_B")) || 0.75;
  
  let score = 0;
  for (const keyword of queryKeywords) {
    if (!idfScores[keyword]) continue;
    
    const tf = (docText.toLowerCase().match(new RegExp(keyword.toLowerCase(), 'g')) || []).length;
    
    if (tf > 0) {
      const idf = idfScores[keyword];
      const numerator = tf * (bm25K1 + 1);
      const denominator = tf + bm25K1 * (1 - bm25B + bm25B * docLen / avgDocLen);
      score += idf * numerator / denominator;
    }
  }
  return score;
}

// 2-2: IDFスコア事前計算（キャッシュ対応）
function computeIDFScores(sheet, keywords) {
  // キャッシュチェック
  if (BM25_CACHE_CONFIG.ENABLE_IDF_CACHE) {
    const cache = CacheService.getScriptCache();
    const cached = cache.get("bm25_idf_" + docCount);
    if (cached) return JSON.parse(cached).idfScores;
  }
  
  const data = sheet.getDataRange().getValues();
  const docCount = data.length - 1;
  
  const idfScores = {};
  for (const keyword of keywords) {
    let df = 0;
    for (let i = 1; i < data.length; i++) {
      if ((data[i][3] || "").toString().toLowerCase().includes(keyword.toLowerCase())) {
        df++;
      }
    }
    if (df > 0) {
      idfScores[keyword] = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    }
  }
  return idfScores;
}

// 2-3: BM25検索
function searchByBM25(queryText, topK = 30) {
  const keywords = extractKeywords(queryText);
  const idfScores = computeIDFScores(sheet, keywords);
  const avgDocLen = totalLen / (data.length - 1);
  
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const score = calculateBM25Score(chunk, keywords, avgDocLen, docLen, idfScores);
    if (score > BM25_THRESHOLD) {
      results.push({ fileId, fileName, chunk, score, source: 'bm25' });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}
```

---

### 3. セマンティックチャンク分割

```javascript
// 3-1: テキスト構造解析（見出し・リスト検出）
function analyzeTextStructure(text) {
  const lines = text.split('\n');
  const structure = { lines: [], sections: [], headers: [], lists: [] };
  
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineInfo = { text: lines[i], trimmed, index: i, type: 'paragraph' };
    
    // Markdown見出し検出
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      lineInfo.type = 'header';
      lineInfo.headerLevel = headerMatch[1].length;
      structure.headers.push({ line: i, level: headerMatch[1].length, text: headerMatch[2] });
    }
    // リスト項目検出
    else if (trimmed.match(/^(\d+\.|\-|•|\*|\◦)\s+/)) {
      lineInfo.type = 'list';
      lineInfo.isListItem = true;
    }
    
    structure.lines.push(lineInfo);
  }
  return structure;
}

// 3-2: チャンク開始判定（セマンティック）
function shouldStartNewChunkSemantic(currentChunk, nextLine, config, structure) {
  const currentLength = currentChunk.text.length;
  const MIN_SIZE = config.MIN_CHUNK_SIZE || 200;
  const MAX_SIZE = config.MAX_CHUNK_SIZE || 1500;
  
  // 見出しで新しいチャンク開始
  if (config.PRIORITIZE_HEADERS && nextLine.type === 'header' && currentLength > MIN_SIZE) {
    return true;
  }
  // サイズ超過
  if (currentLength + nextLine.text.length > MAX_SIZE) {
    return true;
  }
  // 文境界での分割
  if (config.SENTENCE_AWARE && currentLength >= MIN_SIZE) {
    const lastChar = currentChunk.text.trim().slice(-1);
    if (['。', '！', '？', '.', '!', '?'].includes(lastChar)) {
      return true;
    }
  }
  return false;
}

// 3-3: チャンク後処理
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
```

---

### 4. 段落復元チャンク化（preprocess.js）

```javascript
// 4-1: 段落復元メイン関数
function restoreParagraphs(text, options = {}) {
  const config = { ...PARAGRAPH_CHUNK_CONFIG, ...options };
  
  // ステップ1: テキストの前処理
  const normalizedText = preprocessText(text, config);
  
  // ステップ2: 段落の検出
  const paragraphs = detectParagraphs(normalizedText, config);
  
  // ステップ3: 見出しの検出と分類
  const paragraphsWithHeaders = detectAndClassifyHeaders(paragraphs, config);
  
  // ステップ4: 見出しと本文の結合
  const mergedParagraphs = mergeHeadersWithBody(paragraphsWithHeaders, config);
  
  // ステップ5: 短かいチャンクのマージ
  const finalParagraphs = mergeSmallParagraphs(mergedParagraphs, config);
  
  // ステップ6: チャンク化
  const chunks = createChunks(finalParagraphs, config);
  
  return { paragraphs: finalParagraphs, chunks, metadata: {...} };
}

// 4-2: 見出し検出（複数パターン対応）
function detectHeader(text, config) {
  // マークダウン形式: # 見出し
  if (/^#{1,6}\s+/.test(trimmed)) {
    return { isHeader: true, level: match[1].length, type: 'markdown', confidence: 0.95 };
  }
  // 番号付き: 第1章、第○節
  if (/^第[一二三四五六七八九十百千０-９0-9]+[部章節項条号編]+[:：.]?\s*/u.test(trimmed)) {
    return { isHeader: true, type: 'numbered', confidence: 0.95 };
  }
  // キーワード見出し: 【見出し】、《見出し》
  if (/^[【\[【].+[】\]]$/.test(trimmed)) {
    return { isHeader: true, type: 'special', confidence: 0.8 };
  }
  // ... 他多数のパターン
}

// 4-3: 見出しと本文の結合
function mergeHeadersWithBody(paragraphs, config) {
  for (let i = 0; i < paragraphs.length; i++) {
    if (current.isHeader && next && !next.isHeader) {
      // 見出しと本文を結合
      combined = {
        ...current,
        text: `${current.text}\n\n${next.text}`,
        hasBody: true
      };
    }
  }
}
```

---

### 5. ハイブリッド検索（3つの結果統合）

```javascript
// 5-1: 拡張ハイブリッド検索
function enhancedHybridSearch(queryText, options = {}) {
  const TOP_K = config.TOP_K_FINAL || 20;
  const WEIGHTS = { VECTOR: 0.4, KEYWORD: 0.3, BM25: 0.3 };
  
  // 3つの検索を並列実行
  const vectorResults = searchRelevantDocumentsVector(queryText, TOP_K);
  const keywordResults = searchByKeywords(queryText, TOP_K);
  const bm25Results = searchByBM25(queryText, TOP_K);
  
  // 結果統合
  const combined = combineThreeResults(vectorResults, keywordResults, bm25Results, WEIGHTS);
  
  return combined.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, TOP_K);
}

// 5-2: 3つの検索結果統合
function combineThreeResults(vectorResults, keywordResults, bm25Results, weights) {
  const resultMap = new Map();
  
  // ベクトル検索結果（正規化済みsimilarity）
  const maxVector = Math.max(...vectorResults.map(r => r.similarity), 1);
  for (const r of vectorResults) {
    resultMap.set(`${r.fileId}_${r.chunkIndex}`, {
      vectorScore: r.similarity / maxVector,
      keywordScore: 0, bm25Score: 0, ...r
    });
  }
  
  // キーワード検索結果
  const maxKeyword = Math.max(...keywordResults.map(r => r.score), 1);
  for (const r of keywordResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).keywordScore = r.score / maxKeyword;
    } else {
      resultMap.set(key, { keywordScore: r.score / maxKeyword, ...r });
    }
  }
  
  // BM25検索結果
  const maxBM25 = Math.max(...bm25Results.map(r => r.score), 1);
  for (const r of bm25Results) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).bm25Score = r.score / maxBM25;
    } else {
      resultMap.set(key, { bm25Score: r.score / maxBM25, ...r });
    }
  }
  
  // 統合スコア計算
  for (const [key, result] of resultMap) {
    result.combinedScore =
      (result.vectorScore * weights.VECTOR) +
      (result.keywordScore * weights.KEYWORD) +
      (result.bm25Score * weights.BM25);
  }
  
  return Array.from(resultMap.values());
}
```

---

### 6. LLMパラメータ動的適用（llm.js）

```javascript
// 6-1: ChatGPT API呼び出し（パラメータ柔軟対応）
function callChatGPT(messages, overrideTemperature) {
  const llmParams = getLlmParams();
  const currentModel = llmParams.model || GPT_MODEL;
  
  const payload = {
    model: currentModel,
    messages: messages,
    temperature: (overrideTemperature !== undefined) ? overrideTemperature : llmParams.temperature
  };
  
  // top_p（常に有効）
  if (llmParams.top_p) payload.top_p = llmParams.top_p;
  
  // top_k（モデルがサポートしている場合のみ）
  if (supportsTopK(currentModel) && llmParams.top_k) {
    payload.top_k = llmParams.top_k;
  }
  
  // max_tokens（gpt-5.x系はmax_completion_tokens）
  if (llmParams.max_tokens) {
    if (currentModel.startsWith('gpt-5.')) {
      payload.max_completion_tokens = llmParams.max_tokens;
    } else {
      payload.max_tokens = llmParams.max_tokens;
    }
  }
  
  // その他のパラメータ
  if (llmParams.presence_penalty) payload.presence_penalty = llmParams.presence_penalty;
  if (llmParams.frequency_penalty) payload.frequency_penalty = llmParams.frequency_penalty;
  if (llmParams.stop) payload.stop = llmParams.stop.split(',').map(s => s.trim());
  if (llmParams.response_format === 'json') payload.response_format = { type: "json_object" };
  
  const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "post",
    headers: { "Authorization": "Bearer " + OPENAI_API_KEY },
    payload: JSON.stringify(payload)
  });
  
  return JSON.parse(response.getContentText()).choices[0].message.content.trim();
}

// 6-2: LLMパラメータ定義（config.js）
const LLM_PARAM_DEFINITIONS = {
  'LLM_MODEL': {
    defaultValue: 'gpt-4o-mini',
    paramName: 'model',
    isSelect: true,
    options: ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4']
  },
  'LLM_TEMPERATURE': { defaultValue: '0.7', paramName: 'temperature', min: 0, max: 2 },
  'LLM_TOP_P': { defaultValue: '1.0', paramName: 'top_p', min: 0, max: 1 },
  'LLM_TOP_K': { defaultValue: '40', paramName: 'top_k', min: 1, max: 100 },
  'LLM_MAX_COMPLETION_TOKENS': { defaultValue: '2048', paramName: 'max_tokens' },
  'LLM_PRESENCE_PENALTY': { defaultValue: '0', paramName: 'presence_penalty', min: -2, max: 2 },
  'LLM_FREQUENCY_PENALTY': { defaultValue: '0', paramName: 'frequency_penalty', min: -2, max: 2 },
  'LLM_RESPONSE_FORMAT': {
    defaultValue: 'text',
    paramName: 'response_format',
    isSelect: true,
    options: ['text', 'json']
  }
};
```

---

### 7. リランキング（LLMによる再評価）

```javascript
// 7: LLMで検索結果再評価
function rerankResults(query, initialResults) {
  const rerankInitialTopK = parseInt(userProps.getProperty("RERANK_INITIAL_TOP_K")) || 20;
  const rerankFinalTopK = parseInt(userProps.getProperty("RERANK_FINAL_TOP_K")) || 5;
  const rerankModel = userProps.getProperty("RERANK_MODEL") || GPT_MODEL;
  
  const candidates = initialResults.slice(0, rerankInitialTopK);
  
  // プロンプト構築
  const documentsText = candidates.map((doc, i) => 
    `[${i + 1}] ${doc.fileName}${doc.chunkIndex !== undefined ? ` (チャンク ${doc.chunkIndex})` : ''}
---
${(doc.chunk || "").substring(0, 300)}...`
  ).join('\n');
  
  const prompt = buildPromptFromTemplate('PROMPT_RERANK', {
    query: query,
    documents: documentsText
  });
  
  const response = callChatGPTRerank([
    { role: "system", content: "あなたは検索結果の関連性を評価する専門家です。" },
    { role: "user", content: prompt }
  ], 0.3, rerankModel);
  
  // スコアパース: "1: 8\n2: 3\n3: 10" → {1: 8, 2: 3, 3: 10}
  const scores = {};
  response.split('\n').forEach(line => {
    const match = line.match(/^(\d+):\s*(\d+)/);
    if (match) scores[parseInt(match[1])] = parseInt(match[2]);
  });
  
  // スコア適用して再ソート
  return candidates.map((doc, i) => ({
    ...doc,
    rerankScore: scores[i + 1] || 0
  })).sort((a, b) => b.rerankScore - a.rerankScore).slice(0, rerankFinalTopK);
}
```

---

### 8. ユーザー分離キャッシュ（cache.js）

```javascript
// 8-1: 完全一致キャッシュ
function getQueryCache(originalQuery, userId) {
  const hashedUserId = hashUserId(userId);  // SHA-256ハッシュ化
  const queryHash = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, originalQuery)
  ).substring(0, 16);
  
  const cacheKey = "rag_cache_v2_" + hashedUserId + "_" + queryHash;
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached).results;
  return null;
}

// 8-2: 類似度ベースのキャッシュ検索
function findSimilarQueryCache(currentQuery, userId, hashedUserId) {
  const currentEmbedding = getEmbeddingWithCache(currentQuery);
  const registry = getCacheKeyRegistry();
  
  let bestMatch = null;
  let bestSimilarity = 0;
  
  for (const cacheKey of registry) {
    const cached = JSON.parse(cache.get(cacheKey));
    if (cached.queryEmbedding) {
      const similarity = cosineSimilarity(currentEmbedding, cached.queryEmbedding);
      if (similarity >= SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = cached.results;
      }
    }
  }
  return bestMatch;
}

// 8-3: キャッシュ保存（Embedding含む）
function setQueryCache(originalQuery, results, userId) {
  const cacheData = {
    query: originalQuery,
    results: results,
    timestamp: new Date().toISOString(),
    userId: hashedUserId
  };
  
  if (QUERY_CACHE_CONFIG.SIMILARITY_CACHE_ENABLED) {
    const queryEmbedding = getEmbeddingWithCache(originalQuery);
    if (queryEmbedding) cacheData.queryEmbedding = queryEmbedding;
  }
  
  cache.put(cacheKey, JSON.stringify(cacheData), CACHE_TTL_SECONDS);
  addCacheKey(cacheKey);
}
```

---

### 9. RAG拡張版ChatGPT呼び出し（chat_message.js）

```javascript
// 9: callChatGPTWithRAGEnhanced
function callChatGPTWithRAGEnhanced(userMessage, history, userId, additionalContext) {
  // 1. キャッシュ確認
  const cachedResults = getQueryCache(userMessage, userId);
  if (cachedResults) return cachedResults;
  
  const searchParams = getSearchParams();
  
  // 2. クエリ拡張（辞書 + LLM）
  let searchQuery = userMessage;
  if (searchParams.SEARCH_QUERY_EXPANSION_ENABLED) {
    // 辞書ベース拡張
    if (searchParams.SEARCH_DICT_EXPANSION_ENABLED) {
      const dictResult = expandQuery(userMessage);
      searchQuery = dictResult.expanded;
    }
    // LLM拡張
    if (searchParams.SEARCH_LLM_EXPANSION_ENABLED) {
      const prompt = buildPromptFromTemplate('PROMPT_QUERY_EXPANSION', { query: searchQuery });
      const llmResponse = callChatGPT([{ role: "user", content: prompt }]);
      const llmResult = parseExpansionResponse(llmResponse);
      searchQuery = `${searchQuery} ${llmResult.expansions.join(" ")}`;
    }
  }
  
  // 3. ハイブリッド検索
  const candidates = enhancedHybridSearch(searchQuery, {
    TOP_K_FINAL: 50,
    keywordEnabled: searchParams.SEARCH_KEYWORD_ENABLED,
    bm25Enabled: searchParams.SEARCH_BM25_ENABLED
  });
  
  // 4. リランキング
  if (searchParams.SEARCH_RERANK_ENABLED) {
    candidates = rerankResults(userMessage, candidates);
  }
  
  // 5. コンテキスト選択（最大3000文字）
  const selected = selectContextChunks(candidates, MAX_CONTEXT_CHARS);
  
  // 6. ChatGPT呼び出し
  const context = buildContext(selected, additionalContext);
  const promptResult = generateFullPrompt(context);
  const messages = buildChatMessages(promptResult, history);
  const response = callChatGPT(messages);
  
  // 7. 結果キャッシュ保存
  setQueryCache(userMessage, response, userId);
  
  return response + buildReferenceUrls(selected);
}
```

---

### 10. 自律検索エージェント（chat_message.js）

```javascript
// 10: 反復エージェントモード
function callChatGPTWithAgentIterative(userMessage, history, userId, options) {
  const { continueIteration, maxIterations } = options;
  const MIN_CONFIDENCE = AGENT_MODE_CONFIG.MIN_CONFIDENCE || 0.7;
  
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // 検索実行
    const searchResults = enhancedHybridSearch(currentQuery, {...});
    
    // 検索結果評価
    const evaluation = evaluateSearchResults(query, searchResults, context);
    
    if (!evaluation.needsMoreSearch || evaluation.confidence >= MIN_CONFIDENCE) {
      // 情報が十分 → 最終回答生成
      return generateFinalResponse(userMessage, allResults, thinkingLog, history);
    }
    
    // 追加検索キーワード生成
    if (evaluation.needsMoreSearch) {
      const additionalTerms = generateAdditionalSearchTerms(query, allResults, evaluation);
      currentQuery = currentQuery + " " + additionalTerms.join(" ");
    }
    
    // 状態を保存して中断
    saveAgentState(sessionId, { currentQuery, allResults, iteration, userMessage });
    return { isComplete: false, partialResponse, thinkingInfo };
  }
  
  return generateFinalResponse(userMessage, allResults, thinkingLog, history);
}
```

---

### 11. 差分インデックス更新（rag_sheet.js）

```javascript
// 11: 増量更新ロジック
function incrementalIndexGoogleDrive() {
  const lastIndexTime = getLastIndexTime();
  const currentMapping = getFileMapping();
  const newMapping = {};
  
  // 全ファイル取得（サブフォルダ含む）
  const mimeTypes = [
    MimeType.GOOGLE_DOCS, MimeType.GOOGLE_SHEETS,
    MimeType.PDF, MimeType.MICROSOFT_WORD,
    MimeType.MICROSOFT_EXCEL, MimeType.MICROSOFT_POWERPOINT,
    "text/plain", "text/csv", "text/markdown"
  ];
  const allFiles = getAllFilesRecursive(folder, mimeTypes, visitedFolders);
  
  for (const file of allFiles) {
    const fileId = file.getId();
    const lastUpdated = file.getLastUpdated().toISOString();
    newMapping[fileId] = lastUpdated;
    
    if (!currentMapping[fileId]) {
      // 新規ファイル → インデックス追加
      indexSingleFile(sheet, file, fileId, fileName, mimeType);
      addedCount++;
    } else if (currentMapping[fileId] !== lastUpdated) {
      // 更新ファイル → 削除→追加
      deleteChunksByFileId(sheet, fileId);
      indexSingleFile(sheet, file, fileId, fileName, mimeType);
      updatedCount++;
    } else {
      unchangedCount++;
    }
  }
  
  // 削除されたファイルはインデックスから除去
  setFileMapping(newMapping);
  setLastIndexTime(new Date());
  
  return { added: addedCount, updated: updatedCount, unchanged: unchangedCount };
}
```

---

### 12. 表構造抽出（extract.js）

```javascript
// 12: PDF/画像から表データを抽出
function extractTableWithStructure(fileId, fileName, mimeType) {
  const document = getVisionDocument(fileId, fileName);
  const tableData = detectTableFromVisionDocument(document);
  
  return {
    records: tableData,
    chunks: tableData.map(record => ({
      jsonString: JSON.stringify(record),
      naturalText: convertTableRecordToNaturalLanguage(record),
      embedding: getEmbeddingWithCache(naturalText)
    }))
  };
}

// 12-2: Vision Document取得
function getVisionDocument(fileId, fileName) {
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  const base64Data = Utilities.base64Encode(blob.getBytes());
  
  const payload = {
    requests: [{
      image: { content: base64Data },
      features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }]
    }]
  };
  
  const response = UrlFetchApp.fetch(
    "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey,
    { method: "post", headers: {"Content-Type": "application/json"}, payload: JSON.stringify(payload) }
  );
  
  return JSON.parse(response.getContentText()).responses[0].fullTextAnnotation;
}
```

---

## 🐛 実装上の注意点

### 1. GASの制約
- **実行時間**: 6分（有料ユーザーは30分）
- **URL Fetch**: 1回あたり約100KB
- **CacheService**: キーごとに最大100KB、合計1MB
- **PropertiesService**: ScriptPropertiesは合計9KB、UserPropertiesは合計500KB

### 2. 文字数制限対応
- LINEメッセージ: 最大5000文字
- Embedding入力: 最大8000トークン
- コンテキスト: 最大3000文字（設定可）

### 3. API呼び出し間隔
- Embedding API: 6時間TTLのキャッシュで削減
- ChatGPT API: ユーザー別結果キャッシュ（1時間TTL）
- インデックス登録: 300ms間隔でsleep

### 4. エラー耐性
- 各ファイル形式変換でフォールバック処理
- 空チャンクのスキップ
- キャッシュ失敗時のAPI直接呼び出し

---

## 📈 パフォーマンス最適化

| 最適化手法 | 実装 |
|----------|------|
| Embeddingキャッシュ | 6時間TTL（CacheService） |
| IDFキャッシュ | BM25のidfScoresをキャッシュ |
| クエリ結果キャッシュ | 1時間TTL、類似度閾値0.80 |
| 会話履歴 | 直近10件のみ保持 |
| チャンク選択 | 文字数上限3000、超過時は前から順次選択 |
| インデックス分割 | ファイル変更時のみ再インデックス |

---

以上がこのプログラムの技術的な実装詳細です。
