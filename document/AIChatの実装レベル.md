# LINE-GAS-AI 実装レベル詳細解説

---

## 🔧 コア実装ポイント

### 1. Embeddingとコサイン類似度

```javascript
// 10-1: OpenAI Embedding API呼び出し
function getEmbedding(text) {
  const payload = {
    model: EMBEDDING_MODEL,  // "text-embedding-3-small"
    input: text.substring(0, 8000)  // 8000トークン制限
  };
  
  const response = UrlFetchApp.fetch("https://api.openai.com/v1/embeddings", {
    method: "post",
    headers: {
      "Authorization": "Bearer " + OPENAI_APIKEY
    },
    payload: JSON.stringify(payload)
  });
  
  return JSON.parse(response.getContentText()).data[0].embedding;
}

// 10-2: キャッシュ付きEmbedding（6時間TTL）
function getEmbeddingWithCache(text) {
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text);
  const cacheKey = "emb_" + Utilities.base64Encode(hash).substring(0, 20);
  
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  const embedding = getEmbedding(text);
  cache.put(cacheKey, JSON.stringify(embedding), 21600); // 6時間
  return embedding;
}

// 10-3: コサイン類似度計算
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
// 13-1: BM25スコア計算
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

// 13-2: IDFスコア事前計算
function computeIDFScores(sheet, keywords) {
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
```

---

### 3. セマンティックチャンク分割

```javascript
// 9-1: テキスト構造解析（見出し・リスト検出）
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

// 9-2: チャンク開始判定（セマンティック）
function shouldStartNewChunkSemantic(currentChunk, nextLine, config, structure) {
  const currentLength = currentChunk.text.length;
  
  // 見出しで新しいチャンク開始
  if (config.PRIORITIZE_HEADERS && nextLine.type === 'header' && currentLength > config.MIN_CHUNK_SIZE) {
    return true;
  }
  // サイズ超過
  if (currentLength + nextLine.text.length > config.MAX_CHUNK_SIZE) {
    return true;
  }
  // 文境界での分割
  if (config.SENTENCE_AWARE && currentLength >= config.MIN_CHUNK_SIZE) {
    const lastChar = currentChunk.text.trim().slice(-1);
    if (['。', '！', '？', '.', '!', '?'].includes(lastChar)) {
      return true;
    }
  }
  return false;
}
```

---

### 4. ハイブリッド検索（3つの結果統合）

```javascript
// 15: 3つの検索結果統合
function combineThreeResults(vectorResults, keywordResults, bm25Results, weights) {
  const resultMap = new Map();
  
  // ベクトル検索結果
  const maxVector = Math.max(...vectorResults.map(r => r.similarity), 1);
  for (const r of vectorResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    resultMap.set(key, {
      vectorScore: r.similarity / maxVector,
      keywordScore: 0,
      bm25Score: 0,
      ...r
    });
  }
  
  // キーワード検索結果（重複なければ追加）
  const maxKeyword = Math.max(...keywordResults.map(r => r.score), 1);
  for (const r of keywordResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).keywordScore = r.score / maxKeyword;
    } else {
      resultMap.set(key, { keywordScore: r.score / maxKeyword, vectorScore: 0, bm25Score: 0, ...r });
    }
  }
  
  // BM25検索結果（同様）
  const maxBM25 = Math.max(...bm25Results.map(r => r.score), 1);
  for (const r of bm25Results) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).bm25Score = r.score / maxBM25;
    } else {
      resultMap.set(key, { bm25Score: r.score / maxBM25, vectorScore: 0, keywordScore: 0, ...r });
    }
  }
  
  // 統合スコア計算
  for (const [key, result] of resultMap) {
    result.combinedScore =
      (result.vectorScore * weights.VECTOR) +
      (result.keywordScore * weights.KEYWORD) +
      (result.bm25Score * weights.BM25);
  }
  
  return Array.from(resultMap.values()).sort((a, b) => b.combinedScore - a.combinedScore);
}
```

---

### 5. LLMパラメータ動的適用

```javascript
// 17: ChatGPT API呼び出し（パラメータ柔軟対応）
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
  
  // その他のパラメータ
  if (llmParams.max_tokens) payload.max_tokens = llmParams.max_tokens;
  if (llmParams.presence_penalty) payload.presence_penalty = llmParams.presence_penalty;
  if (llmParams.frequency_penalty) payload.frequency_penalty = llmParams.frequency_penalty;
  if (llmParams.stop) payload.stop = llmParams.stop.split(',').map(s => s.trim());
  if (llmParams.response_format === 'json') payload.response_format = { type: "json_object" };
  
  const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "post",
    headers: { "Authorization": "Bearer " + OPENAI_APIKEY },
    payload: JSON.stringify(payload)
  });
  
  return JSON.parse(response.getContentText()).choices[0].message.content.trim();
}
```

---

### 6. リランキング（LLMによる再評価）

```javascript
// 14: LLMで検索結果再評価
function rerankResults(query, initialResults) {
  const candidates = initialResults.slice(0, 20); // 上位20件
  
  // プロンプト構築
  const documentsText = candidates.map((doc, i) => 
    `[${i + 1}] ${doc.fileName}\n---\n${doc.chunk.substring(0, 300)}...`
  ).join('\n');
  
  const prompt = `検索クエリ: ${query}\n\nドキュメント:\n${documentsText}\n\n各ドキュメントの関連性を0-10で評価してください。\n形式: 番号: スコア`;
  
  const response = callChatGPT([
    { role: "system", content: "あなたは検索結果評価の専門家です。" },
    { role: "user", content: prompt }
  ], 0.3);
  
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
  })).sort((a, b) => b.rerankScore - a.rerankScore).slice(0, 5);
}
```

---

### 7. ユーザー分離キャッシュ

```javascript
// 4: ユーザー別のクエリキャッシュ
function getQueryCache(originalQuery, userId) {
  const hashedUserId = hashUserId(userId);  // SHA-256ハッシュ化（最初の16文字）
  const queryHash = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, originalQuery)
  ).substring(0, 16);
  
  const cacheKey = "rag_cache_v2_" + hashedUserId + "_" + queryHash;
  const cache = CacheService.getScriptCache();
  
  const cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached).results;
  }
  return null;
}

function setQueryCache(originalQuery, results, userId) {
  const hashedUserId = hashUserId(userId);
  const cacheKey = "rag_cache_v2_" + hashedUserId + "_" + 
    Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, originalQuery)).substring(0, 16);
  
  const cacheData = { results, timestamp: new Date().toISOString() };
  cache.put(cacheKey, JSON.stringify(cacheData), 3600); // 1時間TTL
}
```

---

### 8. 差分インデックス更新

```javascript
// 20: 増量更新ロジック
function incrementalIndexGoogleDrive() {
  const lastIndexTime = getLastIndexTime();
  const currentMapping = getFileMapping();
  const newMapping = {};
  
  // 全ファイル取得
  const allFiles = [];
  const mimeTypes = [MimeType.GOOGLE_DOCS, MimeType.GOOGLE_SHEETS, MimeType.PDF, ...];
  for (const mimeType of mimeTypes) {
    const iterator = folder.getFilesByType(mimeType);
    while (iterator.hasNext()) allFiles.push(iterator.next());
  }
  
  for (const file of allFiles) {
    const fileId = file.getId();
    const lastUpdated = file.getLastUpdated().toISOString();
    newMapping[fileId] = lastUpdated;
    
    if (!currentMapping[fileId]) {
      // 新規ファイル → インデックス追加
      indexSingleFile(sheet, file, fileId, fileName, mimeType);
    } else if (currentMapping[fileId] !== lastUpdated) {
      // 更新ファイル → 削除→追加
      deleteChunksByFileId(sheet, fileId);
      indexSingleFile(sheet, file, fileId, fileName, mimeType);
    }
  }
  
  // 削除されたファイルはインデックスから除去
  setFileMapping(newMapping);
  setLastIndexTime(new Date());
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

### 3. エラー耐性
- 各ファイル形式変換でフォールバック処理
- 空チャンクのスキップ
- キャッシュ失敗時のAPI直接呼び出し

---

## 📈 パフォーマンス最適化

| 最適化手法 | 実装 |
|----------|------|
| Embeddingキャッシュ | 6時間TTL（CacheService） |
| クエリ結果キャッシュ | 1時間TTL、類似度閾値0.85 |
| 会話履歴 | 直近10件のみ保持 |
| チャンク選択 | 文字数上限3000、超過時は前から順次選択 |
| インデックス分割 | ファイル変更時のみ再インデックス |

---

以上がこのプログラムの技術的な実装詳細です。