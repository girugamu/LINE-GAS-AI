/**
 * OpenAI Embedding API呼び出しモジュール
 * 
 * @module embedding
 * @description OpenAI Embedding API呼び出し
 * 
 * このファイルには以下が含まれています：
 * - getEmbedding: OpenAI Embedding API呼び出し
 * - getEmbeddingWithCache: キャッシュ付きEmbedding取得
 * 
 * @depends config, cache
 * @exports getEmbedding, getEmbeddingWithCache
 */

// ================================
//  Embedding 関数
// ================================

/**
 * OpenAI Embedding APIを使用してテキストのEmbeddingを取得
 */
function getEmbedding(text) {
  try {
    const payload = {
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8000)
    };

    const response = UrlFetchApp.fetch("https://api.openai.com/v1/embeddings", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENAI_API_KEY
      },
      payload: JSON.stringify(payload)
    });

    const json = JSON.parse(response.getContentText());
    return json.data[0].embedding;
  } catch (error) {
    logError("Embedding API エラー:", error);
    return null;
  }
}

/**
 * Embeddingをキャッシュから取得、またはAPIを呼び出して取得
 */
function getEmbeddingWithCache(text, options = {}) {
  try {
    let normalizedText = text;
    if (options.skipNormalization !== true) {
      normalizedText = normalizeTextForCache(text);
    }

    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, normalizedText);
    const hashStr = Utilities.base64Encode(hash).substring(0, 20);
    const cacheKey = "emb_" + hashStr;

    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE] CacheServiceが利用できません、APIを直接呼び出します");
      return getEmbedding(text);
    }

    const cached = cache.get(cacheKey);
    if (cached) {
      logTrace("[CACHE] Embedding キャッシュヒット:", hashStr);
      return JSON.parse(cached);
    }

    logTrace("[CACHE] Embedding キャッシュミス、API 呼び出し:", hashStr);
    const embedding = getEmbedding(text);
    if (embedding) {
      cache.put(cacheKey, JSON.stringify(embedding), EMBEDDING_CACHE_TTL_SECONDS);
    }
    return embedding;
  } catch (error) {
    logError("[CACHE] Embedding キャッシング エラー:", error);
    return getEmbedding(text);
  }
}
