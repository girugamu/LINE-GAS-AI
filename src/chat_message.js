/**
 * AI Chat メイン処理モジュール
 * 
 * このファイルには以下が含まれています：
 * - LINE API返信関数
 * - LINE Loading API関数
 * - doPost: LINE Webhook処理
 * - LINEコマンド処理（履歴削除、インデックス情報表示など）
 */

/**
 * AI Chatに返信メッセージを送信
 */
function sendMessage(replyToken, message) {
  if (!message) {
    logError("LINE API エラー: メッセージが空です");
    return;
  }

  const maxLength = 5000;
  if (message.length > maxLength) {
    logWarn("LINE メッセージ过长 tronics、超過分を削除します");
    message = message.substring(0, maxLength);
  }

  try {
    const response = UrlFetchApp.fetch(LINE_URL, {
      method: "post",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": "Bearer " + LINE_TOKEN
      },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: "text", text: message }]
      })
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      logError("LINE API エラー: ステータスコード " + responseCode, response.getContentText());
    }
  } catch (error) {
    logError("LINE API エラー:", error);
    if (error.message) {
      logError("LINE API エラー詳細:", error.message);
    }
  }
}

/**
 * AI Chat Loading APIで「考え中...」を表示
 */
function sendLineLoading(userId) {
  try {
    const response = UrlFetchApp.fetch(LINE_LOADING_URL, {
      method: "post",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": "Bearer " + LINE_TOKEN
      },
      payload: JSON.stringify({
        chatId: userId,
        loadingPoint: 100
      })
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      logWarn("LINE Loading API エラー: ステータスコード " + responseCode);
    }
  } catch (error) {
    logWarn("LINE Loading API エラー（致命的ではない）:", error.message);
  }
}

// ================================
//  ChatGPT API 呼び出し
// ================================

/**
 * OpenAI ChatGPT APIを呼び出して応答を取得
 */
function callChatGPT(messages, overrideTemperature) {
  try {
    const llmParams = getLlmParams();
    const temperature = (overrideTemperature !== undefined) ? overrideTemperature : llmParams.temperature;

    const currentModel = llmParams.model || GPT_MODEL;
    const payload = {
      model: currentModel,
      messages: messages,
      temperature: temperature
    };

    if (llmParams.top_p !== undefined && llmParams.top_p !== null) {
      payload.top_p = llmParams.top_p;
    }

    if (supportsTopK(currentModel) && llmParams.top_k !== undefined && llmParams.top_k !== null) {
      payload.top_k = llmParams.top_k;
    }

    if (llmParams.max_tokens !== undefined && llmParams.max_tokens !== null) {
      if (currentModel.startsWith('gpt-5.')) {
        payload.max_completion_tokens = llmParams.max_tokens;
      } else {
        payload.max_tokens = llmParams.max_tokens;
      }
    }

    if (currentModel.startsWith('gpt-5.')) {
      if (llmParams.max_prompt_tokens !== undefined && llmParams.max_prompt_tokens !== null) {
        const maxPromptTokens = parseInt(llmParams.max_prompt_tokens);
        if (!isNaN(maxPromptTokens) && maxPromptTokens > 0) {
          payload.max_prompt_tokens = maxPromptTokens;
        }
      }
    }

    if (llmParams.presence_penalty !== undefined && llmParams.presence_penalty !== null) {
      payload.presence_penalty = llmParams.presence_penalty;
    }

    if (llmParams.frequency_penalty !== undefined && llmParams.frequency_penalty !== null) {
      payload.frequency_penalty = llmParams.frequency_penalty;
    }

    if (llmParams.stop && llmParams.stop.trim() !== '') {
      payload.stop = llmParams.stop.split(',').map(s => s.trim()).filter(s => s);
    }

    if (llmParams.response_format === 'json') {
      payload.response_format = { type: "json_object" };
    }

    logTrace("[GPT_PARAMS] 使用パラメータ:", JSON.stringify(payload));

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
      logError("OpenAI API エラー: ステータスコード " + responseCode, responseText);
      return "すみません、処理中にエラーが発生しました。";
    }

    const json = JSON.parse(responseText);
    return json.choices[0].message.content.trim();

  } catch (error) {
    logError("OpenAI API エラー:", error);
    return "すみません、処理中にエラーが発生しました。";
  }
}

// ================================
//  プロンプト管理関数
// ================================

/**
 * 管理者プロンプトを取得（ScriptProperties）
 */
function getAdminPrompt() {
  try {
    const parts = [];
    const systemPrompt = scriptProps.getProperty("ADMIN_SYSTEM_PROMPT");
    if (systemPrompt && systemPrompt.trim() !== "") {
      parts.push(systemPrompt.trim());
    }
    const responseRules = scriptProps.getProperty("ADMIN_RESPONSE_RULES");
    if (responseRules && responseRules.trim() !== "") {
      parts.push("【応答ルール】\n" + responseRules.trim());
    }
    const forbiddenTopics = scriptProps.getProperty("ADMIN_FORBIDDEN_TOPICS");
    if (forbiddenTopics && forbiddenTopics.trim() !== "") {
      parts.push("【注意】以下のトピックには言及しないでください：" + forbiddenTopics.trim());
    }
    return parts.join("\n\n");
  } catch (error) {
    logError("[getAdminPrompt] エラー:", error);
    return "";
  }
}

/**
 * ユーザー独自プロンプトを取得（UserProperties）
 */
function getUserPrompt() {
  try {
    const userProps = PropertiesService.getUserProperties();
    const parts = [];
    const customPrompt = userProps.getProperty("USER_CUSTOM_PROMPT");
    if (customPrompt && customPrompt.trim() !== "") {
      parts.push("【ユーザー設定】\n" + customPrompt.trim());
    }
    const userPersona = userProps.getProperty("USER_PERSONA");
    if (userPersona && userPersona.trim() !== "") {
      parts.push("【ユーザーの特徴】\n" + userPersona.trim());
    }
    const responseStyle = userProps.getProperty("USER_RESPONSE_STYLE");
    if (responseStyle && responseStyle.trim() !== "") {
      parts.push("【応答スタイル】\n" + responseStyle.trim());
    }
    return parts.join("\n\n");
  } catch (error) {
    logError("[getUserPrompt] エラー:", error);
    return "";
  }
}

/**
 * プロンプトテンプレートをScriptPropertiesから取得
 */
function getPromptTemplateSettings() {
  try {
    const settings = {};
    for (const [key, def] of Object.entries(PROMPT_TEMPLATE_DEFINITIONS)) {
      let value = scriptProps.getProperty(key);
      if (value === null || value === undefined || value === "") {
        value = def.defaultValue;
        if (value) scriptProps.setProperty(key, value);
      }
      settings[key] = value || "";
    }
    return { success: true, settings: settings, definitions: PROMPT_TEMPLATE_DEFINITIONS };
  } catch (error) {
    logError('[getPromptTemplateSettings] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * プロンプトテンプレートを更新
 */
function updatePromptTemplate(key, value) {
  try {
    const allowedKeys = Object.keys(PROMPT_TEMPLATE_DEFINITIONS);
    if (!allowedKeys.includes(key)) {
      return { success: false, error: '許可されていないキーです: ' + key };
    }
    scriptProps.setProperty(key, value);
    logInfo('[updatePromptTemplate] プロンプトテンプレートを更新:', key);
    return { success: true, key: key, value: value };
  } catch (error) {
    logError('[updatePromptTemplate] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * プロンプトテンプレートからプロンプトを生成
 */
function buildPromptFromTemplate(templateKey, variables) {
  try {
    let template = scriptProps.getProperty(templateKey);
    if (!template || template.trim() === "") {
      const def = PROMPT_TEMPLATE_DEFINITIONS[templateKey];
      template = def ? def.defaultValue : "";
    }
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        const placeholder = '{{' + key + '}}';
        template = template.split(placeholder).join(value);
      }
    }
    return template;
  } catch (error) {
    logError('[buildPromptFromTemplate] エラー:', error);
    const def = PROMPT_TEMPLATE_DEFINITIONS[templateKey];
    return def ? def.defaultValue : "";
  }
}

/**
 * 管理者プロンプトの全設定を取得
 */
function getAdminPromptSettings() {
  try {
    const settings = {};
    for (const [key, def] of Object.entries(ADMIN_PROMPT_DEFINITIONS)) {
      let value = scriptProps.getProperty(key);
      if (value === null || value === undefined || value === "") {
        value = def.defaultValue;
        if (value) scriptProps.setProperty(key, value);
      }
      settings[key] = value || "";
    }
    return { success: true, settings: settings, definitions: ADMIN_PROMPT_DEFINITIONS };
  } catch (error) {
    logError('[getAdminPromptSettings] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * ユーザー独自プロンプトの全設定を取得
 */
function getUserPromptSettings() {
  try {
    const userProps = PropertiesService.getUserProperties();
    const settings = {};
    for (const [key, def] of Object.entries(USER_PROMPT_DEFINITIONS)) {
      let value = userProps.getProperty(key);
      if (value === null || value === undefined || value === "") {
        value = def.defaultValue;
        if (value) userProps.setProperty(key, value);
      }
      settings[key] = value || "";
    }
    return { success: true, settings: settings, definitions: USER_PROMPT_DEFINITIONS };
  } catch (error) {
    logError('[getUserPromptSettings] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * プロンプトを生成（優先順位: 管理者 → ユーザー → RAGコンテキスト）
 */
function generateFullPrompt(ragContext) {
  const baseSystemPrompt = "あなたはAIアシスタントです。";
  const adminPrompt = getAdminPrompt();
  const userPrompt = getUserPrompt();
  const systemParts = [baseSystemPrompt];
  const userParts = [];

  if (adminPrompt && adminPrompt.trim() !== "") {
    systemParts.push(adminPrompt);
  }
  const combinedSystem = systemParts.filter(p => p && p.trim() !== "").join("\n\n");

  if (userPrompt && userPrompt.trim() !== "") {
    userParts.push(userPrompt.trim());
  }
  if (ragContext && ragContext.trim() !== "") {
    userParts.push("【コンテキスト】\n" + ragContext.trim());
  }
  const combinedUser = userParts.filter(p => p && p.trim() !== "").join("\n\n");

  return {
    system: combinedSystem,
    user: combinedUser,
    hasAdminPrompt: adminPrompt.trim() !== "",
    hasUserPrompt: userPrompt.trim() !== "",
    hasRagContext: ragContext && ragContext.trim() !== ""
  };
}

// ================================
//  LLMパラメータ関連関数
// ================================

function supportsTopK(model) {
  return !MODELS_WITHOUT_TOP_K.includes(model);
}

function getLlmParams() {
  try {
    const getSettings = (defs, props, transform) => {
      const result = {};
      for (const [k, def] of Object.entries(defs)) {
        let v = props.getProperty(k);
        if (v === null || v === undefined || v === '') { v = def.defaultValue; props.setProperty(k, v); }
        result[def.paramName || k] = transform(v, def);
      }
      return result;
    };
    
    return getSettings(LLM_PARAM_DEFINITIONS, userProps, (v, def) => {
      if (def.isString || def.isSelect) return v;
      const n = parseFloat(v);
      return isNaN(n) ? 0 : n;
    });
  } catch (e) {
    const d = {};
    for (const [k, def] of Object.entries(LLM_PARAM_DEFINITIONS)) {
      d[def.paramName] = (def.isString || def.isSelect) ? def.defaultValue : parseFloat(def.defaultValue);
    }
    return d;
  }
}

function getLlmParamsDefault() {
  const d = {};
  for (const [k, def] of Object.entries(LLM_PARAM_DEFINITIONS)) {
    d[def.paramName] = (def.isString || def.isSelect) ? def.defaultValue : parseFloat(def.defaultValue);
  }
  return d;
}

function updateLlmParam(k, v) {
  try {
    if (!Object.keys(LLM_PARAM_DEFINITIONS).includes(k)) return { success: false, error: '許可されていないキー' };
    const def = LLM_PARAM_DEFINITIONS[k];
    if (def.isBoolean) {
      userProps.setProperty(k, String(v));
    } else if (!def.isString && !def.isSelect && v) {
      const n = parseFloat(v);
      if (isNaN(n) || n < def.min || n > def.max) return { success: false, error: `${def.min}〜${def.max}` };
    }
    userProps.setProperty(k, String(v));
    logInfo('[updateLlmParam]', k, v);
    return { success: true, key: k, value: v };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getSearchParams() {
  try {
    const result = {};
    for (const [k, def] of Object.entries(SEARCH_PARAM_DEFINITIONS)) {
      let v = userProps.getProperty(k);
      if (v === null || v === undefined || v === '') { v = def.defaultValue; userProps.setProperty(k, v); }
      result[k] = def.isBoolean ? v !== 'false' : v;
    }
    return result;
  } catch (e) {
    const d = {};
    for (const [k, def] of Object.entries(SEARCH_PARAM_DEFINITIONS)) d[k] = def.defaultValue !== 'false';
    return d;
  }
}

function getSearchParamsDefault() {
  const d = {};
  for (const [k, def] of Object.entries(SEARCH_PARAM_DEFINITIONS)) d[k] = def.defaultValue !== 'false';
  return d;
}

function updateSearchParam(k, v) {
  try {
    if (!Object.keys(SEARCH_PARAM_DEFINITIONS).includes(k)) return { success: false, error: '許可されていないキー' };
    userProps.setProperty(k, String(v));
    logInfo('[updateSearchParam]', k, v);
    return { success: true, key: k, value: v };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ================================
//  RAG拡張機能付き ChatGPT
// ================================

/**
 * RAG拡張版ChatGPT呼び出し
 */
function callChatGPTWithRAGEnhanced(userMessage, history, userId, additionalContext) {
  logTrace("[RAG:ENHANCED] 拡張RAG開始");
  logTrace("[RAG:ENHANCED] ユーザー入力:", userMessage.substring(0, 50));

  const hashedUserId = hashUserId(userId);
  let finalResponse = "";
  let usedCache = false;

  if (!userId) {
    logError("[RAG:ENHANCED] userIdが指定されていません。");
  }

  try {
    // キャッシュ確認
    const cachedResults = userId ? getQueryCache(userMessage, userId) : null;
    if (cachedResults) {
      logTrace("[RAG:ENHANCED] キャッシュを使用 user(hash):", hashedUserId);
      finalResponse = cachedResults;
      usedCache = true;
    }

    if (!usedCache) {
      const searchParams = getSearchParams();

      // クエリ拡張
      let searchQuery = userMessage;
      let expansions = [];
      
      if (searchParams.SEARCH_QUERY_EXPANSION_ENABLED) {
        if (searchParams.SEARCH_DICT_EXPANSION_ENABLED) {
          const dictResult = expandQuery(userMessage);
          expansions.push(...dictResult.expansions);
          searchQuery = dictResult.expanded;
        }
        
        if (searchParams.SEARCH_LLM_EXPANSION_ENABLED) {
          const prompt = buildPromptFromTemplate('PROMPT_QUERY_EXPANSION', { query: searchQuery });
          const llmResponse = callChatGPT([{ role: "user", content: prompt }]);
          const llmResult = parseExpansionResponse(llmResponse);
          if (llmResult.expansions.length > 0) {
            const safeExpansions = llmResult.expansions.filter(w => w.length >= 2);
            expansions.push(...safeExpansions);
            searchQuery = `${searchQuery} ${safeExpansions.join(" ")}`;
          }
        }
      }
      expansions = [...new Set(expansions)];

      // 検索実行
      logTrace("[RAG:ENHANCED] 候補チャンク取得...");
      const useHybrid = searchParams.SEARCH_KEYWORD_ENABLED || searchParams.SEARCH_BM25_ENABLED;

      let candidates = [];
      if (useHybrid) {
        candidates = enhancedHybridSearch(searchQuery, {
          TOP_K_FINAL: 50,
          keywordEnabled: searchParams.SEARCH_KEYWORD_ENABLED,
          bm25Enabled: searchParams.SEARCH_BM25_ENABLED
        });
      } else {
        candidates = fetchRelevantChunks(searchQuery, 50);
      }
      logTrace("[RAG:ENHANCED] 初期候補数:", candidates.length);

      // リランキング
      const rerankFinalTopK = parseInt(userProps.getProperty("RERANK_FINAL_TOP_K")) || 5;
      if (searchParams.SEARCH_RERANK_ENABLED && candidates.length > rerankFinalTopK) {
        candidates = rerankResults(userMessage, candidates);
      }

      // コンテキスト選択
      const MAX_CONTEXT_CHARS = 3000;
      let totalChars = 0;
      const selected = [];

      for (const c of candidates) {
        const chunkText = c.chunk || "";
        const len = chunkText.length;
        if (totalChars + len > MAX_CONTEXT_CHARS) {
          if (selected.length === 0 && len > MAX_CONTEXT_CHARS) {
            selected.push({ ...c, chunk: chunkText.substring(0, MAX_CONTEXT_CHARS) });
            totalChars += MAX_CONTEXT_CHARS;
          }
          break;
        }
        selected.push(c);
        totalChars += len;
      }

      logTrace("[RAG:ENHANCED] 選択チャンク数:", selected.length, "合計文字数:", totalChars);

      // RAG検索結果と追加コンテキストを統合
      let context = "";
      
      if (additionalContext && additionalContext.trim() !== "") {
        context += additionalContext + "\n\n";
      }
      
      if (selected.length > 0) {
        context += "【参考ドキュメント】\n";
        selected.forEach((doc, i) => {
          const preview = (doc.chunk || "").replace(/\n/g, " ");
          const similarityScore = (doc.similarity ?? doc.vectorScore ?? doc.score ?? 0).toFixed(3);
          const chunkInfo = doc.totalChunks ? ` (${doc.chunkIndex + 1}/${doc.totalChunks})` : ` (chunk ${doc.chunkIndex})`;
          const keywords = doc.keywords ? `\n   キーワード: ${doc.keywords}` : "";
          context += `\n${i + 1}. ${doc.fileName}${chunkInfo}, スコア: ${similarityScore}${keywords}\n${preview}\n`;
        });
      } else {
        logTrace("[RAG:ENHANCED] マッチするドキュメントがありません");
      }

      const promptResult = generateFullPrompt(context);
      const messages = buildChatMessages(promptResult, history);
      logTrace("[RAG:ENHANCED] ChatGPT 呼び出し");
      const response = callChatGPT(messages);

      finalResponse = response;
      if (selected.length > 0) {
        const docChunksMap = new Map();
        selected.forEach((doc) => {
          const docKey = doc.fileId || doc.fileName;
          if (!docChunksMap.has(docKey)) {
            docChunksMap.set(docKey, { fileId: doc.fileId, fileName: doc.fileName, mimeType: doc.mimeType, chunks: [], maxScore: 0 });
          }
          const docData = docChunksMap.get(docKey);
          let chunkNum = 1;
          if (doc.chunkIndex !== undefined && doc.chunkIndex !== null) {
            chunkNum = (doc.totalChunks ? doc.chunkIndex + 1 : doc.chunkIndex + 1);
          }
          docData.chunks.push(chunkNum);
          const score = doc.similarity ?? doc.vectorScore ?? doc.score ?? 0;
          if (score > docData.maxScore) docData.maxScore = score;
        });

        finalResponse += "\n\n【参考にしたドキュメント】\n";
        let docIndex = 0;
        docChunksMap.forEach((docData, docKey) => {
          docIndex++;
          const docUrl = getDocumentUrl(docData.fileId, docData.mimeType);
          const similarityScore = docData.maxScore.toFixed(3);
          const sortedChunks = docData.chunks.sort((a, b) => a - b);
          let chunkInfoStr = "";
          if (sortedChunks.length === 1) {
            const chunkNum = sortedChunks[0];
            const totalChunks = docData.totalChunks || docData.chunks.length;
            chunkInfoStr = ` (${chunkNum}/${totalChunks})`;
          } else {
            const minChunk = Math.min(...sortedChunks);
            const maxChunk = Math.max(...sortedChunks);
            const totalChunks = docData.totalChunks || docData.chunks.length;
            if (minChunk === maxChunk) {
              chunkInfoStr = ` (${minChunk}/${totalChunks})`;
            } else {
              chunkInfoStr = ` (${minChunk}-${maxChunk}/${totalChunks})`;
            }
          }
          finalResponse += `${docIndex}. ${docData.fileName}${chunkInfoStr}, スコア: ${similarityScore}\n   🔗 ${docUrl}\n`;
        });
      }

      // キャッシュ保存
      if (userId) {
        setQueryCache(userMessage, finalResponse, userId);
      }
    }

    logTrace("[RAG:ENHANCED] 完了 user(hash):", hashedUserId);
    return finalResponse;

  } catch (error) {
    logError("[RAG:ENHANCED] エラー:", error);
    throw error;
  }
}

// 後方互換性のための旧関数
function callChatGPTWithRAG(userMessage, history) {
  return callChatGPTWithRAGEnhanced(userMessage, history);
}

/**
 * ChatGPT API用のメッセージ配列を構築
 */
function buildChatMessages(promptResult, userMessage) {
  const messages = [];
  messages.push({ role: "system", content: promptResult.system });
  messages.push({ role: "user", content: promptResult.user });
  if (userMessage && userMessage.length > 0) {
    userMessage.forEach(msg => messages.push(msg));
  }
  return messages;
}

// ================================
//  自律検索エージェントモード
// ================================

const AGENT_STATE_PREFIX = "agent_state_";

function saveAgentState(sessionId, state) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) return false;
    const key = AGENT_STATE_PREFIX + sessionId;
    cache.put(key, JSON.stringify(state), 3600);
    logTrace("[AGENT:STATE] 状態を保存:", sessionId);
    return true;
  } catch (error) {
    logError("[AGENT:STATE] 状態保存エラー:", error);
    return false;
  }
}

function getAgentState(sessionId) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) return null;
    const key = AGENT_STATE_PREFIX + sessionId;
    const data = cache.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    logError("[AGENT:STATE] 状態取得エラー:", error);
    return null;
  }
}

function clearAgentState(sessionId) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      const key = AGENT_STATE_PREFIX + sessionId;
      cache.remove(key);
      logTrace("[AGENT:STATE] 状態を削除:", sessionId);
    }
  } catch (error) {
    logError("[AGENT:STATE] 状態削除エラー:", error);
  }
}

/**
 * 検索結果の評価を行い、追加検索が必要かを判断
 */
function evaluateSearchResults(query, results, context) {
  logTrace("[AGENT] 検索結果の評価を開始");

  if (!results || results.length === 0) {
    return { needsMoreSearch: true, confidence: 0, reason: "検索結果がありませんでした。", additionalTerms: [] };
  }

  let resultsSummary = "【検索結果】\n";
  results.slice(0, 5).forEach((r, i) => {
    resultsSummary += `${i + 1}. ${r.fileName || 'Unknown'}\n   ${(r.chunk || '').substring(0, 100)}...\n\n`;
  });

  const evaluationPrompt = buildPromptFromTemplate('PROMPT_AGENT_EVALUATE', {
    query: query,
    context: context ? context.substring(0, 1000) : '（まだ情報なし）',
    results: resultsSummary
  });

  const messages = [
    { role: "system", content: "あなたは検索精度を評価する専門家です。" },
    { role: "user", content: evaluationPrompt }
  ];

  try {
    const response = callChatGPT(messages, 0.3);

    let parsed;
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("JSONが見つかりません");
      }
    } catch (parseError) {
      return {
        needsMoreSearch: results.length < 3,
        confidence: results.length >= 3 ? 0.8 : 0.4,
        reason: "検索結果の数に基づいて判断しました",
        additionalTerms: []
      };
    }

    logTrace("[AGENT] 評価結果 - needsMoreSearch:", parsed.needsMoreSearch, "confidence:", parsed.confidence);
    return {
      needsMoreSearch: parsed.needsMoreSearch || false,
      confidence: parsed.confidence || 0.5,
      reason: parsed.reason || "",
      additionalTerms: parsed.additionalTerms || []
    };

  } catch (error) {
    logError("[AGENT] 評価エラー:", error);
    return {
      needsMoreSearch: results.length < 3,
      confidence: results.length >= 3 ? 0.7 : 0.4,
      reason: "評価中にエラーが発生しました",
      additionalTerms: []
    };
  }
}

/**
 * 追加検索キーワードを生成
 */
function generateAdditionalSearchTerms(query, currentResults, evaluation) {
  logTrace("[AGENT] 追加検索キーワード生成開始");

  if (evaluation.additionalTerms && evaluation.additionalTerms.length > 0) {
    logTrace("[AGENT] 評価結果からキーワードを使用:", evaluation.additionalTerms);
    return evaluation.additionalTerms.slice(0, 3);
  }

  const existingKeywords = new Set();
  currentResults.forEach(r => {
    if (r.keywords) {
      r.keywords.split(',').forEach(k => existingKeywords.add(k.trim()));
    }
  });

  const keywordPrompt = buildPromptFromTemplate('PROMPT_AGENT_KEYWORD', {
    query: query,
    existingKeywords: Array.from(existingKeywords).join(', ') || 'なし'
  });

  const messages = [
    { role: "system", content: "あなたは検索キーワードの専門家です。" },
    { role: "user", content: keywordPrompt }
  ];

  try {
    const response = callChatGPT(messages, 0.5);
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const terms = JSON.parse(jsonMatch[0]);
      logTrace("[AGENT] 生成された追加キーワード:", terms);
      return terms.slice(0, 3);
    }
  } catch (error) {
    logError("[AGENT] キーワード生成エラー:", error);
  }

  return [];
}

/**
 * 反復エージェントモードで回答
 */
function callChatGPTWithAgentIterative(userMessage, history, userId, options) {
  options = options || {};
  const continueIteration = options.continueIteration || false;
  const maxIterations = options.maxIterations || AGENT_MODE_CONFIG.MAX_ITERATIONS || 3;
  const MIN_CONFIDENCE = AGENT_MODE_CONFIG.MIN_CONFIDENCE || 0.7;
  const SHOW_THINKING = AGENT_MODE_CONFIG.SHOW_THINKING || true;
  const ADDITIONAL_SEARCH_ENABLED = AGENT_MODE_CONFIG.ADDITIONAL_SEARCH_ENABLED || true;

  logInfo("[AGENT:ITERATIVE] 反復エージェント開始 - continue:", continueIteration, "max:", maxIterations);

  const searchParams = getSearchParams();

  let currentQuery = userMessage;
  let allResults = [];
  let thinkingLog = [];
  let context = "";
  let iteration = 0;

  if (continueIteration) {
    const savedState = getAgentState(userId);
    if (savedState) {
      logInfo("[AGENT:ITERATIVE] 前回の状態から継続:", savedState.iteration);
      currentQuery = savedState.currentQuery || userMessage;
      allResults = savedState.allResults || [];
      thinkingLog = savedState.thinkingLog || [];
      iteration = savedState.iteration || 0;
    }
  }

  for (; iteration < maxIterations; iteration++) {
    logInfo("[AGENT:ITERATIVE] 反復 " + (iteration + 1) + "/" + maxIterations);

    let searchResults = [];
    const useHybrid = searchParams.SEARCH_KEYWORD_ENABLED || searchParams.SEARCH_BM25_ENABLED;

    if (useHybrid) {
      searchResults = enhancedHybridSearch(currentQuery, {
        TOP_K_FINAL: 20,
        keywordEnabled: searchParams.SEARCH_KEYWORD_ENABLED,
        bm25Enabled: searchParams.SEARCH_BM25_ENABLED
      });
    } else {
      searchResults = fetchRelevantChunks(currentQuery, 20);
    }

    allResults = mergeSearchResults(allResults, searchResults);
    context = buildContextFromResults(allResults);
    const evaluation = evaluateSearchResults(currentQuery, searchResults, context);

    const thinkingStep = {
      iteration: iteration + 1,
      query: currentQuery,
      resultsCount: searchResults.length,
      totalResults: allResults.length,
      evaluation: evaluation
    };
    thinkingLog.push(thinkingStep);

    logInfo("[AGENT:ITERATIVE] 評価結果 - needsMoreSearch:", evaluation.needsMoreSearch, "confidence:", evaluation.confidence);

    const currentResult = {
      iteration: iteration + 1,
      maxIterations: maxIterations,
      query: currentQuery,
      searchResults: searchResults.slice(0, 5),
      totalResults: allResults.length,
      evaluation: evaluation,
      needsMoreSearch: evaluation.needsMoreSearch && evaluation.confidence < MIN_CONFIDENCE,
      isComplete: !evaluation.needsMoreSearch || evaluation.confidence >= MIN_CONFIDENCE || iteration >= maxIterations - 1
    };

    if (!evaluation.needsMoreSearch || evaluation.confidence >= MIN_CONFIDENCE) {
      logInfo("[AGENT:ITERATIVE] 情報が十分と判定、終了");
      const finalResponse = generateAgentFinalResponse(userMessage, userId, allResults, thinkingLog, history, SHOW_THINKING);
      clearAgentState(userId);
      return { ...currentResult, finalResponse: finalResponse.finalResponse, thinkingInfo: finalResponse.thinkingInfo, isComplete: true };
    }

    if (evaluation.needsMoreSearch && ADDITIONAL_SEARCH_ENABLED) {
      const additionalTerms = generateAdditionalSearchTerms(currentQuery, allResults, evaluation);
      if (additionalTerms.length > 0) {
        currentQuery = currentQuery + " " + additionalTerms.join(" ");
        logInfo("[AGENT:ITERATIVE] 追加検索クエリ:", currentQuery);
      }
    }

    const stateToSave = {
      currentQuery: currentQuery,
      allResults: allResults,
      thinkingLog: thinkingLog,
      iteration: iteration + 1,
      userMessage: userMessage,
      userId: userId
    };
    saveAgentState(userId, stateToSave);

    const intermediateResponse = generateAgentIntermediateResponse(userMessage, userId, allResults, thinkingLog, history, iteration + 1, SHOW_THINKING);
    
    return {
      ...currentResult,
      finalResponse: intermediateResponse.partialResponse,
      thinkingInfo: intermediateResponse.thinkingInfo,
      isComplete: false
    };
  }

  logInfo("[AGENT:ITERATIVE] 最大反復回数に達しました");
  const finalResponse = generateAgentFinalResponse(userMessage, userId, allResults, thinkingLog, history, SHOW_THINKING);
  clearAgentState(userId);

  return {
    iteration: iteration,
    maxIterations: maxIterations,
    query: currentQuery,
    searchResults: allResults.slice(0, 5),
    totalResults: allResults.length,
    needsMoreSearch: false,
    isComplete: true,
    finalResponse: finalResponse.finalResponse,
    thinkingInfo: finalResponse.thinkingInfo
  };
}

/**
 * 自律検索エージェントモードで回答（旧バージョン）
 */
function callChatGPTWithAgent(userMessage, history, userId) {
  const result = callChatGPTWithAgentIterative(userMessage, history, userId, {
    maxIterations: AGENT_MODE_CONFIG.MAX_ITERATIONS || 3
  });
  
  if (result && typeof result === 'object') {
    if (result.thinkingInfo) {
      return result.finalResponse + result.thinkingInfo;
    }
    return result.finalResponse;
  }
  
  return result;
}

function generateAgentIntermediateResponse(userMessage, userId, allResults, thinkingLog, history, currentIteration, showThinking) {
  let context = "";
  try {
    context = buildContextFromResults(allResults);
  } catch (e) {
    context = "";
  }

  let promptResult;
  try {
    promptResult = generateFullPrompt(context);
  } catch (e) {
    promptResult = { system: "あなたはAIアシスタントです。", user: userMessage };
  }

  let thinkingInfo = "";
  if (showThinking) {
    thinkingInfo = "\n\n🔄 【検索中】反復 " + currentIteration + " 完了\n";
    thinkingInfo += "─────────────────────\n";
    thinkingLog.forEach((step) => {
      const stepIcon = step.evaluation.needsMoreSearch ? "🔄" : "✅";
      thinkingInfo += `【反復 ${step.iteration}】\n  📝 検索: 「${step.query}」\n  📊 結果: ${step.resultsCount}件\n  ${stepIcon} confidence: ${(step.evaluation.confidence || 0).toFixed(2)}\n\n`;
    });
    thinkingInfo += "🔄 追加検索中...\n─────────────────────";
  }

  const messages = [];
  messages.push({ role: "system", content: promptResult.system + "\n\n※ 検索を続けています。現在の情報で回答してください。" });
  messages.push({ role: "user", content: promptResult.user });
  if (history && history.length > 0) {
    history.forEach(msg => messages.push(msg));
  }

  const partialResponse = callChatGPT(messages);
  return { partialResponse: partialResponse + thinkingInfo, thinkingInfo: thinkingInfo };
}

function generateAgentFinalResponse(userMessage, userId, allResults, thinkingLog, history, showThinking) {
  let finalContext = "";
  try {
    finalContext = buildContextFromResults(allResults);
  } catch (e) {
    finalContext = "";
  }

  let promptResult;
  try {
    promptResult = generateFullPrompt(finalContext);
  } catch (e) {
    promptResult = { system: "あなたはAIアシスタントです。", user: userMessage };
  }

  let systemPrompt = promptResult.system;
  if (showThinking && thinkingLog.length > 1) {
    let thinkingText = "\n\n【検索の過程】\n";
    thinkingLog.forEach((step) => {
      thinkingText += "- 反復" + step.iteration + ": キーワード「" + step.query + "」で" + step.resultsCount + "件取得\n";
      thinkingText += "  評価: " + (step.evaluation.needsMoreSearch ? "追加検索が必要" : "情報が十分") + " (confidence: " + (step.evaluation.confidence || 0).toFixed(2) + ")\n";
    });
    systemPrompt += thinkingText;
  }

  const messages = [];
  messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: promptResult.user });
  if (history && history.length > 0) {
    history.forEach(msg => messages.push(msg));
  }

  const finalResponse = callChatGPT(messages);

  let thinkingInfo = "";
  if (showThinking && thinkingLog.length > 0) {
    thinkingInfo = "\n\n" + "=".repeat(40) + "\n🔍 【AI考える過程】\n" + "=".repeat(40) + "\n\n";
    thinkingLog.forEach((step) => {
      const stepIcon = step.evaluation.needsMoreSearch ? "🔄" : "✅";
      thinkingInfo += `【反復 ${step.iteration}】\n  📝 検索: 「${step.query}」\n  📊 結果: ${step.resultsCount}件のドキュメントを取得\n  ${stepIcon} 評価: ${step.evaluation.needsMoreSearch ? "追加検索が必要" : "情報が十分"}\n  📈 confidence: ${(step.evaluation.confidence || 0).toFixed(2)}\n`;
      if (step.evaluation.reason) {
        thinkingInfo += `  💡 理由: ${step.evaluation.reason}\n`;
      }
      thinkingInfo += "\n";
    });
    thinkingInfo += "=".repeat(40) + "\n✨ 以上の情報をもとに回答を生成しました\n" + "=".repeat(40);
  }

  return { finalResponse: finalResponse, thinkingInfo: thinkingInfo };
}

function mergeSearchResults(existingResults, newResults) {
  const resultMap = new Map();
  existingResults.forEach(r => {
    const key = `${r.fileId}_${r.chunkIndex}`;
    resultMap.set(key, r);
  });
  newResults.forEach(r => {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (!resultMap.has(key)) {
      resultMap.set(key, r);
    }
  });
  return Array.from(resultMap.values());
}

function buildContextFromResults(results) {
  if (results.length === 0) {
    return "関連するドキュメントが見つかりませんでした。";
  }

  const MAX_CONTEXT_CHARS = 4000;
  let totalChars = 0;
  const selected = [];

  const sorted = results.sort((a, b) => {
    const scoreA = a.similarity || a.vectorScore || a.score || 0;
    const scoreB = b.similarity || b.vectorScore || b.score || 0;
    return scoreB - scoreA;
  });

  for (const r of sorted) {
    const chunkText = r.chunk || "";
    const len = chunkText.length;
    if (totalChars + len > MAX_CONTEXT_CHARS) {
      if (selected.length === 0 && len > MAX_CONTEXT_CHARS) {
        selected.push({ ...r, chunk: chunkText.substring(0, MAX_CONTEXT_CHARS) });
        totalChars += MAX_CONTEXT_CHARS;
      }
      break;
    }
    selected.push(r);
    totalChars += len;
  }

  let context = "【参考ドキュメント】\n";
  selected.forEach((doc, i) => {
    const preview = (doc.chunk || "").replace(/\n/g, " ");
    const score = (doc.similarity || doc.vectorScore || doc.score || 0).toFixed(3);
    context += `\n${i + 1}. ${doc.fileName} (スコア: ${score})\n${preview}\n`;
  });

  return context;
}
