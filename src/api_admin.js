/**
 * 管理画面APIエンドポイントモジュール
 * 
 * @module api_admin
 * @description 管理画面APIエンドポイント
 * 
 * このファイルには以下が含まれています：
 * - RAG管理画面用API（getRagStats, getIndexedFiles, getIndexedChunks）
 * - 設定画面用API（getSettingsData, updateSetting）
 * - ログ取得画面用API（getLogs, getNewLogs）
 * - ファイルアップロード・削除機能
 * - フォルダツリー取得機能
 * - プロパティのインポート・エクスポート機能
 * - LLM/検索パラメータ取得・更新機能
 * 
 * @depends config, rag_sheet, triggers, search
 * @exports getRagStats, triggerIndexing, getSettingsData
 */

/**
 * RAGの統計情報を取得（rag-manager.html用）
 */
function getRagStats() {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return { docCount: 0, chunkCount: 0, lastUpdate: '未実行' };
    }

    const chunkCount = data.length - 1;
    const fileIds = new Set();
    for (let i = 1; i < data.length; i++) {
      const fileId = data[i][0];
      if (fileId) {
        fileIds.add(fileId);
      }
    }
    const docCount = fileIds.size;

    const lastIndexTime = getLastIndexTime();
    let lastUpdate = '未実行';
    if (lastIndexTime) {
      lastUpdate = lastIndexTime.toLocaleString('ja-JP');
    }

    return {
      docCount: docCount,
      chunkCount: chunkCount,
      lastUpdate: lastUpdate
    };
  } catch (error) {
    logError('[getRagStats] エラー:', error);
    return { docCount: 0, chunkCount: 0, lastUpdate: 'エラー' };
  }
}

/**
 * インデックス済みファイル一覧を取得
 */
function getIndexedFiles() {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return { files: [] };
    }

    const fileInfo = {};

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = row[0];
      const fileName = row[1];
      const mimeType = row[2];
      const updatedAt = row[5];

      if (!fileInfo[fileId]) {
        fileInfo[fileId] = {
          fileId: fileId,
          fileName: fileName,
          mimeType: mimeType,
          updatedAt: updatedAt,
          chunkCount: 0
        };
      }
      fileInfo[fileId].chunkCount++;
    }

    return { files: Object.values(fileInfo) };
  } catch (error) {
    logError('[getIndexedFiles] エラー:', error);
    return { files: [], error: error.message };
  }
}

/**
 * 特定のファイルのチャンク一覧を取得
 */
function getIndexedChunks(fileId) {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return { chunks: [] };
    }

    const chunks = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rowFileId = row[0];

      if (rowFileId === fileId) {
        chunks.push({
          fileId: row[0],
          fileName: row[1],
          mimeType: row[2],
          textChunk: row[3],
          chunkIndex: row[5],
          charCount: row[7],
          preview: row[8],
          totalChunks: row[9]
        });
      }
    }

    return { chunks: chunks };
  } catch (error) {
    logError('[getIndexedChunks] エラー:', error);
    return { chunks: [], error: error.message };
  }
}

/**
 * DriveフォルダIDを取得
 */
function getDriveFolderId() {
  return DRIVE_FOLDER_ID;
}

/**
 * ファイルをGoogle Driveにアップロード
 */
function uploadFileToDrive(fileName, base64Data, mimeType) {
  try {
    if (!DRIVE_FOLDER_ID) {
      return { success: false, error: 'DRIVE_FOLDER_IDが設定されていません' };
    }

    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType,
      fileName
    );

    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const file = folder.createFile(blob);

    logInfo('[UPLOAD] ファイルアップロード完了:', fileName, 'FileId:', file.getId());

    return {
      success: true,
      fileName: fileName,
      fileId: file.getId(),
      mimeType: file.getMimeType()
    };
  } catch (error) {
    logError('[UPLOAD] ファイルアップロードエラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * インデックスを実行
 */
function triggerIndexing() {
  try {
    logInfo('[triggerIndexing] インデックス更新を開始します');
    const result = incrementalIndexGoogleDrive();
    
    if (!result) {
      logError('[triggerIndexing] 結果がありません');
      return {
        success: false,
        message: '✗ インデックス更新の結果がありません',
        details: { added: 0, updated: 0, unchanged: 0, totalFiles: 0 }
      };
    }

    logInfo('[triggerIndexing] インデックス更新完了:', result);
    
    return {
      success: true,
      message: `✓ インデックス更新完了\n\n📄 新規追加: ${result.added}\n📝 更新: ${result.updated}\n⏩ 未変更: ${result.unchanged}\n📊 合計: ${result.totalFiles}`,
      details: result
    };
  } catch (error) {
    logError('[triggerIndexing] エラー:', error);
    return {
      success: false,
      message: '✗ インデックス更新に失敗しました: ' + error.message,
      error: error.message,
      details: { added: 0, updated: 0, unchanged: 0, totalFiles: 0 }
    };
  }
}

/**
 * フォルダのファイル一覧を取得
 */
function getFolderFiles() {
  try {
    if (!DRIVE_FOLDER_ID) {
      return { files: [], error: 'DRIVE_FOLDER_IDが設定されていません' };
    }

    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const visitedFolders = new Set();
    const files = getFolderTreeRecursive(folder, visitedFolders, 0);

    return { files: files };
  } catch (error) {
    return { files: [], error: error.message };
  }
}

/**
 * フォルダツリーを再帰的に取得
 */
function getFolderTreeRecursive(folder, visitedFolders, depth = 0) {
  const result = [];
  
  const folderId = folder.getId();
  if (visitedFolders.has(folderId)) {
    return result;
  }
  visitedFolders.add(folderId);
  
  const mimeTypes = [
    MimeType.GOOGLE_DOCS,
    MimeType.GOOGLE_SHEETS,
    "text/plain",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/x-markdown",
    "application/x-markdown",
    MimeType.MICROSOFT_WORD,
    MimeType.MICROSOFT_EXCEL,
    MimeType.MICROSOFT_POWERPOINT,
    MimeType.PDF
  ];
  
  for (const mimeType of mimeTypes) {
    const iterator = folder.getFilesByType(mimeType);
    while (iterator.hasNext()) {
      const file = iterator.next();
      result.push({
        type: 'file',
        id: file.getId(),
        name: file.getName(),
        mimeType: file.getMimeType(),
        size: file.getSize(),
        updatedAt: file.getLastUpdated().toString(),
        depth: depth
      });
    }
  }
  
  const subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    const subFolder = subFolders.next();
    result.push({
      type: 'folder',
      id: subFolder.getId(),
      name: subFolder.getName(),
      updatedAt: subFolder.getLastUpdated().toString(),
      depth: depth,
      isExpanded: false
    });
    
    const subItems = getFolderTreeRecursive(subFolder, visitedFolders, depth + 1);
    result.push(...subItems);
  }
  
  return result;
}

/**
 * ファイルのダウンロードURLを取得
 */
function getFileDownloadUrl(fileId) {
  try {
    if (!fileId) {
      return { success: false, error: 'fileIdが指定されていません' };
    }

    const file = DriveApp.getFileById(fileId);
    const mimeType = file.getMimeType();
    const fileName = file.getName();

    // Google Docs/Sheets/Presentation の場合はエクスポート形式が必要
    let downloadUrl = '';
    
    if (mimeType === 'application/vnd.google-apps.document') {
      // Google Docs は DOCX でエクスポート
      downloadUrl = `https://docs.google.com/document/d/${fileId}/export?format=docx`;
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      // Google Sheets は XLSX でエクスポート
      downloadUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`;
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      // Google Slides は PPTX でエクスポート
      downloadUrl = `https://docs.google.com/presentation/d/${fileId}/export?format=pptx`;
    } else {
      // その他のファイルは直接ダウンロード
      downloadUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
    }

    logInfo('[getFileDownloadUrl] ダウンロードURL取得完了:', fileName, 'FileId:', fileId);

    return {
      success: true,
      fileName: fileName,
      downloadUrl: downloadUrl,
      webViewUrl: file.getUrl()
    };
  } catch (error) {
    logError('[getFileDownloadUrl] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * アップロードされたファイルを削除
 */
function deleteUploadedFile(fileId) {
  try {
    if (!fileId) {
      return { success: false, error: 'fileIdが指定されていません' };
    }

    const sheet = getRagSheet();
    deleteChunksByFileId(sheet, fileId);

    const file = DriveApp.getFileById(fileId);
    const fileName = file.getName();
    file.setTrashed(true);

    logInfo('[deleteUploadedFile] ファイル削除完了:', fileName, 'FileId:', fileId);

    return {
      success: true,
      fileName: fileName,
      fileId: fileId
    };
  } catch (error) {
    logError('[deleteUploadedFile] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Script Propertiesから全設定を取得
 */
function getSettingsData() {
  try {
    const properties = {};
    const missingKeys = [];

    const propKeys = Object.keys(SETTING_DEFINITIONS);

    for (const key of propKeys) {
      const def = SETTING_DEFINITIONS[key];
      let value = scriptProps.getProperty(key);

      if (value === null || value === undefined || value === '') {
        if (def.defaultValue) {
          scriptProps.setProperty(key, def.defaultValue);
          value = def.defaultValue;
          logInfo('[getSettingsData] デフォルト値を設定:', key, '=', def.defaultValue);
        }
        missingKeys.push(key);
      }

      properties[key] = value || '';
    }

    return {
      success: true,
      properties: properties,
      definitions: SETTING_DEFINITIONS,
      missingKeys: missingKeys,
      message: missingKeys.length > 0
        ? '未設定項目があります。値を設定してください。'
        : '全設定が完了しています。'
    };
  } catch (error) {
    logError('[getSettingsData] エラー:', error);
    return {
      success: false,
      error: error.message,
      properties: {},
      definitions: SETTING_DEFINITIONS
    };
  }
}

/**
 * Script Propertiesを更新
 */
function updateSetting(key, value) {
  try {
    const allowedKeys = [
      'OPENAI_API_KEY',
      'LINE_TOKEN',
      'LOG_SHEET_ID',
      'DRIVE_FOLDER_ID',
      'INDEX_SHEET_ID',
      'VISION_API_KEY',
      'QUERY_EXPANSION_ENABLED',
      'DEBUG_MODE',
      'ADMIN_LIST',
      'DEV_MODE',
      'ALLOW_LIST',
      'BLOCK_LIST'
    ];

    if (!allowedKeys.includes(key)) {
      return { success: false, error: '許可されていないキーです: ' + key };
    }

    scriptProps.setProperty(key, value);
    logInfo('[updateSetting] 設定を更新:', key);

    return { success: true, key: key, value: value };
  } catch (error) {
    logError('[updateSetting] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * ログを取得
 */
function getLogs(limit) {
  const maxLimit = limit || 100;

  if (!LOG_SHEET_ID) {
    return [];
  }

  try {
    const sheet = SpreadsheetApp.openById(LOG_SHEET_ID).getActiveSheet();
    const lastRow = sheet.getLastRow();

    if (lastRow <= 1) {
      return [];
    }

    const startRow = Math.max(2, lastRow - maxLimit + 1);
    const numRows = lastRow - startRow + 1;
    const data = sheet.getRange(startRow, 1, numRows, 3).getValues();

    const logs = [];
    for (let i = data.length - 1; i >= 0; i--) {
      const [timestamp, level, message] = data[i];
      let timestampStr = '';
      if (timestamp instanceof Date) {
        timestampStr = timestamp.toISOString();
      } else if (typeof timestamp === 'string') {
        timestampStr = timestamp;
      } else if (timestamp) {
        timestampStr = String(timestamp);
      }

      logs.push({
        timestamp: timestampStr,
        level: String(level || ''),
        message: String(message || '')
      });
    }

    return Utilities.jsonStringify(logs);

  } catch (error) {
    return [];
  }
}

/**
 * 新規ログを取得
 */
function getNewLogs(lastTimestamp) {
  if (!LOG_SHEET_ID || !lastTimestamp) {
    return getLogs(50);
  }

  try {
    const sheet = SpreadsheetApp.openById(LOG_SHEET_ID).getActiveSheet();
    const lastRow = sheet.getLastRow();

    if (lastRow <= 1) {
      return [];
    }

    const data = sheet.getDataRange().getValues();
    const newLogs = [];

    for (let i = data.length - 1; i >= 1; i--) {
      const [timestamp, level, message] = data[i];

      if (new Date(timestamp) > new Date(lastTimestamp)) {
        newLogs.unshift({
          timestamp: timestamp,
          level: level,
          message: String(message || '')
        });
      } else {
        break;
      }
    }

    return newLogs;

  } catch (error) {
    console.error('[getNewLogs] エラー:', error);
    return [];
  }
}

/**
 * 全プロパティをエクスポート
 */
function exportAllProperties() {
  try {
    const exportData = {
      exportDate: new Date().toISOString(),
      version: '1.0',
      scriptProperties: {},
      userProperties: {},
      promptTemplates: {},
      adminPrompts: {}
    };

    const scriptPropsData = scriptProps.getProperties();
    exportData.scriptProperties = scriptPropsData || {};

    const userPropsData = userProps.getProperties();
    exportData.userProperties = userPropsData || {};

    for (const key of Object.keys(PROMPT_TEMPLATE_DEFINITIONS)) {
      const value = scriptProps.getProperty(key);
      exportData.promptTemplates[key] = value || '';
    }

    for (const key of Object.keys(ADMIN_PROMPT_DEFINITIONS)) {
      const value = scriptProps.getProperty(key);
      exportData.adminPrompts[key] = value || '';
    }

    logInfo('[exportAllProperties] エクスポート完了');

    return {
      success: true,
      data: exportData,
      json: JSON.stringify(exportData, null, 2)
    };
  } catch (error) {
    logError('[exportAllProperties] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * プロパティをインポート
 */
function importAllProperties(jsonString) {
  try {
    if (!jsonString || jsonString.trim() === '') {
      return { success: false, error: 'JSONデータが空です' };
    }

    const importData = JSON.parse(jsonString);
    
    let importedCount = 0;
    let errorCount = 0;
    const errors = [];

    if (importData.scriptProperties && typeof importData.scriptProperties === 'object') {
      for (const [key, value] of Object.entries(importData.scriptProperties)) {
        try {
          if (Object.keys(SETTING_DEFINITIONS).includes(key)) {
            scriptProps.setProperty(key, String(value));
            importedCount++;
          }
        } catch (e) {
          errorCount++;
          errors.push(`${key}: ${e.message}`);
        }
      }
    }

    if (importData.userProperties && typeof importData.userProperties === 'object') {
      for (const [key, value] of Object.entries(importData.userProperties)) {
        try {
          if (Object.keys(LLM_PARAM_DEFINITIONS).includes(key) || 
              Object.keys(SEARCH_PARAM_DEFINITIONS).includes(key)) {
            userProps.setProperty(key, String(value));
            importedCount++;
          }
        } catch (e) {
          errorCount++;
          errors.push(`${key}: ${e.message}`);
        }
      }
    }

    if (importData.promptTemplates && typeof importData.promptTemplates === 'object') {
      for (const key of Object.keys(PROMPT_TEMPLATE_DEFINITIONS)) {
        try {
          if (importData.promptTemplates[key] !== undefined) {
            scriptProps.setProperty(key, String(importData.promptTemplates[key]));
            importedCount++;
          }
        } catch (e) {
          errorCount++;
          errors.push(`${key}: ${e.message}`);
        }
      }
    }

    if (importData.adminPrompts && typeof importData.adminPrompts === 'object') {
      for (const key of Object.keys(ADMIN_PROMPT_DEFINITIONS)) {
        try {
          if (importData.adminPrompts[key] !== undefined) {
            scriptProps.setProperty(key, String(importData.adminPrompts[key]));
            importedCount++;
          }
        } catch (e) {
          errorCount++;
          errors.push(`${key}: ${e.message}`);
        }
      }
    }

    logInfo('[importAllProperties] インポート完了 - 成功:', importedCount, 'エラー:', errorCount);

    return {
      success: errorCount === 0,
      importedCount: importedCount,
      errorCount: errorCount,
      errors: errors,
      message: `インポート完了: ${importedCount}件成功${errorCount > 0 ? `、${errorCount}件エラー` : ''}`
    };
  } catch (error) {
    logError('[importAllProperties] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * LLMパラメータを取得（settings.html用）
 */
function getLlmSettingsData() {
  try {
    const properties = {};
    const keys = Object.keys(LLM_PARAM_DEFINITIONS);

    for (const key of keys) {
      let value = userProps.getProperty(key);
      const def = LLM_PARAM_DEFINITIONS[key];

      if (value === null || value === undefined || value === '') {
        if (def.defaultValue !== undefined) {
          value = def.defaultValue;
          userProps.setProperty(key, value);
        }
      }

      properties[key] = value || '';
    }

    return {
      success: true,
      properties: properties,
      definitions: LLM_PARAM_DEFINITIONS
    };
  } catch (error) {
    logError('[getLlmSettingsData] エラー:', error);
    return {
      success: false,
      error: error.message,
      properties: {},
      definitions: LLM_PARAM_DEFINITIONS
    };
  }
}

/**
 * LLMパラメータを更新
 */
function updateLlmParam(key, value) {
  try {
    if (!Object.keys(LLM_PARAM_DEFINITIONS).includes(key)) {
      return { success: false, error: '許可されていないキー: ' + key };
    }

    userProps.setProperty(key, String(value));
    logInfo('[updateLlmParam]', key, value);

    return { success: true, key: key, value: value };
  } catch (error) {
    logError('[updateLlmParam] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 検索設定を取得
 */
function getSearchSettingsData() {
  try {
    const properties = {};
    const keys = Object.keys(SEARCH_PARAM_DEFINITIONS);

    for (const key of keys) {
      let value = userProps.getProperty(key);
      const def = SEARCH_PARAM_DEFINITIONS[key];

      if (value === null || value === undefined || value === '') {
        if (def.defaultValue !== undefined) {
          value = def.defaultValue;
          userProps.setProperty(key, value);
        }
      }

      properties[key] = value || '';
    }

    return {
      success: true,
      properties: properties,
      definitions: SEARCH_PARAM_DEFINITIONS
    };
  } catch (error) {
    logError('[getSearchSettingsData] エラー:', error);
    return {
      success: false,
      error: error.message,
      properties: {},
      definitions: SEARCH_PARAM_DEFINITIONS
    };
  }
}

/**
 * 検索パラメータを更新
 */
function updateSearchParam(key, value) {
  try {
    if (!Object.keys(SEARCH_PARAM_DEFINITIONS).includes(key)) {
      return { success: false, error: '許可されていないキー: ' + key };
    }

    userProps.setProperty(key, String(value));
    logInfo('[updateSearchParam]', key, value);

    return { success: true, key: key, value: value };
  } catch (error) {
    logError('[updateSearchParam] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * プロンプトテンプレート設定を取得
 */
function getPromptTemplateSettings() {
  try {
    const settings = {};

    for (const key of Object.keys(PROMPT_TEMPLATE_DEFINITIONS)) {
      let value = scriptProps.getProperty(key);
      const def = PROMPT_TEMPLATE_DEFINITIONS[key];

      if (value === null || value === undefined || value === '') {
        if (def.defaultValue !== undefined) {
          value = def.defaultValue;
          scriptProps.setProperty(key, value);
        }
      }

      settings[key] = value || '';
    }

    return {
      success: true,
      settings: settings,
      definitions: PROMPT_TEMPLATE_DEFINITIONS
    };
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
    if (!Object.keys(PROMPT_TEMPLATE_DEFINITIONS).includes(key)) {
      return { success: false, error: '許可されていないキー: ' + key };
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
 * モデルがtop_kパラメータをサポートしているかチェック
 * @param {string} model - モデル名
 * @returns {boolean} サポートしている場合true
 */
function supportsTopK(model) {
  return !MODELS_WITHOUT_TOP_K.includes(model);
}

/**
 * LLMパラメータを取得（chat_message.js用）
 * @returns {Object} LLMパラメータオブジェクト
 */
function getLlmParams() {
  try {
    const result = {};
    for (const [key, def] of Object.entries(LLM_PARAM_DEFINITIONS)) {
      let value = userProps.getProperty(key);
      if (value === null || value === undefined || value === '') {
        value = def.defaultValue;
        userProps.setProperty(key, value);
      }
      const paramName = def.paramName || key;
      result[paramName] = (def.isString || def.isSelect) ? value : (value === '' ? NaN : parseFloat(value));
    }
    return result;
  } catch (error) {
    logError('[getLlmParams] エラー:', error);
    return getLlmParamsDefault();
  }
}

/**
 * LLMパラメータのデフォルト値を返す
 * @returns {Object} デフォルトLLMパラメータ
 */
function getLlmParamsDefault() {
  const d = {};
  for (const [key, def] of Object.entries(LLM_PARAM_DEFINITIONS)) {
    d[def.paramName] = (def.isString || def.isSelect) ? def.defaultValue : parseFloat(def.defaultValue);
  }
  return d;
}

/**
 * 検索パラメータを取得（chat_message.js用）
 * @returns {Object} 検索パラメータオブジェクト
 */
function getSearchParams() {
  try {
    const result = {};
    for (const [key, def] of Object.entries(SEARCH_PARAM_DEFINITIONS)) {
      let value = userProps.getProperty(key);
      if (value === null || value === undefined || value === '') {
        value = def.defaultValue;
        userProps.setProperty(key, value);
      }
      result[key] = value !== 'false';
    }
    return result;
  } catch (error) {
    logError('[getSearchParams] エラー:', error);
    return getSearchParamsDefault();
  }
}

/**
 * 検索パラメータのデフォルト値を返す
 * @returns {Object} デフォルト検索パラメータ
 */
function getSearchParamsDefault() {
  const d = {};
  for (const [key, def] of Object.entries(SEARCH_PARAM_DEFINITIONS)) {
    d[key] = def.defaultValue !== 'false';
  }
  return d;
}

/**
 * 設定値の初期化（存在しないキーをデフォルト値で作成）
 * @returns {Object} 初期化結果
 */
function initializeSettings() {
  try {
    return {
      success: true,
      message: '設定定義を返却しました',
      definitions: SETTING_DEFINITIONS
    };
  } catch (error) {
    logError('[initializeSettings] エラー:', error);
    return { success: false, error: error.message };
  }
}
