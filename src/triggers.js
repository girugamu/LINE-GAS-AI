/**
 * 自動インデックス更新トリガーモジュール
 * 
 * @module triggers
 * @description 自動インデックス更新トリガー
 * 
 * このファイルには以下が含まれています：
 * - setupAutoIndexTrigger: 自動インデックストリガー設定
 * - removeAutoIndexTrigger: 自動インデックストリガー解除
 * - initIncrementalIndex: 初期インデックス実行
 * - triggerManualIndexUpdate: 手動インデックス更新
 * 
 * @depends config, rag_sheet
 * @exports setupAutoIndexTrigger, removeAutoIndexTrigger, initIncrementalIndex, triggerManualIndexUpdate
 */

/**
 * 自動インデックス更新トリガーを設定
 */
function setupAutoIndexTrigger(hours = 1) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'incrementalIndexGoogleDrive') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('incrementalIndexGoogleDrive')
    .timeBased()
    .everyHours(hours)
    .create();

  console.log(`【トリガー】${hours}時間ごとに増量更新を実行するように設定しました`);
}

/**
 * 自動インデックス更新トリガーを削除
 */
function removeAutoIndexTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'incrementalIndexGoogleDrive') {
      ScriptApp.deleteTrigger(trigger);
      console.log("【トリガー】自動更新トリガーを削除しました");
    }
  });
}

/**
 * 初期インデックスを実行
 */
function initIncrementalIndex() {
  console.log("【初期化】初回インデックス実行開始");
  const result = incrementalIndexGoogleDrive();
  console.log("【初期化】完了:", result);
  return result;
}

/**
 * 手動インデックス更新を実行
 */
function triggerManualIndexUpdate() {
  try {
    const result = incrementalIndexGoogleDrive();
    return {
      success: true,
      message: `✓ インデックス更新完了\n\n📄 新規追加: ${result.added}\n📝 更新: ${result.updated}\n⏩ 未変更: ${result.unchanged}\n📊 合計: ${result.totalFiles}`,
      details: result
    };
  } catch (error) {
    console.error("【手動更新】エラー:", error);
    return {
      success: false,
      message: "✗ インデックス更新に失敗しました",
      error: error.message
    };
  }
}
