/**
 * 会話履歴管理モジュール（CacheService使用）
 * 
 * @module history
 * @description 会話履歴管理
 * 
 * このファイルには以下が含まれています：
 * - ユーザーごとの会話履歴取得
 * - ユーザーごとの会話履歴保存
 * 
 * @depends config, cache
 * @exports getHistory, saveHistory, clearHistory
 */

/**
 * ユーザーごとの会話履歴を取得
 * @param {string} userId - ユーザーID
 * @returns {Array} 会話履歴の配列
 */
function getHistory(userId) {
  const cache = CacheService.getScriptCache();
  const history = cache.get(userId);
  return history ? JSON.parse(history) : [];
}

/**
 * ユーザーごとの会話履歴を保存
 * @param {string} userId - ユーザーID
 * @param {Array} messages - 会話履歴の配列
 */
function saveHistory(userId, messages) {
  const cache = CacheService.getScriptCache();
  cache.put(userId, JSON.stringify(messages), 3600);
}
