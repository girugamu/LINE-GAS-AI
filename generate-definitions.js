/**
 * ローカルでMODULE_DEFINITIONSを自動生成するスクリプト
 * 
 * 使用方法:
 *   node generate-definitions.js
 * 
 * 前提条件:
 *   1. claspがインストール済み (npm install -g clasp)
 *   2. clasp login済み
 *   3. LINE-GAS-AI_v3 フォルダで実行
 * 
 * 機能:
 *   src/フォルダ内の全.js/.gsファイルを読み込み、
 *   JSDocコメントからモジュール情報を自動抽出してMODULE_DEFINITIONSを生成します。
 */

const fs = require('fs');
const path = require('path');

// 設定
const SRC_DIR = path.join(__dirname, 'src');
const OUTPUT_FILE = path.join(__dirname, 'src', 'MODULE_DEFINITIONS_auto.json');

/**
 * ファイル内容からJSDocヘッダーを抽出
 */
function extractJsDocHeader(content) {
  if (!content || typeof content !== 'string') {
    return null;
  }

  // 最初のJSDocコメントブロック（/** ... */）を抽出
  const jsdocPattern = /^\s*\/\*\*([\s\S]*?)\*\/\s*/m;
  const match = content.match(jsdocPattern);

  if (!match || !match[1]) {
    return null;
  }

  const jsdocContent = match[1];

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
  const dependsMatch = jsdocContent.match(/@depends\s+(.+?)(?=\n\s*\*\s*@|\n\s*\*\/|$)/s);
  if (dependsMatch && dependsMatch[1]) {
    result.depends = dependsMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  // @exports を抽出（カンマ区切り）
  const exportsMatch = jsdocContent.match(/@exports\s+(.+?)(?=\n\s*\*\s*@|\n\s*\*\/|$)/s);
  if (exportsMatch && exportsMatch[1]) {
    result.exports = exportsMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  // description を抽出
  const lines = jsdocContent.split('\n');
  const descriptionLines = [];
  let foundDescription = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // タグ行に達したら終了
    if (line.match(/^\s*\*\s*@/)) {
      break;
    }

    const trimmed = line.replace(/^\s*\*\s*/, '');

    if (!foundDescription && trimmed.trim() !== '' && !trimmed.match(/^\//)) {
      descriptionLines.push(trimmed.trim());
      foundDescription = true;
    } else if (foundDescription && trimmed.trim() !== '') {
      descriptionLines.push(trimmed.trim());
    }
  }

  result.description = descriptionLines.join(' ').trim();

  if (!result.module) {
    return null;
  }

  return result;
}

/**
 * src/フォルダ内の全JS/GSファイルを取得
 */
function getJsFiles(dir) {
  const files = [];

  if (!fs.existsSync(dir)) {
    console.error(`ディレクトリが見つかりません: ${dir}`);
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isFile()) {
      if (entry.name.endsWith('.js') || entry.name.endsWith('.gs')) {
        files.push(fullPath);
      }
    } else if (entry.isDirectory()) {
      // サブディレクトリも再帰的に探索
      const subFiles = getJsFiles(fullPath);
      files.push(...subFiles);
    }
  }

  return files;
}

/**
 * メイン処理
 */
function main() {
  console.log('========================================');
  console.log('MODULE_DEFINITIONS自動生成ツール (Node.js)');
  console.log('========================================\n');

  // src/フォルダ内の全JSファイルを取得
  const jsFiles = getJsFiles(SRC_DIR);

  console.log(`検出されたJS/GSファイル数: ${jsFiles.length}\n`);

  // 各ファイルからモジュール情報を抽出
  const moduleDefs = {};

  for (const filePath of jsFiles) {
    const fileName = path.relative(SRC_DIR, filePath);
    console.log(`処理中: ${fileName}`);

    try {
      const content = fs.readFileSync(filePath, 'utf8');

      const jsdocInfo = extractJsDocHeader(content);

      if (jsdocInfo && jsdocInfo.module) {
        moduleDefs[jsdocInfo.module] = {
          file: fileName.replace(/\\/g, '/'), // パスを正規化
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
          const exportCount = jsdocInfo.exports.length;
          const exportList = exportCount > 5
            ? jsdocInfo.exports.slice(0, 5).join(', ') + '...'
            : jsdocInfo.exports.join(', ');
          console.log(`    エクスポート: [${exportList}] (${exportCount}件)`);
        }
      } else {
        console.log(`  ✗ JSDoc @module が見つかりません`);
      }

    } catch (error) {
      console.error(`  ✗ エラー: ${error.message}`);
    }
  }

  // 結果を出力
  console.log('\n========================================');
  console.log('生成されたMODULE_DEFINITIONS');
  console.log('========================================\n');

  const resultJson = JSON.stringify(moduleDefs, null, 2);
  console.log(resultJson);

  // ファイルに保存
  fs.writeFileSync(OUTPUT_FILE, resultJson, 'utf8');
  console.log(`\n結果を保存しました: ${OUTPUT_FILE}`);

  console.log(`\n合計 ${Object.keys(moduleDefs).length} モジュールを検出`);

  return moduleDefs;
}

// 実行
main();
