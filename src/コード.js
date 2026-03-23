/**
 * LINE-GAS-AI エントリーポイント
 * 
 * このファイルはdoGetとdoPostのエクスポートのみを担当します。
 * 実際の処理は各モジュールファイルに実装されています。
 */

// ================================
//  Web Apps エントリーポイント
// ================================

/**
 * Web Appsのエントリーポイント（HTMLページ表示用）
 * @param {Object} e - doGetイベントオブジェクト
 * @returns {HtmlOutput} HTML出力
 */
function doGet(e) {
  // webapp.jsのdoGet関数を呼び出す
  const page = e.parameter.page || 'chat';
  
  // 管理画面（admin, settings, rag, log）は認証が必要
  const requiresAuth = ['admin', 'settings', 'rag', 'log'].includes(page);
  
  let authResult = { isAdmin: true, email: '', message: '' };
  
  if (requiresAuth) {
    authResult = checkAdminAuth();
    if (!authResult.isAdmin) {
      return createAuthErrorHtml(authResult);
    }
  }

  if (page === 'rag') {
    const template = HtmlService.createTemplateFromFile('rag-manager.html');
    return template.evaluate()
      .setTitle('RAG インデックス管理')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else if (page === 'log') {
    const template = HtmlService.createTemplateFromFile('log-monitor.html');
    return template.evaluate()
      .setTitle('AI Chat ログモニター')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else if (page === 'settings') {
    const template = HtmlService.createTemplateFromFile('settings.html');
    return template.evaluate()
      .setTitle('設定')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else if (page === 'admin') {
    const template = HtmlService.createTemplateFromFile('admin.html');
    template.adminParam = 'admin';
    template.userEmail = authResult.email;
    return template.evaluate()
      .setTitle('管理者メニュー')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else {
    // デフォルト: チャット画面
    const chatAuth = checkChatUserAuth();
    if (chatAuth.isBlocked) {
      return createAuthErrorHtml(chatAuth);
    }
    const template = HtmlService.createTemplateFromFile('chat.html');
    template.userEmail = chatAuth.email;
    template.isAdmin = chatAuth.isAdmin || false;
    template.isDevMode = chatAuth.isDevMode || false;
    return template.evaluate()
      .setTitle('AI Chat')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
}

// ================================
//  LINE Webhook エントリーポイント
// ================================

/**
 * LINE Webhookを受け取りメッセージを処理
 * @param {Object} e - doPostイベントオブジェクト
 */
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  const event = data.events[0];
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const userMessage = event.message.text;

  if (!replyToken) return;

  let history = getHistory(userId);

  // 履歴削除コマンド
  if (userMessage === "#履歴削除") {
    try {
      const cache = CacheService.getScriptCache();
      if (!cache) {
        logError("[COMMAND] 履歴削除: CacheServiceが利用できません");
        sendMessage(replyToken, "✗ キャッシュサービスの取得に失敗しました");
        return;
      }
      cache.remove(userId);
      logTrace("[COMMAND] 会話履歴を削除:", userId);
      const cacheDeletedCount = clearAllQueryCaches();
      logInfo("[COMMAND] 履歴削除:", userId, "| RAGキャッシュ削除:", cacheDeletedCount, "件");
      sendMessage(replyToken, "✓ 会話履歴と参考ドキュメントのキャッシュをクリアしました。");
    } catch (error) {
      logError("[COMMAND] 履歴削除エラー:", error);
      sendMessage(replyToken, "✗ 履歴削除に失敗しました");
    }
    return;
  }

  // インデックス情報表示コマンド
  if (userMessage === "#インデックス情報") {
    try {
      const sheet = getRagSheet();
      const data = sheet.getDataRange().getValues();
      const chunkCount = data.length - 1;
      const docMap = {};
      for (let i = 1; i < data.length; i++) {
        const [fileId, fileName, , , , updatedAt] = data[i];
        if (!docMap[fileId]) {
          docMap[fileId] = { fileName, lastUpdate: updatedAt };
        }
      }
      const docCount = Object.keys(docMap).length;
      let info = "📊 インデックス情報\n\n";
      info += `📄 ドキュメント数: ${docCount}\n`;
      info += `📦 チャンク数: ${chunkCount}\n\n`;
      const lastIndex = getLastIndexTime();
      if (lastIndex) {
        info += `🕐 最終更新: ${lastIndex.toLocaleString("ja-JP")}\n\n`;
      }
      info += "【登録ドキュメント】\n";
      Object.entries(docMap).forEach(([fileId, doc], i) => {
        info += `${i + 1}. ${doc.fileName}\n   更新: ${doc.lastUpdate}\n`;
      });
      logInfo("[COMMAND] インデックス情報:", docCount, "files,", chunkCount, "chunks");
      sendMessage(replyToken, info);
      return;
    } catch (error) {
      logError("[COMMAND] インデックス情報エラー:", error);
      sendMessage(replyToken, "✗ インデックス情報の取得に失敗しました");
      return;
    }
  }

  // インデックス更新コマンド
  if (userMessage === "#インデックス更新") {
    try {
      sendMessage(replyToken, "🔄 インデックス更新を開始します...\n\nこの処理には数分かかる場合があります。");
      const result = triggerManualIndexUpdate();
      logInfo("[COMMAND] インデックス更新結果:", result);
      return;
    } catch (error) {
      logError("[COMMAND] インデックス更新エラー:", error);
      sendMessage(replyToken, "✗ インデックス更新に失敗しました");
      return;
    }
  }

  // 自動更新トリガー設定コマンド
  if (userMessage.startsWith("#自動更新")) {
    try {
      const hours = parseInt(userMessage.replace("#自動更新", "").trim()) || 1;
      if (hours < 1 || hours > 24) {
        sendMessage(replyToken, "⚠️ 時間は1〜24時間の間で指定してください。\n例: #自動更新 2");
        return;
      }
      setupAutoIndexTrigger(hours);
      logInfo("[COMMAND] 自動更新トリガー設定:", hours, "時間ごと");
      sendMessage(replyToken, `✅ 自動更新トリガーを設定しました。\n\n⏰ ${hours}時間ごとにインデックスが自動更新されます。`);
      return;
    } catch (error) {
      logError("[COMMAND] 自動更新設定エラー:", error);
      sendMessage(replyToken, "✗ 自動更新の設定に失敗しました");
      return;
    }
  }

  // 自動更新解除コマンド
  if (userMessage === "#自動更新解除") {
    try {
      removeAutoIndexTrigger();
      logInfo("[COMMAND] 自動更新トリガー解除");
      sendMessage(replyToken, "✅ 自動更新を解除しました。");
      return;
    } catch (error) {
      logError("[COMMAND] 自動更新解除エラー:", error);
      sendMessage(replyToken, "✗ 自動更新の解除に失敗しました");
      return;
    }
  }

  // 初期インデックス実行コマンド
  if (userMessage === "#初期インデックス") {
    try {
      sendMessage(replyToken, "🔄 初期インデックスを実行します...\n\n全てのドキュメント的处理には数分かかる場合があります。");
      const result = initIncrementalIndex();
      logInfo("[COMMAND] 初期インデックス結果:", result);
      const resultMsg = `✓ 初期インデックス完了\n\n📄 新規追加: ${result.added}\n📝 更新: ${result.updated}\n⏩ 未変更: ${result.unchanged}\n📊 合計: ${result.totalFiles}`;
      sendMessage(replyToken, resultMsg);
      return;
    } catch (error) {
      logError("[COMMAND] 初期インデックスエラー:", error);
      sendMessage(replyToken, "✗ 初期インデックスの実行に失敗しました");
      return;
    }
  }

  // 拡張機能ON/OFFコマンド
  if (userMessage === "#拡張機能") {
    try {
      const expansionEnabled = scriptProps.getProperty("QUERY_EXPANSION_ENABLED");
      const newValue = expansionEnabled !== "false";
      scriptProps.setProperty("QUERY_EXPANSION_ENABLED", newValue.toString());
      sendMessage(replyToken, `✅ クエリ拡張: ${newValue ? "オン" : "オフ"}\n\n検索精度向上が期待できます。`);
      return;
    } catch (error) {
      sendMessage(replyToken, "✗ 設定変更に失敗しました");
      return;
    }
  }

  // キャッシュクリアコマンド
  if (userMessage === "#キャッシュクリア") {
    try {
      const cache = CacheService.getScriptCache();
      if (!cache) {
        logError("[COMMAND] キャッシュクリア: CacheServiceが利用できません");
        sendMessage(replyToken, "✗ キャッシュサービスの取得に失敗しました");
        return;
      }
      const deletedCount = clearAllQueryCaches();
      logInfo("[COMMAND] キャッシュクリア: 削除件数:", deletedCount);
      sendMessage(replyToken, `✅ キャッシュをクリアしました。\n\n削除件数: ${deletedCount}`);
      return;
    } catch (error) {
      logError("[COMMAND] キャッシュクリアエラー:", error);
      sendMessage(replyToken, "✗ キャッシュクリアに失敗しました");
      return;
    }
  }

  // ヘルプコマンド
  if (userMessage === "#ヘルプ") {
    const helpMessage = `📖 *AI Chat コマンドヘルプ*\n\n` +
      `【情報確認】\n━━━━━━━━━━━━━━━━━━\n` +
      `📊 #インデックス情報\n   → 登録ドキュメント数・チャンク数・最終更新日時を表示\n\n` +
      `【インデックス管理】\n━━━━━━━━━━━━━━━━━━\n` +
      `🔄 #インデックス更新\n   → 手動でインデックスを更新\n\n` +
      `🚀 #初期インデックス\n   → 初回または全ファイル再インデックスを実行\n\n` +
      `⏰ #自動更新 [時間] ⚠️\n   → 自動更新を設定（例: #自動更新 2 で2時間ごと）\n\n` +
      `🛑 #自動更新解除\n   → 自動更新を停止\n\n` +
      `【機能切替】\n━━━━━━━━━━━━━━━━━━\n` +
      `✨ #拡張機能\n   → クエリ拡張（類義語追加）のON/OFFを切り替え\n\n` +
      `🗑️ #キャッシュクリア\n   → 検索キャッシュをクリアして再検索\n\n` +
      `📝 #履歴削除\n   → 会話履歴をクリア\n\n` +
      `【文章加工】\n━━━━━━━━━━━━━━━━━━\n` +
      `📝 #要約 [テキスト]\n   → テキストを要約\n\n` +
      `🙇 #丁寧に [テキスト]\n   → 丁寧な言い方に変換\n\n` +
      `📋 #箇条書き [テキスト]\n   → 箇条書きに変換\n\n` +
      `🌐 #翻訳 [テキスト]\n   → 英語に翻訳\n\n━━━━━━━━━━━━━━━━━━\n` +
      `💡 通常の質問 = 自動的にRAG検索されます`;
    sendMessage(replyToken, helpMessage);
    return;
  }

  // プロンプトテンプレートを選択
  let templateKey = "free";
  let content = userMessage;

  if (userMessage.startsWith("#要約")) {
    templateKey = "summary";
    content = userMessage.replace("#要約", "").trim();
  } else if (userMessage.startsWith("#丁寧")) {
    templateKey = "polite";
    content = userMessage.replace("#丁寧", "").trim();
  } else if (userMessage.startsWith("#箇条書き")) {
    templateKey = "bullet";
    content = userMessage.replace("#箇条書き", "").trim();
  } else if (userMessage.startsWith("#翻訳")) {
    templateKey = "translate";
    content = userMessage.replace("#翻訳", "").trim();
  }

  const prompt = PROMPT_TEMPLATES[templateKey](content);

  sendLineLoading(userId);

  history.push({ role: "user", content: prompt });
  history = history.slice(-5);

  const botReply = callChatGPTWithRAGEnhanced(prompt, history, userId);

  history.push({ role: "assistant", content: botReply });
  saveHistory(userId, history);

  sendMessage(replyToken, botReply);
}
