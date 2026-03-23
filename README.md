# LINE-GAS-AI

LINEとGoogle Apps ScriptとOpenAI ChatGPTを組み合わせたAIチャットボットです。RAG（検索拡張生成）機能を搭載し、ドキュメント検索・要約・分析などが可能です。

## 特徴

### 🎯 メイン機能
- **LINE Messaging API連携** - LINEでAIチャットが可能
- **ChatGPT連携** - OpenAIのGPT-4o-miniモデルを使用
- **RAG検索拡張** - 関連するドキュメントを自動検索して回答
- **Webチャット画面** - ブラウザからも利用可能
- **AIモード切替** - RAGモード、ChatGPTモード、エージェントモード

### 🔍 高度な検索機能
- **ベクトル検索** - OpenAI Embeddingによる意味的類似度検索
- **キーワード検索** - 保存されたキーワードとの照合
- **BM25検索** - TF-IDFベースの精密キーワード検索
- **ハイブリッド検索** - 3つの検索手法を組み合わせて検索
- **リランキング** - LLMで検索結果Top-Nを再評価
- **クエリ拡張** - 類義語・関連語を追加して検索精度を向上（辞書 + LLM）

### 📚 RAG機能
- **自動インデックス更新** - Google Driveのファイル自動監視・更新（サブフォルダ対応）
- **段落復元チャンク化** - OCR/PDFから見出しと本文を結合してチャンク化
- **セマンティックチャンク分割** - 意味的な境界でテキストを分割
- **マルチフォーマット対応** - Google Docs/Sheets、PDF、Word、Excel、PowerPoint、テキストファイルなど
- **表構造抽出** - PDF/画像から表データを抽出しRAGインデックスに追加
- **結果キャッシュ** - 類似クエリの結果を再利用でAPIコスト削減
- **エージェントモード** - 自律的に検索反復して情報を収集

### ⚙️ 管理機能
- **Web管理画面** - ブラウザからインデックス・設定を管理
- **ログモニター** - Botの動作ログをリアルタイム監視
- **管理者認証** - Googleアカウントでアクセス制御
- **プロパティインポート/エクスポート** - 設定のバックアップ・復元

## 必要環境

- Google アカウント（Gmail）
- LINE Messaging API アカウント
- OpenAI API キー
- Google Apps Script

## セットアップ

### 1. Google Sheets の準備

#### RAG用スプレッドシート
1. Google Sheets を新規作成
2. 最初のシートの名前を任意に変更（例: `RAG_index`）
3. 以下の列見出しを1行目に入力:
   ```
   FileId, FileName, MimeType, TextChunk, Embedding, ChunkIndex, UpdatedAt, CharCount, Preview, TotalChunks, Keywords
   ```
4. URLから spreadsheet ID をコピー（例: `https://docs.google.com/spreadsheets/d/ABC.../edit` の `ABC...` 部分）

#### ログ用スプレッドシート（オプション）
1. 別のGoogle Sheets を作成（ログ記録用）
2. 以下の列見出しを入力:
   ```
   Timestamp, Level, Message
   ```

### 2. Google Apps Script のセットアップ

1. [Google Apps Script](https://script.google.com/) にアクセス
2. 「新規プロジェクト」をクリック
3. srcフォルダの内容をデプロイ（CLASP使用推奨）
4. プロジェクト設定で「appsscript.json」の構成を確認

### 3. Script Properties の設定

「プロジェクト設定」→「スクリプトプロパティ」で以下を設定:

| プロパティ | 説明 | 例 |
|-----------|------|-----|
| `OPENAI_API_KEY` | OpenAI APIキー | `sk-xxxxxxxxxxxxxxxx` |
| `LINE_TOKEN` | LINE Messaging APIアクセストークン | `xxxxxxxxxxxxxxxx...` |
| `LOG_SHEET_ID` | ログ用スプレッドシートID | `1ABCdefGHI...` |
| `DRIVE_FOLDER_ID` | RAG用Google DriveフォルダID | `1ABCdefGHI...` |
| `INDEX_SHEET_ID` | RAG用スプレッドシートID | `1ABCdefGHI...` |
| `VISION_API_KEY` | Google Cloud Vision APIキー（OCR用・オプション） | `AIzaSy...` |
| `DEBUG_MODE` | デバッグモード（Traceログ出力） | `true` または `false` |
| `DEV_MODE` | 開発者モード（認証免除） | `true` または `false` |
| `ADMIN_LIST` | 管理者メールアドレス（カンマ区切り） | `admin@example.com, manager@example.com` |
| `ALLOW_LIST` | アクセス許可リスト（カンマ区切り） | `user@example.com` |
| `BLOCK_LIST` | アクセス禁止リスト（カンマ区切り） | `blocked@example.com` |

### 4. LINE Developers のセットアップ

1. [LINE Developers](https://developers.line.me/) にログイン
2. プロバイダーを作成
3. Messaging APIチャンネルを作成
4. 「アクセストークン」を発行してコピー
5. Webhook URLを設定:
   ```
   https://script.google.com/macros/s/{スクリプトID}/exec
   ```
6. 応答メッセージを「オフ」に設定

### 5. 初期インデックスの実行

Apps Scriptエディタで以下を実行:

```javascript
initIncrementalIndex()
```

またはLINEで `#初期インデックス` コマンドを送信

### 6. Web Apps のデプロイ

1. Apps Scriptエディタで「デプロイ」→「新しいデプロイ」
2. 「種類を選択」→「ウェブアプリ」
3. 設定:
   - 説明: 任意
   - 実行者: 「自分」
   - アクセス: 「全員」（または必要な権限に応じて）
4. 「デプロイ」をクリック
5. Web App URLをコピー

## LINE コマンド

| コマンド | 説明 |
|---------|------|
| `#ヘルプ` | コマンド一覧を表示 |
| `#インデックス情報` | 登録ドキュメント数・チャンク数を表示 |
| `#インデックス更新` | 手動でインデックスを更新 |
| `#初期インデックス` | 初回または全ファイル再インデックスを実行 |
| `#自動更新 [時間]` | 自動更新を設定（例: `#自動更新 2` で2時間ごと） |
| `#自動更新解除` | 自動更新を停止 |
| `#拡張機能` | クエリ拡張のON/OFFを切り替え |
| `#キャッシュクリア` | 検索キャッシュをクリア |
| `#履歴削除` | 会話履歴をクリア |
| `#要約 [テキスト]` | テキストを要約 |
| `#丁寧に [テキスト]` | 丁寧な言い方に変換 |
| `#箇条書き [テキスト]` | 箇条書きに変換 |
| `#翻訳 [テキスト]` | 英語に翻訳 |

通常のメッセージは自動的にRAG検索されます。

## Web 画面

### チャット画面
デプロイしたWeb App URLにアクセス

- AIとチャット可能
- AIモード切替（RAG / ChatGPT / エージェント）
- ファイルアップロード対応（一時的に処理して回答）
- セッション履歴を保存・取得・エクスポート（JSON/TXT）
- エージェントモードでの反復検索表示

### 管理画面
URLに `?page=admin` を付けてアクセス

- RAGマネージャー - インデックス管理・統計情報
- ログモニター - リアルタイムログ監視
- 設定 - パラメータ設定・プロンプト編集

## 設定項目

### LLM生成パラメータ

| パラメータ | デフォルト | 説明 |
|-----------|----------|------|
| `LLM_MODEL` | gpt-4o-mini | 使用するGPTモデル |
| `LLM_TEMPERATURE` | 0.7 | 生成のランダム性（0-2） |
| `LLM_TOP_P` | 1.0 | トークン選択範囲（0-1） |
| `LLM_TOP_K` | 40 | 上位K個のトークンから選択 |
| `LLM_MAX_COMPLETION_TOKENS` | 2048 | 最大出力トークン数 |
| `LLM_PRESENCE_PENALTY` | 0 | 同じ話題の出現抑制（-2〜2） |
| `LLM_FREQUENCY_PENALTY` | 0 | 同じ単語の繰り返し抑制（-2〜2） |
| `LLM_RESPONSE_FORMAT` | text | 出力形式（text/json） |

### 検索パラメータ

| パラメータ | デフォルト | 説明 |
|-----------|----------|------|
| `SEARCH_KEYWORD_ENABLED` | true | キーワード検索のON/OFF |
| `SEARCH_BM25_ENABLED` | true | BM25検索のON/OFF |
| `SEARCH_RERANK_ENABLED` | true | リランキングのON/OFF |
| `SEARCH_QUERY_EXPANSION_ENABLED` | true | クエリ拡張のON/OFF |
| `SEARCH_DICT_EXPANSION_ENABLED` | true | 辞書ベース拡張のON/OFF |
| `SEARCH_LLM_EXPANSION_ENABLED` | true | LLM拡張のON/OFF |
| `SEARCH_HYBRID_ENABLED` | true | ハイブリッド検索のON/OFF |
| `BM25_K1` | 1.5 | BM25 K1パラメータ |
| `BM25_B` | 0.75 | BM25 Bパラメータ |
| `RERANK_INITIAL_TOP_K` | 17 | リランキング初期取得数 |
| `RERANK_FINAL_TOP_K` | 8 | リランキング最終出力数 |
| `RERANK_MODEL` | gpt-4o-mini | リランキング用モデル |
| `HYBRID_VECTOR_WEIGHT` | 0.7 | ベクトル検索の重み |
| `HYBRID_KEYWORD_WEIGHT` | 0.3 | キーワード検索の重み |
| `QUERY_EXPANSION_MAX_WORDS` | 5 | 追加拡張語数の上限 |

## ファイル構成

```
LINE-GAS-AI/
├── コード.js              # doGet/doPostエントリーポイント
├── config.js             # 設定・定数・ログ関数
├── chat_message.js       # LINE/Webメッセージ処理・エージェント
├── api_chat.js           # WebチャットAPI
├── api_admin.js          # 管理画面API
├── llm.js                # ChatGPT API呼び出し
├── search.js             # ベクトル検索・BM25・キーワード検索
├── rerank.js             # 検索結果のリランキング
├── embedding.js          # OpenAI Embedding API
├── rag_sheet.js          # RAGインデックス管理
├── chunk.js              # セマンティックチャンク分割
├── preprocess.js          # 段落復元チャンク化
├── extract.js            # テキスト抽出（各種ファイル形式）
├── cache.js              # クエリ・Embeddingキャッシュ
├── history.js            # 会話履歴管理
├── triggers.js           # 自動インデックス更新トリガー
├── webapp.js             # Web Apps認証
├── dependencies.js       # モジュール定義
├── appsscript.json       # GASプロジェクト設定
├── chat.html             # チャット画面
├── admin.html            # 管理画面
├── settings.html         # 設定画面
├── rag-manager.html      # RAG管理画面
├── log-monitor.html      # ログモニター画面
├── auth-error.html       # 認証エラー画面
├── css.html              # 共通スタイル
└── .clasp.json           # CLASP設定
```

## プロンプトテンプレート

ScriptPropertiesで管理されるプロンプトテンプレート:

| テンプレート | 用途 | 変数 |
|-------------|------|------|
| `PROMPT_QUERY_EXPANSION` | クエリ拡張用 | {{query}} |
| `PROMPT_SEARCH` | 検索最適化 | {{query}} |
| `PROMPT_SUMMARY` | 要約用 | {{query}}, {{chunks}} |
| `PROMPT_RERANK` | リランキング用 | {{query}}, {{documents}} |
| `PROMPT_AGENT_EVALUATE` | エージェント評価 | {{query}}, {{context}}, {{results}} |
| `PROMPT_AGENT_KEYWORD` | エージェントキーワード生成 | {{query}}, {{existingKeywords}} |

## トラブルシューティング

### インデックスが空です
- `#初期インデックス` コマンドを実行
- DRIVE_FOLDER_ID が正しいか確認
- INDEX_SHEET_ID が正しいか確認

### 検索結果が返ってこない
- INDEX_SHEET_ID が正しく設定されているか確認
- ドキュメントがテキスト抽出可能な形式か確認
- シートにDataRangeがあることを確認

### LINEからの応答がない
- Webhook設定が正しいか確認
- LINE_TOKEN が有効か確認
- LINE DevelopersでWebhook検証を実行

### APIエラー
- OpenAI APIキーが正しいか確認
- API利用料が上限に達していないか確認
- DEBUG_MODEをtrueにしてログを確認

### アクセス拒否エラー
- ADMIN_LIST にメールアドレスが追加されているか確認
- DEV_MODE をtrueにして開発者モードを有効化

## ライセンス

MIT License

## 貢献

バグ報告や機能提案はIssueまでお願いします。
