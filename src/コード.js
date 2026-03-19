/**
 * AI Chat with RAG - Google Apps Script
 * 拡張機能: BM25検索, リランキング, クエリ拡張, 結果キャッシュ
 * 
 * 関数配置ガイド:
 * 1. ファイル先頭 - 設定・定数グループ
 * 2. ログ出力関数
 * 3. ユーティリティ関数
 * 4. キャッシュ管理関数
 * 5. 会話履歴管理
 * 6. Web Apps エントリーポイント
 * 7. AI Chat メイン処理
 * 8. テキスト抽出関数群
 * 9. チャンク分割関数群
 * 10. Embedding 関数
 * 11. RAG シート管理
 * 12. インデックス管理
 * 13. 検索機能（クエリ拡張→BM25→キーワード→ハイブリッド）
 * 14. リランキング機能
 * 15. 拡張ハイブリッド検索
 * 16. チャンク取得・類似度計算
 * 17. ChatGPT API 呼び出し
 * 18. RAG 拡張機能付き ChatGPT
 * 19. 自律検索エージェントモード関数
 * 20. インデックス更新機能
 * 21. トリガー管理
 * 22. RAG管理画面用API
 * 23. Webチャット画面用API
 * 24. ログ取得画面API
 * 25. 設定画面用API
 * 26. テスト用関数
 */

/**
 * このコードは、LINE Messaging APIとOpenAIのChatGPTを組み合わせたAIチャットボットのGoogle Apps Script実装です。
 */

// ================================
//  1. ファイル先頭 - 設定・定数グループ
// ================================

/** スクリプトプロパティ */
const scriptProps = PropertiesService.getScriptProperties();
/** ユーザープロパティ（LLMパラメータ保存用） */
const userProps = PropertiesService.getUserProperties();

const OPENAI_API_KEY = scriptProps.getProperty("OPENAI_API_KEY");
const LINE_TOKEN = scriptProps.getProperty("LINE_TOKEN");
const LOG_SHEET_ID = scriptProps.getProperty("LOG_SHEET_ID");

// LINE API設定
const LINE_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_LOADING_URL = 'https://api.line.me/v2/bot/chat/loading/start';
const GPT_MODEL = "gpt-4o-mini";

// Vision API設定
const VISION_API_CONFIG = { ENABLE_OCR: true, OCR_LANGUAGE_HINTS: ["ja", "en"] };

// RAG設定
const DRIVE_FOLDER_ID = scriptProps.getProperty("DRIVE_FOLDER_ID");
const INDEX_SHEET_ID = scriptProps.getProperty("INDEX_SHEET_ID");
const EMBEDDING_MODEL = "text-embedding-3-small";

// 自動インデックス更新用設定
const LAST_INDEX_KEY = "LAST_INDEX_TIMESTAMP";
const FILE_MAPPING_KEY = "FILE_MAPPING";
const CACHE_KEY_REGISTRY = "CACHE_KEY_REGISTRY";

// 拡張シートヘッダー（メタデータ活用）
const SHEET_HEADERS = [
  "FileId", "FileName", "MimeType", "TextChunk", "Embedding",
  "ChunkIndex", "UpdatedAt", "CharCount", "Preview",
  "TotalChunks", "Keywords"
];

// インデックススキーマ（列インデックスを集中管理）
const INDEX_SCHEMA = {
  FILE_ID: 0,
  FILE_NAME: 1,
  MIME_TYPE: 2,
  TEXT_CHUNK: 3,
  EMBEDDING: 4,
  CHUNK_INDEX: 5,
  UPDATED_AT: 6,
  CHAR_COUNT: 7,
  PREVIEW: 8,
  TOTAL_CHUNKS: 9,
  KEYWORDS: 10
};

// 結果キャッシュ設定（APIコスト削減）
const QUERY_CACHE_CONFIG = {
  ENABLE_CACHE: true,
  CACHE_TTL_SECONDS: 3600,
  SIMILARITY_THRESHOLD: 0.85,
  MAX_CACHED_QUERIES: 100,
  CACHE_VERSION: "v2"
};

// チャンク設定
const CHUNK_CONFIG = {
  // 基本設定
  CHUNK_SIZE: 1000,           // 基本チャンクサイズ
  CHUNK_OVERLAP: 100,          // オーバーラップ文字数
  MIN_CHUNK_SIZE: 200,         // 最小チャンクサイズ
  MAX_CHUNK_SIZE: 1500,        // 最大チャンクサイズ

  // セマンティック分割設定
  USE_SEMANTIC_SPLIT: true,    // セマンティック分割を有効化
  PRIORITIZE_HEADERS: true,    // 見出しを分割優先
  SENTENCE_AWARE: true,        // 文境界を考慮
  CONTEXT_PRESERVATION: true,  // 文脈維持

  // 品質設定
  MERGE_SMALL_CHUNKS: true,    // 小さいチャンクをマージ
  SPLIT_LONG_CHUNKS: true,     // 長いチャンクを分割
  DEDUPLICATE_CHUNKS: true,    // 重複チャンクを削除

  // 重要度設定
  BOOST_HEADERS: true,         // 見出しの重要度ブースト
  BOOST_LISTS: true,           // リスト項目の重要度ブースト
  HEADER_BOOST_FACTOR: 2.0,   // 見出しブースト倍率
  LIST_BOOST_FACTOR: 1.5       // リストブースト倍率
};

// 検索パラメータのデフォルト定義（UserPropertiesで管理）
// ※ ハイブリッド検索パラメータもここに含まれます
const SEARCH_PARAM_DEFINITIONS = {
  // ===== キーワード検索 =====
  'SEARCH_KEYWORD_ENABLED': {
    defaultValue: 'true',
    description: '保存されたキーワードと照合して関連性スコアを算出します。技術用語や固有名詞に強い検索方式です。',
    example: 'オン: キーワード検索を使用, オフ: キーワード検索を無効化',
    isBoolean: true,
    group: 'keyword'
  },
  // ===== BM25検索 =====
  'SEARCH_BM25_ENABLED': {
    defaultValue: 'true',
    description: 'TF-IDF を改良した BM25 アルゴリズムによる高精度キーワード検索を有効化します。',
    example: 'オン: BM25 を使用, オフ: BM25 を無効化',
    isBoolean: true,
    group: 'bm25'
  },
  // BM25: K1パラメータ
  'BM25_K1': {
    defaultValue: '1.5',
    min: 0.1,
    max: 3.0,
    step: 0.1,
    description: '単語頻度に対する飽和度を調整するパラメータ。値が大きいほど単語の繰り返しによるスコア上昇が抑制されます。',
    example: '一般的には 1.2〜2.0 が推奨値',
    group: 'bm25'
  },
  // BM25: Bパラメータ
  'BM25_B': {
    defaultValue: '0.75',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    description: '文書長の正規化を制御するパラメータ。0 は文書長を無視、1 は完全に正規化します。',
    example: '0.75 が一般的な推奨値',
    group: 'bm25'
  },
  // ===== リランキング =====
  'SEARCH_RERANK_ENABLED': {
    defaultValue: 'true',
    description: '初期検索結果 Top-N を LLM によって再評価し、関連度順に並べ替えます。',
    example: 'オン: LLM リランキングを使用, オフ: リランキングを無効化',
    isBoolean: true,
    group: 'rerank'
  },
  // リランキング: 初期取得数
  'RERANK_INITIAL_TOP_K': {
    defaultValue: '50',
    min: 5,
    max: 100,
    step: 1,
    description: '初期検索で取得する件数。ここから LLM による再評価を行います。',
    example: '例: 50 件取得 → LLM が再評価',
    group: 'rerank'
  },
  // リランキング: 最終出力数
  'RERANK_FINAL_TOP_K': {
    defaultValue: '10',
    min: 1,
    max: 50,
    step: 1,
    description: 'リランキング後に残す最終件数。',
    example: '例: Top-10 のみ最終結果として使用',
    group: 'rerank'
  },
  // リランキング: 使用モデル
  'RERANK_MODEL': {
    defaultValue: 'gpt-4o-mini',
    description: 'リランキングに使用する LLM モデル。高速性・コスト・精度のバランスで選択します。',
    example: 'gpt-4o-mini: 高速・低コスト, gpt-4o: 高精度, gpt-5.4-nano: 超高速・超低コスト',
    isSelect: true,
    options: ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4'],
    group: 'rerank'
  },
  // ===== クエリ拡張 =====
  'SEARCH_QUERY_EXPANSION_ENABLED': {
    defaultValue: 'true',
    description: '類義語・関連語を追加して検索範囲を広げ、検索精度を向上させます（全体 ON/OFF）。',
    example: 'オン: クエリ拡張を使用, オフ: クエリ拡張を無効化',
    isBoolean: true,
    group: 'query_expansion'
  },
  // 辞書ベースクエリ拡張のON/OFF
  'SEARCH_DICT_EXPANSION_ENABLED': {
    defaultValue: 'true',
    description: '辞書ベースの類義語・関連語を追加します。安定した拡張が可能です。',
    example: 'オン: 辞書ベース拡張を使用, オフ: 無効化',
    isBoolean: true,
    group: 'query_expansion'
  },
  // LLMベースクエリ拡張のON/OFF
  'SEARCH_LLM_EXPANSION_ENABLED': {
    defaultValue: 'true',
    description: 'LLM によるクエリ拡張を有効化します。文脈に応じた柔軟な拡張が可能です。',
    example: 'オン: LLM ベース拡張を使用, オフ: 無効化',
    isBoolean: true,
    group: 'query_expansion'
  },
  // クエリ拡張: 最大追加語数
  'QUERY_EXPANSION_MAX_WORDS': {
    defaultValue: '5',
    min: 1,
    max: 10,
    step: 1,
    description: 'クエリに追加する拡張語の最大数。',
    example: '例: 最大 5 語を追加',
    group: 'query_expansion'
  },
  // クエリ拡張: 同義語使用
  'QUERY_EXPANSION_USE_SYNONYMS': {
    defaultValue: 'true',
    description: '同義語展開を有効化します。',
    example: 'オン: 同義語を追加, オフ: 同義語展開を無効化',
    isBoolean: true,
    group: 'query_expansion'
  },
  // クエリ拡張: 関連語使用
  'QUERY_EXPANSION_USE_RELATED': {
    defaultValue: 'true',
    description: '関連語展開を有効化します。',
    example: 'オン: 関連語を追加, オフ: 関連語展開を無効化',
    isBoolean: true,
    group: 'query_expansion'
  },
  // ===== ハイブリッド検索 =====
  'SEARCH_HYBRID_ENABLED': {
    defaultValue: 'true',
    description: 'ベクトル検索とキーワード検索を組み合わせたハイブリッド検索を有効化します。',
    example: 'オン: ハイブリッド検索を使用, オフ: 無効化',
    isBoolean: true,
    group: 'hybrid'
  },
  // ベクトル検索の重み
  'HYBRID_VECTOR_WEIGHT': {
    defaultValue: '0.7',
    min: 0,
    max: 1,
    step: 0.05,
    description: 'ベクトル検索の重み。値が大きいほど意味検索を重視します。',
    example: '0.7: 意味検索を重視, 0.3: キーワード検索を重視',
    group: 'hybrid'
  },
  // キーワード検索の重み
  'HYBRID_KEYWORD_WEIGHT': {
    defaultValue: '0.3',
    min: 0,
    max: 1,
    step: 0.05,
    description: 'キーワード検索の重み。値が大きいほどキーワード一致を重視します。',
    example: '0.3: 意味検索を重視, 0.7: キーワード検索を重視',
    group: 'hybrid'
  },
  // 最小キーワードスコア
  'HYBRID_MIN_KEYWORD_SCORE': {
    defaultValue: '0.1',
    min: 0,
    max: 1,
    step: 0.05,
    description: 'キーワード検索結果を採用するための最小スコア閾値。',
    example: 'この値未満の結果は除外されます',
    group: 'hybrid'
  },
  // ベクトル検索TopK
  'HYBRID_TOP_K_VECTOR': {
    defaultValue: '50',
    min: 10,
    max: 200,
    step: 1,
    description: 'ベクトル検索で取得する上位件数。',
    example: '例: 上位 50 件を取得して統合',
    group: 'hybrid'
  },
  // 最終出力TopK
  'HYBRID_TOP_K_FINAL': {
    defaultValue: '10',
    min: 1,
    max: 50,
    step: 1,
    description: 'ハイブリッド統合後に出力する最終件数。',
    example: '例: 最終的に 10 件を返す',
    group: 'hybrid'
  }
};

// Embeddingキャッシュ設定
const EMBEDDING_CACHE_TTL_SECONDS = 21600; // 6時間（スクリプトレベルキャッシュ）

// 日本語同義語辞書
const SYNONYMS = {
  '会社': ['企業', '事業者', '法人'],
  '商品': ['製品', 'アイテム', 'プロダクト'],
  '価格': ['料金', '費用', '単価', 'コスト'],
  '購入': ['買う', '調達', '注文'],
  '使い方': ['使用法', '操作方法', '方法'],
  '設定': ['コンフィグ', '構成', 'セットアップ'],
  '問題': ['エラー', '故障', 'トラブル'],
  '確認': ['調べる', 'チェック', '検証'],
  '申請': ['リクエスト', '依頼', '届け出'],
  '手続き': ['フロー', 'プロセス', '手順']
};

// 日本語関連語辞書
const RELATED_WORDS = {
  'エラー': ['原因', '解決策', '対応'],
  'つかない': ['起動', '開始', '電源'],
  '遅い': ['パフォーマンス', '速度', '改善'],
  '重い': ['負荷', '処理', '軽減']
};

// エージェントモード設定
const AGENT_MODE_CONFIG = {
  MAX_ITERATIONS: 3,           // 最大反復回数
  MIN_CONFIDENCE: 0.7,         // 最低信頼度閾値
  SHOW_THINKING: true,          // 思考過程を表示するか
  ADDITIONAL_SEARCH_ENABLED: true // 追加検索を有効化するか
};

// 日本語stop words（キーワード抽出用）
const STOP_WORDS = [
  // 丁寧語・助動詞
  'です', 'ます', 'でした', 'でしたら', 'でしたが',
  'だ', 'だった', 'である', 'でしょう', 'ですね', 'ですよ',

  // 汎用動詞（意味が広すぎる）
  'する', 'した', 'して', 'される', 'され',
  'できる', 'できない', '行う', '行った', 'なる', 'なった',

  // 存在・状態
  'いる', 'いない', 'ある', 'ない',

  // 指示語（文脈依存）
  'これ', 'それ', 'あれ', 'ここ', 'そこ', 'あそこ',
  'どれ', 'どこ', 'こちら', 'そちら', 'あちら',

  // 疑問語
  'なに', 'なん', '何', 'どう', 'なぜ', 'どの', 'どんな',

  // 人称代名詞
  '私', 'あなた', 'あなた方', '自分', '彼', '彼女', 'みんな',

  // 接続詞
  'そして', 'また', 'さらに', 'しかし', 'でも', 'ただし', 'なので',

  // 抽象語（意味が広くノイズになりやすい）
  'ため', 'ので', 'から', 'など', 'とか',
  'よう', 'もの', 'こと', 'とき', 'ところ', 'ほう',

  // 文末の曖昧語
  'ですか', 'ますか', 'でしょうか', 'かな', 'かも'
];

// プロンプトテンプレート
const PROMPT_TEMPLATES = {
  "summary": (text) => `次の文章を要約してください。\n\n${text}`,
  "polite": (text) => `次の内容に丁寧に回答してください。\n\n${text}`,
  "bullet": (text) => `次の内容を箇条書きで整理してください。\n\n${text}`,
  "translate": (text) => `次の文章を英語に翻訳してください。\n\n${text}`,
  "free": (text) => text
};

/**
 * 管理者プロンプト設定の定義（ScriptPropertiesで管理）
 */
const ADMIN_PROMPT_DEFINITIONS = {
  "ADMIN_SYSTEM_PROMPT": {
    defaultValue: "あなたは誠実で効率的なAIアシスタントです。ユーザーの意図を正確に理解し、日本語で簡潔かつ明確に回答してください。",
    description: "AIの基本的な役割やペルソナを定義するシステムプロンプト",
    example: "あなたは、親切で正確な情報を提供することに注力するAIアシスタントです。"
  },
  "ADMIN_RESPONSE_RULES": {
    defaultValue: "",
    description: "応答に関する具体的なルール（箇条書きで記載）",
    example: "1. 回答は分かりやすく、丁寧で、必要以上に冗長にしないこと。\n2. 専門知識が必要な場合は、正確な情報を提供すること。\n3. 不明な点や推測が含まれる場合は、その旨を明示し、無理に断定しないこと。\n4. 親しみやすさを保ちつつ、プロフェッショナルなトーンを維持すること。"
  },
  "ADMIN_FORBIDDEN_TOPICS": {
    defaultValue: "",
    description: "応答を避けるべきトピック（カンマ区切り）",
    example: "政治,宗教,機密情報"
  },
  "ADMIN_DEFAULT_TONE": {
    defaultValue: "friendly",
    description: "デフォルトのトーン",
    options: ["friendly", "formal", "casual"],
    isSelect: true
  },
  "ADMIN_GREETING_MESSAGE": {
    defaultValue: "",
    description: "初回挨拶メッセージ（空の場合はデフォルト）",
    example: "こんにちは！何かお手伝いできることがあれば、お気軽にお知らせください。"
  }
};

/**
 * ユーザー独自プロンプト設定の定義（UserPropertiesで管理）
 */
const USER_PROMPT_DEFINITIONS = {
  "USER_CUSTOM_PROMPT": {
    defaultValue: "1. コンテキストに記載された内容を最優先で参照して回答すること。\n2. コンテキストに情報がない場合は、一般的な知識に基づいて回答してよい。\n3. コンテキストと一般知識が矛盾する場合は、コンテキストを優先すること。",
    description: "ユーザー固有の指示やルール",
    example: "彼は専門家なので、より技術的な詳細説明を期待している"
  },
  "USER_PERSONA": {
    defaultValue: "",
    description: "ユーザーに合わせるペルソナ設定",
    example: "20代女性、丁寧な受け答えを好む"
  },
  "USER_RESPONSE_STYLE": {
    defaultValue: "",
    description: "好む応答スタイル",
    example: "短めの回答、絵文字が多め"
  }
};

// RAGプロンプトテンプレートの定義（ScriptPropertiesで管理）
// 6種類のプロンプトを统一管理
const PROMPT_TEMPLATE_DEFINITIONS = {
  'PROMPT_QUERY_EXPANSION': {
    defaultValue: `以下のユーザー質問を検索しやすい形に拡張してください。

【質問】
{{query}}

【出力形式】
検索に使えるキーワードを箇条書きで出力してください。`,
    description: 'クエリ拡張プロンプト - ユーザー入力を検索向けに拡張',
    variables: ['query']
  },
  'PROMPT_SEARCH': {
    defaultValue: `以下の質問の検索意図を明確化し、検索クエリを生成してください。

【質問】
{{query}}

【出力形式】
検索に最適化されたクエリを1行で出力してください。`,
    description: '検索プロンプト - 検索クエリを生成',
    variables: ['query']
  },
  'PROMPT_SUMMARY': {
    defaultValue: `以下のドキュメントを、ユーザーの質問に答える形で要約してください。

【質問】
{{query}}

【ドキュメント】
{{chunks}}

【出力形式】
200文字以内で簡潔にまとめてください。`,
    description: '要約プロンプト - 検索結果の要約',
    variables: ['query', 'chunks']
  },
  'PROMPT_RERANK': {
    defaultValue: `以下の検索クエリに対して、各ドキュメントの関連性を0〜10点で評価してください。

【検索クエリ】
{{query}}

【ドキュメント一覧】
{{documents}}

【出力形式】
番号: スコア の形式で出力してください。
例:
1: 8
2: 3
3: 10`,
    description: 'リランキングプロンプト - 検索結果の再評価',
    variables: ['query', 'documents']
  },
  'PROMPT_AGENT_EVALUATE': {
    defaultValue: `あなたは検索精度を評価するアシスタントです。
以下のクエリに対する検索結果の評価を行い、追加の情報検索が必要かどうかを判断してください。

【ユーザークエリ】
{{query}}

【現在のコンテキスト】
{{context}}

【検索結果】
{{results}}

【評価基準】
1. 検索結果的数量と関連性を確認
2. 現在の情報だけでクエリに完全に回答できるか判断
3. 不足している情報がある場合は何を検索すべきか特定

【出力形式】
以下のJSON形式で出力してください：
{"needsMoreSearch": true/false, "confidence": 0.0〜1.0, "reason": "判断理由", "additionalTerms": ["追加検索キーワード1", "追加検索キーワード2"]}

- needsMoreSearch: 追加検索が必要ならtrue
- confidence: 現在の情報で回答できる自信度（0.0〜1.0）
- reason: 判断理由
- additionalTerms: 追加で検索すべきキーワード（配列）`,
    description: 'エージェント評価プロンプト - 検索結果の評価と追加検索判断',
    variables: ['query', 'context', 'results']
  },
  'PROMPT_AGENT_KEYWORD': {
    defaultValue: `ユーザーからの質問「{{query}}」に対して、追加で検索すべき関連キーワードを最大3つ生成してください。

現在の検索で取得しているキーワード: {{existingKeywords}}

【出力形式】
JSON配列形式で出力してください:
["キーワード1", "キーワード2", "キーワード3"]`,
    description: 'エージェントキーワード生成プロンプト - 追加検索キーワードの生成',
    variables: ['query', 'existingKeywords']
  }
};

// ================================
//  25.5. プロンプトテンプレート管理関数
// ================================

/**
 * プロンプトテンプレートをScriptPropertiesから取得
 * @returns {Object} プロンプトテンプレート設定
 */
function getPromptTemplateSettings() {
  try {
    const settings = {};

    for (const [key, def] of Object.entries(PROMPT_TEMPLATE_DEFINITIONS)) {
      let value = scriptProps.getProperty(key);

      // デフォルト値が空の場合はデフォルト値を設定
      if (value === null || value === undefined || value === "") {
        value = def.defaultValue;
        if (value) {
          scriptProps.setProperty(key, value);
        }
      }

      settings[key] = value || "";
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
 * プロンプトテンプレートをScriptPropertiesに保存
 * @param {string} key - プロンプトテンプレートキー
 * @param {string} value - プロンプト内容
 * @returns {Object} 更新結果
 */
function updatePromptTemplate(key, value) {
  try {
    // 許可されたキーのリスト
    const allowedKeys = Object.keys(PROMPT_TEMPLATE_DEFINITIONS);

    if (!allowedKeys.includes(key)) {
      return {
        success: false,
        error: '許可されていないキーです: ' + key
      };
    }

    // ScriptPropertiesに保存
    scriptProps.setProperty(key, value);

    logInfo('[updatePromptTemplate] プロンプトテンプレートを更新:', key);

    return {
      success: true,
      key: key,
      value: value
    };
  } catch (error) {
    logError('[updatePromptTemplate] エラー:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * プロンプトテンプレートからプロンプトを生成
 * 変数をプレースホルダーに置換
 * @param {string} templateKey - プロンプトテンプレートキー
 * @param {Object} variables - 置換する変数のオブジェクト
 * @returns {string} 生成されたプロンプト
 */
function buildPromptFromTemplate(templateKey, variables) {
  try {
    // ScriptPropertiesからテンプレートを取得
    let template = scriptProps.getProperty(templateKey);

    // テンプレートが設定されていない場合はデフォルトを使用
    if (!template || template.trim() === "") {
      const def = PROMPT_TEMPLATE_DEFINITIONS[templateKey];
      template = def ? def.defaultValue : "";
    }

    // 変数を置換
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        const placeholder = '{{' + key + '}}';
        template = template.split(placeholder).join(value);
      }
    }

    return template;
  } catch (error) {
    logError('[buildPromptFromTemplate] エラー:', error);
    // エラー発生時はデフォルト定義を返す
    const def = PROMPT_TEMPLATE_DEFINITIONS[templateKey];
    return def ? def.defaultValue : "";
  }
}

// LLMパラメータのデフォルト定義（UserPropertiesに保存）
const LLM_PARAM_DEFINITIONS = {
  'LLM_MODEL': {
    defaultValue: 'gpt-4o-mini',
    description: '使用する GPT モデルを指定します。用途に応じて速度・品質・コストのバランスを選択します。',
    example: 'gpt-4o-mini: 高速・低コスト, gpt-4o: 高品質, gpt-5.4-nano: 超高速・超低コスト',
    paramName: 'model',
    isSelect: true,
    options: ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4']
  },
  'LLM_TEMPERATURE': {
    defaultValue: '0.7',
    min: 0,
    max: 2,
    step: 0.1,
    description: '生成内容のランダム性（創造性）を制御します。低いほど安定し、高いほど自由度が増します。',
    example: '0.0: 毎回ほぼ同じ回答, 0.7: バランスの良い自然な文章, 1.5: 創造的だが内容がブレやすい',
    paramName: 'temperature'
  },
  'LLM_TOP_P': {
    defaultValue: '1.0',
    min: 0,
    max: 1,
    step: 0.05,
    description: '確率分布に基づき、どの範囲の候補からトークンを選ぶかを制御します。temperature と併用可能です。',
    example: '0.1: 非常に保守的, 0.9: 多様な表現を許容, 1.0: 全候補から選択',
    paramName: 'top_p'
  },
  'LLM_TOP_K': {
    defaultValue: '40',
    min: 1,
    max: 100,
    step: 1,
    description: '次に選ばれるトークンを上位 K 個に制限します。小さいほど確定的、大きいほど多様になります。',
    example: '1: 最も確率の高い語のみ, 20: バランス, 100: 多様な語彙から選択',
    paramName: 'top_k'
  },
  'LLM_MAX_COMPLETION_TOKENS': {
    defaultValue: '2048',
    min: 1,
    max: 16384,
    step: 1,
    description: 'AI が生成する最大トークン数（文章の長さの上限）。gpt-5.x 系では max_completion_tokens、gpt-4.x 系以前では max_tokens を使用します。入力（プロンプト）と出力の合計がモデルのコンテキスト上限を超えないように設定します。',
    example: '256: 短い回答, 1024: 標準的な説明文, 4096: 長文記事やコード生成',
    paramName: 'max_tokens'
  },
  'LLM_MAX_PROMPT_TOKENS': {
    defaultValue: '2048',
    min: 1,
    max: 16384,
    step: 1,
    description: 'プロンプト（入力）の最大トークン数を制限するパラメータ。gpt-5.x 系専用。0 は無効値（エラー）であり「制限なし」にはなりません。通常は指定せず、OpenAI による自動調整に任せることが推奨されます。',
    example: '（通常は未指定）, 4000: プロンプトを 4000 トークンに制限して出力枠を確保',
    paramName: 'max_prompt_tokens'
  },
  'LLM_PRESENCE_PENALTY': {
    defaultValue: '0',
    min: -2,
    max: 2,
    step: 0.1,
    description: '同じ話題や内容の繰り返しをどの程度抑制するかを制御します。新しい視点を出したいときに有効です。',
    example: '0: 話題の繰り返しを許容, 1.0: 同じ話題を避ける, 2.0: 強く禁止',
    paramName: 'presence_penalty'
  },
  'LLM_FREQUENCY_PENALTY': {
    defaultValue: '0',
    min: -2,
    max: 2,
    step: 0.1,
    description: '同じ単語の繰り返しをどの程度抑制するかを制御します。文章の単調さを防ぎます。',
    example: '0: 繰り返しを許容, 1.0: 同じ単語を避ける, 2.0: 強く抑制',
    paramName: 'frequency_penalty'
  },
  'LLM_STOP': {
    defaultValue: '',
    description: '指定した語句が出た時点で生成を停止します。複数指定する場合はカンマ区切りで入力します。',
    example: 'ありがとう → 「ありがとう」が出たら停止, END → 「END」が出たら停止',
    paramName: 'stop',
    isString: true
  },
  'LLM_RESPONSE_FORMAT': {
    defaultValue: 'text',
    description: '出力形式を指定します。json を選ぶとパース可能な JSON を返します（モデルによっては JSON モードが制限される場合があります）。',
    example: 'text: 通常のテキスト出力, json: プログラム連携向けの JSON 出力',
    paramName: 'response_format',
    isSelect: true,
    options: ['text', 'json']
  }
};

// top_kをサポートしていないモデルリスト
const MODELS_WITHOUT_TOP_K = ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4'];

// 設定項目のデフォルト定義（ScriptPropertiesに保存）
const SETTING_DEFINITIONS = {
  'OPENAI_API_KEY': {
    defaultValue: '',
    isRequired: true,
    description: 'ChatGPT APIの認証キー',
    placeholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    isSecret: true
  },
  'LINE_TOKEN': {
    defaultValue: '',
    isRequired: false,
    description: 'LINE Messaging APIのアクセストークン',
    placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    isSecret: true
  },
  'LOG_SHEET_ID': {
    defaultValue: '',
    isRequired: false,
    description: 'ログを記録するGoogle SheetsのID',
    placeholder: '1ABCdefGHIjklMNOpqrSTUvwxyz1234567890',
    isSensitive: true
  },
  'DRIVE_FOLDER_ID': {
    defaultValue: '',
    isRequired: true,
    description: 'RAGインデックス用のGoogle DriveフォルダID',
    placeholder: '1ABCdefGHIjklMNOpqrSTUvwxyz1234567890',
    isSensitive: true
  },
  'INDEX_SHEET_ID': {
    defaultValue: '',
    isRequired: true,
    description: 'RAGインデックスを保存するGoogle SheetsのID',
    placeholder: '1ABCdefGHIjklMNOpqrSTUvwxyz1234567890',
    isSensitive: true
  },
  'VISION_API_KEY': {
    defaultValue: '',
    isRequired: false,
    description: 'Google Cloud Vision APIのキー（OCR用）',
    placeholder: 'AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    isSecret: true
  },
  'DEBUG_MODE': {
    defaultValue: 'false',
    isRequired: false,
    description: 'デバッグモード（Traceログを出力）',
    isBoolean: true
  },
  // 管理者リスト（カンマ区切りでメールアドレスを複数指定）
  'ADMIN_LIST': {
    defaultValue: 'admin@example.com, manager@example.com',
    isRequired: false,
    description: '管理者メールアドレスリスト（カンマ区切り）',
    placeholder: '（カンマ区切り）admin@example.com, manager@example.com',
    isSecurity: true
  },
  // 開発者モード（trueの場合、管理者リストに関係なく管理画面ボタンを表示）
  'DEV_MODE': {
    defaultValue: 'false',
    isRequired: false,
    description: '開発者モード（管理者リストに関係なく管理画面ボタンを表示）',
    isBoolean: true
  },
  // 許可リスト（カンマ区切りでメールアドレスを複数指定）
  'ALLOW_LIST': {
    defaultValue: 'allowed@example.com, user@example.com',
    isRequired: false,
    description: 'アクセス許可メールアドレスリスト（カンマ区切り）',
    placeholder: '（カンマ区切り）allowed@example.com, user@example.com',
    isSecurity: true
  },
  // アクセス禁止リスト（カンマ区切りでメールアドレスを複数指定）
  'BLOCK_LIST': {
    defaultValue: 'blocked@example.com, user@example.com',
    isRequired: false,
    description: 'アクセス禁止メールアドレスリスト（カンマ区切り）',
    placeholder: '（カンマ区切り）blocked@example.com, user@example.com',
    isSecurity: true
  }
};

// ================================
//  2. ログ出力関数
// ================================

/**
 * ログメッセージを変換（オブジェクトはJSON、文字列に変換）
 * @private
 * @param {Array} args - 可変引数
 * @returns {string} スペース区切りのメッセージ文字列
 */
function formatLogMessage(...args) {
  return args.map(arg => {
    if (typeof arg === 'object') {
      return JSON.stringify(arg);
    }
    return String(arg);
  }).join(' ');
}

/**
 * ログをGoogle Sheetsに記録
 * @param {string} level - ログレベル（INFO, WARN, ERROR, TRACE）
 * @param {string} message - ログメッセージ
 */
function logToSheet(level, message) {
  if (!LOG_SHEET_ID) {
    console.log('[logToSheet] LOG_SHEET_ID が設定されていません');
    return;
  }
  try {
    const sheet = SpreadsheetApp.openById(LOG_SHEET_ID).getActiveSheet();
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp", "Level", "Message"]);
    }
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    sheet.appendRow([now, level, String(message).substring(0, 5000)]);
  } catch (error) {
    console.error('[logToSheet] シート記録エラー:', error);
  }
}

/**
 * 汎用ログ出力関数
 * @param {string} level - ログレベル（TRACE, INFO, ERROR, WARN）
 * @param {boolean} checkDebug - デバッグモードをチェックするか
 * @param {any[]} args - ログ出力する引数
 */
function log(level, checkDebug, ...args) {
  if (checkDebug && !isDebugModeEnabled()) return;
  const message = formatLogMessage(...args);
  const logger = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  logger(...args);
  logToSheet(level, message);
}

/** ログ出力用ラッパー関数 */
function logTrace(...args) { log('TRACE', true, ...args); }
function logInfo(...args) { log('INFO', false, ...args); }
function logError(...args) { log('ERROR', false, ...args); }
function logWarn(...args) { log('WARN', false, ...args); }

// ================================
//  3. ユーティリティ関数
// ================================

/**
 * userIdをハッシュ化して返す（ログ用）
 * セキュリティのため、キャッシュキーとログではハッシュ値を使用
 * @param {string} userId - ユーザーID
 * @returns {string} ハッシュ化されたユーザーID
 */
function hashUserId(userId) {
  if (!userId) return '';
  try {
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, userId);
    return Utilities.base64Encode(hash).substring(0, 16);
  } catch (error) {
    logError("[HASH] userIdハッシュ化エラー:", error);
    return userId;
  }
}

/**
 * スクリプトプロパティからAPIキーを取得
 * @returns {string|null} Vision APIキー
 */
function getVisionApiKey() { return scriptProps.getProperty("VISION_API_KEY"); }

/**
 * MimeTypeに基づいて正しいGoogle DriveのURLを生成
 */
function getDocumentUrl(fileId, mimeType) {
  if (!mimeType) {
    // デフォルトはGoogle Docs
    return `https://docs.google.com/document/d/${fileId}/view`;
  }

  // MimeTypeに基づいてURLを生成（文字列で直接比較）
  if (mimeType === 'application/vnd.google-apps.spreadsheet' || mimeType === MimeType.GOOGLE_SHEETS) {
    return `https://docs.google.com/spreadsheets/d/${fileId}/view`;
  } else if (mimeType === 'application/vnd.google-apps.presentation' || mimeType === MimeType.GOOGLE_SLIDES) {
    return `https://docs.google.com/presentation/d/${fileId}/view`;
  } else if (mimeType === 'application/vnd.google-apps.document' || mimeType === MimeType.GOOGLE_DOCS) {
    return `https://docs.google.com/document/d/${fileId}/view`;
  } else {
    // その他の場合はGoogle DriveのホームURL
    return `https://drive.google.com/file/d/${fileId}/view`;
  }
}

/**
 * スキーマからフィールドを取得
 */
function getIndexField(row, fieldName) {
  return row[INDEX_SCHEMA[fieldName]];
}

/**
 * コサイン類似度を計算
 */
function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return (magA && magB) ? dotProduct / (magA * magB) : 0;
}

// ================================
//  4. キャッシュ管理関数
// ================================

/**
 * ユーザー別の結果キャッシュを取得
 * 類似した過去のクエリ結果が保存されていれば再利用
 * @param {string} originalQuery - ユーザーのクエリ
 * @param {string} userId - ユーザーID（ユーザー別のキャッシュ用）
 */
function getQueryCache(originalQuery, userId) {
  if (!QUERY_CACHE_CONFIG.ENABLE_CACHE) return null;

  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE:QUERY] CacheServiceが利用できません");
      return null;
    }

    // userIdをハッシュ化してキャッシュキーを生成
    const hashedUserId = hashUserId(userId);

    // クエリのハッシュを計算
    const queryHash = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, originalQuery)
    ).substring(0, 16);

    // キャッシュキーを生成（バージョン + ハッシュ化されたユーザーIDを含める）
    // ユーザーIDを含めることで、ユーザー別のキャッシュを実現
    const cacheKey = "rag_cache_" + QUERY_CACHE_CONFIG.CACHE_VERSION + "_" + hashedUserId + "_" + queryHash;
    const cached = cache.get(cacheKey);

    if (cached) {
      logTrace("[CACHE:QUERY] キャッシュヒット! user(hash):", hashedUserId, "query:", originalQuery.substring(0, 30));
      const cacheData = JSON.parse(cached);
      // resultsフィールド（文字列）を返す
      return cacheData.results;
    }

    // 類似クエリを検索
    logTrace("[CACHE:QUERY] キャッシュミス、新規クエリ user(hash):", hashedUserId);
    return null;

  } catch (error) {
    logError("[CACHE:QUERY] エラー:", error);
    return null;
  }
}

/**
 * ユーザー別の結果キャッシュを保存
 * クエリと検索結果をユーザー別に紐付けて保存
 * @param {string} originalQuery - ユーザーのクエリ
 * @param {string} results - 検索結果
 * @param {string} userId - ユーザーID（ユーザー別のキャッシュ用）
 */
function setQueryCache(originalQuery, results, userId) {
  if (!QUERY_CACHE_CONFIG.ENABLE_CACHE) return;

  try {
    const cache = CacheService.getScriptCache();

    // userIdをハッシュ化してキャッシュキーを生成
    const hashedUserId = hashUserId(userId);

    const queryHash = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, originalQuery)
    ).substring(0, 16);

    // キャッシュキーにハッシュ化されたユーザーIDを含める
    const cacheKey = "rag_cache_" + QUERY_CACHE_CONFIG.CACHE_VERSION + "_" + hashedUserId + "_" + queryHash;
    const cacheData = {
      query: originalQuery,
      results: results,
      timestamp: new Date().toISOString(),
      userId: hashedUserId
    };

    cache.put(cacheKey, JSON.stringify(cacheData), QUERY_CACHE_CONFIG.CACHE_TTL_SECONDS);

    // キャッシュキーをレジストリに追加（削除用）
    addCacheKey(cacheKey);

    logTrace("[CACHE:QUERY] キャッシュ保存完了 user(hash):", hashedUserId, "query:", originalQuery.substring(0, 30));

  } catch (error) {
    logError("[CACHE:QUERY] 保存エラー:", error);
  }
}

/**
 * キャッシュキーのレジストリを取得（CacheServiceを使用)
 */
function getCacheKeyRegistry() {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE:REGISTRY] CacheServiceが利用できません");
      return [];
    }

    const registryJson = cache.get(CACHE_KEY_REGISTRY);
    return registryJson ? JSON.parse(registryJson) : [];
  } catch (error) {
    logError("[CACHE:REGISTRY] レジストリ取得エラー:", error);
    return [];
  }
}

/**
 * キャッシュキーをレジストリに追加（CacheServiceを使用）
 */
function addCacheKey(cacheKey) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE:REGISTRY] CacheServiceが利用できません");
      return;
    }

    const registry = getCacheKeyRegistry();
    if (!registry.includes(cacheKey)) {
      registry.push(cacheKey);
      if (registry.length > QUERY_CACHE_CONFIG.MAX_CACHED_QUERIES) {
        registry.shift();
      }
      // CacheServiceに保存（6時間のTTL - メインキャッシュより長く）
      cache.put(CACHE_KEY_REGISTRY, JSON.stringify(registry), 21600);
    }
  } catch (error) {
    logError("[CACHE:REGISTRY] キー追加エラー:", error);
  }
}

/**
 * 全てのクエリキャッシュをクリア（CacheServiceを使用）
 */
function clearAllQueryCaches() {
  let deletedCount = 0;
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logError("[CACHE:CLEAR] CacheServiceが利用できません");
      return 0;
    }

    const registry = getCacheKeyRegistry();

    logInfo("[CACHE:CLEAR] レジストリ内のキャッシュ数:", registry.length);

    for (const cacheKey of registry) {
      try {
        cache.remove(cacheKey);
        deletedCount++;
      } catch (e) {
        logWarn("[CACHE:CLEAR] キー削除エラー:", cacheKey, e.message);
      }
    }

    // レジストリ自体もクリア
    cache.remove(CACHE_KEY_REGISTRY);
    logInfo("[CACHE:CLEAR] 削除完了:", deletedCount, "件");
  } catch (error) {
    logError("[CACHE:CLEAR] 全削除エラー:", error);
  }
  return deletedCount;
}

// ================================
//  5. 会話履歴管理
// ================================

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

// ================================
//  6. Web Apps エントリーポイント
// ================================

/**
 * 管理者リストをScriptPropertiesから取得
 * @returns {Array} 管理者メールアドレスの配列
 */
function getAdminList() {
  try {
    const adminListStr = scriptProps.getProperty('ADMIN_LIST') || '';
    if (!adminListStr || adminListStr.trim() === '') {
      logWarn('[ADMIN_AUTH] ADMIN_LISTがScriptPropertiesに設定されていません');
      return [];
    }
    // カンマ区切りで配列に変換
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
 * @returns {boolean} DEV_MODE有効な場合true
 */
function isDevModeEnabled() {
  const devMode = scriptProps.getProperty('DEV_MODE');
  return devMode === 'true';
}

/**
 * 現在のユーザーが管理者かチェック
 * @returns {Object} 認証結果 { isAdmin: boolean, email: string, message: string }
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
    
    // 管理者リストを取得
    const adminList = getAdminList();
    
    // 管理者リストが空の場合は警告（開発用）
    if (adminList.length === 0) {
      logWarn('[ADMIN_AUTH] 管理者リストが空です。ScriptPropertiesにADMIN_LISTを設定してください。');
      // DEV_MODEも管理者リストも未設定の場合はアクセスを許可（本来は拒否すべき）
      return {
        isAdmin: true,
        email: 'development@local',
        message: '開発モード: 管理者リスト未設定'
      };
    }
    
    // 現在のユーザーを取得
    const userEmail = Session.getActiveUser().getEmail();
    
    if (!userEmail) {
      logWarn('[ADMIN_AUTH] ユーザーメールアドレスを取得できませんでした');
      return {
        isAdmin: false,
        email: '',
        message: 'メールアドレスを取得できませんでした。Googleにログインしているか確認してください。'
      };
    }
    
    // 管理者のメールアドレスかどうかを確認
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
 * Webアプリのメイン関数（doGet）
 * @param {Object} e - doGetイベントオブジェクト
 * @returns {HtmlOutput} HTML出力
 * 
 * パラメータ:
 *   - page=log : ログモニタリング画面
 *   - page=rag : RAG管理画面
 *   - page=admin : 管理者メニュー画面（要認証）
 *   - page=settings : 設定画面（要認証）
 *   - デフォルト : チャット画面
 */
function doGet(e) {
  // ページパラメータを取得（デフォルトはチャット画面）
  const page = e.parameter.page || 'chat';

  // 管理画面（admin, settings, rag, log）は認証が必要
  const requiresAuth = ['admin', 'settings', 'rag', 'log'].includes(page);
  
  let authResult = { isAdmin: true, email: '', message: '' };
  
  if (requiresAuth) {
    authResult = checkAdminAuth();
    
    // 認証失敗の場合はエラーメッセージを表示
    if (!authResult.isAdmin) {
      return createAuthErrorHtml(authResult);
    }
  }

  if (page === 'rag') {
    // RAG管理画面を表示
    const template = HtmlService.createTemplateFromFile('rag-manager.html');
    return template.evaluate()
      .setTitle('RAG インデックス管理')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else if (page === 'log') {
    // ログモニタリング画面を表示
    const template = HtmlService.createTemplateFromFile('log-monitor.html');
    return template.evaluate()
      .setTitle('AI Chat ログモニター')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else if (page === 'settings') {
    // 設定画面を表示
    const template = HtmlService.createTemplateFromFile('settings.html');
    return template.evaluate()
      .setTitle('設定')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else if (page === 'admin') {
    // 管理者メニュー画面を表示
    const template = HtmlService.createTemplateFromFile('admin.html');
    template.adminParam = 'admin'; // サーバーでadminフラグを渡す
    template.userEmail = authResult.email; // ログインユーザー情報を渡す
    return template.evaluate()
      .setTitle('管理者メニュー')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } else {
    // デフォルト: チャット画面を表示（ブラックリスト照合）
    const chatAuth = checkChatUserAuth();
    
    // ブラックリストに一致する場合はアクセス拒否
    if (chatAuth.isBlocked) {
      return createAuthErrorHtml(chatAuth);
    }
    
    const template = HtmlService.createTemplateFromFile('chat.html');
    template.userEmail = chatAuth.email; // ログインユーザー情報を渡す
    template.isAdmin = chatAuth.isAdmin || false; // 管理者フラグを渡す
    template.isDevMode = chatAuth.isDevMode || false; // 開発者モードフラグを渡す
    return template.evaluate()
      .setTitle('AI Chat')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
}

/**
 * 認証エラー時のHTMLを生成
 * @param {Object} authResult - 認証結果
 * @returns {HtmlOutput} エラー画面HTML
 */
function createAuthErrorHtml(authResult) {
  // auth-error.htmlテンプレートを使用してHTMLを生成
  const template = HtmlService.createTemplateFromFile('auth-error.html');
  template.authResult = authResult;
  return template.evaluate()
    .setTitle('アクセス拒否')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * ログモニタリングHTMLをテンプレートとして読み込み
 * @param {string} filename - 読み込むHTMLファイル名
 * @returns {string} HTMLコンテンツ
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Web AppsのURLを取得（画面遷移用）
 * @returns {string} Web AppsのURL
 */
function getAppUrl() {
  return ScriptApp.getService().getUrl();
}

/**
 * 許可リストを取得
 * @returns {Array} 許可メールアドレスの配列
 */
function getAllowList() {
  try {
    const allowListStr = scriptProps.getProperty('ALLOW_LIST') || '';
    if (!allowListStr || allowListStr.trim() === '') {
      logTrace('[ALLOW_LIST] 許可リストがScriptPropertiesに設定されていません');
      return [];
    }
    // カンマ区切りで配列に変換
    const allowList = allowListStr.split(',').map(email => email.trim().toLowerCase()).filter(email => email);
    logTrace('[ALLOW_LIST] 許可リスト取得:', allowList.length, '人');
    return allowList;
  } catch (error) {
    logError('[ALLOW_LIST] 許可リスト取得エラー:', error);
    return [];
  }
}

/**
 * チャットページのユーザー認証チェック（許可リスト・禁止リスト照合）
 * 管理者画面とは異なり、許可リストが設定されている場合は許可リスト内のユーザーのみアクセス可能
 * 禁止リストに一致するユーザーはアクセス拒否
 * @returns {Object} 認証結果 { isBlocked: boolean, email: string, message: string }
 */
function checkChatUserAuth() {
  try {
    // 現在のユーザーを取得
    const userEmail = Session.getActiveUser().getEmail();
    
    // メールアドレスを取得できない場合はアクセスを許可（エラー画面への遷移不要）
    if (!userEmail) {
      logTrace('[CHAT_AUTH] メールアドレスを取得できませんでした（アクセス許可）');
      return {
        isBlocked: false,
        isAdmin: false,
        isDevMode: false,
        email: '',
        message: 'メールアドレス未取得'
      };
    }
    
    const userEmailLower = userEmail.toLowerCase();
    
    // DEV_MODEが有効な場合は無条件でアクセスを許可
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
    
    // 管理者リストを取得
    const adminList = getAdminList();
    
    // 許可リストを取得
    const allowList = getAllowList();
    
    // 管理者・DEV_MODEの判定
    // ADMIN_LISTが空の場合は開発者モードとして扱う（後方互換性）
    const isDevMode = adminList.length === 0;
    const isAdmin = isDevMode || (adminList.length > 0 && adminList.includes(userEmailLower));
    
    // 許可リストの判定
    // 許可リストが設定されている場合は、許可リスト内のユーザーのみアクセス可能
    const isAllowListEnabled = allowList.length > 0;
    const isAllowed = isAllowListEnabled ? allowList.includes(userEmailLower) : true;
    
    // 許可リストが有効でユーザーがリストにいない場合はアクセス拒否
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
    
    // ScriptPropertiesから禁止リストを取得
    const BLOCK_LISTStr = scriptProps.getProperty('BLOCK_LIST') || '';
    
    // 禁止リストが空の場合はアクセスを許可
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
    
    // 禁止リストを配列に変換（小文字比較）
    const BLOCK_LIST = BLOCK_LISTStr.split(',').map(email => email.trim().toLowerCase()).filter(email => email);
    
    // 禁止リストに一致するか確認
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
      logInfo('[CHAT_AUTH] アクセス許可:', userEmail, '管理者:', isAdmin, '開発者モード:', isDevMode, '許可リスト:', isAllowListEnabled);
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
    // エラー発生時はアクセスを許可（エラー画面への遷移不要）
    return {
      isBlocked: false,
      isAdmin: false,
      isDevMode: false,
      email: '',
      message: '認証エラー（アクセス許可）'
    };
  }
}

// ================================
//  7. AI Chat メイン処理
// ================================

/**
 * AI Chatに返信メッセージを送信
 * @param {string} replyToken - LINEの返信トークン
 * @param {string} message - 送信するメッセージ（最大5000文字）
 */
function sendMessage(replyToken, message) {
  // メッセージが空またはundefinedの場合のチェック
  if (!message) {
    logError("LINE API エラー: メッセージが空です");
    return;
  }

  // メッセージ过长tronicsのチェック（LINEの制限: 最大5000文字）
  const maxLength = 5000;
  if (message.length > maxLength) {
    logWarn("LINE メッセージ过长tronics、超過分を削除します");
    message = message.substring(0, maxLength);
  }

  try {
    const response = UrlFetchApp.fetch(LINE_URL, {
      method: "post",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": "Bearer " + LINE_TOKEN
      },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: "text", text: message }]
      })
    });

    // レスポンスの確認
    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      logError("LINE API エラー: ステータスコード " + responseCode, response.getContentText());
    }
  } catch (error) {
    logError("LINE API エラー:", error);
    // より詳細なエラー情報を出力
    if (error.message) {
      logError("LINE API エラー詳細:", error.message);
    }
    if (error.stack) {
      logError("LINE API エラースタック:", error.stack);
    }
  }
}

/**
 * AI Chat Loading APIで「考え中...」を表示
 * @param {string} userId - ユーザーID
 */
function sendLineLoading(userId) {
  try {
    const response = UrlFetchApp.fetch(LINE_LOADING_URL, {
      method: "post",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": "Bearer " + LINE_TOKEN
      },
      payload: JSON.stringify({
        chatId: userId,
        loadingPoint: 100  // 最大100%まで表示
      })
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      logWarn("LINE Loading API エラー: ステータスコード " + responseCode);
    }
  } catch (error) {
    // Loading APIのエラーは致命的ではないため、ログに出力のみ
    logWarn("LINE Loading API エラー（致命的ではない）:", error.message);
  }
}

/**
 * LINE Webhookを受け取りメッセージを処理
 * @param {Object} e - doPostイベントオブジェクト（postData.contentsを含む）
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

      // 会話履歴を削除
      cache.remove(userId);
      logTrace("[COMMAND] 会話履歴を削除:", userId);

      // RAGクエリ結果キャッシュも同時に削除（新しいレジストリ機能を使用）
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

      // RAG関連キャッシュを削除（新しいレジストリ機能を使用）
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
      `【情報確認】\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📊 #インデックス情報\n` +
      `   → 登録ドキュメント数・チャンク数・最終更新日時を表示\n\n` +
      `【インデックス管理】\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🔄 #インデックス更新\n` +
      `   → 手動でインデックスを更新\n\n` +
      `🚀 #初期インデックス\n` +
      `   → 初回または全ファイル再インデックスを実行\n\n` +
      `⏰ #自動更新 [時間] ⚠️\n` +
      `   → 自動更新を設定（例: #自動更新 2 で2時間ごと）\n` +
      `   → *注意: 数字は1〜24の範囲で指定*\n\n` +
      `🛑 #自動更新解除\n` +
      `   → 自動更新を停止\n\n` +
      `【機能切替】\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `✨ #拡張機能\n` +
      `   → クエリ拡張（類義語追加）のON/OFFを切り替え\n\n` +
      `🗑️ #キャッシュクリア\n` +
      `   → 検索キャッシュをクリアして再検索\n\n` +
      `📝 #履歴削除\n` +
      `   → 会話履歴をクリア\n\n` +
      `【文章加工】\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📝 #要約 [テキスト]\n` +
      `   → テキストを要約\n\n` +
      `🙇 #丁寧に [テキスト]\n` +
      `   → 丁寧な言い方に変換\n\n` +
      `📋 #箇条書き [テキスト]\n` +
      `   → 箇条書きに変換\n\n` +
      `🌐 #翻訳 [テキスト]\n` +
      `   → 英語に翻訳\n\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
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

  // LINE Loading APIで「考え中」を表示
  sendLineLoading(userId);

  history.push({ role: "user", content: prompt });
  history = history.slice(-5);

  // 拡張機能付きRAG呼び出し（userIdを渡してユーザー別のキャッシュを実現）
  const botReply = callChatGPTWithRAGEnhanced(prompt, history, userId);

  history.push({ role: "assistant", content: botReply });
  saveHistory(userId, history);

  sendMessage(replyToken, botReply);
}

// ================================
//  8. テキスト抽出関数群
// ================================

/**
 * 様々なMimeTypeのファイルからテキストを抽出
 * @param {string} fileId - Google DriveのファイルID
 * @param {string} mimeType - MIMEタイプ
 * @param {string} name - ファイル名
 * @returns {string} 抽出されたテキスト
 */
function extractText(fileId, mimeType, name) {
  // Googleドキュメント（文字列比較も対応）
  if (mimeType === 'application/vnd.google-apps.document' || mimeType === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(fileId).getBody().getText();
  }
  // Googleスプレッドシート（文字列比較も対応）
  if (mimeType === 'application/vnd.google-apps.spreadsheet' || mimeType === MimeType.GOOGLE_SHEETS) {
    return extractTextFromGoogleSheets(fileId, name);
  }
  // テキストファイル
  if (mimeType === 'text/plain') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  // CSV
  if (mimeType === 'text/csv') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  // HTML
  if (mimeType === 'text/html') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  // マークダウン
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown' || mimeType === 'application/x-markdown') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  // Microsoft Word（文字列比較も対応）
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mimeType === MimeType.MICROSOFT_WORD) {
    return extractTextFromWord(fileId, name);
  }
  // Microsoft Excel（文字列比較も対応）
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimeType === MimeType.MICROSOFT_EXCEL) {
    return extractTextFromExcel(fileId, name);
  }
  // PowerPoint（文字列比較も対応）
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || mimeType === MimeType.MICROSOFT_POWERPOINT) {
    return extractTextFromPowerPoint(fileId, name);
  }
  // PDF（文字列比較も対応）
  if (mimeType === 'application/pdf' || mimeType === MimeType.PDF) {
    return extractTextFromPDFWithOCR(fileId, name);
  }
  throw new Error("未対応: " + mimeType);
}

/**
 * Google Sheetsからテキストを抽出
 */
function extractTextFromGoogleSheets(fileId, fileName) {
  try {
    logTrace("[GOOGLE_SHEETS] Google Sheetsテキスト抽出開始:", fileName);

    const spreadsheet = SpreadsheetApp.openById(fileId);
    let text = "";

    // 全シートのテキストを取得
    const sheets = spreadsheet.getSheets();
    for (const sheet of sheets) {
      const sheetName = sheet.getName();
      text += "\n【シート: " + sheetName + "】\n";

      const data = sheet.getDataRange().getValues();
      for (const row of data) {
        const rowText = row.filter(cell => cell !== null && cell !== "").join("\t");
        if (rowText) {
          text += rowText + "\n";
        }
      }
    }

    if (text && text.trim().length > 0) {
      logTrace("[GOOGLE_SHEETS] Google Sheetsテキスト抽出完了:", fileName, "文字数:", text.length);
      return text;
    }

    logWarn("[GOOGLE_SHEETS] Google Sheetsからテキストを抽出できませんでした:", fileName);
    return "";

  } catch (error) {
    logError("[GOOGLE_SHEETS] Google Sheets抽出エラー:", error);
    return "";
  }
}

/**
 * PowerPointファイルからテキストを抽出
 * Google Slidesに変換してテキストを取得
 */
function extractTextFromPowerPoint(fileId, fileName) {
  try {
    logTrace("[PPT] PowerPointテキスト抽出開始 - fileId:", fileId, "fileName:", fileName);

    // ステップ1: ファイルBlobを取得
    logTrace("[PPT] ファイルBlob取得開始");
    const file = DriveApp.getFileById(fileId);
    const fileBlob = file.getBlob();
    logTrace("[PPT] ファイルBlob取得完了 - contentType:", fileBlob.getContentType(), "size:", fileBlob.getBytes().length);

    // ステップ2: PowerPointをGoogle Slidesに変換
    logTrace("[PPT] Google Slidesへの変換開始");
    const resource = {
      title: "temp_ppt_" + fileName,
      mimeType: MimeType.GOOGLE_SLIDES
    };

    logTrace("[PPT] Drive.Files.insert開始 - resource:", JSON.stringify(resource));
    const convertedFile = Drive.Files.insert(resource, fileBlob, {
      convert: true
    });
    logTrace("[PPT] Google Slidesへの変換完了 - convertedFileId:", convertedFile.id, "convertedMimeType:", convertedFile.mimeType);

    // ステップ3: Slides APIを使ってプレゼン情報を取得
    logTrace("[PPT] Slides APIでテキスト抽出開始 - presentationId:", convertedFile.id);
    const presentation = Slides.Presentations.get(convertedFile.id);
    let text = "";

    // スライド一覧
    const slides = presentation.slides;
    logTrace("[PPT] スライド数:", slides.length);

    // 再帰的にテキストを抽出するヘルパー関数
    function extractTextFromElement(el) {
      let extractedText = "";
      
      try {
        // シェイプ（テキストボックスなど）
        if (el.shape && el.shape.text && el.shape.text.textElements) {
          el.shape.text.textElements.forEach(t => {
            if (t.textRun && t.textRun.content) {
              extractedText += t.textRun.content;
            }
          });
        }

        // テーブル
        if (el.table) {
          el.table.tableRows.forEach(row => {
            row.tableCells.forEach(cell => {
              const cellText = cell.text.textElements
                .map(te => te.textRun ? te.textRun.content : "")
                .join("");
              extractedText += cellText + "\t";
            });
            extractedText += "\n";
          });
        }

        // グループ化された要素（再帰的に処理）
        if (el.group && el.group.children) {
          el.group.children.forEach(childElement => {
            extractedText += extractTextFromElement(childElement);
          });
        }
      } catch (elError) {
        logWarn("[PPT] 要素処理エラー:", elError.message);
      }
      
      return extractedText;
    }

    slides.forEach((slide, index) => {
      logTrace("[PPT] スライド処理中:", index + 1, "/", slides.length);
      text += `\n【スライド ${index + 1}】\n`;

      // ページ要素をすべて走査
      slide.pageElements.forEach(el => {
        const extracted = extractTextFromElement(el);
        if (extracted) {
          text += extracted + "\n";
        }
      });
    });

    logTrace("[PPT] テキスト抽出完了 - 抽出文字数:", text.length);

    // ステップ4: 一時ファイルを削除
    logTrace("[PPT] 一時ファイル削除開始 - fileId:", convertedFile.id);
    DriveApp.getFileById(convertedFile.id).setTrashed(true);
    logTrace("[PPT] 一時ファイル削除完了");

    if (text && text.trim().length > 0) {
      logTrace("[PPT] PowerPointテキスト抽出成功 - fileName:", fileName, "文字数:", text.length);
      logTrace("[PPT] テキストプレビュー:", text.substring(0, 200));
      return text;
    }

    logWarn("[PPT] PowerPointファイルからテキストを抽出できませんでした - fileName:", fileName, "抽出文字数:", text ? text.length : 0);
    return "";

  } catch (error) {
    logError("[PPT] PowerPoint抽出エラー - fileName:", fileName, "error:", error.message, "stack:", error.stack);
    return "";
  }
}

/**
 * Excelファイルからテキストを抽出
 * Google Sheetsに変換してテキストを取得
 */
function extractTextFromExcel(fileId, fileName) {
  try {
    logTrace("[EXCEL] Excelテキスト抽出開始 - fileId:", fileId, "fileName:", fileName);

    // ステップ1: ファイルBlobを取得
    logTrace("[EXCEL] ファイルBlob取得開始");
    const file = DriveApp.getFileById(fileId);
    const fileBlob = file.getBlob();
    logTrace("[EXCEL] ファイルBlob取得完了 - contentType:", fileBlob.getContentType(), "size:", fileBlob.getBytes().length);

    // ステップ2: ExcelをGoogle Sheetsに変換
    logTrace("[EXCEL] Google Sheetsへの変換開始");
    const resource = {
      title: "temp_excel_" + fileName,
      mimeType: MimeType.GOOGLE_SHEETS
    };

    const convertedFile = Drive.Files.insert(resource, fileBlob, {
      convert: true
    });
    logTrace("[EXCEL] Google Sheetsへの変換完了 - convertedFileId:", convertedFile.id, "convertedMimeType:", convertedFile.mimeType);

    // ステップ3: 変換されたスプレッドシートからテキストを抽出
    logTrace("[EXCEL] スプレッドシートからテキスト抽出開始 - spreadsheetId:", convertedFile.id);
    const spreadsheet = SpreadsheetApp.openById(convertedFile.id);
    
    let text = "";
    const sheets = spreadsheet.getSheets();
    logTrace("[EXCEL] シート数:", sheets.length);

    // 全シートのテキストを取得
    for (const sheet of sheets) {
      const sheetName = sheet.getName();
      logTrace("[EXCEL] シート処理中:", sheetName);
      text += "\n【シート: " + sheetName + "】\n";

      const data = sheet.getDataRange().getValues();
      logTrace("[EXCEL] シート '" + sheetName + "' の行数:", data.length);
      
      for (const row of data) {
        const rowText = row.filter(cell => cell !== null && cell !== "").join("\t");
        if (rowText) {
          text += rowText + "\n";
        }
      }
    }

    logTrace("[EXCEL] テキスト抽出完了 - 抽出文字数:", text.length);

    // ステップ4: 一時ファイルを削除
    logTrace("[EXCEL] 一時ファイル削除開始 - fileId:", convertedFile.id);
    DriveApp.getFileById(convertedFile.id).setTrashed(true);
    logTrace("[EXCEL] 一時ファイル削除完了");

    if (text && text.trim().length > 0) {
      logTrace("[EXCEL] Excelテキスト抽出成功 - fileName:", fileName, "文字数:", text.length);
      logTrace("[EXCEL] テキストプレビュー:", text.substring(0, 200));
      return text;
    }

    logWarn("[EXCEL] Excelファイルからテキストを抽出できませんでした - fileName:", fileName, "抽出文字数:", text ? text.length : 0);
    return "";

  } catch (error) {
    logError("[EXCEL] Excel抽出エラー - fileName:", fileName, "error:", error.message, "stack:", error.stack);
    return "";
  }
}

/**
 * PDFファイルからOCRを使用してテキストを抽出
 * Google Docsへの変換を試み、失敗した場合はVision APIを使用
 * @param {string} fileId - Google DriveのファイルID
 * @param {string} fileName - ファイル名
 * @returns {string} 抽出されたテキスト
 */
function extractTextFromPDFWithOCR(fileId, fileName) {
  if (!VISION_API_CONFIG.ENABLE_OCR) {
    logWarn("[OCR] OCRが無効化されています");
    return extractViaTempGoogleDoc_(fileId, fileName);
  }

  const apiKey = getVisionApiKey();
  if (!apiKey) {
    logError("[OCR] VISION_API_KEYが設定されていません");
    return extractViaTempGoogleDoc_(fileId, fileName);
  }

  try {
    logTrace("[OCR] PDF OCR開始:", fileName);

    // PDFファイルをBlobとして取得
    const fileBlob = DriveApp.getFileById(fileId).getBlob();
    const blobType = fileBlob.getContentType();

    // PDFをGoogleドキュメントに変換（画像抽出のため）
    const resource = {
      title: "temp_ocr_" + fileName,
      mimeType: MimeType.GOOGLE_DOCS
    };

    // Drive APIを使用してPDFをGoogleドキュメントに変換
    const convertedFile = Drive.Files.insert(resource, fileBlob, {
      convert: true
    });

    // 変換されたドキュメントからテキストを抽出
    const text = DocumentApp.openById(convertedFile.id).getBody().getText();

    // 一時ドキュメントを削除
    DriveApp.getFileById(convertedFile.id).setTrashed(true);

    if (text && text.trim().length > 0) {
      logTrace("[OCR] OCR完了:", fileName, "文字数:", text.length);
      return text;
    }

    // テキストが空の場合、Vision APIで直接OCRを試行
    logTrace("[OCR] 変換ドキュメントが空、Vision APIで直接OCR試行:", fileName);
    return extractTextFromPDFWithVisionAPI_(fileId, fileName);

  } catch (error) {
    logError("[OCR] PDF OCRエラー:", error);
    // エラー発生時は従来方法来試す
    try {
      return extractViaTempGoogleDoc_(fileId, fileName);
    } catch (fallbackError) {
      logError("[OCR] フォールバックも失敗:", fallbackError);
      return "";
    }
  }
}

/**
 * Vision APIを使用してPDFからテキストを抽出（フォールバック）
 * @private
 * @param {string} fileId - Google DriveのファイルID
 * @param {string} fileName - ファイル名
 * @returns {string} 抽出されたテキスト
 */
function extractTextFromPDFWithVisionAPI_(fileId, fileName) {
  const apiKey = getVisionApiKey();
  if (!apiKey) {
    logError("[OCR] Vision APIキーなし");
    return "";
  }

  try {
    // PDFをDriveから取得
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();

    // PDFからJPEG画像を抽出（1ページ目のみ対応）
    // Google Apps Scriptでは直接PDF→画像変換が困難なため
    // 代替案としてGoogleドキュメント経由での抽出を試みる
    const tempDoc = Drive.Files.insert(
      { title: "ocr_temp_" + fileName, mimeType: MimeType.GOOGLE_DOCS },
      blob,
      { convert: true }
    );

    const text = DocumentApp.openById(tempDoc.id).getBody().getText();
    DriveApp.getFileById(tempDoc.id).setTrashed(true);

    logTrace("[OCR] Vision API方式完了:", fileName, "文字数:", text.length);
    return text;

  } catch (error) {
    logError("[OCR] Vision API方式エラー:", error);
    return "";
  }
}

/**
 * WordファイルをGoogleドキュメントに変換してテキストを抽出
 * Drive APIのconvertオプションを使用
 * @param {string} fileId - Google DriveのファイルID
 * @param {string} fileName - ファイル名
 * @returns {string} 抽出されたテキスト
 */
function extractTextFromWord(fileId, fileName) {
  try {
    logTrace("[WORD] Wordテキスト抽出開始 - fileId:", fileId, "fileName:", fileName);

    // ステップ1: ファイルBlobを取得
    logTrace("[WORD] ファイルBlob取得開始");
    const file = DriveApp.getFileById(fileId);
    const fileBlob = file.getBlob();
    logTrace("[WORD] ファイルBlob取得完了 - contentType:", fileBlob.getContentType(), "size:", fileBlob.getBytes().length);

    // ステップ2: WordをGoogleドキュメントに変換
    logTrace("[WORD] Googleドキュメントへの変換開始");
    const resource = {
      title: "temp_word_" + fileName,
      mimeType: MimeType.GOOGLE_DOCS
    };

    logTrace("[WORD] Drive.Files.insert開始 - resource:", JSON.stringify(resource));
    const convertedFile = Drive.Files.insert(resource, fileBlob, {
      convert: true
    });
    logTrace("[WORD] Googleドキュメントへの変換完了 - convertedFileId:", convertedFile.id, "convertedMimeType:", convertedFile.mimeType);

    // ステップ3: 変換されたドキュメントからテキストを抽出
    logTrace("[WORD] ドキュメントからテキスト抽出開始 - documentId:", convertedFile.id);
    const doc = DocumentApp.openById(convertedFile.id);
    let text = "";

    // 本文のテキストを取得
    const bodyText = doc.getBody().getText();
    text += bodyText;
    logTrace("[WORD] 本文抽出完了 - 文字数:", bodyText ? bodyText.length : 0);

    // ヘッダーを取得（getHeaders() ではなく getHeader() を使用）
    const header = doc.getHeader();
    logTrace("[WORD] ヘッダー存在:", header !== null);
    if (header) {
      const headerText = header.getText();
      if (headerText && headerText.trim().length > 0) {
        text += "\n【ヘッダー】\n" + headerText;
        logTrace("[WORD] ヘッダー 文字数:", headerText.length);
      }
    }

    // フッターを取得（getFooters() ではなく getFooter() を使用）
    const footer = doc.getFooter();
    logTrace("[WORD] フッター存在:", footer !== null);
    if (footer) {
      const footerText = footer.getText();
      if (footerText && footerText.trim().length > 0) {
        text += "\n【フッター】\n" + footerText;
        logTrace("[WORD] フッター 文字数:", footerText.length);
      }
    }

    // ステップ4: 一時ファイルを削除
    logTrace("[WORD] 一時ファイル削除開始 - fileId:", convertedFile.id);
    DriveApp.getFileById(convertedFile.id).setTrashed(true);
    logTrace("[WORD] 一時ファイル削除完了");

    if (text && text.trim().length > 0) {
      logTrace("[WORD] Wordテキスト抽出成功 - fileName:", fileName, "文字数:", text.length);
      logTrace("[WORD] テキストプレビュー:", text.substring(0, 200));
      return text;
    }

    logWarn("[WORD] Wordファイルからテキストを抽出できませんでした - fileName:", fileName, "抽出文字数:", text ? text.length : 0);
    return "";

  } catch (error) {
    logError("[WORD] Word抽出エラー - fileName:", fileName, "error:", error.message, "stack:", error.stack);
    // 詳細なエラー情報を出力
    if (error.name) {
      logError("[WORD] エラー名:", error.name);
    }
    if (error.description) {
      logError("[WORD] エラー詳細:", error.description);
    }
    // 原因特定の試み
    logError("[WORD] 例外タイプ:", Object.prototype.toString.call(error));
    
    // フォールバック: 古い方法で試す
    logTrace("[WORD] フォールバック方法実行 - fileName:", fileName);
    try {
      const fallbackResult = extractViaTempGoogleDoc_(fileId, fileName);
      logTrace("[WORD] フォールバック結果 - fileName:", fileName, "文字数:", fallbackResult ? fallbackResult.length : 0);
      return fallbackResult;
    } catch (fallbackError) {
      logError("[WORD] フォールバックも失敗 - fileName:", fileName, "error:", fallbackError.message);
      return "";
    }
  }
}

/**
 * Googleドキュメント経由でテキストを抽出（他の方法で失敗した場合のフォールバック）
 * @param {string} fileId - Google DriveのファイルID
 * @param {string} name - ファイル名
 * @returns {string} 抽出されたテキスト
 */
function extractViaTempGoogleDoc_(fileId, name) {
  try {
    const blob = DriveApp.getFileById(fileId).getBlob();
    const tempFile = DriveApp.createFile(blob).setName("temp_" + name);
    const tempDoc = DocumentApp.openById(tempFile.getId());
    const text = tempDoc.getBody().getText();
    DriveApp.getFileById(tempFile.getId()).setTrashed(true);
    return text;
  } catch (error) {
    logError(`テキスト抽出エラー (${name}):`, error);
    return "";
  }
}

// ================================
//  9. チャンク分割関数群
// ================================

/**
 * 【新機能】セマンティックチャンク分割のメイン関数
 * 従来の文字数ベース分割を意味的な境界で強化
 */
function splitTextIntoChunks(text) {
  if (!text || text.trim().length === 0) {
    return [];
  }

  // 設定の取得
  const config = CHUNK_CONFIG;

  // ステップ1: テキストの前処理
  const normalizedText = normalizeTextForChunking(text);

  // ステップ2: 構造解析（見出し、リスト、段落を検出）
  const structure = analyzeTextStructure(normalizedText);

  // ステップ3: セマンティック境界で分割
  let chunks;
  if (config.USE_SEMANTIC_SPLIT) {
    chunks = semanticSplit(normalizedText, structure, config);
  } else {
    chunks = basicSplit(normalizedText, config);
  }

  // ステップ4: チャンクの後処理
  const processedChunks = postProcessChunks(chunks, config);

  // ステップ5: メタデータ付きで返す（内部処理用）
  return processedChunks.map(c => c.text);
}

/**
 * テキストの正規化（前処理）を行います。
 * 改行コードの統一、空白の正規化、連続改行の整理を行います。
 * 
 * @param {string} text - 正規化対象のテキスト
 * @returns {string} 正規化済みテキスト
 */
function normalizeTextForChunking(text) {
  // 改行コードの統一
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 連続する空白の正規化
  normalized = normalized.replace(/[ \t]+/g, ' ');

  // 連続する改行の整理（2つ以上を2つに）
  normalized = normalized.replace(/\n{3,}/g, '\n\n');

  return normalized;
}

/**
 * テキストの構造を解析し、見出し、リスト、段落を検出して情報を返します。
 * Markdown形式の見出しや日本語見出し、リスト項目を認識します。
 * 
 * @param {string} text - 解析対象のテキスト
 * @returns {Object} 構造情報オブジェクト（lines, sections, headers, listsを含む）
 * @property {Array} lines - 各行の情報（type, headerLevel, isListItem等）
 * @property {Array} sections - セクション情報の配列
 * @property {Array} headers - 見出し情報の配列
 * @property {Array} lists - リスト項目情報の配列
 */
function analyzeTextStructure(text) {
  const lines = text.split('\n');
  const structure = {
    lines: [],
    sections: [],
    headers: [],
    lists: []
  };

  // 行ごとに解析
  let currentSection = { level: 0, title: '', startLine: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const lineInfo = {
      text: line,
      trimmed: trimmed,
      index: i,
      type: 'paragraph', // paragraph, header, list, empty
      headerLevel: 0,
      isListItem: false,
      sectionId: structure.sections.length
    };

    // 見出しの検出
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      // Markdown見出し
      lineInfo.type = 'header';
      lineInfo.headerLevel = headerMatch[1].length;
      lineInfo.headerText = headerMatch[2];
      structure.headers.push({ line: i, level: lineInfo.headerLevel, text: headerMatch[2] });

      // セクション更新
      currentSection = { level: lineInfo.headerLevel, title: headerMatch[2], startLine: i };
      structure.sections.push(currentSection);
    } else if (trimmed.match(/^(\d+\.|\-|•|\*|\◦)\s+/)) {
      // リスト項目
      lineInfo.type = 'list';
      lineInfo.isListItem = true;
      structure.lists.push({ line: i, text: trimmed });
    } else if (trimmed.match(/^[A-Z][A-Z\s]{2,}：?$/) || trimmed.match(/^[０-９].*：$/)) {
      // 日本語見出し（可能性があるもの）
      lineInfo.type = 'header';
      lineInfo.headerLevel = 2;
      structure.headers.push({ line: i, level: 2, text: trimmed });
    } else if (trimmed === '') {
      lineInfo.type = 'empty';
    }

    structure.lines.push(lineInfo);
  }

  return structure;
}

/**
 * セマンティック分割を行います。
 * 意味的な境界を考慮してチャンクを生成し、テキストを意味的に区切ります。
 * 
 * @param {string} text - 分割対象のテキスト
 * @param {Object} structure - analyzeTextStructureで生成された構造情報
 * @param {Object} config - チャンク設定オブジェクト
 * @returns {Array} チャンクオブジェクトの配列
 */
function semanticSplit(text, structure, config) {
  const chunks = [];
  let currentChunk = {
    text: '',
    lines: [],
    importance: 0,
    sectionId: 0
  };

  const lines = structure.lines;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 空行はスキップ（ただしチャンク区切りとして扱う場合あり）
    if (line.type === 'empty') {
      continue;
    }

    // 新しいチャンク開始の判断
    const shouldStartNewChunk = shouldStartNewChunkSemantic(
      currentChunk, line, config, structure
    );

    if (shouldStartNewChunk) {
      // 現在のチャンクを保存
      if (currentChunk.text.trim().length > 0) {
        chunks.push(currentChunk);
      }

      // オーバーラップ処理
      let overlapText = '';
      if (config.CHUNK_OVERLAP > 0 && chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        overlapText = lastChunk.text.slice(-config.CHUNK_OVERLAP);
      }

      // 新しいチャンク開始
      currentChunk = {
        text: overlapText + line.text,
        lines: [line],
        importance: calculateLineImportance(line, config),
        sectionId: line.sectionId
      };
    } else {
      // 現在のチャンクに追加
      currentChunk.text += '\n' + line.text;
      currentChunk.lines.push(line);
      currentChunk.importance = Math.max(
        currentChunk.importance,
        calculateLineImportance(line, config)
      );
    }
  }

  // 最後のチャンクを追加
  if (currentChunk.text.trim().length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * 新しいチャンクを開始すべきかを判断します（セマンティック）。
 * 見出し、サイズ超過、文境界、セクション変更などの条件をチェックします。
 * 
 * @param {Object} currentChunk - 現在のチャンクオブジェクト
 * @param {Object} nextLine - 次の行情報
 * @param {Object} config - チャンク設定オブジェクト
 * @param {Object} structure - テキスト構造情報
 * @returns {boolean} 新しいチャンクを開始する場合はtrue
 */
function shouldStartNewChunkSemantic(currentChunk, nextLine, config, structure) {
  const MIN_SIZE = config.MIN_CHUNK_SIZE || 200;
  const MAX_SIZE = config.MAX_CHUNK_SIZE || 1500;

  const currentLength = currentChunk.text.length;
  const nextLineLength = nextLine.text.length;

  // 見出し всегда 新しいチャンクを開始
  if (config.PRIORITIZE_HEADERS && nextLine.type === 'header') {
    // ただし、現在のチャンクが見出しのみで空の場合は継続
    if (currentLength > MIN_SIZE) {
      return true;
    }
  }

  // サイズ超過の場合は必ず分割
  if (currentLength + nextLineLength > MAX_SIZE) {
    return true;
  }

  // 文境界での分割（センテンスアウェア）
  if (config.SENTENCE_AWARE && nextLine.type === 'paragraph') {
    // 現在のチャンクが最小サイズ以上の場合
    if (currentLength >= MIN_SIZE) {
      // 文の終わりで分割
      const lastChar = currentChunk.text.trim().slice(-1);
      if (['。', '！', '？', '.', '!', '?'].includes(lastChar)) {
        return true;
      }
    }
  }

  // リスト項目が長時間続いている場合は分割
  if (config.CONTEXT_PRESERVATION && nextLine.isListItem) {
    const listCount = currentChunk.lines.filter(l => l.isListItem).length;
    if (listCount >= 10 && currentLength > MIN_SIZE) {
      return true;
    }
  }

  // 新しいセクションが始まった場合
  if (config.CONTEXT_PRESERVATION && nextLine.sectionId !== currentChunk.sectionId) {
    if (currentLength >= MIN_SIZE) {
      return true;
    }
  }

  return false;
}

/**
 * 行の重要度を計算します。
 * 見出しやリスト項目に対してブースト係数を適用します。
 * 
 * @param {Object} line - 行情報オブジェクト
 * @param {Object} config - チャンク設定オブジェクト
 * @returns {number} 重要度スコア（1.0以上が基本）
 */
function calculateLineImportance(line, config) {
  let importance = 1.0;

  if (config.BOOST_HEADERS && line.type === 'header') {
    importance *= (config.HEADER_BOOST_FACTOR || 2.0);
  }

  if (config.BOOST_LISTS && line.isListItem) {
    importance *= (config.LIST_BOOST_FACTOR || 1.5);
  }

  return importance;
}

/**
 * チャンクの後処理を行います。
 * 小チャンクのマージ、長チャンクの分割、重複チャンクの削除を順番に実行します。
 * 
 * @param {Array} chunks - チャンクオブジェクトの配列
 * @param {Object} config - チャンク設定オブジェクト
 * @returns {Array} 処理済みチャンクの配列
 */
function postProcessChunks(chunks, config) {
  let processed = [...chunks];

  // 小さいチャンクのマージ
  if (config.MERGE_SMALL_CHUNKS) {
    processed = mergeSmallChunks(processed, config);
  }

  // 長いチャンクの分割
  if (config.SPLIT_LONG_CHUNKS) {
    processed = splitLongChunks(processed, config);
  }

  // 重複チャンクの削除
  if (config.DEDUPLICATE_CHUNKS) {
    processed = deduplicateChunks(processed);
  }

  return processed;
}

/**
 * 小さいチャンクを前のチャンクにマージします。
 * 設定された閾値以下のチャンクは前のチャンクと結合します。
 * 
 * @param {Array} chunks - チャンクオブジェクトの配列
 * @param {Object} config - チャンク設定オブジェクト
 * @returns {Array} マージ済みチャンクの配列
 */
function mergeSmallChunks(chunks, config) {
  const MIN_SIZE = config.MIN_CHUNK_SIZE || 200;
  const MERGE_TARGET_SIZE = 500; // これ以下のチャンクはマージ対象

  const merged = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // 最初のチャンクはそのまま追加
    if (merged.length === 0) {
      merged.push(chunk);
      continue;
    }

    // 小さいチャンクは前のチャンクにマージ
    if (chunk.text.length < MERGE_TARGET_SIZE && merged.length > 0) {
      const lastChunk = merged[merged.length - 1];
      lastChunk.text += '\n' + chunk.text;
      lastChunk.lines.push(...chunk.lines);
      lastChunk.importance = Math.max(lastChunk.importance, chunk.importance);
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

/**
 * 長いチャンクを意味的な境界で分割します。
 * 改行や空白を区切りとして、最小チャンクサイズ以上にならないように分割します。
 * 
 * @param {Array} chunks - チャンクオブジェクトの配列
 * @param {Object} config - チャンク設定オブジェクト
 * @returns {Array} 分割済みチャンクの配列
 */
function splitLongChunks(chunks, config) {
  const MAX_SIZE = config.MAX_CHUNK_SIZE || 1500;
  const CHUNK_SIZE = config.CHUNK_SIZE || 1000;
  const OVERLAP = config.CHUNK_OVERLAP || 100;

  const split = [];

  for (const chunk of chunks) {
    if (chunk.text.length <= MAX_SIZE) {
      split.push(chunk);
      continue;
    }

    // 長いチャンクを分割
    const lines = chunk.text.split('\n');
    let currentText = '';
    let currentLines = [];

    for (const line of lines) {
      if (currentText.length + line.length > CHUNK_SIZE && currentText.length > 0) {
        split.push({
          text: currentText,
          lines: currentLines,
          importance: chunk.importance,
          sectionId: chunk.sectionId
        });

        // オーバーラップ
        const overlapText = currentText.slice(-OVERLAP);
        currentText = overlapText + '\n' + line;
        currentLines = [line];
      } else {
        currentText += (currentText ? '\n' : '') + line;
        currentLines.push(line);
      }
    }

    if (currentText.trim().length > 0) {
      split.push({
        text: currentText,
        lines: currentLines,
        importance: chunk.importance,
        sectionId: chunk.sectionId
      });
    }
  }

  return split;
}

/**
 * 重複しているチャンクを削除します。
 * チャンクのフィンガープリント（最初と最後の部分）を使用して重複を判定します。
 * 
 * @param {Array} chunks - チャンクオブジェクトの配列
 * @returns {Array} 重複削除済みチャンクの配列
 */
function deduplicateChunks(chunks) {
  const seen = new Set();
  const unique = [];

  for (const chunk of chunks) {
    // チャンクのフィンガープリント（最初の100文字 + 最後の50文字）
    const fingerprint = chunk.text.substring(0, 100).trim() + '|' +
      chunk.text.slice(-50).trim();

    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      unique.push(chunk);
    }
  }

  return unique;
}

/**
 * 基本的なチャンク分割を行います（後方互換性のため）。
 * 段落単位でチャンクサイズに達するまでチャンクを生成します。
 * 
 * @param {string} text - 分割対象のテキスト
 * @param {Object} config - チャンク設定オブジェクト
 * @returns {Array} チャンクオブジェクトの配列
 */
function basicSplit(text, config) {
  const CHUNK_SIZE = config.CHUNK_SIZE || 1000;
  const CHUNK_OVERLAP = config.CHUNK_OVERLAP || 100;
  const MIN_CHUNK_SIZE = config.MIN_CHUNK_SIZE || 200;
  const MAX_CHUNK_SIZE = config.MAX_CHUNK_SIZE || 1500;

  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) continue;

    if (currentChunk.length + trimmedParagraph.length <= CHUNK_SIZE) {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmedParagraph;
    } else {
      if (currentChunk) {
        chunks.push({ text: currentChunk, lines: [], importance: 1, sectionId: 0 });
      }

      if (chunks.length > 0 && CHUNK_OVERLAP > 0) {
        const lastChunk = chunks[chunks.length - 1];
        const overlapText = lastChunk.text.slice(-CHUNK_OVERLAP);
        currentChunk = overlapText + trimmedParagraph;
      } else {
        currentChunk = trimmedParagraph;
      }
    }
  }

  if (currentChunk) {
    chunks.push({ text: currentChunk, lines: [], importance: 1, sectionId: 0 });
  }

  // サイズ調整
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.text.length > MAX_CHUNK_SIZE) {
      const subChunks = splitLongChunkOnly(chunk.text, config);
      for (const sub of subChunks) {
        finalChunks.push({ text: sub, lines: [], importance: 1, sectionId: 0 });
      }
    } else if (chunk.text.length < MIN_CHUNK_SIZE && finalChunks.length > 0) {
      finalChunks[finalChunks.length - 1].text += '\n' + chunk.text;
    } else {
      finalChunks.push(chunk);
    }
  }

  return finalChunks;
}

/**
 * 長いチャンクのみを分割します（基本版）。
 * 設定されたチャンクサイズを超過したテキストを分割します。
 * 
 * @param {string} text - 分割対象のテキスト
 * @param {Object} config - チャンク設定オブジェクト
 * @returns {Array} 分割されたテキスト配列
 */
function splitLongChunkOnly(text, config) {
  const CHUNK_SIZE = config.CHUNK_SIZE || 1000;
  const CHUNK_OVERLAP = config.CHUNK_OVERLAP || 100;
  const MIN_CHUNK_SIZE = config.MIN_CHUNK_SIZE || 200;

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_SIZE;
    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      const lastSpace = text.lastIndexOf(' ', end);
      const breakPoint = Math.max(lastNewline, lastSpace);
      if (breakPoint > start + MIN_CHUNK_SIZE) {
        end = breakPoint;
      }
    }

    const chunk = text.slice(start, end);
    chunks.push(chunk);
    start = end - CHUNK_OVERLAP;
    if (start < 0) start = 0;
  }

  return chunks;
}

// 後方互換性のための旧関数
function splitLargeChunk(text) {
  return splitLongChunkOnly(text, CHUNK_CONFIG);
}

/**
 * チャンクのメタデータを作成します。
 * ファイルID、ファイル名、チャンクインデックス等信息をオブジェクト形式で返します。
 * 
 * @param {string} chunk - チャンクテキスト
 * @param {string} fileId - ファイルID
 * @param {string} fileName - ファイル名
 * @param {number} chunkIndex - チャンクインデックス（0ベース）
 * @param {number} totalChunks - 総チャンク数
 * @returns {Object} メタデータオブジェクト
 * @property {string} text - チャンクテキスト
 * @property {string} fileId - ファイルID
 * @property {string} fileName - ファイル名
 * @property {number} chunkIndex - チャンクインデックス
 * @property {number} totalChunks - 総チャンク数
 * @property {number} charCount - 文字数
 * @property {string} preview - プレビューテキスト
 */
function createChunkMetadata(chunk, fileId, fileName, chunkIndex, totalChunks) {
  return {
    text: chunk,
    fileId: fileId,
    fileName: fileName,
    chunkIndex: chunkIndex,
    totalChunks: totalChunks,
    charCount: chunk.length,
    preview: chunk.substring(0, 100) + (chunk.length > 100 ? '...' : '')
  };
}

// ================================
//  10. Embedding 関数
// ================================

/**
 * OpenAI Embedding APIを使用してテキストのEmbeddingを取得
 * @param {string} text - エンベディング化するテキスト
 * @returns {Array<number>|null} エンベディングベクトル
 */
function getEmbedding(text) {
  try {
    const payload = {
      model: EMBEDDING_MODEL,
      input: text.substring(0, 8000)
    };

    const response = UrlFetchApp.fetch("https://api.openai.com/v1/embeddings", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENAI_API_KEY
      },
      payload: JSON.stringify(payload)
    });

    const json = JSON.parse(response.getContentText());
    return json.data[0].embedding;
  } catch (error) {
    logError("Embedding API エラー:", error);
    return null;
  }
}

/**
 * Embeddingをキャッシュから取得、またはAPIを呼び出して取得
 * @param {string} text - エンベディング化するテキスト
 * @returns {Array<number>|null} エンベディングベクトル
 */
function getEmbeddingWithCache(text) {
  try {
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text);
    const hashStr = Utilities.base64Encode(hash).substring(0, 20);
    const cacheKey = "emb_" + hashStr;

    // CacheService を使用（UserPropertiesの容量制限を避けるため）
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE] CacheServiceが利用できません、APIを直接呼び出します");
      return getEmbedding(text);
    }

    const cached = cache.get(cacheKey);
    if (cached) {
      logTrace("[CACHE] Embedding キャッシュヒット:", hashStr);
      return JSON.parse(cached);
    }

    logTrace("[CACHE] Embedding キャッシュミス、API 呼び出し:", hashStr);
    const embedding = getEmbedding(text);
    if (embedding) {
      // CacheServiceに保存（TTL: 6時間）
      cache.put(cacheKey, JSON.stringify(embedding), EMBEDDING_CACHE_TTL_SECONDS);
    }
    return embedding;
  } catch (error) {
    logError("[CACHE] Embedding キャッシング エラー:", error);
    // エラー発生時はフォールバックとしてAPIを直接呼び出す
    return getEmbedding(text);
  }
}

/**
 * Embeddingキャッシュをクリア（古いキャッシュを削除）
 */
function clearEmbeddingCache() {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[CACHE] CacheServiceが利用できません");
      return 0;
    }

    // スクリプトレベルキャッシュの全キーを取得する簡易的方法
    // CacheServiceはキーの一覧取得をサポートしていないため、
    // ここではエラーを出してクリアする…
    // 実際には新しいキーを付けて保存し、古いものはTTL切れを待つ
    logInfo("[CACHE] EmbeddingキャッシュはCacheServiceで管理されています");
    logInfo("[CACHE] キャッシュは6時間後に自動的に期限切れになります");
    return 0;
  } catch (error) {
    logError("[CACHE] Embeddingキャッシュクリアエラー:", error);
    return 0;
  }
}

// ================================
//  11. RAG シート管理
// ================================

/**
 * RAG用のスプレッドシートを取得
 * @returns {Sheet} RAGシートオブジェクト
 * @throws {Error} RAG_SHEET_IDが設定されていない場合
 */
function getRagSheet() {
  if (!INDEX_SHEET_ID) {
    throw new Error("INDEX_SHEET_ID が設定されていません。Script Properties に設定してください。");
  }
  return SpreadsheetApp.openById(INDEX_SHEET_ID).getActiveSheet();
}

/**
 * RAGシートをリセットして初期化
 * 既存のデータを全て削除し、ヘッダーを再設定
 */
function resetAndInitializeRagSheet() {
  const sheet = getRagSheet();
  sheet.clear();
  // 拡張ヘッダー（メタデータ活用）
  sheet.appendRow(SHEET_HEADERS);
  console.log("[INIT] 拡張シート初期化完了:", SHEET_HEADERS);
}

// ================================
//  12. インデックス管理
// ================================

/**
 * ファイルマッピングをスクリプトプロパティに保存
 * @param {Object} mapping - ファイルIDと更新時間のマッピングオブジェクト
 */
function setFileMapping(mapping) {
  scriptProps.setProperty(FILE_MAPPING_KEY, JSON.stringify(mapping));
}

/**
 * 最終インデックス時刻を取得
 * @returns {Date|null} 最終インデックス時刻
 */
function getLastIndexTime() {
  const lastTime = scriptProps.getProperty(LAST_INDEX_KEY);
  return lastTime ? new Date(lastTime) : null;
}

/**
 * 最終インデックス時刻を保存
 * @param {Date} date - 設定する日付
 */
function setLastIndexTime(date) {
  scriptProps.setProperty(LAST_INDEX_KEY, date.toISOString());
}

/**
 * ファイルマッピングを取得
 * @returns {Object} ファイルIDと更新時間のマッピングオブジェクト
 */
function getFileMapping() {
  const mapping = scriptProps.getProperty(FILE_MAPPING_KEY);
  return mapping ? JSON.parse(mapping) : {};
}

// ================================
//  13. 検索機能（クエリ拡張→BM25→キーワード→ハイブリッド）
// ================================

/**
 * 辞書ベースクエリを拡張して検索精度を向上します。
 * 類義語・関連語を追加してより幅広い検索を実現します。
 * 設定で有効/無効を切り替えできます。
 * 
 * @param {string} originalQuery - 元のクエリ
 * @returns {Object} 拡張結果オブジェクト
 * @property {string} expanded - 拡張後のクエリ
 * @property {Array} expansions - 追加された拡張語の配列
 */
function expandQuery(originalQuery) {
  // UserPropertiesから設定を取得、ない場合は定数のデフォルト値を使用
  const searchParams = getSearchParams();

  // 全体のON/OFFまたは辞書ベースのON/OFFがオフの場合は拡張しない
  if (!searchParams.SEARCH_QUERY_EXPANSION_ENABLED || !searchParams.SEARCH_DICT_EXPANSION_ENABLED) {
    return { expanded: originalQuery, expansions: [] };
  }

  logTrace("[QUERY:EXPAND:DICT] 辞書ベース拡張開始:", originalQuery);

  const expansions = [];
  const queryLower = originalQuery.toLowerCase();

  // パラメータを取得
  const useSynonyms = userProps.getProperty("QUERY_EXPANSION_USE_SYNONYMS") !== 'false';
  const useRelated = userProps.getProperty("QUERY_EXPANSION_USE_RELATED") !== 'false';
  const maxWords = parseInt(userProps.getProperty("QUERY_EXPANSION_MAX_WORDS")) || 5;

  // 1. 同義語の追加
  if (useSynonyms) {
    for (const [baseWord, synonyms] of Object.entries(SYNONYMS)) {
      if (queryLower.includes(baseWord)) {
        expansions.push(...synonyms);
        logTrace("[QUERY:EXPAND:DICT] 同義語追加:", synonyms.join(", "));
      }
    }
  }

  // 2. 一般的な関連語展開
  if (useRelated) {
    for (const [keyword, related] of Object.entries(RELATED_WORDS)) {
      if (queryLower.includes(keyword)) {
        expansions.push(...related);
      }
    }
  }

  // 重複除去して制限数に収める
  const uniqueExpansions = [...new Set(expansions)].slice(0, maxWords);

  // 拡張クエリを生成
  const expandedQuery = uniqueExpansions.length > 0
    ? `${originalQuery} ${uniqueExpansions.join(" ")}`
    : originalQuery;

  logTrace("[QUERY:EXPAND:DICT] 辞書ベース拡張完了:", expandedQuery);

  return {
    expanded: expandedQuery,
    expansions: uniqueExpansions
  };
}

/**
 * テキストからキーワードを抽出します。
 * 日本語のstop wordsを除去し、必要なキーワードのみを抽出します。
 * 
 * @param {string} text - キーワードを抽出するテキスト
 * @returns {Array} 抽出されたキーワードの配列
 */
function extractKeywords(text) {
  const cleaned = text.trim().toLowerCase();

  let keywords = cleaned
    .split(/[\s,.!?。、！？「」『』（）()\[\]　]+/)
    .filter(word => !/^[ぁ-んァ-ン]$/.test(word))
    .filter(word => word.length > 1)
    .filter(word => !STOP_WORDS.includes(word))
    .slice(0, 10);

  keywords = [...new Set(keywords)];
  return keywords;
}

/**
 * BM25スコアを計算します。
 * 文書とクエリの関連性をTF-IDFベースで評価します。
 * 
 * @param {string} docText - 文書テキスト
 * @param {Array} queryKeywords - クエリキーワードの配列
 * @param {number} avgDocLen - 平均文書長
 * @param {number} docLen - 文書長
 * @param {Object} idfScores - IDFスコアのオブジェクト
 * @returns {number} BM25スコア
 */
function calculateBM25Score(docText, queryKeywords, avgDocLen, docLen, idfScores) {
  // UserPropertiesからBM25設定を取得
  const bm25K1 = parseFloat(userProps.getProperty("BM25_K1")) || 1.5;
  const bm25B = parseFloat(userProps.getProperty("BM25_B")) || 0.75;

  let score = 0;

  for (const keyword of queryKeywords) {
    if (!idfScores[keyword]) continue;

    const keywordLower = keyword.toLowerCase();
    const docLower = docText.toLowerCase();

    // 単語の出現回数をカウント
    const tf = (docLower.match(new RegExp(keywordLower, 'g')) || []).length;

    if (tf > 0) {
      // BM25のスコア計算式
      const idf = idfScores[keyword];
      const numerator = tf * (bm25K1 + 1);
      const denominator = tf + bm25K1 * (1 - bm25B + bm25B * docLen / avgDocLen);
      score += idf * numerator / denominator;
    }
  }

  return score;
}

/**
 * IDFスコアを事前計算します。
 * 全ドキュメントから逆文書頻度（IDF）を計算します。
 * 
 * @param {Sheet} sheet - RAGシートオブジェクト
 * @param {Array} keywords - キーワードの配列
 * @returns {Object} IDFスコアオブジェクト
 */
function computeIDFScores(sheet, keywords) {
  const data = sheet.getDataRange().getValues();
  const docCount = data.length - 1;

  const idfScores = {};
  const docFreq = {};

  // ヘッダー: FileId(0), FileName(1), MimeType(2), TextChunk(3), Embedding(4), ChunkIndex(5), UpdatedAt(6), CharCount(7), Preview(8), TotalChunks(9), Keywords(10)
  // 各キーワードがいくつの文書に出現するかカウント
  for (const keyword of keywords) {
    const keywordLower = keyword.toLowerCase();
    let df = 0;

    for (let i = 1; i < data.length; i++) {
      const chunk = (data[i][3] || "").toString().toLowerCase();
      if (chunk.includes(keywordLower)) {
        df++;
      }
    }

    // IDF計算: log((N - df + 0.5) / (df + 0.5))
    if (df > 0) {
      idfScores[keyword] = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    }
  }

  return idfScores;
}

/**
 * BM25検索を実行します。
 * TF-IDFベースの精密なキーワード検索を実装します。
 * 
 * @param {string} queryText - 検索クエリ
 * @param {number} topK - 取得する上位件数（デフォルト30）
 * @returns {Array} 検索結果の配列
 */
function searchByBM25(queryText, topK = 30) {
  logTrace("[BM25] BM25検索開始:", queryText.substring(0, 50));

  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      logTrace("[BM25] インデックスが空です");
      return [];
    }

    // 1. クエリからキーワードを抽出
    const keywords = extractKeywords(queryText);
    logTrace("[BM25] 抽出キーワード:", keywords);

    if (keywords.length === 0) {
      return [];
    }

    // 2. IDFスコアを計算
    const idfScores = computeIDFScores(sheet, keywords);
    logTrace("[BM25] IDFスコア計算完了:", Object.keys(idfScores).length, "件");

    // 3. 平均文書長を計算
    let totalLen = 0;
    for (let i = 1; i < data.length; i++) {
      totalLen += ((data[i][3] || "").toString().length);
    }
    const avgDocLen = totalLen / (data.length - 1);

    // 4. 各文書のBM25スコアを計算
    const results = [];
    const BM25_THRESHOLD = 0.1; // 最小スコア閾値

    // スキーマを使用してフィールドを取得
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = (getIndexField(row, 'TEXT_CHUNK') || "").toString();
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');
      const keywordsStored = getIndexField(row, 'KEYWORDS') || "";

      const docLen = chunk.length;
      const score = calculateBM25Score(chunk, keywords, avgDocLen, docLen, idfScores);

      if (score > BM25_THRESHOLD) {
        results.push({
          fileId,
          fileName,
          chunk,
          mimeType,
          score,
          chunkIndex,
          keywords: keywordsStored,
          source: 'bm25'
        });
      }
    }


    // スコア順にソート
    const sorted = results.sort((a, b) => b.score - a.score).slice(0, topK);

    logTrace("[BM25] 検索結果:", sorted.length, "件");
    sorted.forEach((r, i) => {
      logTrace(`  [${i + 1}] ${r.fileName} (BM25: ${r.score.toFixed(3)})`);
    });

    return sorted;

  } catch (error) {
    logError("[BM25] エラー:", error);
    return [];
  }
}

/**
 * 保存されたキーワードとクエリキーワードの類似度を計算します。
 * メタデータに保存されたキーワードを使用してスコアを算出します。
 * 
 * @param {string} storedKeywords - 保存されたキーワード（カンマ区切り）
 * @param {Array} queryKeywords - クエリキーワードの配列
 * @returns {number} キーワードスコア（0〜1）
 */
function calculateKeywordScoreWithMetadata(storedKeywords, queryKeywords) {
  if (!storedKeywords || !queryKeywords) return 0;

  const stored = storedKeywords.toLowerCase().split(",").map(k => k.trim()).filter(k => k);
  const query = queryKeywords.map(k => k.toLowerCase());

  let totalScore = 0;
  let matchCount = 0;

  for (const qKeyword of query) {
    for (const sKeyword of stored) {
      if (sKeyword.includes(qKeyword) || qKeyword.includes(sKeyword)) {
        totalScore += 1.0;
        matchCount++;
        break;
      }
    }
  }

  if (matchCount === 0) return 0;

  const score = (totalScore / query.length) * Math.min(matchCount / 2, 1);
  return Math.min(score, 1.0);
}

/**
 * チャンクとキーワードの関連性を計算します。
 * チャンクテキスト内のキーワードの出現に基づいてスコアを算出します。
 * 
 * @param {string} chunk - チャンクテキスト
 * @param {Array} keywords - キーワードの配列
 * @returns {number} キーワードスコア（0〜1）
 */
function calculateKeywordScore(chunk, keywords) {
  const lowerChunk = chunk.toLowerCase();
  let totalScore = 0;
  let matchCount = 0;

  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    if (lowerChunk.includes(lowerKeyword)) {
      totalScore += 1.0;
      matchCount++;
    }
  }

  if (matchCount === 0) return 0;

  const score = (totalScore / keywords.length) * Math.min(matchCount / 2, 1);
  return Math.min(score, 1.0);
}

/**
 * キーワードベースの検索を実行します。
 * 保存されたキーワードと照合して関連性をスコア化します。
 * 
 * @param {string} queryText - 検索クエリ
 * @param {number} topK - 取得する上位件数（デフォルト50）
 * @returns {Array} 検索結果の配列
 */
function searchByKeywords(queryText, topK = 50) {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return [];
    }

    const keywords = extractKeywords(queryText);

    if (keywords.length === 0) {
      return [];
    }

    const results = [];

    // スキーマを使用してフィールドを取得
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = getIndexField(row, 'TEXT_CHUNK');
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');
      const storedKeywords = getIndexField(row, 'KEYWORDS') || "";

      const keywordScore = calculateKeywordScoreWithMetadata(storedKeywords, keywords);

      if (keywordScore > 0) {
        results.push({
          fileId,
          fileName,
          chunk,
          mimeType,
          score: keywordScore,
          chunkIndex,
          source: 'keyword',
          keywords: storedKeywords
        });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

  } catch (error) {
    logError("[HYBRID] キーワード検索エラー:", error);
    return [];
  }
}

/**
 * ベクトル検索を実行します。
 * Embeddingを使用してクエリと関連するドキュメントを検索します。
 * 
 * @param {string} queryText - 検索クエリ
 * @param {number} topK - 取得する上位件数（デフォルト50）
 * @returns {Array} 検索結果の配列（類似度付き）
 */
function searchRelevantDocumentsVector(queryText, topK = 50) {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return [];
    }

    const queryEmbedding = getEmbeddingWithCache(queryText);
    if (!queryEmbedding) {
      return [];
    }

    const results = [];
    const SIMILARITY_THRESHOLD = 0.2;

    // スキーマを使用してフィールドを取得
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = getIndexField(row, 'TEXT_CHUNK');
      const embeddingJson = getIndexField(row, 'EMBEDDING');
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');
      const charCount = getIndexField(row, 'CHAR_COUNT');
      const totalChunks = getIndexField(row, 'TOTAL_CHUNKS');
      const keywords = getIndexField(row, 'KEYWORDS') || "";

      try {
        const embedding = JSON.parse(embeddingJson);
        const similarity = cosineSimilarity(queryEmbedding, embedding);

        if (similarity > SIMILARITY_THRESHOLD) {
          results.push({
            fileId,
            fileName,
            chunk,
            mimeType,
            similarity,
            chunkIndex,
            source: 'vector',
            charCount: charCount || chunk.length,
            totalChunks: totalChunks || 1,
            keywords: keywords
          });
        }
      } catch (e) {
        // エラーは無視
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

  } catch (error) {
    logError("[HYBRID] ベクトル検索エラー:", error);
    return [];
  }
}

/**
 * ベクトル検索結果とキーワード検索結果を統合します。
 * 重み付けを行って総合スコアを計算します。
 * 
 * @param {Array} vectorResults - ベクトル検索結果の配列
 * @param {Array} keywordResults - キーワード検索結果の配列
 * @param {Object} config - 設定オブジェクト（重みなど）
 * @returns {Array} 統合された結果の配列
 */
function combineResults(vectorResults, keywordResults, config) {
  const resultMap = new Map();

  const maxVectorScore = Math.max(...vectorResults.map(r => r.similarity), 1);
  for (const r of vectorResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    resultMap.set(key, {
      fileId: r.fileId,
      fileName: r.fileName,
      chunk: r.chunk,
      chunkIndex: r.chunkIndex,
      mimeType: r.mimeType, // mimeTypeを追加
      vectorScore: r.similarity / maxVectorScore,
      keywordScore: 0,
      combinedScore: 0
    });
  }

  const maxKeywordScore = Math.max(...keywordResults.map(r => r.score), 1);
  for (const r of keywordResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;

    if (resultMap.has(key)) {
      const existing = resultMap.get(key);
      existing.keywordScore = r.score / maxKeywordScore;
    } else {
      resultMap.set(key, {
        fileId: r.fileId,
        fileName: r.fileName,
        chunk: r.chunk,
        chunkIndex: r.chunkIndex,
        mimeType: r.mimeType, // mimeTypeを追加
        vectorScore: 0,
        keywordScore: r.score / maxKeywordScore,
        combinedScore: 0
      });
    }
  }


  for (const [key, result] of resultMap) {
    result.combinedScore =
      (result.vectorScore * config.VECTOR_WEIGHT) +
      (result.keywordScore * config.KEYWORD_WEIGHT);
  }

  return Array.from(resultMap.values());
}

/**
 * ハイブリッド検索を実行します。
 * ベクトル検索とキーワード検索を組み合わせた検索を行います。
 * 
 * @param {string} queryText - 検索クエリ
 * @param {Object} options - オプション設定オブジェクト
 * @returns {Array} 検索結果の配列
 */
function hybridSearch(queryText, options = {}) {
  // UserPropertiesからハイブリッド検索設定を取得
  const searchParams = getSearchParams();
  const config = {
    TOP_K_VECTOR: parseInt(userProps.getProperty("HYBRID_TOP_K_VECTOR")) || 50,
    TOP_K_FINAL: parseInt(userProps.getProperty("HYBRID_TOP_K_FINAL")) || 10,
    VECTOR_WEIGHT: parseFloat(userProps.getProperty("HYBRID_VECTOR_WEIGHT")) || 0.7,
    KEYWORD_WEIGHT: parseFloat(userProps.getProperty("HYBRID_KEYWORD_WEIGHT")) || 0.3,
    MIN_KEYWORD_SCORE: parseFloat(userProps.getProperty("HYBRID_MIN_KEYWORD_SCORE")) || 0.1,
    ...options
  };

  console.log("[HYBRID] 検索開始:", queryText.substring(0, 50));

  const vectorResults = searchRelevantDocumentsVector(queryText, config.TOP_K_VECTOR);
  const keywordResults = searchByKeywords(queryText, config.TOP_K_VECTOR);
  const combinedResults = combineResults(vectorResults, keywordResults, config);

  const finalResults = combinedResults
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, config.TOP_K_FINAL);

  return finalResults;
}

/**
 * ハイブリッド検索をコマンド形式で実行します。
 * 検索結果をChatBot用のフォーマットで返します。
 * 
 * @param {string} queryText - 検索クエリ
 * @returns {string} フォーマット済み検索結果文字列
 */
function searchHybridCommand(queryText) {
  try {
    const results = hybridSearch(queryText, {
      TOP_K_FINAL: 5
    });

    if (results.length === 0) {
      return "関連するドキュメントが見つかりませんでした。";
    }

    let response = "🔍 検索結果\n\n";
    results.forEach((r, i) => {
      response += `${i + 1}. ${r.fileName}\n`;
      response += `   スコア: ${(r.combinedScore * 100).toFixed(1)}%\n`;
      response += `   チャンク: ${r.chunk.substring(0, 50)}...\n\n`;
    });

    return response;
  } catch (error) {
    logError("[HYBRID] コマンドエラー:", error);
    return "検索中にエラーが発生しました。";
  }
}

function parseExpansionResponse(response) {
  if (!response || typeof response !== "string") {
    return { expansions: [] };
  }

  const lines = response.split(/\r?\n/);
  const expansions = [];

  for (let line of lines) {
    line = line.trim();

    // 空行は除外
    if (!line) continue;

    // 箇条書き記号・番号を除去
    line = line.replace(/^[-*・●○◆■\d\.\)\(]+\s*/, "");

    // 記号だけの行は除外
    if (/^[\W_]+$/.test(line)) continue;

    // 文章っぽい行は除外（句点・読点がある）
    if (/[。．、,.]/.test(line) && line.split(" ").length > 3) continue;

    // 助詞だけの行は除外
    if (/^[ぁ-んー]$/.test(line)) continue;

    // 英語のストップワード除外
    const stopwords = ["the", "a", "an", "of", "in", "on", "to", "for"];
    if (stopwords.includes(line.toLowerCase())) continue;

    // 2文字未満は除外
    if (line.length < 2) continue;

    expansions.push(line);
  }

  return { expansions: [...new Set(expansions)] };
}

// ================================
//  14. リランキング機能
// ================================

/**
 * LLMを使用して検索結果をリランキング
 * 初検索結果Top-Nを再評価して関連性が高い順にソート
 */
/**
 * LLMを使用して検索結果をリランキング
 * 初検索結果Top-Nを再評価して関連性が高い順にソート
 */
function rerankResults(query, initialResults) {
  const searchParams = getSearchParams();
  const rerankEnabled = searchParams.SEARCH_RERANK_ENABLED;

  const rerankInitialTopK = parseInt(userProps.getProperty("RERANK_INITIAL_TOP_K")) || 20;
  const rerankFinalTopK = parseInt(userProps.getProperty("RERANK_FINAL_TOP_K")) || 5;
  const rerankModel = userProps.getProperty("RERANK_MODEL") || GPT_MODEL;

  if (!rerankEnabled || initialResults.length <= rerankFinalTopK) {
    logTrace("[RERANK] リランキングスキップ（候補数が少ない）");
    return initialResults;
  }

  logTrace("[RERANK] リランキング開始 - 候補数:", initialResults.length, "- 使用モデル:", rerankModel);

  try {
    // 上位N件のみリランキング対象
    const candidates = initialResults.slice(0, rerankInitialTopK);

    // LLMに順位付けを依頼するプロンプトを生成
    const rankingPrompt = buildRerankPrompt(query, candidates);

    const messages = [
      {
        role: "system",
        content: "あなたは検索結果の関連性を評価する専門家です。与えられた検索クエリとドキュメントを比較し、関連性スコアを0から10の整数で評価してください。"
      },
      { role: "user", content: rankingPrompt }
    ];

    logTrace("[RERANK] LLMに順位付けを依頼中... モデル:", rerankModel);
    // パラメータで指定されたモデルでリランキングAPIを呼び出す
    const response = callChatGPTRerank(messages, 0.3, rerankModel);

    // レスポンスからスコアをパース
    const scores = parseRerankResponse(response, candidates.length);

    if (Object.keys(scores).length === 0) {
      logTrace("[RERANK] スコアパース失敗、元の順序を維持");
      return initialResults;
    }

    // スコアを結果に適用して再ソート
    const reranked = candidates.map((doc, i) => ({
        ...doc,
        rerankScore: scores[i + 1] || 0
      })).sort((a, b) => b.rerankScore - a.rerankScore)
      .slice(0, rerankFinalTopK);

    logTrace("[RERANK] リランキング完了");
    reranked.forEach((r, i) => {
      logTrace(`  [${i + 1}] ${r.fileName} (リランキングスコア: ${r.rerankScore})`);
    });

    return reranked;

  } catch (error) {
    logError("[RERANK] エラー:", error);
    return initialResults;
  }
}

/**
 * リランキング用プロンプトを生成
 * ScriptPropertiesに保存されたテンプレートを使用
 */
function buildRerankPrompt(query, candidates) {
  // ドキュメント一覧を文字列に変換
  const documentsText = candidates.map((doc, i) => {
    return `[${i + 1}] ${doc.fileName}${doc.chunkIndex !== undefined ? ` (チャンク ${doc.chunkIndex})` : ''}
---
${(doc.chunk || "").substring(0, 300)}...`;
  }).join('\n');

  // プロンプトテンプレートを使用（ScriptPropertiesから取得）
  const prompt = buildPromptFromTemplate('PROMPT_RERANK', {
    query: query,
    documents: documentsText
  });

  logTrace('[RERANK] プロンプト生成完了（テンプレート使用）');

  return prompt;
}

/**
 * LLMのレスポンスからリランキングスコアをパースします。
 * レスポンス形式の「番号: スコア」形式からオブジェクトを生成します。
 * 
 * @param {string} response - LLMからのレスポンス
 * @param {number} maxDocs - 最大ドキュメント数
 * @returns {Object} スコアオブジェクト
 */
function parseRerankResponse(response, maxDocs) {
  const scores = {};
  const lines = response.split('\n');

  for (const line of lines) {
    const match = line.match(/^(\d+):\s*(\d+)/);
    if (match) {
      const docNum = parseInt(match[1]);
      const score = parseInt(match[2]);
      if (docNum >= 1 && docNum <= maxDocs && score >= 0 && score <= 10) {
        scores[docNum] = score;
      }
    }
  }

  return scores;
}

// ================================
//  15. 拡張ハイブリッド検索
// ================================

/**
 * 拡張ハイブリッド検索を実行します。
 * ベクトル検索、キーワード検索、BM25検索の3つを組み合わせた検索を行います。
 * 
 * @param {string} queryText - 検索クエリ
 * @param {Object} options - オプション設定オブジェクト
 * @returns {Array} 検索結果の配列
 */
function enhancedHybridSearch(queryText, options = {}) {
  // UserPropertiesからハイブリッド検索設定を取得
  const config = {
    TOP_K_VECTOR: parseInt(userProps.getProperty("HYBRID_TOP_K_VECTOR")) || 50,
    TOP_K_FINAL: parseInt(userProps.getProperty("HYBRID_TOP_K_FINAL")) || 10,
    ...options
  };
  
  const TOP_K = config.TOP_K_FINAL || 20;
  const keywordEnabled = options.keywordEnabled !== false;  // デフォルトtrue
  const bm25Enabled = options.bm25Enabled !== false;        // デフォルトtrue

  logTrace("[ENHANCED:HYBRID] 検索開始:", queryText.substring(0, 50));
  logTrace("[ENHANCED:HYBRID] キーワード検索:", keywordEnabled ? "有効" : "無効");
  logTrace("[ENHANCED:HYBRID] BM25検索:", bm25Enabled ? "有効" : "無効");

  // 重み設定
  const WEIGHTS = {
    VECTOR: 0.4,     // ベクトル検索の重み
    KEYWORD: 0.3,    // キーワード検索の重み
    BM25: 0.3        // BM25検索の重み
  };

  // 1. ベクトル検索（常に実行）
  logTrace("[ENHANCED:HYBRID] ベクトル検索を実行中...");
  const vectorResults = searchRelevantDocumentsVector(queryText, config.TOP_K_VECTOR);
  logTrace("[ENHANCED:HYBRID] ベクトル検索結果:", vectorResults.length, "件");

  // 2. キーワード検索（ON/OFF可能）
  let keywordResults = [];
  if (keywordEnabled) {
    logTrace("[ENHANCED:HYBRID] キーワード検索を実行中...");
    keywordResults = searchByKeywords(queryText, config.TOP_K_VECTOR);
    logTrace("[ENHANCED:HYBRID] キーワード検索結果:", keywordResults.length, "件");
  } else {
    logTrace("[ENHANCED:HYBRID] キーワード検索は有効です");
  }

  // 3. BM25検索（ON/OFF可能）
  let bm25Results = [];
  if (bm25Enabled) {
    logTrace("[ENHANCED:HYBRID] BM25検索を実行中...");
    bm25Results = searchByBM25(queryText, config.TOP_K_VECTOR);
    logTrace("[ENHANCED:HYBRID] BM25検索結果:", bm25Results.length, "件");
  } else {
    logTrace("[ENHANCED:HYBRID] BM25検索は有効です");
  }

  // 4. 結果を統合
  logTrace("[ENHANCED:HYBRID] スコア統合中...");
  const combined = combineThreeResults(vectorResults, keywordResults, bm25Results, WEIGHTS);

  // 5. 上位結果を返す
  const finalResults = combined
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, TOP_K);

  logTrace("[ENHANCED:HYBRID] 最終結果:", finalResults.length, "件");
  finalResults.forEach((r, i) => {
    logTrace(`  [${i + 1}] ${r.fileName} (総合スコア: ${r.combinedScore.toFixed(3)})`);
  });

  return finalResults;
}

/**
 * 3つの検索結果を統合します。
 * ベクトル、キーワード、BM25の結果を重み付けして総合スコアを計算します。
 * 
 * @param {Array} vectorResults - ベクトル検索結果
 * @param {Array} keywordResults - キーワード検索結果
 * @param {Array} bm25Results - BM25検索結果
 * @param {Object} weights - 重み設定オブジェクト
 * @returns {Array} 統合された結果の配列
 */
function combineThreeResults(vectorResults, keywordResults, bm25Results, weights) {
  const resultMap = new Map();

  // ベクトル検索結果
  const maxVector = Math.max(...vectorResults.map(r => r.similarity), 1);
  for (const r of vectorResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    resultMap.set(key, {
      fileId: r.fileId,
      fileName: r.fileName,
      chunk: r.chunk,
      chunkIndex: r.chunkIndex,
      mimeType: r.mimeType, // mimeTypeを追加
      vectorScore: r.similarity / maxVector,
      keywordScore: 0,
      bm25Score: 0,
      combinedScore: 0,
      keywords: r.keywords,
      totalChunks: r.totalChunks
    });
  }

  // キーワード検索結果
  const maxKeyword = Math.max(...keywordResults.map(r => r.score), 1);
  for (const r of keywordResults) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).keywordScore = r.score / maxKeyword;
    } else {
      resultMap.set(key, {
        fileId: r.fileId,
        fileName: r.fileName,
        chunk: r.chunk,
        chunkIndex: r.chunkIndex,
        mimeType: r.mimeType, // mimeTypeを追加
        vectorScore: 0,
        keywordScore: r.score / maxKeyword,
        bm25Score: 0,
        combinedScore: 0,
        keywords: r.keywords
      });
    }
  }

  // BM25検索結果
  const maxBM25 = Math.max(...bm25Results.map(r => r.score), 1);
  for (const r of bm25Results) {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (resultMap.has(key)) {
      resultMap.get(key).bm25Score = r.score / maxBM25;
    } else {
      resultMap.set(key, {
        fileId: r.fileId,
        fileName: r.fileName,
        chunk: r.chunk,
        chunkIndex: r.chunkIndex,
        mimeType: r.mimeType, // mimeTypeを追加
        vectorScore: 0,
        keywordScore: 0,
        bm25Score: r.score / maxBM25,
        combinedScore: 0,
        keywords: r.keywords
      });
    }
  }


  // 統合スコアを計算
  for (const [key, result] of resultMap) {
    result.combinedScore =
      (result.vectorScore * weights.VECTOR) +
      (result.keywordScore * weights.KEYWORD) +
      (result.bm25Score * weights.BM25);
  }

  return Array.from(resultMap.values());
}

// ================================
//  16. チャンク取得・類似度計算
// ================================

/**
 * クエリに関連するチャンクを取得します。
 * Embeddingベースの類似度検索を行い、関連チャンクを返します。
 * 
 * @param {string} queryText - 検索クエリ
 * @param {number} maxCandidates - 最大取得件数（デフォルト50）
 * @returns {Array} 関連チャンクの配列
 */
function fetchRelevantChunks(queryText, maxCandidates = 50) {
  logTrace("[RAG] fetchRelevantChunks 開始:", queryText.substring(0, 50));
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();
    logTrace("[RAG] シート読み込み完了。行数:", data.length);

    if (data.length < 2) {
      logWarn("[RAG] インデックスがありません（ヘッダーのみ）");
      return [];
    }

    logTrace("[RAG] Embedding 取得開始...");
    const queryEmbedding = getEmbeddingWithCache(queryText);
    if (!queryEmbedding) {
      logError("[RAG] Query Embedding 取得失敗");
      return [];
    }
    logTrace("[RAG] Embedding 取得成功。ディメンション:", queryEmbedding.length);

    const SIMILARITY_THRESHOLD = 0.3;
    const results = [];

    // スキーマを使用してフィールドを取得
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = getIndexField(row, 'FILE_ID');
      const fileName = getIndexField(row, 'FILE_NAME');
      const mimeType = getIndexField(row, 'MIME_TYPE');
      const chunk = getIndexField(row, 'TEXT_CHUNK');
      const embeddingJson = getIndexField(row, 'EMBEDDING');
      const chunkIndex = getIndexField(row, 'CHUNK_INDEX');

      try {
        const embedding = JSON.parse(embeddingJson);
        const similarity = cosineSimilarity(queryEmbedding, embedding);

        if (similarity > SIMILARITY_THRESHOLD) {
          results.push({ fileId, fileName, chunk, mimeType, similarity, chunkIndex });
        }
      } catch (e) {
        // エラーは無視
      }
    }


    const sorted = results.sort((a, b) => b.similarity - a.similarity);
    const filtered = sorted.slice(0, maxCandidates);
    logTrace("[RAG] fetchRelevantChunks 結果:", filtered.length, "件");
    return filtered;
  } catch (error) {
    logError("[RAG] fetchRelevantChunks エラー:", error);
    return [];
  }
}

// ================================
//  17. ChatGPT API 呼び出し
// ================================

/**
 * リランキング用ChatGPT APIを呼び出し
 * 指定されたモデルでAPIリクエストを実行
 * @param {Array} messages - メッセージ配列
 * @param {number} temperature - 温度パラメータ
 * @param {string} model - 使用するモデル
 * @returns {string} AIの応答テキスト
 */
function callChatGPTRerank(messages, temperature, model) {
  try {
    const payload = {
      model: model || GPT_MODEL,
      messages: messages,
      temperature: temperature
    };

    logTrace("[RERANK:API] リクエスト送信中... モデル:", payload.model);

    const response = UrlFetchApp.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + OPENAI_API_KEY
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: false
      }
    );

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode !== 200) {
      logError("[RERANK:API] OpenAI API エラー: ステータスコード " + responseCode, responseText);
      return "";
    }

    const json = JSON.parse(responseText);
    return json.choices[0].message.content.trim();

  } catch (error) {
    logError("[RERANK:API] エラー:", error);
    return "";
  }
}

/**
 * OpenAI ChatGPT APIを呼び出して応答を取得
 * @param {Array} messages - メッセージ配列（role, contentを含むオブジェクト）
 * @param {number} overrideTemperature - 上書きするtemperature（オプション）
 * @returns {string} AIの応答テキスト
 */
function callChatGPT(messages, overrideTemperature) {
  try {
    // ユーザー設定からLLMパラメータを取得
    const llmParams = getLlmParams();

    // temperature: 個別指定がある場合はそれを優先、なければ設定値
    const temperature = (overrideTemperature !== undefined) ? overrideTemperature : llmParams.temperature;

    // APIリクエストペイロードを構築
    // ユーザー設定からモデルを取得（デフォルトはGPT_MODEL定数）
    const currentModel = llmParams.model || GPT_MODEL;
    const payload = {
      model: currentModel,
      messages: messages,
      temperature: temperature
    };

    // top_p（設定されている場合）
    if (llmParams.top_p !== undefined && llmParams.top_p !== null) {
      payload.top_p = llmParams.top_p;
    }

    // top_k: モデルがサポートしている場合にのみ追加
    // GPT-4o-miniではサポートされていないため、gpt-4oやgpt-4では有効
    if (supportsTopK(currentModel) && llmParams.top_k !== undefined && llmParams.top_k !== null) {
      payload.top_k = llmParams.top_k;
      logTrace("[GPT_PARAMS] top_k有効 - モデル:", currentModel);
    } else if (!supportsTopK(currentModel)) {
      logTrace("[GPT_PARAMS] top_k無効 - モデルはサポートしていません:", currentModel);
    }

    // max_tokens（設定されている場合）
    // gpt-5.xシリーズの場合はmax_completion_tokensを使用
    if (llmParams.max_tokens !== undefined && llmParams.max_tokens !== null) {
      if (currentModel.startsWith('gpt-5.')) {
        payload.max_completion_tokens = llmParams.max_tokens;
      } else {
        payload.max_tokens = llmParams.max_tokens;
      }
    }

    // max_prompt_tokens（gpt-5.xシリーズ用のプロンプトトークン制限）
    // gpt-5.xシリーズでのみ有効
    if (currentModel.startsWith('gpt-5.')) {
      if (llmParams.max_prompt_tokens !== undefined && llmParams.max_prompt_tokens !== null) {
        const maxPromptTokens = parseInt(llmParams.max_prompt_tokens);
        if (!isNaN(maxPromptTokens) && maxPromptTokens > 0) {
          payload.max_prompt_tokens = maxPromptTokens;
        }
      }
    }

    // presence_penalty（設定されている場合）
    if (llmParams.presence_penalty !== undefined && llmParams.presence_penalty !== null) {
      payload.presence_penalty = llmParams.presence_penalty;
    }

    // frequency_penalty（設定されている場合）
    if (llmParams.frequency_penalty !== undefined && llmParams.frequency_penalty !== null) {
      payload.frequency_penalty = llmParams.frequency_penalty;
    }

    // stop sequences（設定されている場合）
    if (llmParams.stop && llmParams.stop.trim() !== '') {
      payload.stop = llmParams.stop.split(',').map(s => s.trim()).filter(s => s);
    }

    // response_format（設定されている場合）
    if (llmParams.response_format === 'json') {
      payload.response_format = { type: "json_object" };
    }

    logTrace("[GPT_PARAMS] 使用パラメータ:", JSON.stringify(payload));

    // プロンプトの詳細をトレースログに出力
    logTrace("[PROMPT] Messages count:", messages.length);

    messages.forEach((msg, idx) => {
      const role = msg.role || 'unknown';
      const content = msg.content || '';
      // コンテンツが長い場合は切り詰めて表示
      const contentPreview = content.length > 200 ? content.substring(0, 200) + '...' : content;
      logTrace(`[PROMPT] [${idx}] role: ${role}, content: ${contentPreview}`);
    });

    const response = UrlFetchApp.fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + OPENAI_API_KEY
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: false
      }
    );

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode !== 200) {
      logError("OpenAI API エラー: ステータスコード " + responseCode, responseText);
      return "すみません、処理中にエラーが発生しました。時間をおいて再度お試しください。";
    }

    const json = JSON.parse(responseText);
    return json.choices[0].message.content.trim();

  } catch (error) {
    logError("OpenAI API エラー:", error);
    if (error.message) {
      logError("OpenAI API エラー詳細:", error.message);
    }
    return "すみません、処理中にエラーが発生しました。時間をおいて再度お試しください。";
  }
}

// ================================
//  18. RAG 拡張機能付き ChatGPT
// ================================

/**
 * 管理者プロンプトを取得（ScriptProperties）
 */
function getAdminPrompt() {
  try {
    const parts = [];

    // システムプロンプト
    const systemPrompt = scriptProps.getProperty("ADMIN_SYSTEM_PROMPT");
    if (systemPrompt && systemPrompt.trim() !== "") {
      parts.push(systemPrompt.trim());
    }

    // 応答ルール
    const responseRules = scriptProps.getProperty("ADMIN_RESPONSE_RULES");
    if (responseRules && responseRules.trim() !== "") {
      parts.push("【応答ルール】\n" + responseRules.trim());
    }

    // 禁止トピック
    const forbiddenTopics = scriptProps.getProperty("ADMIN_FORBIDDEN_TOPICS");
    if (forbiddenTopics && forbiddenTopics.trim() !== "") {
      parts.push("【注意】以下のトピックには言及しないでください：" + forbiddenTopics.trim());
    }

    return parts.join("\n\n");
  } catch (error) {
    logError("[getAdminPrompt] エラー:", error);
    return "";
  }
}

/**
 * ユーザー独自プロンプトを取得（UserProperties）
 */
function getUserPrompt() {
  try {
    const userProps = PropertiesService.getUserProperties();

    const parts = [];

    // ユーザー固有の指示
    const customPrompt = userProps.getProperty("USER_CUSTOM_PROMPT");
    if (customPrompt && customPrompt.trim() !== "") {
      parts.push("【ユーザー設定】\n" + customPrompt.trim());
    }

    // ペルソナ設定
    const userPersona = userProps.getProperty("USER_PERSONA");
    if (userPersona && userPersona.trim() !== "") {
      parts.push("【ユーザーの特徴】\n" + userPersona.trim());
    }

    // 応答スタイル
    const responseStyle = userProps.getProperty("USER_RESPONSE_STYLE");
    if (responseStyle && responseStyle.trim() !== "") {
      parts.push("【応答スタイル】\n" + responseStyle.trim());
    }

    return parts.join("\n\n");
  } catch (error) {
    logError("[getUserPrompt] エラー:", error);
    return "";
  }
}

/**
 * 管理者プロンプトを設定（ScriptProperties）
 * @param {string} key - プロンプトキー
 * @param {string} value - 設定値
 */
function setAdminPrompt(key, value) {
  try {
    // 許可されたキーのリスト
    const allowedKeys = Object.keys(ADMIN_PROMPT_DEFINITIONS);

    if (!allowedKeys.includes(key)) {
      return { success: false, error: "許可されていないキーです: " + key };
    }

    scriptProps.setProperty(key, value);
    logInfo("[setAdminPrompt] 管理者プロンプトを更新:", key);

    return { success: true, key: key, value: value };
  } catch (error) {
    logError("[setAdminPrompt] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * ユーザー独自プロンプトを設定（UserProperties）
 * @param {string} key - プロンプトキー
 * @param {string} value - 設定値
 */
function setUserPrompt(key, value) {
  try {
    // 許可されたキーのリスト
    const allowedKeys = Object.keys(USER_PROMPT_DEFINITIONS);

    if (!allowedKeys.includes(key)) {
      return { success: false, error: "許可されていないキーです: " + key };
    }

    const userProps = PropertiesService.getUserProperties();
    userProps.setProperty(key, value);
    logInfo("[setUserPrompt] ユーザープロンプトを更新:", key);

    return { success: true, key: key, value: value };
  } catch (error) {
    logError("[setUserPrompt] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * 管理者プロンプトの全設定を取得
 */
function getAdminPromptSettings() {
  try {
    const settings = {};

    for (const [key, def] of Object.entries(ADMIN_PROMPT_DEFINITIONS)) {
      let value = scriptProps.getProperty(key);

      // デフォルト値が空の場合はデフォルト値を設定
      if (value === null || value === undefined || value === "") {
        value = def.defaultValue;
        if (value) {
          scriptProps.setProperty(key, value);
        }
      }

      settings[key] = value || "";
    }

    return {
      success: true,
      settings: settings,
      definitions: ADMIN_PROMPT_DEFINITIONS
    };
  } catch (error) {
    logError("[getAdminPromptSettings] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * ユーザー独自プロンプトの全設定を取得
 */
function getUserPromptSettings() {
  try {
    const userProps = PropertiesService.getUserProperties();
    const settings = {};

    for (const [key, def] of Object.entries(USER_PROMPT_DEFINITIONS)) {
      let value = userProps.getProperty(key);

      // デフォルト値が空の場合はデフォルト値を設定
      if (value === null || value === undefined || value === "") {
        value = def.defaultValue;
        if (value) {
          userProps.setProperty(key, value);
        }
      }

      settings[key] = value || "";
    }

    return {
      success: true,
      settings: settings,
      definitions: USER_PROMPT_DEFINITIONS
    };
  } catch (error) {
    logError("[getUserPromptSettings] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * プロンプトを生成（優先順位: 管理者 → ユーザー → RAGコンテキスト）
 * @param {string} ragContext - RAG検索結果（オプション）
 * @returns {Object} 生成されたプロンプト情報
 */
function generateFullPrompt(ragContext) {
  // Step 1: ベースシステムプロンプト（管理者基本指示）
  const baseSystemPrompt = "あなたはAIアシスタントです。";
  // Step 2: 管理者プロンプトを取得（ScriptProperties）
  const adminPrompt = getAdminPrompt();
  // Step 3: ユーザー独自プロンプトを取得（UserProperties）
  const userPrompt = getUserPrompt();
  // Step 4: システムプロンプトを形成（ベース + 管理者）
  const systemParts = [baseSystemPrompt];
  // Step 5: ユーザーメッセージを形成（ユーザー設定（UserProperties）+ RAGコンテキスト + 実際のメッセージ）
  const userParts = [];

  if (adminPrompt && adminPrompt.trim() !== "") {
    systemParts.push(adminPrompt);
  }
  const combinedSystem = systemParts.filter(p => p && p.trim() !== "").join("\n\n");

  if (userPrompt && userPrompt.trim() !== "") {
    userParts.push(userPrompt.trim());
  }

  if (ragContext && ragContext.trim() !== "") {
    userParts.push("【コンテキスト】\n" + ragContext.trim());
  }
  const combinedUser = userParts.filter(p => p && p.trim() !== "").join("\n\n");

  return {
    system: combinedSystem,
    user: combinedUser,
    hasAdminPrompt: adminPrompt.trim() !== "",
    hasUserPrompt: userPrompt.trim() !== "",
    hasRagContext: ragContext && ragContext.trim() !== ""
  };
}

/**
 * RAG拡張版ChatGPT呼び出し
 * @param {string} userMessage - ユーザーメッセージ
 * @param {Array} history - 会話履歴
 * @param {string} userId - ユーザーID（キャッシュをユーザー別に保存するために必須）
 * @param {string} additionalContext - 追加のコンテキスト（アップロードされたファイルなど）
 */
function callChatGPTWithRAGEnhanced(userMessage, history, userId, additionalContext) {
  logTrace("[RAG:ENHANCED] 拡張RAG開始");
  logTrace("[RAG:ENHANCED] ユーザー入力:", userMessage.substring(0, 50));

  // userIdをハッシュ化してログ用に使用
  const hashedUserId = hashUserId(userId);

  let finalResponse = "";
  let usedCache = false;

  // userIdが渡されていない場合はエラー
  if (!userId) {
    logError("[RAG:ENHANCED] userIdが指定されていません。キャッシュは使用されません。");
  }

  try {
    // ===========================
    // 【機能1: 結果キャッシュ】まずキャッシュを確認（ユーザー別）
    // ===========================
    const cachedResults = userId ? getQueryCache(userMessage, userId) : null;
    if (cachedResults) {
      logTrace("[RAG:ENHANCED] キャッシュを使用 user(hash):", hashedUserId);
      finalResponse = cachedResults;
      usedCache = true;
    }

    // キャッシュがない場合は通常処理を実行
    if (!usedCache) {
      // 検索パラメータをUserPropertiesから取得
      const searchParams = getSearchParams();

      // ===========================
      // 【機能2: クエリ拡張】入力を最適化
      // ===========================
      let searchQuery = userMessage;
      
      let expansions = [];
      if (searchParams.SEARCH_QUERY_EXPANSION_ENABLED) {
        // 1. 辞書ベース拡張（新しい設定を使用）
        if (searchParams.SEARCH_DICT_EXPANSION_ENABLED) {
          const dictResult = expandQuery(userMessage);
          expansions.push(...dictResult.expansions);
          searchQuery = dictResult.expanded;
          logTrace("[QUERY:EXPAND:DICT] 辞書ベース拡張完了:", dictResult.expansions.join(", "));
        }
        
        // 2. LLM ベース拡張（新しい設定を使用）
        if (searchParams.SEARCH_LLM_EXPANSION_ENABLED) {
          // プロンプトテンプレートを使用（ScriptPropertiesから取得）
          const prompt = buildPromptFromTemplate('PROMPT_QUERY_EXPANSION', {
            query: searchQuery   // ← 辞書拡張後のクエリを渡す
          });
          const llmResponse = callChatGPT([{ role: "user", content: prompt }]);
          const llmResult = parseExpansionResponse(llmResponse);

          if (llmResult.expansions.length > 0) {
            const safeExpansions = llmResult.expansions.filter(w => w.length >= 2);
            expansions.push(...safeExpansions);
            searchQuery = `${searchQuery} ${safeExpansions.join(" ")}`;
          }
          logTrace("[QUERY:EXPAND:LLM] LLM追加語:", llmResult.expansions.join(", "));
        }
      }
      // 重複除去
      expansions = [...new Set(expansions)];

      // ===========================
      // 検索実行（ハイブリッド検索 + BM25）
      // ===========================
      logTrace("[RAG:ENHANCED] 候補チャンク取得...");
      // キーワード検索またはBM25検索が有効な場合はハイブリッド検索を使用
      const useHybrid = searchParams.SEARCH_KEYWORD_ENABLED || searchParams.SEARCH_BM25_ENABLED;

      // クエリ拡張の有効/無効をログ出力
      logTrace("[RAG:ENHANCED] クエリ拡張:", searchParams.SEARCH_QUERY_EXPANSION_ENABLED ? "有効" : "無効");

      let candidates = [];
      if (useHybrid) {
        logTrace("[RAG:ENHANCED] ハイブリッド検索を使用");
        // ベクトル + キーワード + BM25（各検索のON/OFFを取得）
        candidates = enhancedHybridSearch(searchQuery, {
          TOP_K_FINAL: 50,
          keywordEnabled: searchParams.SEARCH_KEYWORD_ENABLED,
          bm25Enabled: searchParams.SEARCH_BM25_ENABLED
        });
      } else {
        logTrace("[RAG:ENHANCED] ベクトル検索のみ使用");
        candidates = fetchRelevantChunks(searchQuery, 50);
      }
      logTrace("[RAG:ENHANCED] 初期候補数:", candidates.length);

      // ===========================
      // 【機能4: リランキング】結果を再評価
      // ===========================
      // RERANK_FINAL_TOP_K は UserProperties から取得（デフォルト5）
      const rerankFinalTopK = parseInt(userProps.getProperty("RERANK_FINAL_TOP_K")) || 5;
      if (searchParams.SEARCH_RERANK_ENABLED && candidates.length > rerankFinalTopK) {
        logTrace("[RAG:ENHANCED] リランキング:", searchParams.SEARCH_RERANK_ENABLED ? "有効" : "無効");
        candidates = rerankResults(userMessage, candidates);
      }

      // ===========================
      // コンテキスト選択
      // ===========================
      const MAX_CONTEXT_CHARS = 3000;
      let totalChars = 0;
      const selected = [];

      for (const c of candidates) {
        const chunkText = c.chunk || "";
        const len = chunkText.length;
        if (totalChars + len > MAX_CONTEXT_CHARS) {
          if (selected.length === 0 && len > MAX_CONTEXT_CHARS) {
            selected.push({ ...c, chunk: chunkText.substring(0, MAX_CONTEXT_CHARS) });
            totalChars += MAX_CONTEXT_CHARS;
          }
          break;
        }
        selected.push(c);
        totalChars += len;
      }

      logTrace("[RAG:ENHANCED] 選択チャンク数:", selected.length, "合計文字数:", totalChars);

      // RAG検索結果とアップロードされたファイルのコンテキストを統合
      let context = "";
      
      // 追加のコンテキスト（アップロードされたファイル）を先頭に追加
      if (additionalContext && additionalContext.trim() !== "") {
        context += additionalContext + "\n\n";
      }
      
      if (selected.length > 0) {
        context += "【参考ドキュメント】\n";
        selected.forEach((doc, i) => {
          const preview = (doc.chunk || "").replace(/\n/g, " ");
          const similarityScore = (doc.similarity ?? doc.vectorScore ?? doc.score ?? 0).toFixed(3);
          const chunkInfo = doc.totalChunks ? ` (${doc.chunkIndex + 1}/${doc.totalChunks})` : ` (chunk ${doc.chunkIndex})`;
          const keywords = doc.keywords ? `\n   キーワード: ${doc.keywords}` : "";

          context += `\n${i + 1}. ${doc.fileName}${chunkInfo}, スコア: ${similarityScore}${keywords}\n${preview}\n`;
        });
      } else {
        logTrace("[RAG:ENHANCED] マッチするドキュメントがありません");
      }

      // generateFullPromptでシステムプロンプトを生成（RAGコンテキストを含む）
      const promptResult = generateFullPrompt(context);

      // buildChatMessages関数を使用してメッセージ配列を構築
      const messages = buildChatMessages(promptResult, history);

      logTrace("[RAG:ENHANCED] ChatGPT 呼び出し - 管理者プロンプト: " + promptResult.hasAdminPrompt + ", ユーザープロンプト: " + promptResult.hasUserPrompt);
      const response = callChatGPT(messages);

      // レスポンス作成
      finalResponse = response;
      if (selected.length > 0) {
        // デバッグログ: selected の内容を確認
        logTrace("[DEBUG] selected チャンク数:", selected.length);
        selected.forEach((doc, idx) => {
          logTrace(`[DEBUG] selected[${idx}]: fileId=${doc.fileId}, fileName=${doc.fileName}, chunkIndex=${doc.chunkIndex}`);
        });

        // ドキュメントごとにチャンクをグループ化（URL重複防止）
        const docChunksMap = new Map();

        selected.forEach((doc) => {
          // fileId または fileName をキーとして使用
          const docKey = doc.fileId || doc.fileName;

          if (!docChunksMap.has(docKey)) {
            docChunksMap.set(docKey, {
              fileId: doc.fileId,
              fileName: doc.fileName,
              mimeType: doc.mimeType,
              chunks: [],
              maxScore: 0
            });
            logTrace("[DEBUG] 新しいドキュメントを追加:", docKey);
          }
          const docData = docChunksMap.get(docKey);

          // チャンク番号を取得（0ベースから1ベースに转换）
          let chunkNum = 1;
          if (doc.chunkIndex !== undefined && doc.chunkIndex !== null) {
            chunkNum = (doc.totalChunks ? doc.chunkIndex + 1 : doc.chunkIndex + 1);
          }
          docData.chunks.push(chunkNum);

          const score = doc.similarity ?? doc.vectorScore ?? doc.score ?? 0;
          if (score > docData.maxScore) {
            docData.maxScore = score;
          }
          logTrace("[DEBUG] チャンク追加: key=" + docKey + ", chunk=" + chunkNum);
        });

        // デバッグログ: グループ化の結果を確認
        logTrace("[DEBUG] グループ化後のドキュメント数:", docChunksMap.size);
        docChunksMap.forEach((docData, docKey) => {
          logTrace(`[DEBUG] グループ: ${docKey}, チャンク数: ${docData.chunks.length}, chunks: ${JSON.stringify(docData.chunks)}`);
        });

        finalResponse += "\n\n【参考にしたドキュメント】\n";
        let docIndex = 0;
        docChunksMap.forEach((docData, docKey) => {
          docIndex++;
          const docUrl = getDocumentUrl(docData.fileId, docData.mimeType);
          const similarityScore = docData.maxScore.toFixed(3);

          // チャンク情報をソートして範囲を表示
          const sortedChunks = docData.chunks.sort((a, b) => a - b);

          let chunkInfoStr = "";
          if (sortedChunks.length === 1) {
            const chunkNum = sortedChunks[0];
            const totalChunks = docData.totalChunks || docData.chunks.length;
            chunkInfoStr = ` (${chunkNum}/${totalChunks})`;
          } else {
            // チャンクが複数ある場合は範囲を表示
            const minChunk = Math.min(...sortedChunks);
            const maxChunk = Math.max(...sortedChunks);
            const totalChunks = docData.totalChunks || docData.chunks.length;
            if (minChunk === maxChunk) {
              chunkInfoStr = ` (${minChunk}/${totalChunks})`;
            } else {
              chunkInfoStr = ` (${minChunk}-${maxChunk}/${totalChunks})`;
            }
          }

          finalResponse += `${docIndex}. ${docData.fileName}${chunkInfoStr}, スコア: ${similarityScore}\n   🔗 ${docUrl}\n`;
        });
      }


      // ===========================
      // 【機能1: 結果キャッシュ】結果を保存（ユーザー別）
      // ===========================
      if (userId) {
        setQueryCache(userMessage, finalResponse, userId);
      }
    }

    logTrace("[RAG:ENHANCED] 完了 user(hash):", hashedUserId);
    return finalResponse;

  } catch (error) {
    logError("[RAG:ENHANCED] エラー:", error);
    throw error;
  }
}

//  旧版RAG関数（後方互換性のため残存）
function callChatGPTWithRAG(userMessage, history) {
  return callChatGPTWithRAGEnhanced(userMessage, history);
}

// ================================
//  19.自律検索エージェントモード関数
// ================================

/**
 * 検索結果の評価を行い、追加検索が必要かを判断
 * ScriptPropertiesに保存されたプロンプトテンプレートを使用
 * @param {string} query - ユーザークエリ
 * @param {Array} results - 検索結果配列
 * @param {string} context - 現在までに集めたコンテキスト
 * @returns {Object} 評価結果 { needsMoreSearch: boolean, confidence: number, reason: string }
 */
function evaluateSearchResults(query, results, context) {
  logTrace("[AGENT] 検索結果の評価を開始");

  // 結果がない場合は必ず追加検索が必要
  if (!results || results.length === 0) {
    return {
      needsMoreSearch: true,
      confidence: 0,
      reason: "検索結果がありませんでした。別のキーワードで検索してみます。"
    };
  }

  // 検索結果の概要を作成
  let resultsSummary = "【検索結果】\n";
  results.slice(0, 5).forEach((r, i) => {
    resultsSummary += `${i + 1}. ${r.fileName || 'Unknown'}\n`;
    resultsSummary += `   ${(r.chunk || '').substring(0, 100)}...\n\n`;
  });

  // ScriptPropertiesからプロンプトテンプレートを取得
  const evaluationPrompt = buildPromptFromTemplate('PROMPT_AGENT_EVALUATE', {
    query: query,
    context: context ? context.substring(0, 1000) : '（まだ情報なし）',
    results: resultsSummary
  });

  const messages = [
    { role: "system", content: "あなたは検索精度を評価する専門家です。適切かつ正確に評価してください。" },
    { role: "user", content: evaluationPrompt }
  ];

  try {
    const response = callChatGPT(messages, 0.3);

    // JSONパースを試みる
    let parsed;
    try {
      // JSON部分を抽出
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("JSONが見つかりません");
      }
    } catch (parseError) {
      logWarn("[AGENT] JSONパース失敗、フォールバック評価を使用");
      // 簡易フォールバック
      return {
        needsMoreSearch: results.length < 3,
        confidence: results.length >= 3 ? 0.8 : 0.4,
        reason: "検索結果の数に基づいて判断しました",
        additionalTerms: []
      };
    }

    logTrace("[AGENT] 評価結果 - needsMoreSearch:", parsed.needsMoreSearch, "confidence:", parsed.confidence);

    return {
      needsMoreSearch: parsed.needsMoreSearch || false,
      confidence: parsed.confidence || 0.5,
      reason: parsed.reason || "",
      additionalTerms: parsed.additionalTerms || []
    };

  } catch (error) {
    logError("[AGENT] 評価エラー:", error);
    return {
      needsMoreSearch: results.length < 3,
      confidence: results.length >= 3 ? 0.7 : 0.4,
      reason: "評価中にエラーが発生しました",
      additionalTerms: []
    };
  }
}

/**
 * 追加検索キーワードを生成
 * ScriptPropertiesに保存されたプロンプトテンプレートを使用
 * @param {string} query - 元のクエリ
 * @param {Array} currentResults - 現在の検索結果
 * @param {Object} evaluation - 評価結果
 * @returns {Array} 追加検索用のキーワード配列
 */
function generateAdditionalSearchTerms(query, currentResults, evaluation) {
  logTrace("[AGENT] 追加検索キーワード生成開始");

  // 評価結果からキーワードが既にあればそれを使用
  if (evaluation.additionalTerms && evaluation.additionalTerms.length > 0) {
    logTrace("[AGENT] 評価結果からキーワードを使用:", evaluation.additionalTerms);
    return evaluation.additionalTerms.slice(0, 3);
  }

  // 現在の検索結果から関連キーワードを抽出
  const existingKeywords = new Set();
  currentResults.forEach(r => {
    if (r.keywords) {
      r.keywords.split(',').forEach(k => existingKeywords.add(k.trim()));
    }
  });

  // ScriptPropertiesからプロンプトテンプレートを取得
  const keywordPrompt = buildPromptFromTemplate('PROMPT_AGENT_KEYWORD', {
    query: query,
    existingKeywords: Array.from(existingKeywords).join(', ') || 'なし'
  });

  const messages = [
    { role: "system", content: "あなたは検索キーワードの専門家です。" },
    { role: "user", content: keywordPrompt }
  ];

  try {
    const response = callChatGPT(messages, 0.5);

    // JSONパース
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const terms = JSON.parse(jsonMatch[0]);
      logTrace("[AGENT] 生成された追加キーワード:", terms);
      return terms.slice(0, 3);
    }
  } catch (error) {
    logError("[AGENT] キーワード生成エラー:", error);
  }

  // フォールバック: 元のクエリをそのまま返す
  return [];
}

// ================================
//  エージェントモード（自律検索・調査）
// ================================

/**
 * 反復エージェントの状態を保存するためのグローバルオブジェクト
 * クライアントからの継続要求時に状態を復元するために使用
 */
const AGENT_STATE_PREFIX = "agent_state_";

/**
 * エージェントの状態を保存
 * @param {string} sessionId - セッションID
 * @param {Object} state - 保存する状態オブジェクト
 */
function saveAgentState(sessionId, state) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      logWarn("[AGENT:STATE] CacheServiceが利用できません");
      return false;
    }
    const key = AGENT_STATE_PREFIX + sessionId;
    cache.put(key, JSON.stringify(state), 3600); // 1時間有効
    logTrace("[AGENT:STATE] 状態を保存:", sessionId);
    return true;
  } catch (error) {
    logError("[AGENT:STATE] 状態保存エラー:", error);
    return false;
  }
}

/**
 * エージェントの状態を取得
 * @param {string} sessionId - セッションID
 * @returns {Object|null} 状態オブジェクト、存在しない場合はnull
 */
function getAgentState(sessionId) {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache) {
      return null;
    }
    const key = AGENT_STATE_PREFIX + sessionId;
    const data = cache.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    logError("[AGENT:STATE] 状態取得エラー:", error);
    return null;
  }
}

/**
 * エージェントの状態を削除
 * @param {string} sessionId - セッションID
 */
function clearAgentState(sessionId) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      const key = AGENT_STATE_PREFIX + sessionId;
      cache.remove(key);
      logTrace("[AGENT:STATE] 状態を削除:", sessionId);
    }
  } catch (error) {
    logError("[AGENT:STATE] 状態削除エラー:", error);
  }
}

/**
 * 自律検索エージェントモードで回答（反復ごとにクライアントへ返却）
 * 複数の検索を反復的に実行し、反復ごとに結果をクライアントへ返却
 * 継続フラグがTrueの場合は自動的に次の反復へ進む
 * 
 * @param {string} userMessage - ユーザーメッセージ
 * @param {Array} history - 会話履歴
 * @param {string} userId - ユーザーID
 * @param {Object} options - オプション設定
 * @param {boolean} options.continueIteration - 前回の反復から継続するかどうか
 * @param {number} options.maxIterations - 最大反復回数（デフォルト3）
 * @returns {Object} 検索結果と継続状态
 */
function callChatGPTWithAgentIterative(userMessage, history, userId, options) {
  options = options || {};
  const continueIteration = options.continueIteration || false;
  const maxIterations = options.maxIterations || AGENT_MODE_CONFIG.MAX_ITERATIONS || 3;
  const MIN_CONFIDENCE = AGENT_MODE_CONFIG.MIN_CONFIDENCE || 0.7;
  const SHOW_THINKING = AGENT_MODE_CONFIG.SHOW_THINKING || true;
  const ADDITIONAL_SEARCH_ENABLED = AGENT_MODE_CONFIG.ADDITIONAL_SEARCH_ENABLED || true;

  logInfo("[AGENT:ITERATIVE] 反復エージェント開始 - continue:", continueIteration, "max:", maxIterations);

  // 検索パラメータを取得
  const searchParams = getSearchParams();

  let currentQuery = userMessage;
  let allResults = [];
  let thinkingLog = [];
  let context = "";
  let iteration = 0;
  let isContinuing = false;

  // 前回の状態から継続する場合
  if (continueIteration) {
    const savedState = getAgentState(userId);
    if (savedState) {
      logInfo("[AGENT:ITERATIVE] 前回の状態から継続:", savedState.iteration);
      currentQuery = savedState.currentQuery || userMessage;
      allResults = savedState.allResults || [];
      thinkingLog = savedState.thinkingLog || [];
      iteration = savedState.iteration || 0;
      isContinuing = true;
    }
  }

  // 反復ループ
  for (; iteration < maxIterations; iteration++) {
    logInfo("[AGENT:ITERATIVE] 反復 " + (iteration + 1) + "/" + maxIterations);

    // ハイブリッド検索を実行
    let searchResults = [];
    const useHybrid = searchParams.SEARCH_KEYWORD_ENABLED || searchParams.SEARCH_BM25_ENABLED;

    if (useHybrid) {
      searchResults = enhancedHybridSearch(currentQuery, {
        TOP_K_FINAL: 20,
        keywordEnabled: searchParams.SEARCH_KEYWORD_ENABLED,
        bm25Enabled: searchParams.SEARCH_BM25_ENABLED
      });
    } else {
      searchResults = fetchRelevantChunks(currentQuery, 20);
    }

    // 結果をマージ
    allResults = mergeSearchResults(allResults, searchResults);

    // 現在のコンテキストを構築
    context = buildContextFromResults(allResults);

    // 検索結果を評価
    const evaluation = evaluateSearchResults(currentQuery, searchResults, context);

    const thinkingStep = {
      iteration: iteration + 1,
      query: currentQuery,
      resultsCount: searchResults.length,
      totalResults: allResults.length,
      evaluation: evaluation
    };
    thinkingLog.push(thinkingStep);

    logInfo("[AGENT:ITERATIVE] 評価結果 - needsMoreSearch:", evaluation.needsMoreSearch, "confidence:", evaluation.confidence);

    // 現在の反復 결과를 반환（クライアントへ）
    const currentResult = {
      iteration: iteration + 1,
      maxIterations: maxIterations,
      query: currentQuery,
      searchResults: searchResults.slice(0, 5), // 上位5件を返す
      totalResults: allResults.length,
      evaluation: evaluation,
      needsMoreSearch: evaluation.needsMoreSearch && evaluation.confidence < MIN_CONFIDENCE,
      isComplete: !evaluation.needsMoreSearch || evaluation.confidence >= MIN_CONFIDENCE || iteration >= maxIterations - 1
    };

    // 情報が十分ならループを終了
    if (!evaluation.needsMoreSearch || evaluation.confidence >= MIN_CONFIDENCE) {
      logInfo("[AGENT:ITERATIVE] 情報が十分と判定、終了");
      // 最終回答を生成
      const finalResponse = generateAgentFinalResponse(userMessage, userId, allResults, thinkingLog, history, SHOW_THINKING);
      
      // 状態をクリア
      clearAgentState(userId);
      
      return {
        ...currentResult,
        finalResponse: finalResponse.finalResponse,
        thinkingInfo: finalResponse.thinkingInfo,
        isComplete: true
      };
    }

    // 追加検索が必要な場合
    if (evaluation.needsMoreSearch && ADDITIONAL_SEARCH_ENABLED) {
      // 追加検索キーワードを生成
      const additionalTerms = generateAdditionalSearchTerms(currentQuery, allResults, evaluation);

      if (additionalTerms.length > 0) {
        // 次の検索クエリを構築
        currentQuery = currentQuery + " " + additionalTerms.join(" ");
        logInfo("[AGENT:ITERATIVE] 追加検索クエリ:", currentQuery);
      }
    }

    // 現在の状態を保存（次の反復のため）
    const stateToSave = {
      currentQuery: currentQuery,
      allResults: allResults,
      thinkingLog: thinkingLog,
      iteration: iteration + 1,
      userMessage: userMessage,
      userId: userId
    };
    saveAgentState(userId, stateToSave);

    // この反復の結果を返す（継続が必要な場合）
    const intermediateResponse = generateAgentIntermediateResponse(userMessage, userId, allResults, thinkingLog, history, iteration + 1, SHOW_THINKING);
    
    return {
      ...currentResult,
      finalResponse: intermediateResponse.partialResponse,
      thinkingInfo: intermediateResponse.thinkingInfo,
      isComplete: false
    };
  }

  // 最大反復回数に達した場合
  logInfo("[AGENT:ITERATIVE] 最大反復回数に達しました");

  // 最終回答を生成
  const finalResponse = generateAgentFinalResponse(userMessage, userId, allResults, thinkingLog, history, SHOW_THINKING);
  
  // 状態をクリア
  clearAgentState(userId);

  return {
    iteration: iteration,
    maxIterations: maxIterations,
    query: currentQuery,
    searchResults: allResults.slice(0, 5),
    totalResults: allResults.length,
    needsMoreSearch: false,
    isComplete: true,
    finalResponse: finalResponse.finalResponse,
    thinkingInfo: finalResponse.thinkingInfo
  };
}

/**
 * エージェントの中間回答を生成（反復中）
 */
function generateAgentIntermediateResponse(userMessage, userId, allResults, thinkingLog, history, currentIteration, showThinking) {
  // 現在のコンテキストを構築
  let context = "";
  try {
    context = buildContextFromResults(allResults);
  } catch (e) {
    context = "";
  }

  // プロンプトを生成
  let promptResult;
  try {
    promptResult = generateFullPrompt(context);
  } catch (e) {
    promptResult = { system: "あなたはAIアシスタントです。", user: userMessage };
  }

  // 思考過程テキスト生成
  let thinkingInfo = "";
  if (showThinking) {
    thinkingInfo = "\n\n🔄 【検索中】反復 " + currentIteration + " 完了\n";
    thinkingInfo += "─────────────────────\n";
    thinkingLog.forEach((step) => {
      const stepIcon = step.evaluation.needsMoreSearch ? "🔄" : "✅";
      thinkingInfo += `【反復 ${step.iteration}】\n`;
      thinkingInfo += `  📝 検索: 「${step.query}」\n`;
      thinkingInfo += `  📊 結果: ${step.resultsCount}件\n`;
      thinkingInfo += `  ${stepIcon} confidence: ${(step.evaluation.confidence || 0).toFixed(2)}\n\n`;
    });
    thinkingInfo += "🔄 追加検索中...\n";
    thinkingInfo += "─────────────────────";
  }

  // 【重要】messagesの順序: system → user(history) → user(新規)
  // systemは常に最初に配置する必要があります
  const messages = [];
  
  // 1. systemプロンプトを最初に配置
  messages.push({ role: "system", content: promptResult.system + "\n\n※ 検索を続けています。現在の情報で回答してください。" });

  // 2. 最後に新しいユーザーメッセージを追加
  messages.push({ role: "user", content: promptResult.user });

  // 3. その後、historyからのメッセージを追加
  if (history && history.length > 0) {
    history.forEach(msg => messages.push(msg));
  }

  const partialResponse = callChatGPT(messages);

  return {
    partialResponse: partialResponse + thinkingInfo,
    thinkingInfo: thinkingInfo
  };
}

/**
 * エージェントの最終回答を生成（反復完了後）
 */
function generateAgentFinalResponse(userMessage, userId, allResults, thinkingLog, history, showThinking) {
  // 最終的なコンテキストを構築
  let finalContext = "";
  try {
    finalContext = buildContextFromResults(allResults);
  } catch (e) {
    finalContext = "";
  }

  // プロンプトを生成
  let promptResult;
  try {
    promptResult = generateFullPrompt(finalContext);
  } catch (e) {
    promptResult = { system: "あなたはAIアシスタントです。", user: userMessage };
  }

  // エージェント用のシステムプロンプトを追加
  let systemPrompt = promptResult.system;
  if (showThinking && thinkingLog.length > 1) {
    let thinkingText = "\n\n【検索の過程】\n";
    thinkingLog.forEach((step) => {
      thinkingText += "- 反復" + step.iteration + ": キーワード「" + step.query + "」で" + step.resultsCount + "件取得\n";
      thinkingText += "  評価: " + (step.evaluation.needsMoreSearch ? "追加検索が必要" : "情報が十分") +
        " (confidence: " + (step.evaluation.confidence || 0).toFixed(2) + ")\n";
    });
    systemPrompt += thinkingText;
  }

  // 【重要】messagesの順序: system → user(history) → user(新規)
  // systemは常に最初に配置する必要があります
  const messages = [];
  
  // 1. systemプロンプトを最初に配置
  messages.push({ role: "system", content: systemPrompt });
  
  // 2. 最後に新しいユーザーメッセージを追加
  messages.push({ role: "user", content: promptResult.user });

  // 3. その後、historyからのメッセージを追加
  if (history && history.length > 0) {
    history.forEach(msg => messages.push(msg));
  }

  const finalResponse = callChatGPT(messages);

  // 思考過程テキスト生成
  let thinkingInfo = "";
  if (showThinking && thinkingLog.length > 0) {
    thinkingInfo = "\n\n" + "=".repeat(40) + "\n";
    thinkingInfo += "🔍 【AI考える過程】\n";
    thinkingInfo += "=".repeat(40) + "\n\n";

    thinkingLog.forEach((step) => {
      const stepIcon = step.evaluation.needsMoreSearch ? "🔄" : "✅";
      thinkingInfo += `【反復 ${step.iteration}】\n`;
      thinkingInfo += `  📝 検索: 「${step.query}」\n`;
      thinkingInfo += `  📊 結果: ${step.resultsCount}件のドキュメントを取得\n`;
      thinkingInfo += `  ${stepIcon} 評価: ${step.evaluation.needsMoreSearch ? "追加検索が必要" : "情報が十分"}\n`;
      thinkingInfo += `  📈 confidence: ${(step.evaluation.confidence || 0).toFixed(2)}\n`;
      if (step.evaluation.reason) {
        thinkingInfo += `  💡 理由: ${step.evaluation.reason}\n`;
      }
      thinkingInfo += "\n";
    });

    thinkingInfo += "=".repeat(40) + "\n";
    thinkingInfo += "✨ 以上の情報をもとに回答を生成しました\n";
    thinkingInfo += "=".repeat(40);
  }

  return {
    finalResponse: finalResponse,
    thinkingInfo: thinkingInfo
  };
}

/**
 * 自律検索エージェントモードで回答（旧バージョン、後方互換性のため残存）
 * 複数の検索を反復的に実行し、必要な情報を収集
 * @param {string} userMessage - ユーザーメッセージ
 * @param {Array} history - 会話履歴
 * @param {string} userId - ユーザーID
 * @returns {string} AIの回答
 */
function callChatGPTWithAgent(userMessage, history, userId) {
  // 新バージョンを呼び出して結果を文字列として返す
  const result = callChatGPTWithAgentIterative(userMessage, history, userId, {
    maxIterations: AGENT_MODE_CONFIG.MAX_ITERATIONS || 3
  });
  
  // オブジェクトの場合は文字列のみを返す
  if (result && typeof result === 'object') {
    if (result.thinkingInfo) {
      return result.finalResponse + result.thinkingInfo;
    }
    return result.finalResponse;
  }
  
  return result;
}

/**
 * 検索結果をマージ（重複排除）
 */
function mergeSearchResults(existingResults, newResults) {
  const resultMap = new Map();

  // 既存の結果を追加
  existingResults.forEach(r => {
    const key = `${r.fileId}_${r.chunkIndex}`;
    resultMap.set(key, r);
  });

  // 新しい結果を追加
  newResults.forEach(r => {
    const key = `${r.fileId}_${r.chunkIndex}`;
    if (!resultMap.has(key)) {
      resultMap.set(key, r);
    }
  });

  return Array.from(resultMap.values());
}

/**
 * 検索結果からコンテキストを構築
 */
function buildContextFromResults(results) {
  if (results.length === 0) {
    return "関連するドキュメントが見つかりませんでした。";
  }

  const MAX_CONTEXT_CHARS = 4000;
  let totalChars = 0;
  const selected = [];

  // スコア順にソート
  const sorted = results.sort((a, b) => {
    const scoreA = a.similarity || a.vectorScore || a.score || 0;
    const scoreB = b.similarity || b.vectorScore || b.score || 0;
    return scoreB - scoreA;
  });

  for (const r of sorted) {
    const chunkText = r.chunk || "";
    const len = chunkText.length;
    if (totalChars + len > MAX_CONTEXT_CHARS) {
      if (selected.length === 0 && len > MAX_CONTEXT_CHARS) {
        selected.push({ ...r, chunk: chunkText.substring(0, MAX_CONTEXT_CHARS) });
        totalChars += MAX_CONTEXT_CHARS;
      }
      break;
    }
    selected.push(r);
    totalChars += len;
  }

  let context = "【参考ドキュメント】\n";
  selected.forEach((doc, i) => {
    const preview = (doc.chunk || "").replace(/\n/g, " ");
    const score = (doc.similarity || doc.vectorScore || doc.score || 0).toFixed(3);
    context += `\n${i + 1}. ${doc.fileName} (スコア: ${score})\n${preview}\n`;
  });

  return context;
}

// ================================
//  20. インデックス更新機能
// ================================

/**
 * Google Driveのファイルを差分インデックス更新
 * 前回更新以降に変更されたファイルのみをインデックスに追加/更新
 * @returns {Object} インデックス更新結果（added, updated, unchanged, totalFiles, lastIndex）
 */
/**
 * フォルダ内の全ファイルを再帰的に取得（サブフォルダを含む）
 * @param {Folder} folder - 対象フォルダ
 * @param {Array} mimeTypes - 取得するMIMEタイプ配列
 * @param {Set} visitedFolders - 訪問済みフォルダIDのセット（無限ループ防止）
 * @returns {Array} ファイルオブジェクトの配列
 */
function getAllFilesRecursive(folder, mimeTypes, visitedFolders) {
  const allFiles = [];
  
  // フォルダIDを追加（循環参照防止）
  const folderId = folder.getId();
  if (visitedFolders.has(folderId)) {
    console.log("【サブフォルダ】循環参照を検出スキップ:", folder.getName());
    return allFiles;
  }
  visitedFolders.add(folderId);
  
  console.log("【サブフォルダ】処理中:", folder.getName());
  
  // 現在のフォルダ内のファイルを収集
  for (const mimeType of mimeTypes) {
    const iterator = folder.getFilesByType(mimeType);
    while (iterator.hasNext()) {
      allFiles.push(iterator.next());
    }
  }
  
  // サブフォルダを再帰的に処理
  const subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    const subFolder = subFolders.next();
    const subFiles = getAllFilesRecursive(subFolder, mimeTypes, visitedFolders);
    allFiles.push(...subFiles);
  }
  
  return allFiles;
}

function incrementalIndexGoogleDrive() {
  console.log("【増量更新】インデックス更新開始: " + new Date());

  const lastIndexTime = getLastIndexTime();
  console.log("【増量更新】最終インデックス時刻:", lastIndexTime);

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const sheet = getRagSheet();

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

  // サブフォルダを含む全ファイルを再帰的に取得
  const visitedFolders = new Set();
  const allFiles = getAllFilesRecursive(folder, mimeTypes, visitedFolders);

  console.log(`【増量更新】フォルダ内のファイル数（サブフォルダ含む）: ${allFiles.length}`);

  const currentMapping = getFileMapping();
  const newMapping = {};

  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const now = new Date();

  for (const file of allFiles) {
    const fileId = file.getId();
    const fileName = file.getName();
    const mimeType = file.getMimeType();
    const lastUpdated = file.getLastUpdated();

    const lastUpdatedStr = lastUpdated.toISOString();
    newMapping[fileId] = lastUpdatedStr;

    const previousUpdateTime = currentMapping[fileId];

    if (!previousUpdateTime) {
      console.log(`【増量更新】[新規] ${fileName}`);
      const success = indexSingleFile(sheet, file, fileId, fileName, mimeType);
      if (success) addedCount++;
    } else if (previousUpdateTime !== lastUpdatedStr) {
      console.log(`【増量更新】[更新] ${fileName}`);
      deleteChunksByFileId(sheet, fileId);
      const success = indexSingleFile(sheet, file, fileId, fileName, mimeType);
      if (success) updatedCount++;
    } else {
      unchangedCount++;
      console.log(`【増量更新】[済] ${fileName} (変更なし)`);
    }
  }

  const currentFileIds = allFiles.map(f => f.getId());
  const indexedFileIds = Object.keys(currentMapping);

  for (const indexedId of indexedFileIds) {
    if (!currentFileIds.includes(indexedId)) {
      console.log(`【増量更新】[削除] FileId: ${indexedId} - インデックスから削除`);
      deleteChunksByFileId(sheet, indexedId);
    }
  }

  setFileMapping(newMapping);
  setLastIndexTime(now);

  console.log("【増量更新】完了:", { added: addedCount, updated: updatedCount, unchanged: unchangedCount });

  return {
    added: addedCount,
    updated: updatedCount,
    unchanged: unchangedCount,
    totalFiles: allFiles.length,
    lastIndex: now
  };
}

/**
 * 単一ファイルをインデックスにチャンクとして分割して追加
 * @param {Sheet} sheet - RAGシートオブジェクト
 * @param {File} file - Google Driveファイルオブジェクト
 * @param {string} fileId - ファイルID
 * @param {string} fileName - ファイル名
 * @param {string} mimeType - MIMEタイプ
 * @returns {boolean} 成功した場合true
 */
function indexSingleFile(sheet, file, fileId, fileName, mimeType) {
  try {
    const text = extractText(fileId, mimeType, fileName);

    if (!text || text.trim().length === 0) {
      console.log(`  └ 空ファイルのためスキップ: ${fileName}`);
      return false;
    }

    const chunks = splitTextIntoChunks(text);
    const totalChunks = chunks.length;

    chunks.forEach((chunk, index) => {
      const embedding = getEmbeddingWithCache(chunk);
      if (embedding) {
        // createChunkMetadataを活用してメタデータを生成
        const metadata = createChunkMetadata(chunk, fileId, fileName, index, totalChunks);
        // チャンクからキーワードを抽出して追加
        const keywords = extractKeywords(chunk);

        sheet.appendRow([
          metadata.fileId,
          metadata.fileName,
          mimeType, // MimeType列を追加
          metadata.text,
          JSON.stringify(embedding),
          metadata.chunkIndex,
          new Date(),
          metadata.charCount,
          metadata.preview,
          metadata.totalChunks,
          keywords.join(",") // Keywords列に保存
        ]);
      }
      Utilities.sleep(300);
    });

    console.log(`  └ ${chunks.length} チャンクを追加（メタデータ付与済）`);
    return true;
  } catch (error) {
    console.error(`  └ エラー: ${fileName}`, error);
    return false;
  }
}

function deleteChunksByFileId(sheet, fileId) {
  try {
    const data = sheet.getDataRange().getValues();
    const rowsToDelete = [];

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === fileId) {
        rowsToDelete.push(i + 1);
      }
    }

    rowsToDelete.reverse().forEach(rowNum => {
      sheet.deleteRow(rowNum);
    });

    console.log(`  └ ${rowsToDelete.length} チャンクを削除`);
  } catch (error) {
    console.error("  └ 削除エラー:", error);
  }
}

// ================================
//  21. トリガー管理
// ================================

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

function removeAutoIndexTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'incrementalIndexGoogleDrive') {
      ScriptApp.deleteTrigger(trigger);
      console.log("【トリガー】自動更新トリガーを削除しました");
    }
  });
}

function initIncrementalIndex() {
  console.log("【初期化】初回インデックス実行開始");
  const result = incrementalIndexGoogleDrive();
  console.log("【初期化】完了:", result);
  return result;
}

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

// ================================
//  22. RAG管理画面用API
// ================================

/**
 * RAGの統計情報を取得（rag-manager.html用）
 * @returns {Object} 統計情報オブジェクト
 */
function getRagStats() {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return {
        docCount: 0,
        chunkCount: 0,
        lastUpdate: '未実行'
      };
    }

    // チャンク数（データ行数）
    const chunkCount = data.length - 1;

    // ドキュメント数をカウント（重複 제외）
    const fileIds = new Set();
    for (let i = 1; i < data.length; i++) {
      const fileId = data[i][0]; // FileId列
      if (fileId) {
        fileIds.add(fileId);
      }
    }
    const docCount = fileIds.size;

    // 最終更新日時
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
    return {
      docCount: 0,
      chunkCount: 0,
      lastUpdate: 'エラー'
    };
  }
}

/**
 * インデックス済みファイル一覧を取得（rag-manager.html用）
 * @returns {Object} ファイル一覧オブジェクト
 */
function getIndexedFiles() {
  try {
    const sheet = getRagSheet();
    const data = sheet.getDataRange().getValues();

    if (data.length <= 1) {
      return { files: [] };
    }

    // ファイルごとにチャンク数をカウント
    const fileInfo = {};

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const fileId = row[0]; // FileId
      const fileName = row[1]; // FileName
      const mimeType = row[2]; // MimeType
      const updatedAt = row[5]; // UpdatedAt

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
 * 特定のファイルのチャンク一覧を取得（rag-manager.html用）
 * @param {string} fileId - ファイルID
 * @returns {Object} チャンク一覧オブジェクト
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
      const rowFileId = row[0]; // FileId

      if (rowFileId === fileId) {
        chunks.push({
          fileId: row[0],
          fileName: row[1],
          mimeType: row[2],
          textChunk: row[3], // TextChunk
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
 * DriveフォルダIDを取得（rag-manager.html用）
 * @returns {string} フォルダID
 */
function getDriveFolderId() {
  return DRIVE_FOLDER_ID;
}

/**
 * ファイルをGoogle Driveにアップロード（rag-manager.html用）
 * @param {string} fileName - ファイル名
 * @param {string} base64Data - Base64エンコードされたファイルデータ
 * @param {string} mimeType - MIMEタイプ
 * @returns {Object} アップロード結果
 */
function uploadFileToDrive(fileName, base64Data, mimeType) {
  try {
    if (!DRIVE_FOLDER_ID) {
      return { success: false, error: 'DRIVE_FOLDER_IDが設定されていません' };
    }

    // Base64データをデコード
    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType,
      fileName
    );

    // フォルダを取得してファイルをアップロード
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
 * インデックスを実行（rag-manager.html用）
 * @returns {Object} 実行結果
 */
function triggerIndexing() {
  try {
    logInfo('[triggerIndexing] インデックス更新を開始します');
    const result = incrementalIndexGoogleDrive();
    
    // resultがundefinedまたはnullの場合のチェック
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
 * アップロードされたファイルからテキストを抽出（インデックスには追加しない）
 * ファイルはその会話の中でのみ一時的に参照される
 * @param {Array} uploadedFiles - アップロードされたファイルの配列
 * @returns {string} 抽出されたテキスト（コンテキスト用）
 */
function extractTextFromUploadedFiles(uploadedFiles) {
  logTrace("[UPLOAD:TEMP] ファイルからテキスト抽出開始 - 件数:", uploadedFiles ? uploadedFiles.length : 'undefined');
  
  if (!uploadedFiles || uploadedFiles.length === 0) {
    logWarn("[UPLOAD:TEMP] ファイル配列が空またはundefined");
    return "";
  }
  
  let context = "";
  
  try {
    logTrace("[UPLOAD:TEMP] forEach開始 - 配列長:", uploadedFiles.length);
    
    // アップロードされたファイルごとにテキストを抽出
    uploadedFiles.forEach((file, index) => {
      logTrace("[UPLOAD:TEMP] ファイル処理開始 - index:", index);
      
      const fileId = file.fileId;
      const fileName = file.fileName;
      const mimeType = file.mimeType;
      
      logTrace("[UPLOAD:TEMP] ファイル情報 - fileId:", fileId, "fileName:", fileName, "mimeType:", mimeType);
      
      // 必須パラメータのチェック
      if (!fileId) {
        logError("[UPLOAD:TEMP] fileIdがありません - index:", index);
        context += `\n【添付ファイル ${index + 1}】\n`;
        context += `※ fileIdがありません。\n`;
        return;
      }
      
      try {
        // ファイルからテキストを抽出
        logTrace("[UPLOAD:TEMP] extractText呼び出し開始 - fileName:", fileName);
        const text = extractText(fileId, mimeType, fileName);
        logTrace("[UPLOAD:TEMP] extractText完了 - text length:", text ? text.length : 0);
        
        if (text && text.trim().length > 0) {
          // テキストをチャンクに分割（セマンティック分割を使用）
          logTrace("[UPLOAD:TEMP] splitTextIntoChunks開始");
          const chunks = splitTextIntoChunks(text);
          logTrace("[UPLOAD:TEMP] splitTextIntoChunks完了 - chunks:", chunks.length);
          
          context += `\n【添付ファイル ${index + 1}: ${fileName}】\n`;
          context += `ファイル形式: ${mimeType}\n`;
          context += `文字数: ${text.length}\n\n`;
          
          // チャンク化されたテキストを追加
          chunks.forEach((chunk, chunkIndex) => {
            context += `[${chunkIndex + 1}] ${chunk}\n\n`;
          });
          
          logTrace("[UPLOAD:TEMP] テキスト抽出完了:", fileName, "文字数:", text.length, "チャンク数:", chunks.length);
        } else {
          logWarn("[UPLOAD:TEMP] テキストが空:", fileName);
          context += `\n【添付ファイル ${index + 1}: ${fileName}】\n`;
          context += `※ このファイルからテキストを抽出できませんでした。\n`;
        }
      } catch (extractError) {
        logError("[UPLOAD:TEMP] テキスト抽出エラー - fileName:", fileName, "error:", extractError.message, "stack:", extractError.stack);
        context += `\n【添付ファイル ${index + 1}: ${fileName}】\n`;
        context += `※ テキスト抽出中にエラーが発生しました: ${extractError.message}\n`;
      }
    });
    
    logTrace("[UPLOAD:TEMP] forEach完了 - context length:", context.length);
    
    if (context) {
      context = "【アップロードされたファイル（この会話のみで使用）】\n" + context;
      context += "\n↑ 上記の添付ファイルの内容を参照して回答してください。\n";
    }
    
    logTrace("[UPLOAD:TEMP] 抽出完了 - 最終context length:", context.length);
    return context;
    
  } catch (error) {
    logError("[UPLOAD:TEMP] 全体エラー:", error.message, "stack:", error.stack);
    return "";
  }
}

// ================================
//  23. Webチャット画面用API
// ================================

/**
 * Webチャット用のセッションデータを生成
 * 複数のセッションを管理するために一意のセッションIDを生成
 */
function generateSessionId() {
  const timestamp = new Date().getTime();
  const random = Math.random().toString(36).substring(2, 15);
  return 'web_' + timestamp + '_' + random;
}

/**
 * WebチャットAPI（chat.htmlから呼び出される）
 * @param {Object} request - リクエストオブジェクト
 * @returns {Object} レスポンスオブジェクト
 */
function chatAPI(request) {
  const action = request.action;

  try {
    // アクションに応じた処理を実行
    switch (action) {
      case 'send':
        return handleChatMessage(request);
      case 'clear':
        return handleClearHistory(request);
      case 'getHistory':
        return handleGetHistory(request);
      case 'export':
        return handleExportHistory(request);
      case 'agentContinue':
        return handleAgentContinue(request);
      case 'agentStart':
        return handleAgentStart(request);
      default:
        return { success: false, error: '不明なアクション: ' + action };
    }
  } catch (error) {
    logError('[chatAPI] エラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * エージェントモードを開始（新規反復検索）
 */
function handleAgentStart(request) {
  const clientSessionId = request.sessionId;
  const userMessage = request.message;
  
  if (!userMessage || userMessage.trim() === '') {
    return { success: false, error: 'メッセージが空です' };
  }

  if (!clientSessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  // Webセッション用のプレフィックスを付けて履歴を管理
  const webSessionId = 'WEB_' + clientSessionId;

  // 履歴を取得
  const history = getHistory(webSessionId);
  history.push({ role: 'user', content: userMessage });
  const trimmedHistory = history.slice(-10);

  // 反復エージェントを新規開始
  const agentResult = callChatGPTWithAgentIterative(userMessage, trimmedHistory, webSessionId, {
    continueIteration: false,
    maxIterations: AGENT_MODE_CONFIG.MAX_ITERATIONS || 3
  });

  // 履歴に保存
  trimmedHistory.push({ role: 'assistant', content: agentResult.finalResponse });
  saveHistory(webSessionId, trimmedHistory);

  logInfo('[chatAPI] エージェント開始完了 - sessionId:', clientSessionId, 'isComplete:', agentResult.isComplete);

  return {
    success: true,
    reply: agentResult.finalResponse,
    thinkingInfo: agentResult.thinkingInfo,
    iteration: agentResult.iteration,
    maxIterations: agentResult.maxIterations,
    isComplete: agentResult.isComplete,
    needsMoreSearch: agentResult.needsMoreSearch,
    sessionId: clientSessionId,
    timestamp: new Date().toISOString()
  };
}

/**
 * エージェントの反復を継続（次の反復へ進む）
 */
function handleAgentContinue(request) {
  const clientSessionId = request.sessionId;
  
  if (!clientSessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  // Webセッション用のプレフィックスを付けて履歴を管理
  const webSessionId = 'WEB_' + clientSessionId;

  // 履歴を取得
  const history = getHistory(webSessionId);
  const trimmedHistory = history.slice(-10);

  // 前回の状態を取得
  const savedState = getAgentState(webSessionId);
  if (!savedState || !savedState.userMessage) {
    return { success: false, error: 'エージェントの状態が見つかりません。再度開始してください。' };
  }

  const userMessage = savedState.userMessage;

  // 反復エージェントを継続（次の反復へ）
  const agentResult = callChatGPTWithAgentIterative(userMessage, trimmedHistory, webSessionId, {
    continueIteration: true,
    maxIterations: AGENT_MODE_CONFIG.MAX_ITERATIONS || 3
  });

  // 履歴に保存
  trimmedHistory.push({ role: 'assistant', content: agentResult.finalResponse });
  saveHistory(webSessionId, trimmedHistory);

  logInfo('[chatAPI] エージェント継続完了 - sessionId:', clientSessionId, 'isComplete:', agentResult.isComplete, 'iteration:', agentResult.iteration);

  return {
    success: true,
    reply: agentResult.finalResponse,
    thinkingInfo: agentResult.thinkingInfo,
    iteration: agentResult.iteration,
    maxIterations: agentResult.maxIterations,
    isComplete: agentResult.isComplete,
    needsMoreSearch: agentResult.needsMoreSearch,
    sessionId: clientSessionId,
    timestamp: new Date().toISOString()
  };
}

/**
 * ChatGPT API用のメッセージ配列を構築
 * 順序: system → user(新規) → history
 * 
 * @param {Object} promptResult - generateFullPromptで生成されたプロンプト結果オブジェクト
 * @param {Array} userMessage - 過去の会話履歴（ChatGPT APIのmessages形式）
 * @returns {Array} ChatGPT API用のmessages配列
 */
function buildChatMessages(promptResult, userMessage) {
  const messages = [];

  // 1. 最初にsystemを追加
  messages.push({ role: "system", content: promptResult.system });

  // 2. 次に新しいuserメッセージを追加
  messages.push({ role: "user", content: promptResult.user });

  // 3. 最後にhistoryを追加
  if (userMessage && userMessage.length > 0) {
    userMessage.forEach(msg => messages.push(msg));
  }

  return messages;
}

/**
 * チャットメッセージを処理
 */
function handleChatMessage(request) {
  const clientSessionId = request.sessionId;
  const userMessage = request.message;
  const mode = request.mode || 'free'; // free, summary, polite, bullet, translate
  const aiMode = request.aiMode || 'llm'; // 'llm' = RAG検索, 'chatgpt' = ChatGPTのみ
  
  // uploadedFilesのチェックを強化
  let uploadedFiles = [];
  try {
    if (request.uploadedFiles) {
      if (Array.isArray(request.uploadedFiles)) {
        uploadedFiles = request.uploadedFiles;
      } else if (typeof request.uploadedFiles === 'string') {
        // 文字列で来的場合JSONとしてパースを試みる
        try {
          uploadedFiles = JSON.parse(request.uploadedFiles);
          logTrace("[chatAPI] uploadedFilesをJSONパース:", uploadedFiles.length);
        } catch (e) {
          logError("[chatAPI] uploadedFiles JSONパースエラー:", e.message);
        }
      }
    }
  } catch (e) {
    logError("[chatAPI] uploadedFiles処理エラー:", e.message);
  }

  logInfo("[chatAPI] メッセージ受信 - sessionId:", clientSessionId, "aiMode:", aiMode, "uploadedFiles件数:", uploadedFiles.length);
  logTrace("[chatAPI] uploadedFiles詳細:", JSON.stringify(uploadedFiles).substring(0, 500));
  logTrace("[chatAPI] request.uploadedFiles raw:", request.uploadedFiles ? "存在" : "undefined/null");
  if (request.uploadedFiles) {
    logTrace("[chatAPI] request.uploadedFiles type:", typeof request.uploadedFiles);
    logTrace("[chatAPI] request.uploadedFiles isArray:", Array.isArray(request.uploadedFiles));
  }

  if (!userMessage || userMessage.trim() === '') {
    if (uploadedFiles.length === 0) {
      return { success: false, error: 'メッセージが空です' };
    }
    // ファイルのみがアップロードされている場合はデフォルトメッセージを使用
  }

  if (!clientSessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }
  
  // アップロードされたファイルからテキストを抽出（一時的なコンテキスト）
  // RAGインデックスには追加されず、その会話の中でのみ使用される
  let fileContext = '';
  if (uploadedFiles.length > 0) {
    logTrace("[chatAPI] extractTextFromUploadedFiles呼び出し前 - uploadedFiles:", uploadedFiles.length, "件");
    try {
      fileContext = extractTextFromUploadedFiles(uploadedFiles);
      logTrace("[chatAPI] extractTextFromUploadedFiles完了 - fileContext長:", fileContext ? fileContext.length : 0);
    } catch (e) {
      logError("[chatAPI] ファイル処理エラー:", e.message, "stack:", e.stack);
    }
  } else {
    logTrace("[chatAPI] uploadedFilesが空のためスキップ");
  }

  // プロンプトテンプレートを選択
  let prompt = userMessage;
  if (mode === 'summary') {
    prompt = PROMPT_TEMPLATES.summary(userMessage);
  } else if (mode === 'polite') {
    prompt = PROMPT_TEMPLATES.polite(userMessage);
  } else if (mode === 'bullet') {
    prompt = PROMPT_TEMPLATES.bullet(userMessage);
  } else if (mode === 'translate') {
    prompt = PROMPT_TEMPLATES.translate(userMessage);
  }

  // Webセッション用のプレフィックスを付けて履歴を管理（LINEの履歴と分離）
  const webSessionId = 'WEB_' + clientSessionId;

  // Webセッション用の履歴を取得
  const history = getHistory(webSessionId);

  // 履歴にリクエストのメッセージを追加
  history.push({ role: 'user', content: prompt });
  const trimmedHistory = history.slice(-10);

  let botReply = '';

  // AIモードに応じて処理を変更
  if (aiMode === 'agent') {
    // エージェントモード（自律検索・調査）
    logTrace('[chatAPI] エージェントモードで回答 - sessionId:', clientSessionId);
    const agentResult = callChatGPTWithAgent(prompt, trimmedHistory, webSessionId);
    // エージェント結果がオブジェクトの場合（思考過程を含む）
    if (agentResult && agentResult.thinkingSteps) {
      return {
        success: true,
        reply: agentResult.finalResponse,
        thinkingSteps: agentResult.thinkingSteps,
        sessionId: clientSessionId,
        timestamp: new Date().toISOString()
      };
    }
    botReply = agentResult;
  } else if (aiMode === 'chatgpt') {
    // ChatGPTモード（RAGなし、ただし添付ファイルはコンテキストとして読む）
    // generateFullPromptを使用して、管理者・ユーザーのプロンプトを設定
    logTrace('[chatAPI] ChatGPTモードで回答 - sessionId:', clientSessionId);

    // generateFullPromptでシステムプロンプトを生成（添付ファイルのコンテキストを含める）
    const promptResult = generateFullPrompt(fileContext);

    // buildChatMessages関数を使用してメッセージ配列を構築
    const chatMessages = buildChatMessages(promptResult, trimmedHistory);

    logTrace('[chatAPI] ChatGPTモード - 管理者プロンプト: ' + promptResult.hasAdminPrompt + ', ユーザープロンプト: ' + promptResult.hasUserPrompt);
    botReply = callChatGPT(chatMessages);
  } else {
    // RAG検索モード（デフォルト）
    logTrace('[chatAPI] RAGモードで回答 - sessionId:', clientSessionId);
    // RAG-enhanced ChatGPTを呼び出し（WebセッションIDをuserIdとして渡してキャッシュをセッション別に保存）
    botReply = callChatGPTWithRAGEnhanced(prompt, trimmedHistory, webSessionId, fileContext);
  }

  // 応答を履歴に保存
  trimmedHistory.push({ role: 'assistant', content: botReply });
  saveHistory(webSessionId, trimmedHistory);

  // アップロードされたファイルを一時保存していた場合は削除（その会話のみで使用されたため）
  if (uploadedFiles && uploadedFiles.length > 0) {
    try {
      deleteUploadedFiles(uploadedFiles);
    } catch (e) {
      logWarn("[chatAPI] ファイル削除エラー:", e.message);
    }
  }

  logInfo('[chatAPI] チャット完了 - sessionId:', clientSessionId, 'mode:', mode, 'aiMode:', aiMode);

  return {
    success: true,
    reply: botReply,
    sessionId: clientSessionId,
    timestamp: new Date().toISOString()
  };
}

/**
 * アップロードされたファイルをGoogle Driveから削除
 * Webチャットで添付されたファイルはその会話のみで一時的に使用されるため、
 * 回答完了后将ファイルを削除
 * @param {Array} uploadedFiles - アップロードされたファイルの配列
 */
function deleteUploadedFiles(uploadedFiles) {
  if (!uploadedFiles || uploadedFiles.length === 0) {
    return;
  }

  logInfo("[DELETE:UPLOAD] アップロードされたファイルの一時削除開始 - 件数:", uploadedFiles.length);

  let deletedCount = 0;
  let failedCount = 0;

  uploadedFiles.forEach((file, index) => {
    const fileId = file.fileId;
    const fileName = file.fileName;

    if (!fileId) {
      logWarn("[DELETE:UPLOAD] fileIdがありません - index:", index, "fileName:", fileName);
      failedCount++;
      return;
    }

    try {
      // ファイルをゴミ箱に移動（完全削除ではなくゴミ箱に入る）
      DriveApp.getFileById(fileId).setTrashed(true);
      deletedCount++;
      logTrace("[DELETE:UPLOAD] ファイル削除成功 - fileName:", fileName, "fileId:", fileId);
    } catch (error) {
      logError("[DELETE:UPLOAD] ファイル削除失敗 - fileName:", fileName, "fileId:", fileId, "error:", error.message);
      failedCount++;
    }
  });

  logInfo("[DELETE:UPLOAD] アップロードされたファイル削除完了 - 成功:", deletedCount, "件, 失敗:", failedCount, "件");
}

/**
 * 会話履歴をクリア
 */
function handleClearHistory(request) {
  const sessionId = request.sessionId;

  if (!sessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  try {
    const cache = CacheService.getScriptCache();
    if (cache) {
      // Webセッション用のプレフィックスを付けて削除
      const webSessionId = 'WEB_' + sessionId;
      // 会話履歴を削除
      cache.remove(webSessionId);
      // RAGキャッシュもクリア
      clearAllQueryCaches();
    }

    logInfo('[chatAPI] 履歴をクリア - sessionId:', sessionId);

    return {
      success: true,
      message: '会話履歴をクリアしました'
    };
  } catch (error) {
    logError('[chatAPI] 履歴クリアエラー:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 会話履歴を取得
 */
function handleGetHistory(request) {
  const sessionId = request.sessionId;

  if (!sessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  const history = getHistory(sessionId);

  return {
    success: true,
    history: history,
    sessionId: sessionId
  };
}

/**
 * 会話履歴をエクスポート
 */
function handleExportHistory(request) {
  const sessionId = request.sessionId;
  const format = request.format || 'json'; // json, txt

  if (!sessionId) {
    return { success: false, error: 'セッションIDがありません' };
  }

  const history = getHistory(sessionId);

  if (!history || history.length === 0) {
    return { success: false, error: 'エクスポートする履歴がありません' };
  }

  let content = '';
  let mimeType = '';

  if (format === 'txt') {
    // テキスト形式でエクスポート
    content = '=== AI Chat エクスポート ===\n';
    content += 'エクスポート日時: ' + new Date().toLocaleString('ja-JP') + '\n\n';

    history.forEach((msg, index) => {
      const role = msg.role === 'user' ? 'あなた' : 'AI';
      content += '--- ' + role + ' ---\n';
      content += msg.content + '\n\n';
    });

    mimeType = 'text/plain';
  } else {
    // JSON形式でエクスポート
    content = JSON.stringify({
      exportedAt: new Date().toISOString(),
      sessionId: sessionId,
      messages: history
    }, null, 2);

    mimeType = 'application/json';
  }

  logInfo('[chatAPI] エクスポート完了 - sessionId:', sessionId, 'format:', format);

  return {
    success: true,
    content: content,
    format: format,
    mimeType: mimeType,
    fileName: 'chat_export_' + sessionId + '.' + format
  };
}

/**
 * 新しいセッションを開始（新規会話クリア）
 */
function createNewSession() {
  const newSessionId = generateSessionId();

  return {
    success: true,
    sessionId: newSessionId,
    message: '新しいセッションを開始しました'
  };
}

// ================================
//  24. ログ取得画面API
// ================================
/**
 * スプレッドシートからログを取得
 * ログモニタリングHTMLから呼び出される
 * @param {number} limit - 取得するログ件数（デフォルト100件）
 * @returns {Array} ログデータの配列
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

    // 最後の行から逆順で取得（新しいログが上）
    const startRow = Math.max(2, lastRow - maxLimit + 1);
    const numRows = lastRow - startRow + 1;

    const data = sheet.getRange(startRow, 1, numRows, 3).getValues();

    // 逆順で返す（新しいログが先）
    const logs = [];
    for (let i = data.length - 1; i >= 0; i--) {
      const [timestamp, level, message] = data[i];
      // timestampを文字列に変換
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

    // 明示的にJSONとして返す
    return Utilities.jsonStringify(logs);

  } catch (error) {
    return [];
  }
}

/**
 * ログのリアルタイム監視用関数
 * 、前回の最終ログIDからの新しいログのみを返す
 * @param {string} lastTimestamp - 前回の最終ログのタイムスタンプ
 * @returns {Array} 新規ログの配列
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

    // 最後の行から新しいログを探す
    for (let i = data.length - 1; i >= 1; i--) {
      const [timestamp, level, message] = data[i];

      // 前回の最終タイムスタンプ以后的ログのみを追加
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

// ================================
//  25. 設定画面用API（統合版）
// ================================

/** 汎用設定取得関数: definitions, props, prefix, transform, isBoolean */
const getSettings = (defs, props, prefix = '', transform = (v, def) => v, isBool = false) => {
  const result = {};
  for (const [k, def] of Object.entries(defs)) {
    let v = props.getProperty(k);
    if (v === null || v === undefined || v === '') { v = def.defaultValue; props.setProperty(k, v); }
    result[prefix + (def.paramName || k)] = isBool ? v !== 'false' : transform(v, def);
  }
  return result;
};

  /** 設定更新汎用関数 */
  const updateSetting_ = (key, value, defs, props) => {
    if (!Object.keys(defs).includes(key)) return { success: false, error: '許可されていないキー' };
    const def = defs[key];
    // Boolean値の場合は検証をスキップ
    if (def.isBoolean) {
      props.setProperty(key, String(value)); logInfo('[updateSetting]', key, value);
      return { success: true, key, value };
    }
    if (!def.isString && !def.isSelect && value) { const n = parseFloat(value); if (isNaN(n) || n < def.min || n > def.max) return { success: false, error: `${def.min}〜${def.max}` }; }
    props.setProperty(key, String(value)); logInfo('[updateSetting]', key, value);
    return { success: true, key, value };
  };

/** 設定全取得 */
const getAllSettings = (defs, props) => {
  const p = {};
  for (const [k, def] of Object.entries(defs)) {
    let v = props.getProperty(k);
    if (v === null || v === undefined || v === '') { v = def.defaultValue; props.setProperty(k, v); }
    p[k] = v;
  }
  return { success: true, properties: p, definitions: defs };
};

function supportsTopK(model) { return !MODELS_WITHOUT_TOP_K.includes(model); }
function getLlmParams() { try { return getSettings(LLM_PARAM_DEFINITIONS, userProps, '', (v, def) => v === '' ? NaN : (def.isString || def.isSelect ? v : parseFloat(v)), false); } catch(e) { return getLlmParamsDefault(); } }
function getLlmParamsDefault() { const d = {}; for (const [k,def] of Object.entries(LLM_PARAM_DEFINITIONS)) d[def.paramName] = (def.isString || def.isSelect) ? def.defaultValue : parseFloat(def.defaultValue); return d; }
function updateLlmParam(k, v) { return updateSetting_(k, v, LLM_PARAM_DEFINITIONS, userProps); }
function getLlmSettingsData() { return getAllSettings(LLM_PARAM_DEFINITIONS, userProps); }
function getSearchParams() { try { return getSettings(SEARCH_PARAM_DEFINITIONS, userProps, '', (v, def) => v, true); } catch(e) { return getSearchParamsDefault(); } }
function getSearchParamsDefault() { const d = {}; for (const [k,def] of Object.entries(SEARCH_PARAM_DEFINITIONS)) d[k] = def.defaultValue !== 'false'; return d; }
function updateSearchParam(k, v) { return updateSetting_(k, v, SEARCH_PARAM_DEFINITIONS, userProps); }
function getSearchSettingsData() { return getAllSettings(SEARCH_PARAM_DEFINITIONS, userProps); }

/**
 * デバッグモードが有効かを確認
 * @returns {boolean} デバッグモード有効な場合true
 */
function isDebugModeEnabled() {
  const debugMode = scriptProps.getProperty('DEBUG_MODE');
  return debugMode === 'true';
}

/**
 * 設定値の初期化（存在しないキーをデフォルト値で作成）
 * @returns {Object} 初期化結果
 */
function initializeSettings() {
  try {
    const results = {
      created: [],
      updated: [],
      errors: []
    };

    // 既存の定数マップを返す（これらはScript Propertiesに存在しない）
    return {
      success: true,
      message: '設定定義を返却しました',
      definitions: SETTING_DEFINITIONS
    };
  } catch (error) {
    logError('[initializeSettings] エラー:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Script Propertiesから全設定を取得（settings.html用）
 * 存在しない場合はデフォルト値で初期化
 * @returns {Object} 設定情報オブジェクト
 */
function getSettingsData() {
  try {
    const properties = {};
    const missingKeys = [];

    // 設定項目リスト
    const propKeys = Object.keys(SETTING_DEFINITIONS);

    // 各プロパティを取得・確認
    for (const key of propKeys) {
      const def = SETTING_DEFINITIONS[key];
      let value = scriptProps.getProperty(key);

      // プロパティが存在しない場合
      if (value === null || value === undefined || value === '') {
        // デフォルト値を設定（ダミー値は空文字列）
        if (def.defaultValue) {
          // ブール値の場合はデフォルト値をセット
          scriptProps.setProperty(key, def.defaultValue);
          value = def.defaultValue;
          logInfo('[getSettingsData] デフォルト値を設定:', key, '=', def.defaultValue);
        }
        missingKeys.push(key);
      }

      properties[key] = value || '';
    }

    // 設定定義と初期化情報を返す
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
 * Script Propertiesを更新（settings.html用）
 * @param {string} key - プロパティキー
 * @param {string} value - 設定値
 * @returns {Object} 更新結果
 */
function updateSetting(key, value) {
  try {
    // 許可されたキーのリスト
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
      return {
        success: false,
        error: '許可されていないキーです: ' + key
      };
    }

    // プロパティを更新
    scriptProps.setProperty(key, value);

    logInfo('[updateSetting] 設定を更新:', key);

    return {
      success: true,
      key: key,
      value: value
    };
  } catch (error) {
    logError('[updateSetting] エラー:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ================================
//  26. テスト用関数
// ================================

/**
 * フォルダツリーを再帰的に取得（サブフォルダ含む）
 * @param {Folder} folder - 対象フォルダ
 * @param {Set} visitedFolders - 訪問済みフォルダIDのセット
 * @param {number} depth - 現在の深さ（ルートは0）
 * @returns {Array} フォルダ・ファイル情報の配列
 */
function getFolderTreeRecursive(folder, visitedFolders, depth = 0) {
  const result = [];
  
  // 循環参照防止
  const folderId = folder.getId();
  if (visitedFolders.has(folderId)) {
    return result;
  }
  visitedFolders.add(folderId);
  
  // 現在のフォルダのファイルを収集
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
  
  // ファイルを追加
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
  
  // サブフォルダを追加
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
    
    // サブフォルダ内のアイテムを追加（深い階層）
    const subItems = getFolderTreeRecursive(subFolder, visitedFolders, depth + 1);
    result.push(...subItems);
  }
  
  return result;
}

/**
 * 指定フォルダのファイル一覧を取得（rag-manager.html用）
 * サブフォルダを含む階層構造を返す
 * @returns {Object} ファイル一覧オブジェクト
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
 * アップロードされたファイルを削除（rag-manager.html用）
 * @param {string} fileId - ファイルID
 * @returns {Object} 削除結果
 */
function deleteUploadedFile(fileId) {
  try {
    if (!fileId) {
      return { success: false, error: 'fileIdが指定されていません' };
    }

    // RAGシートから 해당ファイルのチャンクを削除
    const sheet = getRagSheet();
    deleteChunksByFileId(sheet, fileId);

    // Google Driveからファイルを削除
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
 * 全プロパティをJSON形式でエクスポート
 * Script Properties, User Properties, プロンプトテンプレート定義を含む
 * @returns {Object} エクスポート結果
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

    // Script Propertiesを取得
    const scriptPropsData = scriptProps.getProperties();
    exportData.scriptProperties = scriptPropsData || {};

    // User Propertiesを取得
    const userPropsData = userProps.getProperties();
    exportData.userProperties = userPropsData || {};

    // プロンプトテンプレートを取得
    for (const key of Object.keys(PROMPT_TEMPLATE_DEFINITIONS)) {
      const value = scriptProps.getProperty(key);
      exportData.promptTemplates[key] = value || '';
    }

    // 管理者プロンプトを取得
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
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * JSON形式からプロパティをインポート
 * @param {string} jsonString - インポートするJSON文字列
 * @returns {Object} インポート結果
 */
function importAllProperties(jsonString) {
  try {
    if (!jsonString || jsonString.trim() === '') {
      return {
        success: false,
        error: 'JSONデータが空です'
      };
    }

    const importData = JSON.parse(jsonString);
    
    let importedCount = 0;
    let errorCount = 0;
    const errors = [];

    // Script Propertiesをインポート
    if (importData.scriptProperties && typeof importData.scriptProperties === 'object') {
      for (const [key, value] of Object.entries(importData.scriptProperties)) {
        try {
          // 許可されたキーのみインポート
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

    // User Propertiesをインポート
    if (importData.userProperties && typeof importData.userProperties === 'object') {
      for (const [key, value] of Object.entries(importData.userProperties)) {
        try {
          // 許可されたキーのみインポート
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

    // プロンプトテンプレートをインポート
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

    // 管理者プロンプトをインポート
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
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 特定のファイルを強制的に再インデックス
 * @param {string} fileId - Google DriveのファイルID
 */
function forceReindexFile(fileId) {

  try {
    const file = DriveApp.getFileById(fileId);
    const fileName = file.getName();
    const mimeType = file.getMimeType();

    logInfo("[FORCE] 強制再インデックス開始:", fileName, mimeType);

    const sheet = getRagSheet();

    // 既存のチャンクを削除
    deleteChunksByFileId(sheet, fileId);

    // ファイルを再インデックス
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
 * @param {string} fileId - Google DriveのExcelファイルID
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

    // シートを初期化してヘッダーを追加
    resetAndInitializeRagSheet();
    logInfo("[CLEAR] ヘッダーを追加しました");

    // ファイルマッピングをクリア
    setFileMapping({});
    // ScriptPropertiesから削除
    scriptProps.deleteProperty(LAST_INDEX_KEY);
    logInfo("[CLEAR] ファイルマッピングをクリアしました");

    // 再インデックス実行
    const result = incrementalIndexGoogleDrive();
    logInfo("[CLEAR] 再インデックス完了:", result);

    return result;
  } catch (error) {
    logError("[CLEAR] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * テスト用関数: UrlFetchApp.fetchの動作確認(GASの外部通信が正常に機能しているかを確認するための関数)
 */
function testFetch() {
  const url = "https://example.com"; // どこでもOK（実際に存在する必要もない）
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getResponseCode());
}

/*
【拡張機能付き】セットアップ手順：

1. Google Sheets を作成して、Script Properties に登録
   - Google Sheets を新規作成
   - URL から Sheet ID をコピー
   - Script Properties に新規追加: INDEX_SHEET_ID = <スプレッドシートID>

2. 初期インデックスを実行
   - Apps Script エディタで initIncrementalIndex() 関数を実行
   - 完了を待つ（ドキュメント数による）

3. LINE チャット使用時に自動的に RAG が有効化
   - 質問に関連したドキュメントが自動検索されます
   - 拡張機能（BM25、リランキング、クエリ拡張、キャッシュ）が自動適用

4. 自動更新を設定（オプション）
   - LINEで「#自動更新 1」と送信（1時間ごとに自動更新）

【新しいLINEコマンド】
- #インデックス情報 → インデックス状況を確認
- #インデックス更新 → 手動で更新
- #自動更新 [時間] → 自動更新を設定（例: #自動更新 2）
- #自動更新解除 → 自動更新を解除
- #初期インデックス → 初回インデックスを実行
- #拡張機能 → クエリ拡張機能のON/OFF切替
- #キャッシュクリア → 検索キャッシュをクリア

【拡張機能】
- BM25検索: キーワードベースの精密検索
- リランキング: LLMで検索結果Top-Nを再評価
- クエリ拡張: 類義語・関連語を追加して検索精度向上
- 結果キャッシュ: 類似クエリの結果を再利用でAPIコスト削減
*/
