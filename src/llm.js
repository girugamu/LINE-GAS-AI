/**
 * LLM（Large Language Model）呼び出しモジュール
 * 
 * @module llm
 * @description ChatGPT API呼び出し、LLMパラメータ管理、プロンプト生成
 * 
 * このファイルには以下が含まれています：
 * - ChatGPT API呼び出し（callChatGPT）
 * - LLMパラメータ管理（取得、更新）
 * - プロンプト生成（generateFullPrompt）
 * - プロンプトテンプレート管理
 * - Searchパラメータ管理
 * - リランキング用ChatGPT呼び出し（callChatGPTRerank）
 * 
 * 注意：LLM_PARAM_DEFINITIONS, SEARCH_PARAM_DEFINITIONS, PROMPT_TEMPLATE_DEFINITIONS,
 *       ADMIN_PROMPT_DEFINITIONS, USER_PROMPT_DEFINITIONS, MODELS_WITHOUT_TOP_K
 *       はconfig.jsで定義されています
 * 
 * @depends config
 * @exports callChatGPT, callChatGPTRerank, getLlmParams, getLlmParamsDefault, updateLlmParam, supportsTopK, generateFullPrompt, getAdminPrompt, getUserPrompt, getPromptTemplateSettings, updatePromptTemplate, buildPromptFromTemplate, getAdminPromptSettings, getUserPromptSettings, getSearchParams, getSearchParamsDefault, updateSearchParam
 */

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

// ================================
//  LLMパラメータ関連関数
// ================================

/**
 * 指定モデルがTop-Kをサポートするか確認
 */
function supportsTopK(model) {
  return !MODELS_WITHOUT_TOP_K.includes(model);
}

/**
 * 現在のLLMパラメータを取得
 */
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

/**
 * LLMパラメータのデフォルト値を取得
 */
function getLlmParamsDefault() {
  const d = {};
  for (const [k, def] of Object.entries(LLM_PARAM_DEFINITIONS)) {
    d[def.paramName] = (def.isString || def.isSelect) ? def.defaultValue : parseFloat(def.defaultValue);
  }
  return d;
}

/**
 * LLMパラメータを更新
 */
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

// ================================
//  Searchパラメータ関連関数
// ================================

/**
 * 現在のSearchパラメータを取得
 */
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

/**
 * Searchパラメータのデフォルト値を取得
 */
function getSearchParamsDefault() {
  const d = {};
  for (const [k, def] of Object.entries(SEARCH_PARAM_DEFINITIONS)) d[k] = def.defaultValue !== 'false';
  return d;
}

/**
 * Searchパラメータを更新
 */
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
    const userPropsLocal = PropertiesService.getUserProperties();
    const parts = [];
    const customPrompt = userPropsLocal.getProperty("USER_CUSTOM_PROMPT");
    if (customPrompt && customPrompt.trim() !== "") {
      parts.push("【ユーザー設定】\n" + customPrompt.trim());
    }
    const userPersona = userPropsLocal.getProperty("USER_PERSONA");
    if (userPersona && userPersona.trim() !== "") {
      parts.push("【ユーザーの特徴】\n" + userPersona.trim());
    }
    const responseStyle = userPropsLocal.getProperty("USER_RESPONSE_STYLE");
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
    const userPropsLocal = PropertiesService.getUserProperties();
    const settings = {};
    for (const [key, def] of Object.entries(USER_PROMPT_DEFINITIONS)) {
      let value = userPropsLocal.getProperty(key);
      if (value === null || value === undefined || value === "") {
        value = def.defaultValue;
        if (value) userPropsLocal.setProperty(key, value);
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
