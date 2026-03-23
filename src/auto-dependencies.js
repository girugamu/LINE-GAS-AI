/**
 * 自動依存関係マッピング生成スクリプト
 * 
 * @module auto-dependencies
 * @description JSDocコメントからMODULE_DEFINITIONSを自動生成するツール
 * 
 * このスクリプトは、GASプロジェクト内の全.js/.gsファイルを読み込み、
 * JSDocコメントからモジュール情報を自動抽出してMODULE_DEFINITIONSを生成します。
 * 
 * 抽出対象のJSDocタグ：@module, @depends, @exports
 * 
 * @depends dependencies
 * @exports generateModuleDefinitions, extractJsDocHeader, getProjectJsFiles, exportModuleDefinitionsAsJson, reparseFile, testExtractJsDocHeader
 */

/**
 * メイン関数：全JSファイルからMODULE_DEFINITIONSを自動生成
 * 
 * @returns {Object} 生成されたモジュール定義オブジェクト
 */
function generateModuleDefinitions() {
  console.log('========================================');
  console.log('モジュール定義自動生成開始');
  console.log('========================================');
  
  // プロジェクト内のJSファイルを全て取得
  const jsFiles = getProjectJsFiles();
  
  console.log(`\n検出されたJS/GSファイル数: ${jsFiles.length}`);
  
  // 各ファイルからモジュール情報を抽出
  const moduleDefs = {};
  
  jsFiles.forEach(function(fileInfo) {
    const fileName = fileInfo.name;
    console.log(`\n処理中: ${fileName}`);
    
    try {
      // ファイル内容（Apps Script APIの場合はsourceフィールド）
      const content = fileInfo.source || '';
      
      if (!content) {
        console.log(`  ✗ ファイル内容が空です`);
        return;
      }
      
      // JSDocヘッダーを解析
      const jsdocInfo = extractJsDocHeader(content);
      
      if (jsdocInfo && jsdocInfo.module) {
        // モジュール情報を保存
        moduleDefs[jsdocInfo.module] = {
          file: fileName,
          description: jsdocInfo.description || '',
          dependsOn: jsdocInfo.depends || [],
          exports: jsdocInfo.exports || []
        };
        
        console.log(`  ✓ モジュール: ${jsdocInfo.module}`);
        console.log(`    ファイル: ${fileName}`);
        console.log(`    説明: ${jsdocInfo.description || '(なし)'}`);
        if (jsdocInfo.depends.length > 0) {
          console.log(`    依存: [${jsdocInfo.depends.join(', ')}]`);
        }
        if (jsdocInfo.exports.length > 0) {
          console.log(`    エクスポート: [${jsdocInfo.exports.slice(0, 5).join(', ')}${jsdocInfo.exports.length > 5 ? '...' : ''}]`);
        }
      } else {
        console.log(`  ✗ JSDoc @module が見つかりません`);
      }
      
    } catch (error) {
      console.error(`  ✗ エラー: ${error.message}`);
    }
  });
  
  // 結果を出力
  console.log('\n========================================');
  console.log('生成されたMODULE_DEFINITIONS');
  console.log('========================================');
  
  const resultJson = JSON.stringify(moduleDefs, null, 2);
  console.log(resultJson);
  
  console.log(`\n合計 ${Object.keys(moduleDefs).length} モジュールを検出`);
  
  return moduleDefs;
}

/**
 * プロジェクト内の全JSファイルを Apps Script API から取得
 * 
 * @returns {Array} ファイル情報の配列 [{name, type, source}]
 */
function getProjectJsFiles() {
  const files = [];
  
  try {
    // 現在のスクリプトのIDを取得
    const scriptId = ScriptApp.getScriptId();
    console.log(`スクリプトID: ${scriptId}`);
    
    // Apps Script API v1 を呼び出してファイル一覧を取得
    const apiUrl = `https://script.googleapis.com/v1/projects/${scriptId}/content`;
    
    const response = UrlFetchApp.fetch(apiUrl, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + ScriptApp.getOAuthToken()
      },
      muteHttpExceptions: true
    });
    
    const responseCode = response.getResponseCode();
    console.log(`API レスポンスコード: ${responseCode}`);
    
    if (responseCode === 200) {
      const projectData = JSON.parse(response.getContentText());
      console.log('Apps Script API v1 からプロジェクトを取得しました');
      
      if (projectData.files && Array.isArray(projectData.files)) {
        console.log(`\n発見したファイル数: ${projectData.files.length}`);
        
        projectData.files.forEach(function(file) {
          // server_js, server_gs タイプのみを処理
          if (file.type === 'server_js' || file.type === 'server_gs') {
            const name = file.name || 'unknown';
            const hasJsExt = name.endsWith('.js');
            const hasGsExt = name.endsWith('.gs');
            
            // 拡張子チェック（タイプがserver_js/gsでもファイル名で判断）
            if (hasJsExt || hasGsExt) {
              console.log(`  - ${name} (type: ${file.type})`);
              files.push({
                name: name,
                source: file.source || '',
                type: file.type
              });
            }
          }
        });
        
        console.log(`\n検出されたスクリプトファイル数: ${files.length}`);
        return files;
      }
    } else if (responseCode === 403) {
      console.error('スコープエラー: https://www.googleapis.com/auth/script.scopes が必要です');
      console.error('または、スクリプトプロジェクトのアクセス権限がありません');
      console.error('\n代替手段：clasp でローカルにpullしたファイルを使用してください');
    } else {
      console.error(`Apps Script API エラー: ${responseCode}`);
      const errorContent = response.getContentText();
      if (errorContent) {
        console.error(errorContent);
      }
    }
    
  } catch (error) {
    console.error('ファイル取得エラー: ' + error.message);
  }
  
  // フォールバック：DriveApp 経由で取得
  console.log('\nフォールバック: DriveAppでスクリプトプロジェクトを検索...');
  return getProjectFilesViaDrive();
}

/**
 * フォルダ再帰的にJSファイルを取得
 * 
 * @param {Folder} folder - 調査対象のフォルダ
 * @param {Set} visited - 訪問済みフォルダID Set
 * @returns {Array<File>} JSファイルの配列
 */
function getAllJsFilesRecursive(folder, visited) {
  const files = [];
  
  // 循環参照防止
  if (visited.has(folder.getId())) {
    return files;
  }
  visited.add(folder.getId());
  
  try {
    // フォルダ内のファイルを取得
    const folderFiles = folder.getFiles();
    while (folderFiles.hasNext()) {
      const file = folderFiles.next();
      const name = file.getName();
      
      // .js または .gs ファイルのみ対象
      if (name.endsWith('.js') || name.endsWith('.gs')) {
        files.push(file);
      }
    }
    
    // サブフォルダも探索
    const subFolders = folder.getFolders();
    while (subFolders.hasNext()) {
      const subFolder = subFolders.next();
      const subFiles = getAllJsFilesRecursive(subFolder, visited);
      files.push.apply(files, subFiles);
    }
    
  } catch (error) {
    console.warn(`フォルダアクセス警告: ${folder.getName()} - ${error.message}`);
  }
  
  return files;
}

/**
 * フォールバック：DriveAppでApps Scriptプロジェクトファイルを検索
 * 
 * @returns {Array} ファイル情報の配列 [{name, source}]
 */
function getProjectFilesViaDrive() {
  const files = [];
  
  try {
    console.log('DriveAppでApps Scriptプロジェクトを検索中...');
    
    // 現在のスクリプトのスクリプトIDを取得
    const scriptId = ScriptApp.getScriptId();
    
    // Apps Scriptのコンテナバインドスクリプトの場合、親ドキュメントを取得
    // そうでない場合はルートフォルダを探索
    let containers = [];
    
    // ルートフォルダからApps Scriptファイルを探す
    const rootFolder = DriveApp.getRootFolder();
    const allFiles = getAllJsFilesRecursive(rootFolder, new Set());
    
    console.log(`DriveAppで見つけたスクリプトファイル数: ${allFiles.length}`);
    
    allFiles.forEach(function(file) {
      files.push({
        name: file.getName(),
        source: null  // DriveAppではソースを取得できない
      });
    });
    
    return files;
    
  } catch (error) {
    console.error('DriveAppアクセスエラー: ' + error.message);
  }
  
  // 最終フォールバック：既知のファイルリスト
  console.log('\n最終フォールバック: 既知のファイルリストを使用');
  return getProjectFilesAlternative();
}

/**
 * 代替手段：Apps Script APIを使って既知のファイルリストを返す
 * 
 * @returns {Array} ファイル情報の配列 [{name, source: null}]
 */
function getProjectFilesAlternative() {
  const files = [];
  
  // 既知のファイルリスト（このプロジェクトのファイル）
  const knownFiles = [
    'config.js',
    'chat_message.js',
    'search.js',
    'chunk.js',
    'embedding.js',
    'cache.js',
    'history.js',
    'rag_sheet.js',
    'extract.js',
    'rerank.js',
    'triggers.js',
    'webapp.js',
    'api_admin.js',
    'api_chat.js',
    'dependencies.js',
    'auto-dependencies.js',
    'ParagraphRestoration.js',
    'コード.js'
  ];
  
  console.log('既知ファイル一覧:');
  knownFiles.forEach(function(name) {
    console.log(`  - ${name}`);
    files.push({
      name: name,
      source: null  // この方法ではソースは取得できない
    });
  });
  
  console.log(`\n合計 ${files.length} ファイル`);
  return files;
}

/**
 * ファイル内容からJSDocヘッダーを抽出
 * 
 * @param {string} content - ファイル内容全文
 * @returns {Object|null} 抽出したJSDoc情報 {module, depends, exports, description}
 */
function extractJsDocHeader(content) {
  if (!content || typeof content !== 'string') {
    return null;
  }
  
  // 最初のJSDocコメントブロック（/** ... */）を抽出
  // 複数行にまたがるJSDocに対応
  const jsdocPattern = /^\s*\/\*\*([\s\S]*?)\*\/\s*/m;
  const match = content.match(jsdocPattern);
  
  if (!match || !match[1]) {
    return null;
  }
  
  const jsdocContent = match[1];
  
  // 各タグを抽出
  const result = {
    module: null,
    depends: [],
    exports: [],
    description: ''
  };
  
  // @module を抽出
  const moduleMatch = jsdocContent.match(/@module\s+(\S+)/);
  if (moduleMatch && moduleMatch[1]) {
    result.module = moduleMatch[1].trim();
  }
  
  // @depends を抽出（カンマ区切り）
  const dependsMatch = jsdocContent.match(/@depends\s+(.+?)(?=\n\s*\*\s*@|\n\s*\*\/|$)/);
  if (dependsMatch && dependsMatch[1]) {
    result.depends = dependsMatch[1]
      .split(',')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s.length > 0; });
  }
  
  // @exports を抽出（カンマ区切り）
  const exportsMatch = jsdocContent.match(/@exports\s+(.+?)(?=\n\s*\*\s*@|\n\s*\*\/|$)/);
  if (exportsMatch && exportsMatch[1]) {
    result.exports = exportsMatch[1]
      .split(',')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s.length > 0; });
  }
  
  // description を抽出（最初の * で始まる行から）
  // JSDocコメントの行頭から抽出
  const lines = jsdocContent.split('\n');
  const descriptionLines = [];
  let foundDescription = false;
  
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    
    // タグ行に達したら終了
    if (line.match(/^\s*\*\s*@/)) {
      break;
    }
    
    // 空行は説明の一部としてスキップ（最初のみ）
    var trimmed = line.replace(/^\s*\*\s*/, '');
    
    // 最初に見つかった空でない行を説明として採用
    if (!foundDescription && trimmed.trim() !== '' && !trimmed.match(/^\//)) {
      descriptionLines.push(trimmed.trim());
      foundDescription = true;
    } else if (foundDescription && trimmed.trim() !== '') {
      // 2行目以降も追加（ただし次のタグまで）
      descriptionLines.push(trimmed.trim());
    }
  }
  
  result.description = descriptionLines.join(' ').trim();
  
  // @module がない場合はnullを返す
  if (!result.module) {
    return null;
  }
  
  return result;
}

/**
 * JSDoc解析のテスト関数
 * 
 * @param {string} testContent - テスト用JSDoc内容
 */
function testExtractJsDocHeader(testContent) {
  console.log('========================================');
  console.log('JSDoc解析テスト');
  console.log('========================================');
  
  // テストケース1：正常系
  const test1 = /**
 * search.js - 検索モジュールの説明
 * 
 * @module search
 * @depends config,cache,embedding
 * @exports hybridSearch,searchByKeywords,searchRelevantDocumentsVector
 */ 

function test1_content() {}
var test1_result = extractJsDocHeader('/**\n * search.js - 検索モジュールの説明\n * \n * @module search\n * @depends config,cache,embedding\n * @exports hybridSearch,searchByKeywords,searchRelevantDocumentsVector\n */');

  console.log('\nテスト1結果:');
  console.log(JSON.stringify(test1_result, null, 2));
  
  // テストケース2： mínima
  var test2_content = '/**\n * 最小限のモジュール\n * @module minimal\n */';
  var test2_result = extractJsDocHeader(test2_content);
  
  console.log('\nテスト2結果:');
  console.log(JSON.stringify(test2_result, null, 2));
  
  // テストケース3： @depends, @exports なし
  var test3_content = '/**\n * 説明文のみ\n * @module noDeps\n */';
  var test3_result = extractJsDocHeader(test3_content);
  
  console.log('\nテスト3結果:');
  console.log(JSON.stringify(test3_result, null, 2));
  
  // テストケース4： 複数行の説明
  var test4_content = '/**\n * これは複数行の\n * 説明文を持つ\n * モジュールです\n * @module multiLine\n * @depends config\n */';
  var test4_result = extractJsDocHeader(test4_content);
  
  console.log('\nテスト4結果:');
  console.log(JSON.stringify(test4_result, null, 2));
}

/**
 * 特定のファイルのみを再解析（デバッグ用）
 * 
 * @param {string} fileName - ファイル名
 */
function reparseFile(fileName) {
  console.log('========================================');
  console.log(`ファイル再解析: ${fileName}`);
  console.log('========================================');
  
  const jsFiles = getProjectJsFiles();
  
  for (var i = 0; i < jsFiles.length; i++) {
    var fileInfo = jsFiles[i];
    // ファイル名は fileInfo.name で取得
    var name = fileInfo.name || fileInfo.getName ? fileInfo.getName() : fileInfo;
    
    if (name === fileName) {
      console.log('ファイルを発見しました');
      
      // Apps Script API の場合は source フィールド、DriveApp の場合は getBlob()
      var content = fileInfo.source || (fileInfo.getBlob ? fileInfo.getBlob().getDataAsString() : '');
      var result = extractJsDocHeader(content);
      
      console.log('\n解析結果:');
      console.log(JSON.stringify(result, null, 2));
      
      return result;
    }
  }
  
  console.log('ファイルが見つかりません');
  return null;
}

/**
 * 生成されたMODULE_DEFINITIONSをappsscript.json的形式でエクスポート
 * 
 * @returns {string} JSON文字列
 */
function exportModuleDefinitionsAsJson() {
  var moduleDefs = generateModuleDefinitions();
  return JSON.stringify(moduleDefs, null, 2);
}
