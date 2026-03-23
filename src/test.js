/**
 * テストモジュール
 * 
 * このファイルには以下が含まれています：
 * - forceReindexFile: 特定のファイルを強制再インデックス
 * - testExcelExtraction: Excel抽出テスト
 * - clearAndReindexAll: 全インデックスクリアして再作成
 * - testFetch: 外部通信テスト
 */

/**
 * 特定のファイルを強制的に再インデックス
 */
function forceReindexFile(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const fileName = file.getName();
    const mimeType = file.getMimeType();

    logInfo("[FORCE] 強制再インデックス開始:", fileName, mimeType);

    const sheet = getRagSheet();

    deleteChunksByFileId(sheet, fileId);

    const success = indexSingleFile(sheet, file, fileId, fileName, mimeType);

    if (success) {
      logInfo("[FORCE] 再インデックス成功:", fileName);
      return { success: true, fileName, mimeType };
    } else {
      logError("[FORCE] 再インデックス失敗:", fileName);
      return { success: false, fileName, mimeType, error: "indexSingleFile returned false" };
    }
  } catch (error) {
    logError("[FORCE] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Excelファイルのテキスト抽出をテスト
 */
function testExcelExtraction(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const fileName = file.getName();
    const mimeType = file.getMimeType();

    logInfo("[TEST:EXCEL] テスト開始:", fileName, mimeType);

    const text = extractText(fileId, mimeType, fileName);

    if (!text || text.trim().length === 0) {
      logError("[TEST:EXCEL] テキストが空:", fileName);
      return { success: false, fileName, error: "テキストが空" };
    }

    logInfo("[TEST:EXCEL] 抽出成功:", fileName, "文字数:", text.length);
    logInfo("[TEST:EXCEL] テキストプレビュー:", text.substring(0, 500));

    return { success: true, fileName, charCount: text.length, preview: text.substring(0, 500) };
  } catch (error) {
    logError("[TEST:EXCEL] エラー:", error);
    return { success: false, error: error.message, stack: error.stack };
  }
}

/**
 * インデックスをクリアして再作成
 */
function clearAndReindexAll() {
  try {
    const sheet = getRagSheet();
    const lastRow = sheet.getLastRow();

    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
      logInfo("[CLEAR] インデックスをクリアしました");
    }

    resetAndInitializeRagSheet();
    logInfo("[CLEAR] ヘッダーを追加しました");

    setFileMapping({});
    scriptProps.deleteProperty(LAST_INDEX_KEY);
    logInfo("[CLEAR] ファイルマッピングをクリアしました");

    const result = incrementalIndexGoogleDrive();
    logInfo("[CLEAR] 再インデックス完了:", result);

    return result;
  } catch (error) {
    logError("[CLEAR] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * UrlFetchApp.fetchの動作確認
 */
function testFetch() {
  const url = "https://example.com";
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getResponseCode());
}
