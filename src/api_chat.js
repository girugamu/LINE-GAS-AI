/**
 * WebチャットAPIモジュール
 * 
 * このファイルには以下が含まれています：
 * - chatAPI: WebチャットAPIエントリーポイント
 * - handleChatMessage: チャットメッセージ処理
 * - handleClearHistory: 履歴クリア処理
 * - handleGetHistory: 履歴取得処理
 * - handleExportHistory: 履歴エクスポート処理
 * - handleAgentStart/handleAgentContinue: エージェントモード処理
 */

/**
 * Webチャット用のセッションデータを生成
 */
function generateSessionId() {
  const timestamp = new Date().getTime();
  const random = Math.random().toString(36).substring(2, 15);
  return 'web_' + timestamp + '_' + random;
}

/**
 * WebチャットAPI
 */
function chatAPI(request) {
  const action = request.action;

  try {
    switch (action) {
      case 'send':
        return handleChatMessage(request);
      case 'clear':
        return handleClearHistory(request);
      case 'getHistory':
        return handleGetHistory(request);
      case 'export':
        return handleExportHistory(request);
      case 'agentContinue':
        return handleAgentContinue(request);
      case 'agentStart':
        return handleAgentStart(request);
      default:
        return { success: false, error: '不明なアクション: ' + action };
    }
  } catch (error) {
    logError('[chatAPI] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * チャットメッセージを処理
 */
function handleChatMessage(request) {
  const clientSessionId = request.sessionId;
  const userMessage = request.message;
  const mode = request.mode || 'free';
  const aiMode = request.aiMode || 'llm';
  
  let uploadedFiles = [];
  try {
    if (request.uploadedFiles) {
      if (Array.isArray(request.uploadedFiles)) {
        uploadedFiles = request.uploadedFiles;
      } else if (typeof request.uploadedFiles === 'string') {
        try {
          uploadedFiles = JSON.parse(request.uploadedFiles);
        } catch (e) {
          logError("[chatAPI] uploadedFiles JSONパースエラー:", e.message);
        }
      }
    }
  } catch (e) {
    logError("[chatAPI] uploadedFiles処理エラー:", e.message);
  }

  logInfo("[chatAPI] メッセージ受信 - sessionId:", clientSessionId, "aiMode:", aiMode);

  if (!clientSessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }
  
  let fileContext = '';
  if (uploadedFiles.length > 0) {
    try {
      fileContext = extractTextFromUploadedFiles(uploadedFiles);
    } catch (e) {
      logError("[chatAPI] ファイル処理エラー:", e.message);
    }
  }

  let prompt = userMessage;
  if (mode === 'summary') {
    prompt = PROMPT_TEMPLATES.summary(userMessage);
  } else if (mode === 'polite') {
    prompt = PROMPT_TEMPLATES.polite(userMessage);
  } else if (mode === 'bullet') {
    prompt = PROMPT_TEMPLATES.bullet(userMessage);
  } else if (mode === 'translate') {
    prompt = PROMPT_TEMPLATES.translate(userMessage);
  }

  const webSessionId = 'WEB_' + clientSessionId;
  const history = getHistory(webSessionId);

  history.push({ role: 'user', content: prompt });
  const trimmedHistory = history.slice(-10);

  let botReply = '';

  if (aiMode === 'agent') {
    logTrace('[chatAPI] エージェントモードで回答 - sessionId:', clientSessionId);
    const agentResult = callChatGPTWithAgent(prompt, trimmedHistory, webSessionId);
    if (agentResult && agentResult.thinkingSteps) {
      return {
        success: true,
        reply: agentResult.finalResponse,
        thinkingSteps: agentResult.thinkingSteps,
        sessionId: clientSessionId,
        timestamp: new Date().toISOString()
      };
    }
    botReply = agentResult;
  } else if (aiMode === 'chatgpt') {
    logTrace('[chatAPI] ChatGPTモードで回答 - sessionId:', clientSessionId);
    const promptResult = generateFullPrompt(fileContext);
    const chatMessages = buildChatMessages(promptResult, trimmedHistory);
    logTrace('[chatAPI] ChatGPTモード - 管理者プロンプト: ' + promptResult.hasAdminPrompt);
    botReply = callChatGPT(chatMessages);
  } else {
    logTrace('[chatAPI] RAGモードで回答 - sessionId:', clientSessionId);
    botReply = callChatGPTWithRAGEnhanced(prompt, trimmedHistory, webSessionId, fileContext);
  }

  trimmedHistory.push({ role: 'assistant', content: botReply });
  saveHistory(webSessionId, trimmedHistory);

  if (uploadedFiles && uploadedFiles.length > 0) {
    try {
      deleteUploadedFiles(uploadedFiles);
    } catch (e) {
      logWarn("[chatAPI] ファイル削除エラー:", e.message);
    }
  }

  logInfo('[chatAPI] チャット完了 - sessionId:', clientSessionId, 'mode:', mode, 'aiMode:', aiMode);

  return {
    success: true,
    reply: botReply,
    sessionId: clientSessionId,
    timestamp: new Date().toISOString()
  };
}

/**
 * アップロードされたファイルからテキストを抽出
 */
function extractTextFromUploadedFiles(uploadedFiles) {
  logTrace("[UPLOAD:TEMP] ファイルからテキスト抽出開始 - 件数:", uploadedFiles ? uploadedFiles.length : 'undefined');
  
  if (!uploadedFiles || uploadedFiles.length === 0) {
    return "";
  }
  
  let context = "";
  
  try {
    uploadedFiles.forEach((file, index) => {
      const fileId = file.fileId;
      const fileName = file.fileName;
      const mimeType = file.mimeType;
      
      if (!fileId) {
        context += `\n【添付ファイル ${index + 1}】\n※ fileIdがありません。\n`;
        return;
      }
      
      try {
        const text = extractText(fileId, mimeType, fileName);
        
        if (text && text.trim().length > 0) {
          const chunks = splitTextIntoChunks(text);

          context += `\n【添付ファイル ${index + 1}: ${fileName}】\n`;
          context += `ファイル形式: ${mimeType}\n`;
          context += `文字数: ${text.length}\n\n`;
          
          chunks.forEach((chunk, chunkIndex) => {
            context += `[${chunkIndex + 1}] ${chunk}\n\n`;
          });
        } else {
          context += `\n【添付ファイル ${index + 1}: ${fileName}】\n※ このファイルからテキストを抽出できませんでした。\n`;
        }
      } catch (extractError) {
        context += `\n【添付ファイル ${index + 1}: ${fileName}】\n※ エラー: ${extractError.message}\n`;
      }
    });
    
    if (context) {
      context = "【アップロードされたファイル（この会話のみで使用）】\n" + context;
      context += "\n↑ 上記の添付ファイルの内容を参照して回答してください。\n";
    }
    
    return context;
    
  } catch (error) {
    logError("[UPLOAD:TEMP] 全体エラー:", error.message);
    return "";
  }
}

/**
 * アップロードされたファイルを削除
 */
function deleteUploadedFiles(uploadedFiles) {
  if (!uploadedFiles || uploadedFiles.length === 0) {
    return;
  }

  logInfo("[DELETE:UPLOAD] 削除開始 - 件数:", uploadedFiles.length);

  uploadedFiles.forEach((file) => {
    const fileId = file.fileId;
    if (!fileId) return;

    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (error) {
      logError("[DELETE:UPLOAD] 削除失敗:", error.message);
    }
  });
}

/**
 * 会話履歴をクリア
 */
function handleClearHistory(request) {
  const sessionId = request.sessionId;

  if (!sessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      const webSessionId = 'WEB_' + sessionId;
      cache.remove(webSessionId);
      clearAllQueryCaches();
    }

    logInfo('[chatAPI] 履歴をクリア - sessionId:', sessionId);

    return {
      success: true,
      message: '会話履歴をクリアしました'
    };
  } catch (error) {
    logError('[chatAPI] 履歴クリアエラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 会話履歴を取得
 */
function handleGetHistory(request) {
  const sessionId = request.sessionId;

  if (!sessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  const history = getHistory(sessionId);

  return {
    success: true,
    history: history,
    sessionId: sessionId
  };
}

/**
 * 会話履歴をエクスポート
 */
function handleExportHistory(request) {
  const sessionId = request.sessionId;
  const format = request.format || 'json';

  if (!sessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  const history = getHistory(sessionId);

  if (!history || history.length === 0) {
    return { success: false, error: 'エクスポートする履歴がありません' };
  }

  let content = '';
  let mimeType = '';

  if (format === 'txt') {
    content = '=== AI Chat エクスポート ===\n';
    content += 'エクスポート日時: ' + new Date().toLocaleString('ja-JP') + '\n\n';

    history.forEach((msg) => {
      const role = msg.role === 'user' ? 'あなた' : 'AI';
      content += '--- ' + role + ' ---\n';
      content += msg.content + '\n\n';
    });

    mimeType = 'text/plain';
  } else {
    content = JSON.stringify({
      exportedAt: new Date().toISOString(),
      sessionId: sessionId,
      messages: history
    }, null, 2);

    mimeType = 'application/json';
  }

  logInfo('[chatAPI] エクスポート完了 - sessionId:', sessionId, 'format:', format);

  return {
    success: true,
    content: content,
    format: format,
    mimeType: mimeType,
    fileName: 'chat_export_' + sessionId + '.' + format
  };
}

/**
 * 新しいセッションを開始
 */
function createNewSession() {
  const newSessionId = generateSessionId();

  return {
    success: true,
    sessionId: newSessionId,
    message: '新しいセッションを開始しました'
  };
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

/**
 * エージェントモードを開始
 */
function handleAgentStart(request) {
  const clientSessionId = request.sessionId;
  const userMessage = request.message;
  
  if (!userMessage || userMessage.trim() === '') {
    return { success: false, error: 'メッセージが空です' };
  }

  if (!clientSessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  const webSessionId = 'WEB_' + clientSessionId;
  const history = getHistory(webSessionId);
  history.push({ role: 'user', content: userMessage });
  const trimmedHistory = history.slice(-10);

  const agentResult = callChatGPTWithAgentIterative(userMessage, trimmedHistory, webSessionId, {
    continueIteration: false,
    maxIterations: AGENT_MODE_CONFIG.MAX_ITERATIONS || 3
  });

  trimmedHistory.push({ role: 'assistant', content: agentResult.finalResponse });
  saveHistory(webSessionId, trimmedHistory);

  logInfo('[chatAPI] エージェント開始完了 - sessionId:', clientSessionId, 'isComplete:', agentResult.isComplete);

  return {
    success: true,
    reply: agentResult.finalResponse,
    thinkingInfo: agentResult.thinkingInfo,
    iteration: agentResult.iteration,
    maxIterations: agentResult.maxIterations,
    isComplete: agentResult.isComplete,
    needsMoreSearch: agentResult.needsMoreSearch,
    sessionId: clientSessionId,
    timestamp: new Date().toISOString()
  };
}

/**
 * エージェントの反復を継続
 */
function handleAgentContinue(request) {
  const clientSessionId = request.sessionId;
  
  if (!clientSessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  const webSessionId = 'WEB_' + clientSessionId;
  const history = getHistory(webSessionId);
  const trimmedHistory = history.slice(-10);

  const savedState = getAgentState(webSessionId);
  if (!savedState || !savedState.userMessage) {
    return { success: false, error: 'エージェントの状態が見つかりません。再度開始してください。' };
  }

  const userMessage = savedState.userMessage;

  const agentResult = callChatGPTWithAgentIterative(userMessage, trimmedHistory, webSessionId, {
    continueIteration: true,
    maxIterations: AGENT_MODE_CONFIG.MAX_ITERATIONS || 3
  });

  trimmedHistory.push({ role: 'assistant', content: agentResult.finalResponse });
  saveHistory(webSessionId, trimmedHistory);

  logInfo('[chatAPI] エージェント継続完了 - sessionId:', clientSessionId, 'isComplete:', agentResult.isComplete);

  return {
    success: true,
    reply: agentResult.finalResponse,
    thinkingInfo: agentResult.thinkingInfo,
    iteration: agentResult.iteration,
    maxIterations: agentResult.maxIterations,
    isComplete: agentResult.isComplete,
    needsMoreSearch: agentResult.needsMoreSearch,
    sessionId: clientSessionId,
    timestamp: new Date().toISOString()
  };
}
