# LINE-GAS-AI プログラム解説

---

## 📌 プログラムの概要

このプログラムは、Google Apps Script（GAS）で動作する**LINE Bot + RAG（検索拡張生成）システム**です。Googleドキュメント、スプレッドシート、PDF、Word、Excel、PowerPointなどの多様なファイルからテキストを抽出し、Embedding化して保存。ユーザーからの質問に対して関連するドキュメントを自動検索し、ChatGPTと組み合わせた高精度な回答を提供します。

---

## 🏗️ システム構成

```
LINE Bot / Web Chat → 処理中枢（GAS）→ RAGインデックス（Google Sheets）
                              ↓
                    外部API（ChatGPT, Vision API）
```

**提供インターフェース：**
- **LINE Bot**: LINE Messaging API連携
- **Web Chat画面**: ブラウザから使えるチャット画面
- **管理画面**: RAG管理・ログ確認・各種設定

---

## ⚙️ 主要機能

### 1️⃣ RAG（検索拡張生成）機能
- **ファイル対応**: Google Docs/Sheets、PDF、Word、Excel、PowerPoint、テキストファイル
- **テキスト抽出**: 各ファイル形式から本文を抽出（OCR対応）
- **チャンク分割**: 意味的な境界を考慮したセマンティック分割
- **Embedding生成**: OpenAI APIでベクトル化
- **段落復元**: OCR/PDF抽出結果から段落構造を復元（preprocess.js）

### 2️⃣ 高度な検索機能
- **ベクトル検索**: Embeddingベースの類似度検索
- **キーワード検索**: 保存されたメタデータキーワードと照合
- **BM25検索**: TF-IDFベースの精密キーワード検索
- **ハイブリッド検索**: 上記3つの結果を重み付けして統合
- **リランキング**: LLMで検索結果Top-Nを再評価
- **クエリ拡張**: 類義語・関連語を追加して検索精度向上（辞書ベース + LLM）

### 3️⃣ 拡張機能
- **結果キャッシュ**: 類似クエリの結果を再利用（APIコスト削減）
- **自律検索エージェント**: 複数回の検索反復で情報不足を検知し追加検索
- **ファイルアップロード対応**: チャットに添付されたファイルをその場で処理
- **段落復元チャンク化**: 見出しと本文を結合し、意味のまとまりでチャンク化
- **表構造抽出**: PDF/画像から表データを抽出し、RAGインデックスに追加

### 4️⃣ LINE Bot機能
- 通常のテキスト会話
- 各種コマンド（#ヘルプ、#インデックス情報、#更新など）
- プロンプトテンプレート（要約、翻訳、箇条書き変換）

### 5️⃣ Web Chat機能
- **AIモード切替**: RAGモード / ChatGPTモード / エージェントモード
- **ファイルアップロード**: アップロードされたファイルを一時的に処理して回答
- **セッション履歴**: 会話履歴の保存・取得・エクスポート（JSON/TXT）
- **エージェントモード**: 反復検索で情報を自動的に収集

---

## 📊 データフロー

```
① ファイル登録（Google Drive）
      ↓
② インデックス更新（差分更新）
      ↓
③ ユーザー質問 → クエリ拡張（辞書 + LLM）
      ↓
④ ハイブリッド検索（ベクトル+BM25+キーワード）
      ↓
⑤ リランキング（LLMで再評価）
      ↓
⑥ 関連チャンクをコンテキストとしてChatGPTに送信
      ↓
⑦ 回答生成 + 参考ドキュメントURL出力
```

---

## 💾 データ保存先

- **RAGインデックス**: Google Sheets（チャンクごとに保存）
- **設定・プロンプト**: ScriptProperties（グローバル）
- **ユーザー設定**: UserProperties（ユーザー別）
- **キャッシュ**: CacheService（有効期限付き）
- **会話履歴**: CacheService（ユーザー別）

---

## 🔧 必要な外部設定

| 設定項目 | 説明 |
|---------|------|
| OPENAI_API_KEY | ChatGPT・Embedding用APIキー |
| LINE_TOKEN | LINE Messaging APIアクセストークン |
| DRIVE_FOLDER_ID | RAG用Google DriveフォルダID |
| INDEX_SHEET_ID | RAGインデックス保存用スプレッドシートID |
| LOG_SHEET_ID | ログ保存用スプレッドシートID（任意）|
| VISION_API_KEY | Google Cloud Vision APIキー（OCR用・任意）|

---

## 📁 モジュールの依存関係

| モジュール | ファイル | 説明 | 依存先 |
|-----------|---------|------|--------|
| config | config.js | 設定・定数・ログ関数 | - |
| cache | cache.js | クエリ・Embeddingキャッシュ管理 | config |
| chunk | chunk.js | テキストのチャンク分割処理 | config |
| extract | extract.js | 各種ファイル形式からのテキスト抽出 | config, chunk |
| embedding | embedding.js | OpenAI Embedding API呼び出し | config, cache |
| rag_sheet | rag_sheet.js | RAGインデックス用スプレッドシート操作 | config, chunk, embedding |
| search | search.js | ベクトル検索・キーワード検索・BM25 | config, cache, embedding, rag_sheet |
| rerank | rerank.js | 検索結果のリランキング | config, llm |
| llm | llm.js | ChatGPT API呼び出し | config |
| history | history.js | 会話履歴管理 | config, cache |
| chat_message | chat_message.js | LINEメッセージ送信・自律検索エージェント | config, history, search, llm |
| preprocess | preprocess.js | 段落復元チャンク化 | config, chunk, embedding, rag_sheet, extract |
| triggers | triggers.js | 自動インデックス更新トリガー | config, rag_sheet |
| webapp | webapp.js | Web Apps認証・HTML出力 | config |
| api_chat | api_chat.js | チャットAPIエンドポイント | config, chat_message, history, search, webapp |
| api_admin | api_admin.js | 管理画面APIエンドポイント | config, rag_sheet, triggers, search |

---

## 📁 関連ファイル

| ファイル | 役割 |
|---------|------|
| コード.js | エントリーポイント（doGet/doPost） |
| config.js | 設定・定数・ログ関数 |
| chat_message.js | LINE/Webメッセージ処理・エージェント |
| api_chat.js | WebチャットAPI |
| api_admin.js | 管理画面API |
| llm.js | ChatGPT API呼び出し |
| search.js | 検索機能 |
| rerank.js | リランキング |
| embedding.js | Embedding生成 |
| rag_sheet.js | RAGシート管理 |
| chunk.js | チャンク分割 |
| preprocess.js | 段落復元チャンク化 |
| extract.js | テキスト抽出 |
| cache.js | キャッシュ管理 |
| history.js | 履歴管理 |
| triggers.js | トリガー管理 |
| webapp.js | Web認証 |
| dependencies.js | モジュール定義 |
| chat.html | Webチャット画面 |
| admin.html | 管理者メニュー画面 |
| settings.html | 設定画面 |
| rag-manager.html | RAGインデックス管理画面 |
| log-monitor.html | ログ監視画面 |
| auth-error.html | 認証エラー画面 |
| css.html | 共通スタイル |

---

このプログラムは、企業や組織のFAQ-bot、ナレッジベース検索、業務効率化ツールとして活用できる高度なシステムです。
