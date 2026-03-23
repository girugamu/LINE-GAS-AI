/**
 * クエリ・Embeddingキャッシュ管理モジュール
 * 
 * @module cache
 * @description クエリ・Embeddingキャッシュ管理
 * 
 * このファイルには以下が含まれています：
 * - ユーザー別の結果キャッシュ（クエリ結果の保存・取得）
 * - 類似度ベースのキャッシュ検索
 * - キャッシュキーのレジストリ管理
 * - Embeddingキャッシュ
 * - テキスト正規化関数群
 * 
 * @depends config
 * @exports getQueryCache, setQueryCache, clearAllQueryCaches, clearEmbeddingCache, findSimilarQueryCache
 */

// ================================
//  Embedding テキスト正規化関数群
// ================================

/**
 * Embedding用テキスト正規化関数
 * 
 * 処理順序: JSON → 自然文 → 正規化 → MD5 → キャッシュキー
 * 
 * 【追加した正規化】
 * ✓ 全角・半角の統一
 * ✓ 全角スペース → 半角スペース
 * ✓ 連続空白・改行の統一
 * ✓ 記号の揺らぎ統一
 * ✓ 数値は文字列に統一
 */
function normalizeTextForCache(text) {
  if (!text || typeof text !== "string") return "";
  
  let normalized = text;
  
  // 1. 全角数字を半角に変換
  normalized = normalized.replace(/[０-９]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
  });
  
  // 2. 全角アルファベットを半角に変換
  normalized = normalized.replace(/[Ａ-Ｚａ-ｚ]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
  });
  
  // 3. 全角スペース → 半角スペース
  normalized = normalized.replace(/\u3000/g, ' ');
  
  // 4. 連続空白を1つに（タブ含む）
  normalized = normalized.replace(/[ \t]+/g, ' ');
  
  // 5. 連続改行を2つ以下に
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  
  // 6. 記号の揺らぎを統一
  normalized = normalized.replace(/・/g, '-');
  normalized = normalized.replace(/：/g, ':');
  normalized = normalized.replace(/，/g, ',');
  normalized = normalized.replace(/．/g, '.');
  normalized = normalized.replace(/？/g, '?');
  normalized = normalized.replace(/！/g, '!');
  
  // 7. 前後の空白を削除
  normalized = normalized.trim();
  
  // 8. 複数行の空白を整理
  normalized = normalized.split('\n').map(line => line.trim()).join('\n');
  
  // 9. 連続する空行を1つにする
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  
  return normalized;
}

/**
 * JSONオブジェクトのキーをソートして正規化
 */
function normalizeJsonForCache(obj) {
  if (!obj) return "";
  
  try {
    const sorted = {};
    Object.keys(obj).sort().forEach(key => {
      const value = obj[key];
      if (typeof value === 'number') {
        sorted[key] = String(value);
      } else if (typeof value === 'object' && value !== null) {
        sorted[key] = normalizeJsonForCache(value);
      } else {
        sorted[key] = value;
      }
    });
    
    return JSON.stringify(sorted, null, 0);
  } catch (error) {
    logWarn("[NORMALIZE:JSON] 正規化エラー:", error.message);
    return JSON.stringify(obj);
  }
}

/**
 * Embeddingキャッシュ用のテキストを正規化
 */
function normalizeForEmbeddingCache(input) {
  if (!input) return "";
  
  if (typeof input === "object") {
    const sortedJson = normalizeJsonForCache(input);
    const naturalText = convertObjectToNaturalText(input);
    return normalizeTextForCache(naturalText || sortedJson);
  }
  
  return normalizeTextForCache(String(input));
}

/**
 * オブジェクトを自然言語テキストに変換
 */
function convertObjectToNaturalText(obj) {
  if (!obj || typeof obj !== "object") return String(obj);
  
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join(', ');
}

// ================================
//  結果キャッシュ関数群
// ================================

/**
 * ユーザー別の結果キャッシュを取得
 * 類似した過去のクエリ結果が保存されていれば再利用
 */
function getQueryCache(originalQuery, userId, options = {}) {
  if (!QUERY_CACHE_CONFIG.ENABLE_CACHE) return null;

  const useSimilarity = options.useSimilarity !== false && QUERY_CACHE_CONFIG.SIMILARITY_CACHE_ENABLED;

  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE:QUERY] CacheServiceが利用できません");
      return null;
    }

    const hashedUserId = hashUserId(userId);

    // 完全一致チェック
    const queryHash = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, originalQuery)
    ).substring(0, 16);

    const cacheKey = "rag_cache_" + QUERY_CACHE_CONFIG.CACHE_VERSION + "_" + hashedUserId + "_" + queryHash;
    const cached = cache.get(cacheKey);

    if (cached) {
      logTrace("[CACHE:QUERY] 完全一致キャッシュヒット! user(hash):", hashedUserId);
      const cacheData = JSON.parse(cached);
      return cacheData.results;
    }

    logTrace("[CACHE:QUERY] 完全一致キャッシュミス user(hash):", hashedUserId);

    // 類似度ベースのキャッシュ検索
    if (useSimilarity) {
      const similarResult = findSimilarQueryCache(originalQuery, userId, hashedUserId);
      if (similarResult) {
        return similarResult;
      }
    }

    return null;

  } catch (error) {
    logError("[CACHE:QUERY] エラー:", error);
    return null;
  }
}

/**
 * 類似度ベースでキャッシュを検索
 */
function findSimilarQueryCache(currentQuery, userId, hashedUserId) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) return null;

    const currentEmbedding = getEmbeddingWithCache(currentQuery);
    if (!currentEmbedding) {
      logTrace("[CACHE:SIMILAR] Embedding取得失敗");
      return null;
    }

    const registry = getCacheKeyRegistry();
    const userCachePrefix = "rag_cache_" + QUERY_CACHE_CONFIG.CACHE_VERSION + "_" + hashedUserId;

    let bestMatch = null;
    let bestSimilarity = 0;

    logTrace("[CACHE:SIMILAR] 類似キャッシュ検索開始 - user(hash):", hashedUserId);

    for (const cacheKey of registry) {
      if (!cacheKey.startsWith(userCachePrefix)) continue;

      try {
        const cached = cache.get(cacheKey);
        if (!cached) continue;

        const cacheData = JSON.parse(cached);
        
        if (!cacheData.queryEmbedding) continue;

        const similarity = cosineSimilarity(currentEmbedding, cacheData.queryEmbedding);

        logTrace("[CACHE:SIMILAR] 類似度計算 - similarity:", similarity.toFixed(3));

        if (similarity >= QUERY_CACHE_CONFIG.SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestMatch = {
            results: cacheData.results,
            originalQuery: cacheData.query,
            similarity: similarity
          };
        }
      } catch (e) {
        logWarn("[CACHE:SIMILAR] キャッシュ読み取りエラー:", e.message);
      }
    }

    if (bestMatch) {
      logInfo("[CACHE:SIMILAR] 類似キャッシュヒット! similarity:", bestMatch.similarity.toFixed(3));
      return bestMatch.results;
    }

    logTrace("[CACHE:SIMILAR] 類似キャッシュなし");
    return null;

  } catch (error) {
    logError("[CACHE:SIMILAR] 類似キャッシュ検索エラー:", error);
    return null;
  }
}

/**
 * ユーザー別の結果キャッシュを保存
 */
function setQueryCache(originalQuery, results, userId) {
  if (!QUERY_CACHE_CONFIG.ENABLE_CACHE) return;

  try {
    const cache = CacheService.getScriptCache();

    const hashedUserId = hashUserId(userId);

    const queryHash = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, originalQuery)
    ).substring(0, 16);

    const cacheKey = "rag_cache_" + QUERY_CACHE_CONFIG.CACHE_VERSION + "_" + hashedUserId + "_" + queryHash;

    const cacheData = {
      query: originalQuery,
      results: results,
      timestamp: new Date().toISOString(),
      userId: hashedUserId
    };

    if (QUERY_CACHE_CONFIG.SIMILARITY_CACHE_ENABLED) {
      try {
        const queryEmbedding = getEmbeddingWithCache(originalQuery);
        if (queryEmbedding) {
          cacheData.queryEmbedding = queryEmbedding;
          logTrace("[CACHE:QUERY] Embeddingを保存");
        }
      } catch (embeddingError) {
        logWarn("[CACHE:QUERY] Embedding保存エラー:", embeddingError.message);
      }
    }

    cache.put(cacheKey, JSON.stringify(cacheData), QUERY_CACHE_CONFIG.CACHE_TTL_SECONDS);

    addCacheKey(cacheKey);

    logTrace("[CACHE:QUERY] キャッシュ保存完了 user(hash):", hashedUserId);

  } catch (error) {
    logError("[CACHE:QUERY] 保存エラー:", error);
  }
}

// ================================
//  キャッシュキーのレジストリ管理
// ================================

/**
 * キャッシュキーのレジストリを取得
 */
function getCacheKeyRegistry() {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE:REGISTRY] CacheServiceが利用できません");
      return [];
    }

    const registryJson = cache.get(CACHE_KEY_REGISTRY);
    return registryJson ? JSON.parse(registryJson) : [];
  } catch (error) {
    logError("[CACHE:REGISTRY] レジストリ取得エラー:", error);
    return [];
  }
}

/**
 * キャッシュキーをレジストリに追加
 */
function addCacheKey(cacheKey) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE:REGISTRY] CacheServiceが利用できません");
      return;
    }

    const registry = getCacheKeyRegistry();
    if (!registry.includes(cacheKey)) {
      registry.push(cacheKey);
      if (registry.length > QUERY_CACHE_CONFIG.MAX_CACHED_QUERIES) {
        registry.shift();
      }
      cache.put(CACHE_KEY_REGISTRY, JSON.stringify(registry), 21600);
    }
  } catch (error) {
    logError("[CACHE:REGISTRY] キー追加エラー:", error);
  }
}

/**
 * 全てのクエリキャッシュをクリア
 */
function clearAllQueryCaches() {
  let deletedCount = 0;
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logError("[CACHE:CLEAR] CacheServiceが利用できません");
      return 0;
    }

    const registry = getCacheKeyRegistry();

    logInfo("[CACHE:CLEAR] レジストリ内のキャッシュ数:", registry.length);

    for (const cacheKey of registry) {
      try {
        cache.remove(cacheKey);
        deletedCount++;
      } catch (e) {
        logWarn("[CACHE:CLEAR] キー削除エラー:", cacheKey, e.message);
      }
    }

    cache.remove(CACHE_KEY_REGISTRY);
    logInfo("[CACHE:CLEAR] 削除完了:", deletedCount, "件");
  } catch (error) {
    logError("[CACHE:CLEAR] 全削除エラー:", error);
  }
  return deletedCount;
}

/**
 * Embeddingキャッシュをクリア
 */
function clearEmbeddingCache() {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE] CacheServiceが利用できません");
      return 0;
    }

    logInfo("[CACHE] EmbeddingキャッシュはCacheServiceで管理されています");
    logInfo("[CACHE] キャッシュは6時間後に自動的に期限切れになります");
    return 0;
  } catch (error) {
    logError("[CACHE] Embeddingキャッシュクリアエラー:", error);
    return 0;
  }
}
