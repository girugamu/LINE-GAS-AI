/**
 * Web Apps認証・HTML出力モジュール
 * 
 * @module webapp
 * @description Web Apps認証・HTML出力
 * 
 * このファイルには以下が含まれています：
 * - doGet: Web Appsのメインエントリーポイント
 * - 管理者リスト取得・認証チェック
 * - 許可リスト取得
 * - 認証エラーHTML生成
 * - HTMLテンプレート読み込み関数
 * - Web Apps URL取得
 * 
 * @depends config
 * @exports checkAdminAuth, checkChatUserAuth, createAuthErrorHtml, getAllowList, isDevModeEnabled
 */

/**
 * 管理者リストをScriptPropertiesから取得
 */
function getAdminList() {
  try {
    const adminListStr = scriptProps.getProperty('ADMIN_LIST') || '';
    if (!adminListStr || adminListStr.trim() === '') {
      logWarn('[ADMIN_AUTH] ADMIN_LISTがScriptPropertiesに設定されていません');
      return [];
    }
    const adminList = adminListStr.split(',').map(email => email.trim().toLowerCase()).filter(email => email);
    logTrace('[ADMIN_AUTH] 管理者リスト取得:', adminList.length, '人');
    return adminList;
  } catch (error) {
    logError('[ADMIN_AUTH] 管理者リスト取得エラー:', error);
    return [];
  }
}

/**
 * DEV_MODEが有効かを確認
 */
function isDevModeEnabled() {
  const devMode = scriptProps.getProperty('DEV_MODE');
  return devMode === 'true';
}

/**
 * 現在のユーザーが管理者かチェック
 */
function checkAdminAuth() {
  try {
    // DEV_MODEが有効な場合は無条件でアクセスを許可
    if (isDevModeEnabled()) {
      const userEmail = Session.getActiveUser().getEmail() || 'dev@local';
      logInfo('[ADMIN_AUTH] DEV_MODE有効: アクセス許可', userEmail);
      return {
        isAdmin: true,
        email: userEmail,
        message: '開発者モード: DEV_MODEが有効'
      };
    }
    
    const adminList = getAdminList();
    
    if (adminList.length === 0) {
      logWarn('[ADMIN_AUTH] 管理者リストが空です。');
      return {
        isAdmin: true,
        email: 'development@local',
        message: '開発モード: 管理者リスト未設定'
      };
    }
    
    const userEmail = Session.getActiveUser().getEmail();
    
    if (!userEmail) {
      logWarn('[ADMIN_AUTH] ユーザーメールアドレスを取得できませんでした');
      return {
        isAdmin: false,
        email: '',
        message: 'メールアドレスを取得できませんでした。'
      };
    }
    
    const userEmailLower = userEmail.toLowerCase();
    const isAdmin = adminList.includes(userEmailLower);
    
    if (isAdmin) {
      logInfo('[ADMIN_AUTH] 管理者アクセス許可:', userEmail);
      return {
        isAdmin: true,
        email: userEmail,
        message: '管理者として認証されました'
      };
    } else {
      logWarn('[ADMIN_AUTH] アクセス拒否:', userEmail, '(管理者リスト外)');
      return {
        isAdmin: false,
        email: userEmail,
        message: 'この機能へのアクセスは許可されていません'
      };
    }
  } catch (error) {
    logError('[ADMIN_AUTH] 認証エラー:', error);
    return {
      isAdmin: false,
      email: '',
      message: '認証処理中にエラーが発生しました: ' + error.message
    };
  }
}

/**
 * 認証エラー時のHTMLを生成
 */
function createAuthErrorHtml(authResult) {
  const template = HtmlService.createTemplateFromFile('auth-error.html');
  template.authResult = authResult;
  return template.evaluate()
    .setTitle('アクセス拒否')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * HTMLテンプレートを読み込み
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Web AppsのURLを取得
 */
function getAppUrl() {
  return ScriptApp.getService().getUrl();
}

/**
 * 許可リストを取得
 */
function getAllowList() {
  try {
    const allowListStr = scriptProps.getProperty('ALLOW_LIST') || '';
    if (!allowListStr || allowListStr.trim() === '') {
      logTrace('[ALLOW_LIST] 許可リストがScriptPropertiesに設定されていません');
      return [];
    }
    const allowList = allowListStr.split(',').map(email => email.trim().toLowerCase()).filter(email => email);
    logTrace('[ALLOW_LIST] 許可リスト取得:', allowList.length, '人');
    return allowList;
  } catch (error) {
    logError('[ALLOW_LIST] 許可リスト取得エラー:', error);
    return [];
  }
}

/**
 * チャットページのユーザー認証チェック
 */
function checkChatUserAuth() {
  try {
    const userEmail = Session.getActiveUser().getEmail();
    
    if (!userEmail) {
      logTrace('[CHAT_AUTH] メールアドレスを取得できませんでした');
      
      if (isDevModeEnabled()) {
        logInfo('[CHAT_AUTH] DEV_MODE有効（メールアドレス未取得）: 管理者アクセス許可');
        return {
          isBlocked: false,
          isAdmin: true,
          isDevMode: true,
          email: '',
          message: '開発者モード: DEV_MODEが有効（メールアドレス未取得）'
        };
      }
      
      return {
        isBlocked: false,
        isAdmin: false,
        isDevMode: false,
        email: '',
        message: 'メールアドレス未取得'
      };
    }
    
    const userEmailLower = userEmail.toLowerCase();
    
    if (isDevModeEnabled()) {
      logInfo('[CHAT_AUTH] DEV_MODE有効: アクセス許可', userEmail);
      return {
        isBlocked: false,
        isAdmin: true,
        isDevMode: true,
        email: userEmail,
        message: '開発者モード: DEV_MODEが有効'
      };
    }
    
    const adminList = getAdminList();
    const allowList = getAllowList();
    
    const isDevMode = adminList.length === 0;
    const isAdmin = isDevMode || (adminList.length > 0 && adminList.includes(userEmailLower));
    
    const isAllowListEnabled = allowList.length > 0;
    const isAllowed = isAllowListEnabled ? allowList.includes(userEmailLower) : true;
    
    if (isAllowListEnabled && !isAllowed) {
      logWarn('[CHAT_AUTH] アクセス拒否（許可リスト外）:', userEmail);
      return {
        isBlocked: true,
        isAdmin: false,
        isDevMode: false,
        email: userEmail,
        message: 'このサービスへのアクセスは許可されていません'
      };
    }
    
    const BLOCK_LISTStr = scriptProps.getProperty('BLOCK_LIST') || '';
    
    if (!BLOCK_LISTStr || BLOCK_LISTStr.trim() === '') {
      logTrace('[CHAT_AUTH] 禁止リストは設定されていません（アクセス許可）: ', userEmail);
      return {
        isBlocked: false,
        isAdmin: isAdmin,
        isDevMode: isDevMode,
        email: userEmail,
        message: isDevMode ? '開発者モード: 管理者リスト未設定' : (isAllowListEnabled ? '許可リストユーザー' : '禁止リスト未設定')
      };
    }
    
    const BLOCK_LIST = BLOCK_LISTStr.split(',').map(email => email.trim().toLowerCase()).filter(email => email);
    const isBlocked = BLOCK_LIST.includes(userEmailLower);
    
    if (isBlocked) {
      logWarn('[CHAT_AUTH] アクセス拒否（禁止リスト）:', userEmail);
      return {
        isBlocked: true,
        isAdmin: false,
        isDevMode: false,
        email: userEmail,
        message: 'このサービスへのアクセスは拒否されています'
      };
    } else {
      logInfo('[CHAT_AUTH] アクセス許可:', userEmail, '管理者:', isAdmin, '開発者モード:', isDevMode);
      return {
        isBlocked: false,
        isAdmin: isAdmin,
        isDevMode: isDevMode,
        email: userEmail,
        message: isDevMode ? '開発者モード' : (isAllowListEnabled ? '許可リストユーザー' : 'アクセス許可')
      };
    }
  } catch (error) {
    logError('[CHAT_AUTH] 認証エラー:', error);
    return {
      isBlocked: false,
      isAdmin: false,
      isDevMode: false,
      email: '',
      message: '認証エラー（アクセス許可）'
    };
  }
}
