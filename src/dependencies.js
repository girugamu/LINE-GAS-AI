/**
 * 依存関係マップモジュール
 * 
 * @module dependencies
 * @description プロジェクト内のモジュール間依存関係を集中管理
 * 
 * このファイルはプロジェクト内のモジュール間依存関係を集中管理します。
 * 関数の依存関係を明確にし、読み込み順序を制御するために使用します。
 * 
 * @depends (なし - 自己完結型ユーティリティ)
 * @exports MODULE_DEFINITIONS, resolveDependencyOrder, exportDependencyGraphAsDot, findFunctionModule, getModuleDependencies, detectCircularDependencies, printDependencyReport, buildFunctionIndex
 */

/**
 * モジュール定義
 * 各モジュールの定義情報をここに記述します
 */
const MODULE_DEFINITIONS = {
  // ================================
  //  基本設定・ユーティリティ（最初に読み込み）
  // ================================
  'config': {
    file: 'config.js',
    description: '設定・定数・ログ関数',
    dependsOn: [],
    exports: [
      'scriptProps', 'userProps', 'LOG_SHEET_ID', 'PROMPT_TEMPLATES',
      'logInfo', 'logError', 'logWarn', 'logTrace',
      'cosineSimilarity', 'hashUserId', 'isDebugModeEnabled'
    ]
  },

  // ================================
  //  プリプロセス（テキスト前処理・チャンク化）
  // ================================
  'preprocess': {
    file: 'preprocess.js',
    description: 'プリプロセス（テキスト前処理・チャンク化）モジュール',
    dependsOn: ['config', 'chunk', 'embedding', 'rag_sheet', 'extract'],
    exports: [
      'restoreParagraphs', 'processTextForRag',
      'processAndIndexWithParagraphRestoration',
      'PARAGRAPH_CHUNK_CONFIG'
    ]
  },

  // ================================
  //  LLM（Large Language Model）呼び出し
  // ================================
  'llm': {
    file: 'llm.js',
    description: 'ChatGPT API呼び出し、LLMパラメータ管理、プロンプト生成',
    dependsOn: ['config'],
    exports: [
      'callChatGPT', 'callChatGPTRerank', 'getLlmParams', 'getLlmParamsDefault',
      'updateLlmParam', 'supportsTopK', 'generateFullPrompt', 'getAdminPrompt',
      'getUserPrompt', 'getPromptTemplateSettings', 'updatePromptTemplate',
      'buildPromptFromTemplate', 'getAdminPromptSettings', 'getUserPromptSettings',
      'getSearchParams', 'getSearchParamsDefault', 'updateSearchParam'
    ]
  },

  // ================================
  //  キャッシュ管理
  // ================================
  'cache': {
    file: 'cache.js',
    description: 'クエリ・Embeddingキャッシュ管理',
    dependsOn: ['config'],
    exports: [
      'getQueryCache', 'setQueryCache', 'clearAllQueryCaches',
      'clearEmbeddingCache', 'findSimilarQueryCache'
    ]
  },
  
  // ================================
  //  履歴管理
  // ================================
  'history': {
    file: 'history.js',
    description: '会話履歴管理（CacheService使用）',
    dependsOn: ['config', 'cache'],
    exports: ['getHistory', 'saveHistory', 'clearHistory']
  },
  
  // ================================
  //  チャットメッセージ処理
  // ================================
  'chat_message': {
    file: 'chat_message.js',
    description: 'LINEメッセージ送信、自律検索エージェントモード',
    dependsOn: ['config', 'history', 'search', 'llm'],
    exports: [
      'sendMessage', 'sendLineLoading',
      'callChatGPTWithRAG', 'callChatGPTWithRAGEnhanced',
      'callChatGPTWithAgent', 'buildChatMessages'
    ]
  },
  
  // ================================
  //  テキスト分割
  // ================================
  'chunk': {
    file: 'chunk.js',
    description: 'テキストのチャンク分割処理',
    dependsOn: ['config'],
    exports: [
      'splitTextIntoChunks', 'semanticSplit', 'basicSplit',
      'splitLongChunkOnly', 'mergeSmallChunks', 'deduplicateChunks'
    ]
  },
  
  // ================================
  //  ファイルテキスト抽出
  // ================================
  'extract': {
    file: 'extract.js',
    description: '各種ファイル形式からのテキスト抽出',
    dependsOn: ['config', 'chunk'],
    exports: [
      'extractText', 'extractTextFromGoogleSheets',
      'extractTextFromWord', 'extractTextFromPDFWithOCR',
      'extractTableWithStructure'
    ]
  },
  
  // ================================
  //  Embedding処理
  // ================================
  'embedding': {
    file: 'embedding.js',
    description: 'OpenAI Embedding API呼び出し',
    dependsOn: ['config', 'cache'],
    exports: ['getEmbedding', 'getEmbeddingWithCache']
  },
  
  // ================================
  //  RAGシート管理
  // ================================
  'rag_sheet': {
    file: 'rag_sheet.js',
    description: 'RAGインデックス用スプレッドシート操作',
    dependsOn: ['config', 'chunk', 'embedding'],
    exports: [
      'getRagSheet', 'incrementalIndexGoogleDrive',
      'getFileMapping', 'setFileMapping', 'getLastIndexTime'
    ]
  },
  
  // ================================
  //  検索機能
  // ================================
  'search': {
    file: 'search.js',
    description: 'ベクトル検索・キーワード検索・BM25',
    dependsOn: ['config', 'cache', 'embedding', 'rag_sheet'],
    exports: [
      'hybridSearch', 'enhancedHybridSearch',
      'searchByKeywords', 'searchRelevantDocumentsVector',
      'expandQuery', 'fetchRelevantChunks'
    ]
  },
  
  // ================================
  //  リランキング
  // ================================
  'rerank': {
    file: 'rerank.js',
    description: '検索結果のリランキング',
    dependsOn: ['config', 'llm'],
    exports: ['rerankResults']
  },
  
  // ================================
  //  トリガー管理
  // ================================
  'triggers': {
    file: 'triggers.js',
    description: '自動インデックス更新トリガー',
    dependsOn: ['config', 'rag_sheet'],
    exports: [
      'setupAutoIndexTrigger', 'removeAutoIndexTrigger',
      'initIncrementalIndex', 'triggerManualIndexUpdate'
    ]
  },
  
  // ================================
  //  Webアプリ認証
  // ================================
  'webapp': {
    file: 'webapp.js',
    description: 'Web Apps認証・HTML出力',
    dependsOn: ['config'],
    exports: [
      'checkAdminAuth', 'checkChatUserAuth',
      'createAuthErrorHtml', 'getAllowList', 'isDevModeEnabled'
    ]
  },
  
  // ================================
  //  APIハンドラ（後処理）
  // ================================
  'api_chat': {
    file: 'api_chat.js',
    description: 'チャットAPIエンドポイント',
    dependsOn: ['config', 'chat_message', 'history', 'search', 'webapp'],
    exports: ['chatAPI', 'handleChatMessage', 'handleAgentStart']
  },
  
  'api_admin': {
    file: 'api_admin.js',
    description: '管理画面APIエンドポイント',
    dependsOn: ['config', 'rag_sheet', 'triggers', 'search'],
    exports: ['getRagStats', 'triggerIndexing', 'getSettingsData']
  }
};

/**
 * 依存解決：正しい順序でモジュールを解決
 * @returns {Array} 解決されたモジュール名の配列（順序付き）
 */
function resolveDependencyOrder() {
  const resolved = [];
  const visited = new Set();
  
  function visit(moduleName) {
    if (visited.has(moduleName)) return;
    visited.add(moduleName);
    
    const module = MODULE_DEFINITIONS[moduleName];
    if (!module) return;
    
    // 依存を先に解決
    module.dependsOn.forEach(dep => visit(dep));
    
    resolved.push(moduleName);
  }
  
  // 全てのモジュールを訪問
  Object.keys(MODULE_DEFINITIONS).forEach(name => visit(name));
  
  return resolved;
}

/**
 * 依存グラフを DOT 形式で出力（Graphviz用）
 * @returns {string} DOT形式文字列
 */
function exportDependencyGraphAsDot() {
  let dot = 'digraph Dependencies {\n';
  dot += '  rankdir=LR;\n';
  dot += '  node [shape=box];\n\n';
  
  Object.entries(MODULE_DEFINITIONS).forEach(([name, module]) => {
    dot += `  "${name}" [label="${name}\\n(${module.file})"];\n`;
  });
  
  dot += '\n';
  
  Object.entries(MODULE_DEFINITIONS).forEach(([name, module]) => {
    module.dependsOn.forEach(dep => {
      dot += `  "${dep}" -> "${name}";\n`;
    });
  });
  
  dot += '}\n';
  return dot;
}

/**
 * 特定の関数がどのモジュールに属するか查找
 * @param {string} functionName - 関数名
 * @returns {Object|null} モジュール情報
 */
function findFunctionModule(functionName) {
  for (const [moduleName, module] of Object.entries(MODULE_DEFINITIONS)) {
    if (module.exports.includes(functionName)) {
      return {
        module: moduleName,
        file: module.file,
        description: module.description,
        dependsOn: module.dependsOn
      };
    }
  }
  return null;
}

/**
 * モジュールの依存関係を取得
 * @param {string} moduleName - モジュール名
 * @returns {Object} { direct: [], all: [] } 直接依存と全依存
 */
function getModuleDependencies(moduleName) {
  const module = MODULE_DEFINITIONS[moduleName];
  if (!module) return { direct: [], all: [] };
  
  const direct = [...module.dependsOn];
  const all = new Set();
  
  function collect(deps) {
    deps.forEach(dep => {
      if (!all.has(dep)) {
        all.add(dep);
        const subDeps = MODULE_DEFINITIONS[dep]?.dependsOn || [];
        collect(subDeps);
      }
    });
  }
  
  collect(direct);
  return { direct, all: Array.from(all) };
}

/**
 * 循環参照を検出
 * @returns {Array} 循環参照があるモジュールのペア
 */
function detectCircularDependencies() {
  const cycles = [];
  
  function dfs(moduleName, visited, stack, path) {
    if (stack.has(moduleName)) {
      const cycleStart = path.indexOf(moduleName);
      if (cycleStart !== -1) {
        cycles.push(path.slice(cycleStart).concat(moduleName));
      }
      return;
    }
    
    if (visited.has(moduleName)) return;
    
    visited.add(moduleName);
    stack.add(moduleName);
    path.push(moduleName);
    
    const deps = MODULE_DEFINITIONS[moduleName]?.dependsOn || [];
    deps.forEach(dep => dfs(dep, visited, stack, [...path]));
    
    stack.delete(moduleName);
  }
  
  Object.keys(MODULE_DEFINITIONS).forEach(name => {
    dfs(name, new Set(), new Set(), []);
  });
  
  return cycles;
}

// ===== デバッグ・可視化用関数 =====

/**
 * 依存関係レポートをコンソール出力
 */
function printDependencyReport() {
  console.log('=== モジュール依存関係レポート ===\n');
  
  const order = resolveDependencyOrder();
  console.log('【解決順序】');
  order.forEach((name, i) => {
    const module = MODULE_DEFINITIONS[name];
    console.log(`${i + 1}. ${name} (${module.file})`);
    console.log(`   説明: ${module.description}`);
    if (module.dependsOn.length > 0) {
      console.log(`   依存: ${module.dependsOn.join(', ')}`);
    }
    console.log('');
  });
  
  console.log('\n【循環参照チェック】');
  const cycles = detectCircularDependencies();
  if (cycles.length === 0) {
    console.log('✓ 循環参照なし');
  } else {
    cycles.forEach(cycle => {
      console.log(`✗ 循環参照: ${cycle.join(' -> ')}`);
    });
  }
}

/**
 * 全エクスポート関数の索引を作成
 */
function buildFunctionIndex() {
  const index = {};
  
  Object.entries(MODULE_DEFINITIONS).forEach(([moduleName, module]) => {
    module.exports.forEach(fn => {
      index[fn] = {
        module: moduleName,
        file: module.file
      };
    });
  });
  
  return index;
}
