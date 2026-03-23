/**
 * リランキングモジュール
 * 
 * このファイルには以下が含まれています：
 * - rerankResults: LLMを使用して検索結果をリランキング
 * - buildRerankPrompt: リランキング用プロンプト生成
 * - parseRerankResponse: LLMレスポンスからスコアをパース
 */

/**
 * LLMを使用して検索結果をリランキング
 */
function rerankResults(query, initialResults) {
  const searchParams = getSearchParams();
  const rerankEnabled = searchParams.SEARCH_RERANK_ENABLED;

  const rerankInitialTopK = parseInt(userProps.getProperty("RERANK_INITIAL_TOP_K")) || 20;
  const rerankFinalTopK = parseInt(userProps.getProperty("RERANK_FINAL_TOP_K")) || 5;
  const rerankModel = userProps.getProperty("RERANK_MODEL") || GPT_MODEL;

  if (!rerankEnabled || initialResults.length <= rerankFinalTopK) {
    logTrace("[RERANK] リランキングスキップ（候補数が少ない）");
    return initialResults;
  }

  logTrace("[RERANK] リランキング開始 - 候補数:", initialResults.length, "- 使用モデル:", rerankModel);

  try {
    const candidates = initialResults.slice(0, rerankInitialTopK);
    const rankingPrompt = buildRerankPrompt(query, candidates);

    const messages = [
      {
        role: "system",
        content: "あなたは検索結果の関連性を評価する専門家です。与えられた検索クエリとドキュメントを比較し、関連性スコアを0から10の整数で評価してください。"
      },
      { role: "user", content: rankingPrompt }
    ];

    logTrace("[RERANK] LLMに順位付けを依頼中... モデル:", rerankModel);
    const response = callChatGPTRerank(messages, 0.3, rerankModel);

    const scores = parseRerankResponse(response, candidates.length);

    if (Object.keys(scores).length === 0) {
      logTrace("[RERANK] スコアパース失敗、元の順序を維持");
      return initialResults;
    }

    const reranked = candidates.map((doc, i) => ({
        ...doc,
        rerankScore: scores[i + 1] || 0
      })).sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, rerankFinalTopK);

    logTrace("[RERANK] リランキング完了");
    reranked.forEach((r, i) => {
      logTrace(`  [${i + 1}] ${r.fileName} (リランキングスコア: ${r.rerankScore})`);
    });

    return reranked;

  } catch (error) {
    logError("[RERANK] エラー:", error);
    return initialResults;
  }
}

/**
 * リランキング用プロンプトを生成
 */
function buildRerankPrompt(query, candidates) {
  const documentsText = candidates.map((doc, i) => {
    return `[${i + 1}] ${doc.fileName}${doc.chunkIndex !== undefined ? ` (チャンク ${doc.chunkIndex})` : ''}
---
${(doc.chunk || "").substring(0, 300)}...`;
  }).join('\n');

  const prompt = buildPromptFromTemplate('PROMPT_RERANK', {
    query: query,
    documents: documentsText
  });

  logTrace('[RERANK] プロンプト生成完了（テンプレート使用）');

  return prompt;
}

/**
 * LLMのレスポンスからリランキングスコアをパース
 */
function parseRerankResponse(response, maxDocs) {
  const scores = {};
  const lines = response.split('\n');

  for (const line of lines) {
    const match = line.match(/^(\d+):\s*(\d+)/);
    if (match) {
      const docNum = parseInt(match[1]);
      const score = parseInt(match[2]);
      if (docNum >= 1 && docNum <= maxDocs && score >= 0 && score <= 10) {
        scores[docNum] = score;
      }
    }
  }

  return scores;
}

/**
 * リランキング用ChatGPT APIを呼び出し
 */
function callChatGPTRerank(messages, temperature, model) {
  try {
    const payload = {
      model: model || GPT_MODEL,
      messages: messages,
      temperature: temperature
    };

    logTrace("[RERANK:API] リクエスト送信中... モデル:", payload.model);

    const response = UrlFetchApp.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + OPENAI_API_KEY
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: false
      }
    );

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode !== 200) {
      logError("[RERANK:API] OpenAI API エラー: ステータスコード " + responseCode, responseText);
      return "";
    }

    const json = JSON.parse(responseText);
    return json.choices[0].message.content.trim();

  } catch (error) {
    logError("[RERANK:API] エラー:", error);
    return "";
  }
}
