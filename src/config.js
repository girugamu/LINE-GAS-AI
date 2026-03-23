/**
 * 設定・定数・ログ設定
 * 
 * このファイルには以下が含まれています：
 * - スクリプトプロパティ・ユーザープロパティ
 * - API設定定数（LINE、OpenAI、Vision）
 * - RAG設定定数
 * - チャンク設定
 * - 検索パラメータ定義
 * - BM25・Embeddingキャッシュ設定
 * - 同義語・関連語辞書
 * - エージェントモード設定
 * - Stop Words
 * - プロンプトテンプレート定義
 * - LLMパラメータ定義
 * - 設定項目定義
 * - ログ出力関数
 * - ユーティリティ関数
 */

// ================================
//  スクリプトプロパティ・ユーザープロパティ
// ================================

/** スクリプトプロパティ */
const scriptProps = PropertiesService.getScriptProperties();
/** ユーザープロパティ（LLMパラメータ保存用） */
const userProps = PropertiesService.getUserProperties();

const OPENAI_API_KEY = scriptProps.getProperty("OPENAI_API_KEY");
const LINE_TOKEN = scriptProps.getProperty("LINE_TOKEN");
const LOG_SHEET_ID = scriptProps.getProperty("LOG_SHEET_ID");

// ================================
//  API設定定数
// ================================

// LINE API設定
const LINE_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_LOADING_URL = 'https://api.line.me/v2/bot/chat/loading/start';
const GPT_MODEL = "gpt-4o-mini";

// Vision API設定
const VISION_API_CONFIG = { ENABLE_OCR: true, OCR_LANGUAGE_HINTS: ["ja", "en"] };

// ================================
//  RAG設定定数
// ================================

// 自動インデックス更新用設定
const DRIVE_FOLDER_ID = scriptProps.getProperty("DRIVE_FOLDER_ID");
const INDEX_SHEET_ID = scriptProps.getProperty("INDEX_SHEET_ID");
const EMBEDDING_MODEL = "text-embedding-3-small";
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

// ================================
//  結果キャッシュ設定
// ================================

const QUERY_CACHE_CONFIG = {
  ENABLE_CACHE: true,
  CACHE_TTL_SECONDS: 3600,
  SIMILARITY_THRESHOLD: 0.80,
  SIMILARITY_CACHE_ENABLED: true,
  MAX_CACHED_QUERIES: 100,
  CACHE_VERSION: "v2"
};

// ================================
//  チャンク設定
// ================================

const CHUNK_CONFIG = {
  // 基本設定
  CHUNK_SIZE: 1000,
  CHUNK_OVERLAP: 100,
  MIN_CHUNK_SIZE: 200,
  MAX_CHUNK_SIZE: 1500,

  // セマンティック分割設定
  USE_SEMANTIC_SPLIT: true,
  PRIORITIZE_HEADERS: true,
  SENTENCE_AWARE: true,
  CONTEXT_PRESERVATION: true,

  // 品質設定
  MERGE_SMALL_CHUNKS: true,
  SPLIT_LONG_CHUNKS: true,
  DEDUPLICATE_CHUNKS: true,

  // 重要度設定
  BOOST_HEADERS: true,
  BOOST_LISTS: true,
  HEADER_BOOST_FACTOR: 2.0,
  LIST_BOOST_FACTOR: 1.5,

  // 段落復元チャンク化
  USE_PARAGRAPH_RESTORATION: false,
  PARAGRAPH_RESTORE_OPTIONS: {
    preserveStructure: true,
    minChunkSize: 50,
    maxChunkSize: 500,
    targetChunkSize: 300
  }
};

// ================================
//  検索パラメータのデフォルト定義
// ================================

const SEARCH_PARAM_DEFINITIONS = {
  // ===== キーワード検索 =====
  'SEARCH_KEYWORD_ENABLED': {
    defaultValue: 'true',
    description: '保存されたキーワードと照合して関連性スコアを算出します。',
    isBoolean: true,
    group: 'keyword'
  },
  // ===== BM25検索 =====
  'SEARCH_BM25_ENABLED': {
    defaultValue: 'true',
    description: 'BM25 アルゴリズムによる高精度キーワード検索を有効化します。',
    isBoolean: true,
    group: 'bm25'
  },
  'BM25_K1': {
    defaultValue: '1.5',
    min: 0.1,
    max: 3.0,
    step: 0.1,
    description: '単語頻度に対する飽和度を調整するパラメータ。',
    group: 'bm25'
  },
  'BM25_B': {
    defaultValue: '0.75',
    min: 0.0,
    max: 1.0,
    step: 0.05,
    description: '文書長の正規化を制御するパラメータ。',
    group: 'bm25'
  },
  // ===== リランキング =====
  'SEARCH_RERANK_ENABLED': {
    defaultValue: 'true',
    description: '初期検索結果 Top-N を LLM によって再評価し、関連度順に並べ替えます。',
    isBoolean: true,
    group: 'rerank'
  },
  'RERANK_INITIAL_TOP_K': {
    defaultValue: '17',
    min: 5,
    max: 100,
    step: 1,
    description: '初期検索で取得する件数、ここからLLMによる再評価を行います。',
    group: 'rerank'
  },
  'RERANK_FINAL_TOP_K': {
    defaultValue: '8',
    min: 1,
    max: 50,
    step: 1,
    description: 'リランキング後に残す最終件数。',
    group: 'rerank'
  },
  'RERANK_MODEL': {
    defaultValue: 'gpt-4o-mini',
    description: 'リランキングに使用する LLM モデル。',
    isSelect: true,
    options: ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4'],
    group: 'rerank'
  },
  // ===== クエリ拡張 =====
  'SEARCH_QUERY_EXPANSION_ENABLED': {
    defaultValue: 'true',
    description: '類義語・関連語を追加して検索範囲を広げます。',
    isBoolean: true,
    group: 'query_expansion'
  },
  'SEARCH_DICT_EXPANSION_ENABLED': {
    defaultValue: 'true',
    description: '辞書ベースの類義語・関連語を追加します。',
    isBoolean: true,
    group: 'query_expansion'
  },
  'SEARCH_LLM_EXPANSION_ENABLED': {
    defaultValue: 'true',
    description: 'LLM によるクエリ拡張を有効化します。',
    isBoolean: true,
    group: 'query_expansion'
  },
  'QUERY_EXPANSION_MAX_WORDS': {
    defaultValue: '5',
    min: 1,
    max: 10,
    step: 1,
    description: 'クエリに追加する拡張語の最大数。',
    group: 'query_expansion'
  },
  'QUERY_EXPANSION_USE_SYNONYMS': {
    defaultValue: 'true',
    description: '同義語展開を有効化します。',
    isBoolean: true,
    group: 'query_expansion'
  },
  'QUERY_EXPANSION_USE_RELATED': {
    defaultValue: 'true',
    description: '関連語展開を有効化します。',
    isBoolean: true,
    group: 'query_expansion'
  },
  // ===== ハイブリッド検索 =====
  'SEARCH_HYBRID_ENABLED': {
    defaultValue: 'true',
    description: 'ベクトル検索とキーワード検索を組み合わせたハイブリッド検索を有効化します。',
    isBoolean: true,
    group: 'hybrid'
  },
  'HYBRID_VECTOR_WEIGHT': {
    defaultValue: '0.7',
    min: 0,
    max: 1,
    step: 0.05,
    description: 'ベクトル検索の重み。',
    group: 'hybrid'
  },
  'HYBRID_KEYWORD_WEIGHT': {
    defaultValue: '0.3',
    min: 0,
    max: 1,
    step: 0.05,
    description: 'キーワード検索の重み。',
    group: 'hybrid'
  },
  'HYBRID_MIN_KEYWORD_SCORE': {
    defaultValue: '0.1',
    min: 0,
    max: 1,
    step: 0.05,
    description: 'キーワード検索結果を採用するための最小スコア閾値。',
    group: 'hybrid'
  },
  'HYBRID_TOP_K_VECTOR': {
    defaultValue: '10',
    min: 5,
    max: 50,
    step: 1,
    description: 'ベクトル検索で取得する上位件数。',
    group: 'hybrid'
  },
  'HYBRID_TOP_K_KEYWORD': {
    defaultValue: '5',
    min: 3,
    max: 30,
    step: 1,
    description: 'キーワード検索で取得する上位件数。',
    group: 'hybrid'
  },
  'HYBRID_TOP_K_BM25': {
    defaultValue: '5',
    min: 3,
    max: 30,
    step: 1,
    description: 'BM25検索で取得する上位件数。',
    group: 'hybrid'
  },
  'HYBRID_TOP_K_FINAL': {
    defaultValue: '8',
    min: 1,
    max: 30,
    step: 1,
    description: 'ハイブリッド統合後に出力する最終件数。',
    group: 'hybrid'
  }
};

// ================================
//  BM25 IDFキャッシュ設定
// ================================

const BM25_CACHE_CONFIG = {
  ENABLE_IDF_CACHE: true,
  IDF_CACHE_TTL_SECONDS: 21600,
  ENABLE_AVGDL_CACHE: true
};

const EMBEDDING_CACHE_TTL_SECONDS = 21600;

// ================================
//  日本語同義語辞書
// ================================

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

// ================================
//  日本語関連語辞書
// ================================

const RELATED_WORDS = {
  'エラー': ['原因', '解決策', '対応'],
  'つかない': ['起動', '開始', '電源'],
  '遅い': ['パフォーマンス', '速度', '改善'],
  '重い': ['負荷', '処理', '軽減']
};

// ================================
//  エージェントモード設定
// ================================

const AGENT_MODE_CONFIG = {
  MAX_ITERATIONS: 3,
  MIN_CONFIDENCE: 0.7,
  SHOW_THINKING: true,
  ADDITIONAL_SEARCH_ENABLED: true
};

// ================================
//  日本語stop words
// ================================

const STOP_WORDS = [
  'です', 'ます', 'でした', 'でしたら', 'でしたが',
  'だ', 'だった', 'である', 'でしょう', 'ですね', 'ですよ',
  'する', 'した', 'して', 'される', 'され',
  'できる', 'できない', '行う', '行った', 'なる', 'になった',
  'いる', 'いない', 'ある', 'ない',
  'これ', 'それ', 'あれ', 'ここ', 'そこ', 'あそこ',
  'どれ', 'どこ', 'こちら', 'そちら', 'あちら',
  'なに', 'なん', '何', 'どう', 'なぜ', 'どの', 'どんな',
  '私', 'あなた', 'あなた方', '自分', '彼', '彼女', 'みんな',
  'そして', 'また', 'さらに', 'しかし', 'でも', 'ただし', 'なので',
  'ため', 'ので', 'から', 'など', 'とか',
  'よう', 'もの', 'こと', 'とき', 'ところ', 'ほう',
  'ですか', 'ますか', 'でしょうか', 'かな', 'かも'
];

// ================================
//  プロンプトテンプレート
// ================================

const PROMPT_TEMPLATES = {
  "summary": (text) => `次の文章を要約してください。\n\n${text}`,
  "polite": (text) => `次の内容に丁寧に回答してください。\n\n${text}`,
  "bullet": (text) => `次の内容を箇条書きで整理してください。\n\n${text}`,
  "translate": (text) => `次の文章を英語に翻訳してください。\n\n${text}`,
  "free": (text) => text
};

// ================================
//  管理者プロンプト設定の定義
// ================================

const ADMIN_PROMPT_DEFINITIONS = {
  "ADMIN_SYSTEM_PROMPT": {
    defaultValue: "あなたは誠実で効率的なAIアシスタントです。",
    description: "AIの基本的な役割やペルソナを定義するシステムプロンプト",
    example: "あなたは、親切で正確な情報を提供することに注力するAIアシスタントです。"
  },
  "ADMIN_RESPONSE_RULES": {
    defaultValue: "",
    description: "応答に関する具体的なルール（箇条書きで記載）",
    example: "1. 回答は分かりやすく、丁寧で、必要以上に冗長にしないこと。"
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

// ================================
//  ユーザー独自プロンプト設定の定義
// ================================

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

// ================================
//  RAGプロンプトテンプレートの定義
// ================================

const PROMPT_TEMPLATE_DEFINITIONS = {
  'PROMPT_QUERY_EXPANSION': {
    defaultValue: `以下のユーザー質問を検索しやすい形に拡張してください。

【質問】
{{query}}

【出力形式】
検索に使えるキーワードを箇条書きで出力してください。`,
    description: 'クエリ拡張プロンプト',
    variables: ['query']
  },
  'PROMPT_SEARCH': {
    defaultValue: `以下の質問の検索意図を明確化し、検索クエリを生成してください。

【質問】
{{query}}

【出力形式】
検索に最適化されたクエリを1行で出力してください。`,
    description: '検索プロンプト',
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
    description: '要約プロンプト',
    variables: ['query', 'chunks']
  },
  'PROMPT_RERANK': {
    defaultValue: `以下の検索クエリに対して、各ドキュメントの関連性を0〜10点で評価してください。

【検索クエリ】
{{query}}

【ドキュメント一覧】
{{documents}}

【出力形式】
番号: スコア の形式で出力してください。`,
    description: 'リランキングプロンプト',
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

【出力形式】
以下のJSON形式で出力してください：
{"needsMoreSearch": true/false, "confidence": 0.0〜1.0, "reason": "判断理由", "additionalTerms": ["追加検索キーワード"]}`,
    description: 'エージェント評価プロンプト',
    variables: ['query', 'context', 'results']
  },
  'PROMPT_AGENT_KEYWORD': {
    defaultValue: `ユーザーからの質問「{{query}}」に対して、追加で検索すべき関連キーワードを最大3つ生成してください。

現在の検索で取得しているキーワード: {{existingKeywords}}

【出力形式】
JSON配列形式で出力してください:
["キーワード1", "キーワード2", "キーワード3"]`,
    description: 'エージェントキーワード生成プロンプト',
    variables: ['query', 'existingKeywords']
  }
};

// ================================
//  LLMパラメータのデフォルト定義
// ================================

const LLM_PARAM_DEFINITIONS = {
  'LLM_MODEL': {
    defaultValue: 'gpt-4o-mini',
    description: '使用する GPT モデルを指定します。',
    example: 'gpt-4o-mini: 高速・低コスト, gpt-4o: 高品質',
    paramName: 'model',
    isSelect: true,
    options: ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4']
  },
  'LLM_TEMPERATURE': {
    defaultValue: '0.7',
    min: 0,
    max: 2,
    step: 0.1,
    description: '生成内容のランダム性（創造性）を制御します。',
    example: '0.0: 毎回ほぼ同じ回答, 0.7: バランスの良い自然な文章',
    paramName: 'temperature'
  },
  'LLM_TOP_P': {
    defaultValue: '1.0',
    min: 0,
    max: 1,
    step: 0.05,
    description: '確率分布に基づき、どの範囲の候補からトークンを選ぶかを制御します。',
    paramName: 'top_p'
  },
  'LLM_TOP_K': {
    defaultValue: '40',
    min: 1,
    max: 100,
    step: 1,
    description: '次に選ばれるトークンを上位 K 個に制限します。',
    paramName: 'top_k'
  },
  'LLM_MAX_COMPLETION_TOKENS': {
    defaultValue: '2048',
    min: 1,
    max: 16384,
    step: 1,
    description: 'AI が生成する最大トークン数。',
    paramName: 'max_tokens'
  },
  'LLM_MAX_PROMPT_TOKENS': {
    defaultValue: '2048',
    min: 1,
    max: 16384,
    step: 1,
    description: 'プロンプト（入力）の最大トークン数を制限するパラメータ（gpt-5.x 系専用）。',
    paramName: 'max_prompt_tokens'
  },
  'LLM_PRESENCE_PENALTY': {
    defaultValue: '0',
    min: -2,
    max: 2,
    step: 0.1,
    description: '同じ話題や内容の繰り返しをどの程度抑制するかを制御します。',
    paramName: 'presence_penalty'
  },
  'LLM_FREQUENCY_PENALTY': {
    defaultValue: '0',
    min: -2,
    max: 2,
    step: 0.1,
    description: '同じ単語の繰り返しをどの程度抑制するかを制御します。',
    paramName: 'frequency_penalty'
  },
  'LLM_STOP': {
    defaultValue: '',
    description: '指定した語句が出た時点で生成を停止します。',
    paramName: 'stop',
    isString: true
  },
  'LLM_RESPONSE_FORMAT': {
    defaultValue: 'text',
    description: '出力形式を指定します。json を選ぶとパース可能な JSON を返します。',
    paramName: 'response_format',
    isSelect: true,
    options: ['text', 'json']
  }
};

// top_kをサポートしていないモデルリスト
const MODELS_WITHOUT_TOP_K = ['gpt-4o-mini', 'gpt-4o', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4'];

// ================================
//  設定項目のデフォルト定義
// ================================

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
    isSecret: true
  },
  'LOG_SHEET_ID': {
    defaultValue: '',
    isRequired: false,
    description: 'ログを記録するGoogle SheetsのID',
    isSensitive: true
  },
  'DRIVE_FOLDER_ID': {
    defaultValue: '',
    isRequired: true,
    description: 'RAGインデックス用のGoogle DriveフォルダID',
    isSensitive: true
  },
  'INDEX_SHEET_ID': {
    defaultValue: '',
    isRequired: true,
    description: 'RAGインデックスを保存するGoogle SheetsのID',
    isSensitive: true
  },
  'VISION_API_KEY': {
    defaultValue: '',
    isRequired: false,
    description: 'Google Cloud Vision APIのキー（OCR用）',
    isSecret: true
  },
  'DEBUG_MODE': {
    defaultValue: 'false',
    isRequired: false,
    description: 'デバッグモード（Traceログを出力）',
    isBoolean: true
  },
  'ADMIN_LIST': {
    defaultValue: 'admin@example.com, manager@example.com',
    isRequired: false,
    description: '管理者メールアドレスリスト（カンマ区切り）',
    isSecurity: true
  },
  'DEV_MODE': {
    defaultValue: 'false',
    isRequired: false,
    description: '開発者モード（管理者リストに関係なく管理画面ボタンを表示）',
    isBoolean: true
  },
  'ALLOW_LIST': {
    defaultValue: 'allowed@example.com, user@example.com',
    isRequired: false,
    description: 'アクセス許可メールアドレスリスト（カンマ区切り）',
    isSecurity: true
  },
  'BLOCK_LIST': {
    defaultValue: 'blocked@example.com, user@example.com',
    isRequired: false,
    description: 'アクセス禁止メールアドレスリスト（カンマ区切り）',
    isSecurity: true
  }
};

// ================================
//  ログ出力関数
// ================================

/**
 * ログメッセージを変換（オブジェクトはJSON、文字列に変換）
 * @private
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
//  ユーティリティ関数
// ================================

/**
 * userIdをハッシュ化して返す（ログ用）
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
 */
function getVisionApiKey() { return scriptProps.getProperty("VISION_API_KEY"); }

/**
 * MimeTypeに基づいて正しいGoogle DriveのURLを生成
 */
function getDocumentUrl(fileId, mimeType) {
  if (!mimeType) {
    return `https://docs.google.com/document/d/${fileId}/view`;
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet' || mimeType === MimeType.GOOGLE_SHEETS) {
    return `https://docs.google.com/spreadsheets/d/${fileId}/view`;
  } else if (mimeType === 'application/vnd.google-apps.presentation' || mimeType === MimeType.GOOGLE_SLIDES) {
    return `https://docs.google.com/presentation/d/${fileId}/view`;
  } else if (mimeType === 'application/vnd.google-apps.document' || mimeType === MimeType.GOOGLE_DOCS) {
    return `https://docs.google.com/document/d/${fileId}/view`;
  } else {
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

/**
 * デバッグモードが有効かを確認
 */
function isDebugModeEnabled() {
  const debugMode = scriptProps.getProperty('DEBUG_MODE');
  return debugMode === 'true';
}
