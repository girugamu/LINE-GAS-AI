# LINE-GAS-AI プログラム詳細解説

## 📌 プログラムの概要

このプログラムは、Google Apps Script（GAS）で動作する**LINE Bot + RAG（Retrieval Augmented Generation）システム**です。

**基本動作:**
1. Google Driveのファイルを読み込み、テキストを抽出・チャンク化・Embedding化
2. ユーザーからの質問に対して、関連ドキュメントを自動検索
3. 検索結果をChatGPTのコンテキストとして渡し、回答を生成

---

## 🏗️ 26の関数グループ（コード内順序）

### 1. ファイル先頭 - 設定・定数グループ
- **API設定**: OPENAI_APIKEY, LINE_TOKEN, GPT_MODEL
- **RAG設定**: DRIVE_FOLDER_ID, RAG_SHEET_ID, EMBEDDING_MODEL
- **キャッシュ設定**: QUERY_CACHE_CONFIG（TTL、類似度閾値、最大件数）
- **チャンク設定**: CHUNK_CONFIG（サイズ、オーバーラップ、セマンティック分割）
- **日本語辞書**: SYNONYMS（同義語）、RELATED_WORDS（関連語）、STOP_WORDS（除外語）
- **プロンプト定義**: LLM_PARAM_DEFINITIONS、SEARCH_PARAM_DEFINITIONSなど

### 2. ログ出力関数
- `logTrace()` / `logInfo()` / `logError()` / `logWarn()`
- Google Sheetsへのログ記録機能付き
- `hashUserId()`: セキュリティのためユーザーIDをハッシュ化

### 3. ユーティリティ関数
- `getDocumentUrl()`: MimeTypeに基づくGoogle Drive URL生成
- `cosineSimilarity()`: Embedding間の類似度計算

### 4. キャッシュ管理関数
- `getQueryCache()` / `setQueryCache()`: ユーザー別の結果キャッシュ
- `clearAllQueryCaches()`: 全キャッシュ削除
- CacheServiceを使用（有効期限: 1時間）

### 5. 会話履歴管理
- `getHistory()` / `saveHistory()`: ユーザーごとの会話履歴（CacheService保存）

---

## 🌐 Web Apps エントリーポイント（6. doGet）

### 5つのページを提供:
| ページ | パラメータ | 概要 |
|--------|-----------|------|
| chat | page=chat | Webチャット画面 |
| rag | page=rag | RAGインデックス管理 |
| admin | page=admin | 管理者メニュー |
| settings | page=settings | 各種設定 |
| log | page=log | ログ監視 |

### 認証機能:
- `checkAdminAuth()`: ScriptPropertiesのADMIN_LISTで管理者確認
- `checkChatUserAuth()`: BLOCK_LISTによるアクセス制御

---

## 💬 LINE Bot メイン処理（7. doPost）

### 処理フロー:
```
Webhook受信 → イベント解析 → コマンド判定 → 履歴取得 → RAG処理 → 応答保存 → 返信
```

### 対応コマンド:
```
#ヘルプ          → コマンド一覧表示
#インデックス情報 → 登録ドキュメント数・チャンク数表示
#インデックス更新  → 手動インデックス更新
#初期インデックス  → 初回・全ファイル再インデックス
#自動更新 [時間]  → 自動更新トリガー設定（1-24時間）
#自動更新解除    → 自動更新停止
#拡張機能       → クエリ拡張ON/OFF切替
#キャッシュクリア → 検索キャッシュクリア
#履歴削除       → 会話履歴クリア
#要約/丁寧に/箇条書き/翻訳 → プロンプトテンプレート処理
```

---

## 📄 テキスト抽出関数群（8.）

### 対応MimeType:
| 関数 | 対象ファイル |
|-----|-------------|
| extractText() | メインラッパー |
| extractTextFromGoogleSheets() | Google Sheets |
| extractTextFromWord() | Word（Google Docs変換）|
| extractTextFromExcel() | Excel（Google Sheets変換）|
| extractTextFromPowerPoint() | PowerPoint（Google Slides変換）|
| extractTextFromPDFWithOCR() | PDF（OCR/Vision API）|

**ポイント**: Microsoft OfficeファイルはGoogle Docs/Sheets/Slidesに変換してからテキスト抽出

---

## ✂️ チャンク分割関数群（9.）

### セマンティック分割の流れ:
```
テキスト入力 → 正規化(normalizeTextForChunking)
           → 構造解析(analyzeTextStructure) - 見出し・リスト検出
           → セマンティック分割(semanticSplit)
           → 後処理(postProcessChunks) - 小チャンクマージ・重複削除
```

### 設定可能な分割戦略:
- 見出し優先分割（PRIORITIZE_HEADERS）
- 文境界考慮（SENTENCE_AWARE）
- コンテキスト維持（CONTEXT_PRESERVATION）
- オーバーラップ文字数設定

---

## 🔢 Embedding 関数（10.）

```javascript
getEmbedding(text)           // OpenAI API呼び出し
getEmbeddingWithCache()      // キャッシュ付き（6時間TTL）
clearEmbeddingCache()        // キャッシュクリア
```

---

## 📊 RAG シート管理（11.）

### スプレッドシートの列構成:
| 列 | 項目 | 说明 |
|----|------|------|
| 0 | FileId | Google Drive ファイルID |
| 1 | FileName | ファイル名 |
| 2 | MimeType | MIMEタイプ |
| 3 | TextChunk | チャンクテキスト |
| 4 | Embedding | JSON形式ベクトル |
| 5 | ChunkIndex | チャンク番号 |
| 6 | UpdatedAt | 更新日時 |
| 7 | CharCount | 文字数 |
| 8 | Preview | 先頭100文字 |
| 9 | TotalChunks | 総チャンク数 |
| 10 | Keywords | 抽出キーワード |

---

## 🔍 検索機能（13.）

### 検索パイプライン:
```
expandQuery()        → 類義語・関連語を追加
searchRelevantDocumentsVector()  → Embedding類似度検索
searchByKeywords()   → メタデータキーワード照合
searchByBM25()       → TF-IDFベース精密検索
hybridSearch()       → ベクトル+キーワード統合
enhancedHybridSearch() → 3つ全部統合
rerankResults()      → LLMで再評価
```

### 重み設定（HYBRID_SEARCH_CONFIG）:
- VECTOR_WEIGHT: 0.7
- KEYWORD_WEIGHT: 0.3

---

## 🤖 ChatGPT 統合（17-19.）

### 17. ChatGPT API呼び出し
- ユーザー設定からLLMパラメータ取得（temperature, top_p, top_k, max_tokensなど）
- モデル自動判別（top_k対応/非対応）

### 18. RAG拡張版
```javascript
callChatGPTWithRAGEnhanced(userMessage, history, userId, additionalContext)
```
処理:
1. キャッシュ確認
2. クエリ拡張
3. ハイブリッド検索
4. リランキング
5. コンテキスト選択（最大3000文字）
6. ChatGPT呼び出し
7. 結果キャッシュ保存
8. 参考ドキュメントURL出力

### 19. 自律検索エージェント
```javascript
callChatGPTWithAgent(userMessage, history, userId)
```
- 最大3回の検索反復
- 検索結果自信度評価
- 必要に応じて追加キーワード生成

---

## 🔄 インデックス更新（20.）

### 差分更新:
```
incrementalIndexGoogleDrive()
├── 前回更新以降のファイルを検出
├── 新規: indexSingleFile()
├── 更新: deleteChunks() → indexSingleFile()
└── 削除: インデックスから除去
```

---

## 🎛️ 管理画面API（22-25.）

### RAG管理画面（rag-manager.html）
- `getRagStats()`: 統計情報取得
- `getIndexedFiles()`: 登録ファイル一覧
- `triggerIndexing()`: インデックス実行
- `uploadFileToDrive()`: ファイルアップロード
- `deleteUploadedFile()`: ファイル削除

### Webチャット（chat.html）
- `chatAPI()`: メッセージ送受信
- `handleChatMessage()`: 処理中枢
- AIモード切替: rag / chatgpt / agent

### 設定画面（settings.html）
- `getLlmSettingsData()`: LLMパラメータ
- `getSearchSettingsData()`: 検索パラメータ
- `getSettingsData()`: 基本設定

---

## 💡 技術的ポイント

### 1. ユーザー分離キャッシュ
- userIdをハッシュ化してキャッシュキー一部に使用
- ユーザー別の検索結果を提供可能

### 2. ハイブリッド検索
- ベクトル検索（セマンティック）+ キーワード（正確）+ BM25（精密）の3段構成

### 3. プロンプトテンプレート管理
- ScriptPropertiesで管理者プロンプト一元管理
- ユーザー別UserPropertiesで個人設定

### 4. エラー処理
- 各関数でtry-catchによるエラーキャッチ
- ログ出力（Google Sheets + console）

---

このプログラムは、企業内FAQ、ナレッジベース検索、業務効率化などに活用できる完全なRAGシステムです。