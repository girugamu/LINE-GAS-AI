# LINE-GAS-AI プログラム詳細解説

---

## 📌 プログラムの概要

このプログラムは、Google Apps Script（GAS）で動作する**LINE Bot + RAG（Retrieval Augmented Generation）システム**です。

**基本動作:**
1. Google Driveのファイルを読み込み、テキストを抽出・チャンク化・Embedding化
2. ユーザーからの質問に対して、関連ドキュメントを自動検索
3. 検索結果をChatGPTのコンテキストとして渡し、回答を生成

---

## 🏗️ モジュールの依存関係

### モジュールの読み込み順序（dependencies.js）

| 順序 | モジュール | ファイル | 依存先 | 説明 |
|-----|-----------|---------|--------|------|
| 1 | config | config.js | - | 設定・定数・ログ関数 |
| 2 | cache | cache.js | config | クエリ・Embeddingキャッシュ管理 |
| 3 | chunk | chunk.js | config | テキストのチャンク分割処理 |
| 4 | extract | extract.js | config, chunk | テキスト抽出（各種ファイル形式） |
| 5 | embedding | embedding.js | config, cache | OpenAI Embedding API呼び出し |
| 6 | rag_sheet | rag_sheet.js | config, chunk, embedding | RAGインデックス管理 |
| 7 | search | search.js | config, cache, embedding, rag_sheet | 検索機能 |
| 8 | rerank | rerank.js | config, llm | 検索結果のリランキング |
| 9 | llm | llm.js | config | ChatGPT API呼び出し |
| 10 | history | history.js | config, cache | 会話履歴管理 |
| 11 | chat_message | chat_message.js | config, history, search, llm | LINE/Webメッセージ処理 |
| 12 | preprocess | preprocess.js | config, chunk, embedding, rag_sheet, extract | 段落復元チャンク化 |
| 13 | triggers | triggers.js | config, rag_sheet | 自動インデックス更新 |
| 14 | webapp | webapp.js | config | Web Apps認証 |
| 15 | api_chat | api_chat.js | config, chat_message, history, search, webapp | チャットAPI |
| 16 | api_admin | api_admin.js | config, rag_sheet, triggers, search | 管理画面API |

---

## 🌐 Web Apps エントリーポイント（コード.js）

### 5つのページを提供:

| ページ | パラメータ | 概要 | 認証 |
|-------|-----------|------|-----|
| chat | page=chat | Webチャット画面 | 任意 |
| rag | page=rag | RAGインデックス管理 | 必要 |
| admin | page=admin | 管理者メニュー | 必要 |
| settings | page=settings | 各種設定 | 必要 |
| log | page=log | ログ監視 | 必要 |

### 認証機能:
- `checkAdminAuth()`: ScriptPropertiesのADMIN_LISTで管理者確認
- `checkChatUserAuth()`: BLOCK_LISTによるアクセス制御
- `isDevModeEnabled()`: DEV_MODEで開発者モード

---

## 💬 LINE Bot メイン処理（コード.js - doPost）

### 処理フロー:
```
Webhook受信 → イベント解析 → コマンド判定 → 履歴取得 → RAG処理 → 応答保存 → 返信
```

### 対応コマンド:

| コマンド | 説明 |
|---------|------|
| `#ヘルプ` | コマンド一覧表示 |
| `#インデックス情報` | 登録ドキュメント数・チャンク数表示 |
| `#インデックス更新` | 手動インデックス更新 |
| `#初期インデックス` | 初回・全ファイル再インデックス |
| `#自動更新 [時間]` | 自動更新トリガー設定（1-24時間） |
| `#自動更新解除` | 自動更新停止 |
| `#拡張機能` | クエリ拡張ON/OFF切替 |
| `#キャッシュクリア` | 検索キャッシュクリア |
| `#履歴削除` | 会話履歴クリア |
| `#要約 [テキスト]` | テキストを要約 |
| `#丁寧に [テキスト]` | 丁寧な言い方に変換 |
| `#箇条書き [テキスト]` | 箇条書きに変換 |
| `#翻訳 [テキスト]` | 英語に翻訳 |

---

## 🔧 設定・定数（config.js）

### API設定定数

| 定数 | 値 | 説明 |
|-----|-----|------|
| OPENAI_API_KEY | ScriptProperties | ChatGPT APIキー |
| LINE_TOKEN | ScriptProperties | LINE Messaging APIトークン |
| GPT_MODEL | "gpt-4o-mini" | デフォルトLLMモデル |
| EMBEDDING_MODEL | "text-embedding-3-small" | Embeddingモデル |
| LINE_URL | 'https://api.line.me/v2/bot/message/reply' | LINE返信API |
| LINE_LOADING_URL | 'https://api.line.me/v2/bot/chat/loading/start' | LINE Loading API |

### RAG設定定数

| 定数 | 値 | 説明 |
|-----|-----|------|
| DRIVE_FOLDER_ID | ScriptProperties | Google DriveフォルダID |
| INDEX_SHEET_ID | ScriptProperties | RAGシートID |
| LAST_INDEX_KEY | "LAST_INDEX_TIMESTAMP" | 最終インデックス時刻キー |
| FILE_MAPPING_KEY | "FILE_MAPPING" | ファイルマッピングキー |

### シートヘッダー

```
FileId, FileName, MimeType, TextChunk, Embedding, ChunkIndex, UpdatedAt, CharCount, Preview, TotalChunks, Keywords
```

---

## 📄 テキスト抽出（extract.js）

### 対応MimeType:

| 関数 | 対象ファイル | 変換先 |
|-----|-------------|--------|
| extractTextFromGoogleSheets() | Google Sheets | 直接読み込み |
| extractTextFromWord() | Word (.docx) | Google Docs変換 |
| extractTextFromExcel() | Excel (.xlsx) | Google Sheets変換 |
| extractTextFromPowerPoint() | PowerPoint (.pptx) | Google Slides変換 |
| extractTextFromPDFWithOCR() | PDF | Google Docs/Vision API変換 |
| extractViaTempGoogleDoc_() | その他 | 一時ファイル変換 |

### 表構造抽出:

| 関数 | 説明 |
|-----|------|
| extractTableWithStructure() | PDF/画像から表を抽出 |
| detectTableFromVisionDocument() | Vision Documentから表を検出 |
| processTableForRag() | 表データをRAG用に処理 |

---

## ✂️ チャンク分割（chunk.js）

### セマンティック分割の流れ:

```
テキスト入力 → 正規化(normalizeTextForChunking)
           → 構造解析(analyzeTextStructure) - 見出し・リスト検出
           → セマンティック分割(semanticSplit)
           → 後処理(postProcessChunks) - 小チャンクマージ・重複削除
```

### CHUNK_CONFIG設定:

| 設定 | デフォルト | 説明 |
|-----|----------|------|
| CHUNK_SIZE | 1000 | 基本チャンクサイズ |
| CHUNK_OVERLAP | 100 | オーバーラップ文字数 |
| MIN_CHUNK_SIZE | 200 | 最小チャンクサイズ |
| MAX_CHUNK_SIZE | 1500 | 最大チャンクサイズ |
| USE_SEMANTIC_SPLIT | true | セマンティック分割有効 |
| PRIORITIZE_HEADERS | true | 見出し優先分割 |
| SENTENCE_AWARE | true | 文境界考慮 |
| BOOST_HEADERS | true | 見出しブースト |
| MERGE_SMALL_CHUNKS | true | 小チャンクマージ |
| DEDUPLICATE_CHUNKS | true | 重複削除 |

---

## 🔍 検索機能（search.js）

### 検索パイプライン:

```
expandQuery()        → 類義語・関連語を追加
extractKeywords()    → キーワード抽出
searchRelevantDocumentsVector()  → Embedding類似度検索
searchByKeywords()   → メタデータキーワード照合
searchByBM25()       → TF-IDFベース精密検索
hybridSearch()        → ベクトル+キーワード統合
enhancedHybridSearch() → 3つ全部統合
rerankResults()      → LLMで再評価
```

### SEARCH_PARAM_DEFINITIONS設定:

| パラメータ | デフォルト | 説明 |
|-----------|----------|------|
| SEARCH_KEYWORD_ENABLED | true | キーワード検索有効 |
| SEARCH_BM25_ENABLED | true | BM25検索有効 |
| SEARCH_RERANK_ENABLED | true | リランキング有効 |
| SEARCH_QUERY_EXPANSION_ENABLED | true | クエリ拡張有効 |
| SEARCH_DICT_EXPANSION_ENABLED | true | 辞書ベース拡張 |
| SEARCH_LLM_EXPANSION_ENABLED | true | LLM拡張 |
| SEARCH_HYBRID_ENABLED | true | ハイブリッド検索有効 |
| HYBRID_VECTOR_WEIGHT | 0.7 | ベクトル検索重み |
| HYBRID_KEYWORD_WEIGHT | 0.3 | キーワード検索重み |
| BM25_K1 | 1.5 | BM25 K1パラメータ |
| BM25_B | 0.75 | BM25 Bパラメータ |

### 重み設定:

```
enhancedHybridSearch: VECTOR=0.4, KEYWORD=0.3, BM25=0.3
hybridSearch: VECTOR=0.7, KEYWORD=0.3
```

---

## 🤖 ChatGPT統合（llm.js）

### ChatGPT API呼び出し:

```javascript
function callChatGPT(messages, overrideTemperature)
```

**対応パラメータ:**

| パラメータ | paramName | デフォルト |
|-----------|-----------|----------|
| model | model | gpt-4o-mini |
| temperature | temperature | 0.7 |
| top_p | top_p | 1.0 |
| top_k | top_k | 40 |
| max_tokens | max_tokens | 2048 |
| presence_penalty | presence_penalty | 0 |
| frequency_penalty | frequency_penalty | 0 |
| response_format | response_format | text |

**対応モデル:**
- gpt-4o-mini
- gpt-4o
- gpt-5.4-nano
- gpt-5.4-mini
- gpt-5.4

### プロンプトテンプレート（PROMPT_TEMPLATE_DEFINITIONS）:

| キー | 用途 | 変数 |
|-----|------|-----|
| PROMPT_QUERY_EXPANSION | クエリ拡張 | {{query}} |
| PROMPT_SEARCH | 検索最適化 | {{query}} |
| PROMPT_SUMMARY | 要約 | {{query}}, {{chunks}} |
| PROMPT_RERANK | リランキング | {{query}}, {{documents}} |
| PROMPT_AGENT_EVALUATE | エージェント評価 | {{query}}, {{context}}, {{results}} |
| PROMPT_AGENT_KEYWORD | エージェントキーワード | {{query}}, {{existingKeywords}} |

---

## 💬 RAG拡張版ChatGPT（chat_message.js）

### callChatGPTWithRAGEnhanced処理フロー:

```javascript
function callChatGPTWithRAGEnhanced(userMessage, history, userId, additionalContext)
```

1. **キャッシュ確認** - userIdベースのクエリキャッシュ
2. **クエリ拡張** - 辞書ベース + LLM拡張
3. **ハイブリッド検索** - enhancedHybridSearch
4. **リランキング** - rerankResults
5. **コンテキスト選択** - 最大3000文字
6. **ChatGPT呼び出し** - generateFullPrompt + buildChatMessages
7. **結果キャッシュ保存**
8. **参考ドキュメントURL出力**

---

## 🔄 自律検索エージェント（chat_message.js）

### callChatGPTWithAgentIterative:

```javascript
function callChatGPTWithAgentIterative(userMessage, history, userId, options)
```

**処理フロー:**

```
反復開始
  ↓
検索実行（enhancedHybridSearch）
  ↓
検索結果評価（evaluateSearchResults）
  ↓
┌─ 情報が十分（confidence >= MIN_CONFIDENCE）
│    ↓
│  最終回答生成（generateAgentFinalResponse）
│    ↓
│  終了
└─ 情報が不足
     ↓
  追加キーワード生成（generateAdditionalSearchTerms）
     ↓
  検索クエリ拡張
     ↓
  状態保存・中断 または 次の反復
```

**AGENT_MODE_CONFIG設定:**

| 設定 | デフォルト | 説明 |
|-----|----------|------|
| MAX_ITERATIONS | 3 | 最大反復回数 |
| MIN_CONFIDENCE | 0.7 | 最小信頼度 |
| SHOW_THINKING | true | 思考過程表示 |
| ADDITIONAL_SEARCH_ENABLED | true | 追加検索有効 |

---

## 🔄 インデックス更新（rag_sheet.js）

### incrementalIndexGoogleDrive:

```javascript
function incrementalIndexGoogleDrive()
```

**処理フロー:**

```
最終インデックス時刻取得
  ↓
全ファイル取得（サブフォルダ含む）
  ↓
ループ:
  ├─ 新規ファイル → indexSingleFile()
  ├─ 更新ファイル → deleteChunks() → indexSingleFile()
  └─ 未変更 → スキップ
  ↓
削除されたファイル → インデックスから除去
  ↓
マッピング・時刻保存
```

### indexSingleFile:

```javascript
function indexSingleFile(sheet, file, fileId, fileName, mimeType)
```

- extractText() でテキスト抽出
- splitTextIntoChunks() でチャンク化
- getEmbeddingWithCache() でEmbedding生成
- extractKeywords() でキーワード抽出
- sheet.appendRow() で登録
- PDFは表データも追加抽出

---

## 🎛️ 管理画面API（api_admin.js）

### RAG管理画面（rag-manager.html）

| 関数 | 説明 |
|-----|------|
| getRagStats() | 統計情報取得 |
| getIndexedFiles() | 登録ファイル一覧 |
| getIndexedChunks(fileId) | ファイル別チャンク一覧 |
| triggerIndexing() | インデックス実行 |
| uploadFileToDrive() | ファイルアップロード |
| deleteUploadedFile() | ファイル削除 |
| getFolderFiles() | Driveフォルダ取得 |

### 設定画面（settings.html）

| 関数 | 説明 |
|-----|------|
| getSettingsData() | 基本設定取得 |
| updateSetting() | 基本設定更新 |
| getLlmSettingsData() | LLMパラメータ取得 |
| updateLlmParam() | LLMパラメータ更新 |
| getSearchSettingsData() | 検索パラメータ取得 |
| updateSearchParam() | 検索パラメータ更新 |
| getPromptTemplateSettings() | プロンプトテンプレート取得 |
| updatePromptTemplate() | プロンプトテンプレート更新 |
| exportAllProperties() | 全プロパティエクスポート |
| importAllProperties() | プロパティインポート |

---

## 💡 技術的ポイント

### 1. ユーザー分離キャッシュ
- userIdをSHA-256でハッシュ化
- 類似クエリもEmbeddingで検出（SIMILARITY_THRESHOLD: 0.80）

### 2. ハイブリッド検索
- ベクトル検索（セマンティック）+ キーワード（正確）+ BM25（精密）の3段構成

### 3. プロンプトテンプレート管理
- ScriptPropertiesで一元管理（管理者向け）
- UserPropertiesで個人設定（ユーザー向け）

### 4. 段落復元チャンク化
- OCR/PDF結果から見出しと本文を結合
- 「見出しだけ」「単語だけ」のチャンクを防止

### 5. 表構造抽出
- Vision APIでPDF/画像から表データを抽出
- 抽出した表をRAGインデックスに追加

### 6. エラー処理
- 各関数でtry-catchによるエラーキャッチ
- ログ出力（Google Sheets + console.log）

---

## 📁 ファイル構成

```
LINE-GAS-AI_v3/
├── コード.js              # エントリーポイント
├── config.js             # 設定・定数
├── chat_message.js       # LINE/Webメッセージ処理
├── api_chat.js           # WebチャットAPI
├── api_admin.js          # 管理画面API
├── llm.js                # ChatGPT API
├── search.js             # 検索機能
├── rerank.js             # リランキング
├── embedding.js          # Embedding生成
├── rag_sheet.js          # RAGシート管理
├── chunk.js              # チャンク分割
├── preprocess.js          # 段落復元
├── extract.js            # テキスト抽出
├── cache.js              # キャッシュ管理
├── history.js            # 履歴管理
├── triggers.js           # トリガー管理
├── webapp.js            # Web認証
├── dependencies.js       # モジュール定義
├── chat.html             # チャット画面
├── admin.html            # 管理画面
├── settings.html         # 設定画面
├── rag-manager.html      # RAG管理画面
├── log-monitor.html      # ログ監視
├── auth-error.html       # 認証エラー
├── css.html              # 共通スタイル
└── appsscript.json       # GAS設定
```

---

このプログラムは、企業内FAQ、ナレッジベース検索、業務効率化などに活用できる完全なRAGシステムです。
