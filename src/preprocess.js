/**
 * プリプロセス（テキスト前処理・チャンク化）モジュール
 * 
 * @module preprocess
 * @description OCR/PDF抽出結果から段落構造を復元し、意味のまとまりでチャンク化
 * 
 * OCR / PDF抽出結果から段落構造を復元し、意味のまとまりでチャンク化します。
 * 「見出しだけ」「単語だけ」のチャンクを防止し、1チャンク=1段落（または1セクション）を実現します。
 * 
 * 【機能概要】
 * 1. OCR / PDF 抽出結果の改行・空白・フォントサイズ・位置情報を利用して段落を推定
 * 2. 見出し（大きなフォント・太字・中央寄せなど）を検出し、次の本文と結合
 * 3. 見出しだけのチャンクを作らず、必ず本文とセットにする
 * 4. 1チャンク＝1段落（または1セクション）とする
 * 
 * 【出力形式】
 * - TextChunk には JSON ではなく「自然文の段落」を保存
 * - record フィールドは見出し階層を保持（オプション）
 * - Embedding は段落テキストに対して生成
 * 
 * @depends config, chunk, embedding, rag_sheet, extract
 * @exports restoreParagraphs, processTextForRag, processAndIndexWithParagraphRestoration, PARAGRAPH_CHUNK_CONFIG
 */

// ================================
// 段落復元チャンク化設定
// ================================

/**
 * 段落復元チャンク化の設定
 */
const PARAGRAPH_CHUNK_CONFIG = {
  // ===== 基本設定 =====
  // 段落復元モードを有効化（true: 有効、false: 従来の文字ベース分割）
  ENABLE_PARAGRAPH_RESTORATION: true,

  // 最小チャンクサイズ（文字数）
  MIN_CHUNK_SIZE: 50,

  // 最大チャンクサイズ（文字数）
  MAX_CHUNK_SIZE: 500,

  // 目標チャンクサイズ（文字数）
  TARGET_CHUNK_SIZE: 300,

  // ===== 段落復元設定 =====
  // 見出し階層をrecordに保存
  PRESERVE_STRUCTURE: true,

  // 見出しと本文の最小結合サイズ（見出しの後にこのサイズ以上の本文が必要）
  MIN_BODY_SIZE: 30,

  // 連続する短かい段落を結合する
  MERGE_SHORT_PARAGRAPHS: true,

  // ===== 見出し検出設定 =====
  // 見出し候補のパターン
  HEADER_PATTERNS: [
    /^第[一二三四五六七八九十百千]+部[:：]?\s*/u,           // 第1部、第○章など
    /^第[０-９0-9]+[章节項条号]+[:：]?\s*/u,             // 第1章、第2節など
    /^【[^】]+】\s*/,                                     // 【見出し】
    /^[Ａ-Ｚ]+[．.、,][^。．]+$/u,                       // A. 見出し
    /^[０-９]+[．.、,][^。．]+$/u,                       // 1. 見出し
    /^[A-Z][a-z]?[．.、,][^。．]+$/u,                    // A. 見出し
    /^[0-9]+[．.、,][^。．]+$/u,                         // 1. 見出し
    /^={3,}.+={3,}$/,                                    // === 見出し ===
    /^[-]{3,}.+[-]{3,}$/,                               // --- 見出し ---
    /^【[^】]+】$/,                                       // 【見出しのみ】
    /^[《「][^》」]+[》」]$/,                            // 《見出し》
  ],

  // 見出しレベルのキーワード
  HEADER_KEYWORDS: [
    '概要', '導入', 'はじめに', '前言', '背景',
    '本題', '本文', '主要内容', '詳細', '解説',
    '方法', '手法', '手順', 'プロセス',
    '結果', '成果', '効果', '適用事例',
    '考察', '分析', '評価', '比較',
    '結論', 'まとめ', '要約', '終わりに', 'おわりに',
    '付録', '参考', '関連', '連絡先'
  ],

  // ===== リスト検出設定 =====
  // リスト項目のパターン
  LIST_PATTERNS: [
    /^[・•◦○●\-\*]\s+/,                               // ・, •, -, * で始まる
    /^\d+[．.、,]\s+/,                                 // 1. 2. で始まる
    /^[a-z][）.)]\s+/i,                                // a) b) で始まる
    /^[A-Z][）.)]\s+/,                                 // A) B) で始まる
  ],

  // ===== チャンク化設定 =====
  // 文境界で分割（句点「。」で区切る）
  SPLIT_AT_SENTENCE_BOUNDARY: true,

  // 段落境界で分割
  SPLIT_AT_PARAGRAPH_BOUNDARY: true,

  // ===== 短かいチャンク対策 =====
  // 短かいチャンクを前後と結合
  MERGE_SMALL_CHUNKS: true,

  // 短かいチャンクの定義（このサイズ以下のチャンクは結合対象）
  SMALL_CHUNK_THRESHOLD: 100,

  // 前後のチャンクと結合する際の最大サイズ
  MERGE_MAX_SIZE: 400,

  // ===== 空白・改行処理 =====
  // 連続空白を正規化
  NORMALIZE_WHITESPACE: true,

  // 連続改行を段落区切りとして扱う
  DOUBLE_NEWLINE_AS_PARAGRAPH_BOUNDARY: true,

  // 連続改行の数（この数以上を一つの区切りとする）
  NEWLINE_COUNT_FOR_PARAGRAPH: 2,

  // ===== 出力設定 =====
  // TextChunkに自然文段落を保存（JSONではなくテキスト）
  STORE_AS_NATURAL_TEXT: true,

  // recordフィールドに見出し階層を保持
  STORE_HEADING_HIERARCHY: true
};

// ================================
// 段落復元メイン関数
// ================================

/**
 * OCRまたはPDF抽出結果から段落構造を復元します。
 * 見出しと本文を結合し、意味のまとまりを作成します。
 * 
 * 【処理フロー】
 * 1. テキストの前処理（空白・改行の正規化）
 * 2. 段落の検出（改行、空白、フォント情報を使用）
 * 3. 見出しの検出と分類
 * 4. 見出しと本文の結合
 * 5. 短かいチャンクのマージ
 * 6. チャンク化
 * 
 * @param {string} text - OCRまたはPDF抽出結果のテキスト
 * @param {Object} options - オプション設定
 * @param {boolean} options.useOcrStructure - OCRの構造情報を使用（位置情報など）
 * @param {Object} options.ocrData - OCR結果の詳細データ（Vision API結果など）
 * @returns {Object} 復元結果 { paragraphs: Array, chunks: Array, metadata: Object }
 */
function restoreParagraphs(text, options = {}) {
  // 設定を取得
  const config = { ...PARAGRAPH_CHUNK_CONFIG, ...options };

  if (!text || text.trim().length === 0) {
    return {
      paragraphs: [],
      chunks: [],
      metadata: { charCount: 0, paragraphCount: 0, chunkCount: 0 }
    };
  }

  logTrace('[PARAGRAPH:RESTORE] 段落復元開始 - 文字数:', text.length);

  // ステップ1: テキストの前処理
  const normalizedText = preprocessText(text, config);
  logTrace('[PARAGRAPH:RESTORE] 前処理完了 - 正規化後文字数:', normalizedText.length);

  // ステップ2: 段落の検出
  const paragraphs = detectParagraphs(normalizedText, config);
  logTrace('[PARAGRAPH:RESTORE] 段落検出完了 - 段落数:', paragraphs.length);

  // ステップ3: 見出しの検出と分類
  const paragraphsWithHeaders = detectAndClassifyHeaders(paragraphs, config);
  logTrace('[PARAGRAPH:RESTORE] 見出し検出完了');

  // ステップ4: 見出しと本文の結合
  const mergedParagraphs = mergeHeadersWithBody(paragraphsWithHeaders, config);
  logTrace('[PARAGRAPH:RESTORE] 見出し・本文結合完了 - 段落数:', mergedParagraphs.length);

  // ステップ5: 短かいチャンクのマージ
  const finalParagraphs = mergeSmallParagraphs(mergedParagraphs, config);
  logTrace('[PARAGRAPH:RESTORE] 短かい段落マージ完了 - 段落数:', finalParagraphs.length);

  // ステップ6: チャンク化
  const chunks = createChunks(finalParagraphs, config);
  logTrace('[PARAGRAPH:RESTORE] チャンク化完了 - チャンク数:', chunks.length);

  return {
    paragraphs: finalParagraphs,
    chunks: chunks,
    metadata: {
      originalCharCount: text.length,
      normalizedCharCount: normalizedText.length,
      paragraphCount: finalParagraphs.length,
      chunkCount: chunks.length,
      headerCount: finalParagraphs.filter(p => p.isHeader).length,
      listCount: finalParagraphs.filter(p => p.isListItem).length
    }
  };
}

/**
 * テキストの前処理を行います。
 * 空白・改行の正規化、特殊文字の統一などを行います。
 * 
 * @param {string} text - 処理対象テキスト
 * @param {Object} config - 設定オブジェクト
 * @returns {string} 正規化済みテキスト
 */
function preprocessText(text, config) {
  if (!text) return '';

  let normalized = text;

  // ステップ1: 改行コードの統一
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ステップ2: 全角・半角の統一
  // 全角数字 → 半角
  normalized = normalized.replace(/[０-９]/g, (char) => 
    String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
  );
  // 全角アルファベット → 半角
  normalized = normalized.replace(/[Ａ-Ｚａ-ｚ]/g, (char) => 
    String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
  );
  // 全角スペース → 半角スペース
  normalized = normalized.replace(/\u3000/g, ' ');

  // ステップ3: 連続空白の正規化
  if (config.NORMALIZE_WHITESPACE) {
    normalized = normalized.replace(/[ \t]+/g, ' ');
  }

  // ステップ4: 連続改行の処理
  if (config.DOUBLE_NEWLINE_AS_PARAGRAPH_BOUNDARY) {
    // 3つ以上の連続改行を2つに統一
    normalized = normalized.replace(/\n{3,}/g, '\n\n');
  }

  // ステップ5: 行頭行末の空白を削除
  normalized = normalized.split('\n').map(line => line.trim()).join('\n');

  // ステップ6: 段落末の空白を削除
  normalized = normalized.replace(/[ \t]+$/gm, '');

  // ステップ7: 連続する空行を整理
  normalized = normalized.replace(/\n{3,}/g, '\n\n');

  // ステップ8: 記号の揺らぎを統一
  normalized = normalized.replace(/[：:]/g, ':');    // コロン
  normalized = normalized.replace(/[,，]/g, ',');    // カンマ
  normalized = normalized.replace(/[．.]/g, '.');    // ピリオド
  normalized = normalized.replace(/[？?]/g, '?');    // 疑問符
  normalized = normalized.replace(/[！!]/g, '!');    // 感嘆符
  normalized = normalized.replace(/[「」『』]/g, '"'); // 引用符
  normalized = normalized.replace(/[（()]/g, '(');   // 括弧
  normalized = normalized.replace(/[）)]/g, ')');   // 括弧閉じ
  normalized = normalized.replace(/[・]/g, '-');    // 中黒

  return normalized;
}

// ================================
// 段落検出関数群
// ================================

/**
 * テキストから段落を検出します。
 * 改行、空白、位置情報を手がかりにして段落を区切ります。
 * 
 * @param {string} text - 処理対象テキスト
 * @param {Object} config - 設定オブジェクト
 * @returns {Array} 段落オブジェクトの配列
 */
function detectParagraphs(text, config) {
  if (!text) return [];

  const paragraphs = [];
  
  // ステップ1: 段落に分割（改行で区切る）
  const rawParagraphs = text.split(/\n\n+/);
  
  let currentHeadingLevel = 0;
  let currentSection = '';
  
  for (let i = 0; i < rawParagraphs.length; i++) {
    const rawPara = rawParagraphs[i];
    const trimmed = rawPara.trim();
    
    // 空の段落をスキップ
    if (!trimmed || trimmed.length === 0) continue;
    
    // ステップ2: 各段落の特徴を分析
    const paragraphInfo = analyzeParagraph(trimmed, i, config);
    
    // ステップ3: 見出しレベルの更新
    if (paragraphInfo.isHeader) {
      currentHeadingLevel = paragraphInfo.headerLevel || 1;
      currentSection = trimmed;
    } else {
      paragraphInfo.parentHeading = currentSection;
      paragraphInfo.parentLevel = currentHeadingLevel;
    }
    
    paragraphs.push(paragraphInfo);
  }
  
  return paragraphs;
}

/**
 * 段落の特徴を分析します。
 * 見出し、リスト項目、本文などを判定します。
 * 
 * @param {string} text - 段落テキスト
 * @param {number} index - 段落インデックス
 * @param {Object} config - 設定オブジェクト
 * @returns {Object} 段落情報オブジェクト
 */
function analyzeParagraph(text, index, config) {
  const trimmed = text.trim();
  const lineCount = text.split('\n').length;
  
  const info = {
    id: `p_${index}`,
    text: trimmed,
    originalText: text,
    index: index,
    lineCount: lineCount,
    charCount: trimmed.length,
    isHeader: false,
    isListItem: false,
    isStandaloneHeader: false,
    headerLevel: 0,
    headerType: null,
    confidence: 0,
    parentHeading: null,
    parentLevel: 0,
    record: {}
  };
  
  // ===== 見出し検出 =====
  const headerCheck = detectHeader(trimmed, config);
  if (headerCheck.isHeader) {
    info.isHeader = true;
    info.headerLevel = headerCheck.level;
    info.headerType = headerCheck.type;
    info.confidence = headerCheck.confidence;
    info.record.type = 'header';
    info.record.level = headerCheck.level;
  }
  
  // ===== リスト項目検出 =====
  const listCheck = detectListItem(trimmed, config);
  if (listCheck.isList) {
    info.isListItem = true;
    info.confidence = Math.max(info.confidence, listCheck.confidence);
    info.record.type = 'list';
    info.record.listStyle = listCheck.style;
  }
  
  // ===== 本文判定 =====
  if (!info.isHeader && !info.isListItem) {
    info.record.type = 'body';
  }
  
  // ===== 短かい段落の特別処理 =====
  if (trimmed.length < 30 && !info.isHeader) {
    // 短かい段落は見出しまたはリストの可能性が高い
    if (headerCheck.confidence > 0.5 || listCheck.confidence > 0.5) {
      info.isStandaloneHeader = true;
    }
  }
  
  return info;
}

/**
 * 段落が見出しかどうかを判定します。
 * パターン、マークアップ、キーワード等因素を総合的に評価します。
 * 
 * @param {string} text - 段落テキスト
 * @param {Object} config - 設定オブジェクト
 * @returns {Object} 判定結果 { isHeader, level, type, confidence }
 */
function detectHeader(text, config) {
  const trimmed = text.trim();
  
  // 即座に見出しでないとする条件
  if (!trimmed) return { isHeader: false, level: 0, type: null, confidence: 0 };
  
  // 長すぎる場合は見出しではない可能性が高い
  if (trimmed.length > 200) return { isHeader: false, level: 0, type: null, confidence: 0 };
  
  let isHeader = false;
  let level = 3;  // デフォルトは見出しレベル3
  let type = null;
  let confidence = 0;
  
  // ===== パターン1: マークダウン形式の見出し =====
  if (/^#{1,6}\s+/.test(trimmed)) {
    const match = trimmed.match(/^(#+)\s+/);
    if (match) {
      level = match[1].length;
      isHeader = true;
      type = 'markdown';
      confidence = 0.95;
    }
  }
  
  // ===== パターン2: 装飾線を含む見出し =====
  if (/^={3,}.+={3,}$/.test(trimmed) || /^[-]{3,}.+[-]{3,}$/.test(trimmed)) {
    isHeader = true;
    type = 'decorated';
    confidence = 0.9;
  }
  
  // ===== パターン3: 番号付き見出し =====
  const numberedPattern = /^第[一二三四五六七八九十百千０-９0-9]+[部章節項条号編]+[:：.]?\s*/u;
  if (numberedPattern.test(trimmed)) {
    isHeader = true;
    type = 'numbered';
    confidence = 0.95;
    
    // レベルの判定
    if (/第[一二三四五六七八九十]部/.test(trimmed)) level = 1;
    else if (/第[一二三四五六七八九十]章/.test(trimmed)) level = 2;
    else if (/第[一二三四五六七八九十]節/.test(trimmed)) level = 3;
    else level = 4;
  }
  
  // ===== パターン4: キーワード見出し =====
  // 「○○：」「○○.」形式
  if (!isHeader) {
    const keywordMatch = trimmed.match(/^([Ａ-Ｚa-z0-9][^:：.]{0,30})[:：.]\s*(.+)?$/);
    if (keywordMatch) {
      const prefix = keywordMatch[1];
      // プレフィックスがキーワードリストに含まれているか
      const isKnownKeyword = config.HEADER_KEYWORDS.some(kw => 
        prefix.includes(kw) || kw.includes(prefix)
      );
      
      if (isKnownKeyword || prefix.length <= 20) {
        isHeader = true;
        type = 'keyword';
        confidence = isKnownKeyword ? 0.85 : 0.7;
      }
    }
  }
  
  // ===== パターン5: 特殊マーク付き見出し =====
  if (!isHeader) {
    const specialPatterns = [
      /^[【\[].+[】\]]$/,           // 【見出し】
      /^[《「『][^》」』]+[》」』]$/, // 《見出し》
      /^[A-Z][）.)][\s　]*.+/,      // A) 見出し
      /^[a-z][）.)][\s　]*.+/,      // a) 見出し
    ];
    
    for (const pattern of specialPatterns) {
      if (pattern.test(trimmed)) {
        isHeader = true;
        type = 'special';
        confidence = 0.8;
        break;
      }
    }
  }
  
  // ===== パターン6: 短かい大文字テキスト =====
  if (!isHeader && trimmed.length <= 50) {
    // すべて大文字または数字のみ
    if (/^[Ａ-ＺA-Z0-9\s　.,-]+$/.test(trimmed) && /[Ａ-ＺA-Z]/.test(trimmed)) {
      isHeader = true;
      type = 'caps';
      confidence = 0.6;
    }
    
    // 数字とピリオドで始まる
    if (/^[0-9０-９]+[．.]/.test(trimmed)) {
      isHeader = true;
      type = 'numbered';
      confidence = 0.75;
    }
  }
  
  // ===== パターン7: キーワードベースの見出し判定 =====
  if (!isHeader && trimmed.length <= 100) {
    // 見出しキーワードが含まれている
    const hasKeyword = config.HEADER_KEYWORDS.some(kw => {
      // 完全に一致
      if (trimmed === kw || trimmed === kw + '：' || trimmed === kw + ':') return true;
      // 先頭に含まれる
      if (trimmed.startsWith(kw + '：') || trimmed.startsWith(kw + ':') ||
          trimmed.startsWith(kw + ' ') || trimmed.startsWith(kw + '　')) return true;
      return false;
    });
    
    if (hasKeyword) {
      isHeader = true;
      type = 'keyword';
      confidence = 0.7;
    }
  }
  
  return {
    isHeader,
    level,
    type,
    confidence
  };
}

/**
 * 段落がリスト項目かどうかを判定します。
 * 
 * @param {string} text - 段落テキスト
 * @param {Object} config - 設定オブジェクト
 * @returns {Object} 判定結果 { isList, style, confidence }
 */
function detectListItem(text, config) {
  const trimmed = text.trim();
  
  if (!trimmed) return { isList: false, style: null, confidence: 0 };
  
  // リストパターンをチェック
  for (const pattern of config.LIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      const style = pattern.source;
      return { isList: true, style, confidence: 0.8 };
    }
  }
  
  // 箇条書き文字が含まれている
  if (/^[・•◦○●\-\*]\s/.test(trimmed) || /\n[・•◦○●\-\*]\s/.test(trimmed)) {
    return { isList: true, style: 'bullet', confidence: 0.75 };
  }
  
  return { isList: false, style: null, confidence: 0 };
}

// ================================
// 見出し・本文結合関数群
// ================================

/**
 * 見出しと本文を結合します。
 * 見出しの直後にある本文は見出しと結合して1つの意味のまとまりとします。
 * 見出しだけではチャンクにならないようにします。
 * 
 * @param {Array} paragraphs - 段落オブジェクトの配列
 * @param {Object} config - 設定オブジェクト
 * @returns {Array} 結合済み段落の配列
 */
function mergeHeadersWithBody(paragraphs, config) {
  const merged = [];
  
  for (let i = 0; i < paragraphs.length; i++) {
    const current = paragraphs[i];
    
    // 見出しの場合
    if (current.isHeader) {
      // 次の段落を取得
      const next = paragraphs[i + 1];
      
      // 次の段落があり、かつ見出しではなく、本文またはリスト項目の場合
      if (next && !next.isHeader) {
        // 見出しと本文を結合
        const combined = {
          ...current,
          text: `${current.text}\n\n${next.text}`,
          originalText: `${current.originalText}\n\n${next.originalText}`,
          charCount: current.text.length + 2 + next.text.length,
          isHeader: true,  // 見出しフラグは維持
          hasBody: true,   // 本文を含むフラグ
          record: {
            ...current.record,
            hasBody: true,
            bodyCharCount: next.charCount
          }
        };
        
        merged.push(combined);
        
        // 次の段落は結合済みとしてスキップ
        continue;
      } else {
        // 見出しの後に本文がない場合（短かい見出しのみ）
        // この見出しをフラグ付けして、後でマージ対象とする
        current.isStandaloneHeader = true;
        current.record.standaloneHeader = true;
        merged.push(current);
      }
    } else {
      // 本文またはリスト項目
      merged.push(current);
    }
  }
  
  return merged;
}

/**
 * 連続する短かい段落をマージします。
 * 見出しだけのチャンクや短かい本文を見出しと結合します。
 * 
 * @param {Array} paragraphs - 段落オブジェクトの配列
 * @param {Object} config - 設定オブジェクト
 * @returns {Array} マージ済み段落の配列
 */
function mergeSmallParagraphs(paragraphs, config) {
  if (!config.MERGE_SMALL_CHUNKS) return paragraphs;
  
  const merged = [];
  
  for (let i = 0; i < paragraphs.length; i++) {
    const current = paragraphs[i];
    
    // 現在の段落が短かい場合
    if (current.charCount < config.SMALL_CHUNK_THRESHOLD) {
      // ===== 次の段落とマージを試みる =====
      if (i + 1 < paragraphs.length) {
        const next = paragraphs[i + 1];
        const combinedLength = current.charCount + 2 + next.charCount;
        
        // マージ後のサイズが許容範囲内の場合
        if (combinedLength <= config.MERGE_MAX_SIZE) {
          // 見出し + 本文としてマージ
          const combined = {
            ...current,
            text: `${current.text}\n\n${next.text}`,
            originalText: `${current.originalText}\n\n${next.originalText}`,
            charCount: combinedLength,
            isHeader: current.isHeader,
            hasBody: !current.isHeader || next.isListItem || !next.isHeader,
            record: {
              ...current.record,
              merged: true,
              mergedFrom: [current.id, next.id]
            }
          };
          
          merged.push(combined);
          i++;  // 次の段落をスキップ
          continue;
        }
      }
      
      // ===== 前の段落とマージを試みる =====
      if (merged.length > 0) {
        const prev = merged[merged.length - 1];
        const prevCombinedLength = prev.charCount + 2 + current.charCount;
        
        // マージ後のサイズが許容範囲内の場合
        if (prevCombinedLength <= config.MERGE_MAX_SIZE) {
          // 前の段落に結合
          prev.text = `${prev.text}\n\n${current.text}`;
          prev.originalText = `${prev.originalText}\n\n${current.originalText}`;
          prev.charCount = prevCombinedLength;
          prev.hasBody = true;
          prev.record.merged = true;
          prev.record.mergedFrom = [...(prev.record.mergedFrom || [prev.id]), current.id];
          continue;
        }
      }
    }
    
    // マージできない場合はそのまま追加
    merged.push(current);
  }
  
  return merged;
}

// ================================
// チャンク化関数群
// ================================

/**
 * 段落からチャンクを作成します。
 * 1チャンク=1段落を基本原则とし、大きすぎる場合は分割します。
 * 
 * @param {Array} paragraphs - 段落オブジェクトの配列
 * @param {Object} config - 設定オブジェクト
 * @returns {Array} チャンクオブジェクトの配列
 */
function createChunks(paragraphs, config) {
  const chunks = [];
  
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    
    // ===== チャンクサイズをチェック =====
    if (para.charCount <= config.MAX_CHUNK_SIZE) {
      // 適切なサイズの段落はそのままチャンク化
      chunks.push(createChunk(para, i, config));
    } else {
      // 大きすぎる段落は分割
      const subChunks = splitLargeParagraph(para, config);
      for (let j = 0; j < subChunks.length; j++) {
        chunks.push(createChunk(subChunks[j], i, config, j, subChunks.length));
      }
    }
  }
  
  return chunks;
}

/**
 * 段落からチャンクオブジェクトを作成します。
 * 
 * @param {Object} para - 段落オブジェクト
 * @param {number} index - 段落インデックス
 * @param {Object} config - 設定オブジェクト
 * @param {number} subIndex - 分割した場合のサブインデックス
 * @param {number} totalSub - 分割した場合の総数
 * @returns {Object} チャンクオブジェクト
 */
function createChunk(para, index, config, subIndex = 0, totalSub = 1) {
  // TextChunkには自然文段落を保存（JSONではなく）
  const textChunk = config.STORE_AS_NATURAL_TEXT ? para.text : para.text;
  
  return {
    id: `chunk_${index}_${subIndex}`,
    text: textChunk,                          // 自然文段落
    charCount: para.charCount,
    paragraphIndex: index,
    subIndex: subIndex,
    totalSub: totalSub,
    isHeader: para.isHeader,
    hasBody: para.hasBody || !para.isHeader,
    isStandaloneHeader: para.isStandaloneHeader,
    parentHeading: para.parentHeading,
    parentLevel: para.parentLevel,
    record: config.STORE_HEADING_HIERARCHY ? {
      ...para.record,
      text: textChunk,
      hierarchy: {
        level: para.parentLevel,
        heading: para.parentHeading,
        isHeaderChunk: para.isHeader,
        hasBody: para.hasBody || !para.isHeader
      }
    } : {}
  };
}

/**
 * 大きすぎる段落を分割します。
 * 文境界を检测して意味的な区切りで分割します。
 * 
 * @param {Object} para - 段落オブジェクト
 * @param {Object} config - 設定オブジェクト
 * @returns {Array} 分割されたテキスト配列
 */
function splitLargeParagraph(para, config) {
  const text = para.text;
  const chunks = [];
  
  if (!config.SPLIT_AT_SENTENCE_BOUNDARY) {
    // 文境界で分割しない場合は文字数ベースで分割
    let start = 0;
    while (start < text.length) {
      let end = start + config.TARGET_CHUNK_SIZE;
      
      if (end < text.length) {
        // 文の終わりを探す
        const lastPeriod = text.lastIndexOf('。', end);
        const lastNewline = text.lastIndexOf('\n', end);
        const breakPoint = Math.max(lastPeriod, lastNewline);
        
        if (breakPoint > start + config.MIN_CHUNK_SIZE) {
          end = breakPoint + 1;  // 句点を含める
        }
      }
      
      chunks.push(text.slice(start, end).trim());
      start = end;
    }
    
    return chunks;
  }
  
  // 文境界で分割
  // 句点「。」、改行、セミコロン「；」などで区切る
  const sentences = [];
  let current = '';
  const chars = text.split('');
  
  for (let i = 0; i < chars.length; i++) {
    current += chars[i];
    
    // 文の終わりを检测
    const isEndOfSentence = ['。', '！', '？', '．', '.'].includes(chars[i]);
    const isBreak = chars[i] === '\n';
    
    if (isEndOfSentence || isBreak) {
      // 現在の文を追加
      if (current.trim()) {
        sentences.push(current.trim());
      }
      current = '';
    }
  }
  
  // 残りのテキストを追加
  if (current.trim()) {
    sentences.push(current.trim());
  }
  
  // ===== 文を集約してチャンクにする =====
  let currentChunk = '';
  
  for (const sentence of sentences) {
    const potentialLength = currentChunk.length + (currentChunk ? 2 : 0) + sentence.length;
    
    if (potentialLength > config.MAX_CHUNK_SIZE && currentChunk.length > 0) {
      // 現在のチャンクを保存
      chunks.push(currentChunk);
      currentChunk = sentence;
    } else {
      // チャンクに追加
      if (currentChunk) {
        currentChunk += '\n' + sentence;
      } else {
        currentChunk = sentence;
      }
    }
  }
  
  // 最後のチャンクを追加
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  // チャンクがまだ大きすぎる場合は文字数ベースで強制分割
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= config.MAX_CHUNK_SIZE) {
      finalChunks.push(chunk);
    } else {
      // 強制分割
      let start = 0;
      while (start < chunk.length) {
        let end = start + config.TARGET_CHUNK_SIZE;
        if (end < chunk.length) {
          const lastBreak = chunk.lastIndexOf('\n', end);
          if (lastBreak > start) {
            end = lastBreak;
          }
        }
        finalChunks.push(chunk.slice(start, end).trim());
        start = end;
      }
    }
  }
  
  return finalChunks;
}

// ================================
// Embedding 生成関数
// ================================

/**
 * チャンクからEmbeddingを生成します。
 * 各チャンクの自然文テキストに対してEmbeddingを生成します。
 * 
 * @param {Object} chunk - チャンクオブジェクト
 * @param {string} chunk.text - チャンクテキスト（自然文段落）
 * @returns {Object|null} Embedding結果 { embedding: Array, naturalText: string }
 */
function generateChunkEmbedding(chunk) {
  if (!chunk || !chunk.text) {
    logWarn('[EMBEDDING:CHUNK] チャンクが空です');
    return null;
  }

  const naturalText = chunk.text;
  const embedding = getEmbeddingWithCache(naturalText);

  if (!embedding) {
    logError('[EMBEDDING:CHUNK] Embedding生成失敗');
    return null;
  }

  return {
    embedding: embedding,
    naturalText: naturalText,
    charCount: naturalText.length
  };
}

/**
 * 複数のチャンクのEmbeddingを生成します。
 * 
 * @param {Array} chunks - チャンクオブジェクトの配列
 * @returns {Array} Embedding結果の配列
 */
function generateChunksEmbeddings(chunks) {
  const results = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // Embeddingを生成
    const embeddingResult = generateChunkEmbedding(chunk);
    
    if (embeddingResult) {
      results.push({
        ...chunk,
        embedding: embeddingResult.embedding,
        embeddingCharCount: embeddingResult.charCount
      });
    }

    // API呼び出し間隔を空ける（100ms）
    Utilities.sleep(100);
  }

  logInfo('[EMBEDDING:CHUNK] チャンク群のEmbedding生成完了 - 成功:', results.length, '/', chunks.length);

  return results;
}

// ================================
// RAG 用高レベル関数
// ================================

/**
 * OCR/PDF抽出結果からRAG用チャンクを生成します。
 * 段落復元→チャンク化→Embedding生成の一連の処理を実行します。
 * 
 * 【処理フロー】
 * 1. 段落構造の復元（見出しと本文の結合）
 * 2. 意味のまとまりでのチャンク化
 * 3. 各チャンクのEmbedding生成
 * 
 * @param {string} text - OCRまたはPDF抽出結果
 * @param {Object} options - オプション設定
 * @returns {Object} RAG処理結果
 */
function processTextForRag(text, options = {}) {
  logInfo('[RAG:PARAGRAPH] RAG処理開始 - 文字数:', text.length);

  // 設定を取得
  const config = { ...PARAGRAPH_CHUNK_CONFIG, ...options };

  // ステップ1: 段落復元
  const restoreResult = restoreParagraphs(text, config);
  logInfo('[RAG:PARAGRAPH] 段落復元完了 - 段落数:', restoreResult.paragraphs.length);

  // ステップ2: チャンク化
  const chunks = restoreResult.chunks;
  logInfo('[RAG:PARAGRAPH] チャンク化完了 - チャンク数:', chunks.length);

  // ステップ3: Embedding生成
  const chunksWithEmbedding = generateChunksEmbeddings(chunks);
  logInfo('[RAG:PARAGRAPH] Embedding生成完了 - 成功:', chunksWithEmbedding.length);

  return {
    success: true,
    text: text,
    paragraphs: restoreResult.paragraphs,
    chunks: chunksWithEmbedding,
    metadata: {
      ...restoreResult.metadata,
      embeddingSuccessCount: chunksWithEmbedding.length
    }
  };
}

/**
 * OCR結果にVision APIの詳細情報が含まれている場合、
 * 位置情報やフォントサイズを活用して段落構造を復元します。
 * 
 * @param {string} text - 抽出されたテキスト
 * @param {Object} ocrData - Vision APIの詳細結果
 * @param {Object} options - オプション設定
 * @returns {Object} RAG処理結果
 */
function processOcrWithStructure(text, ocrData, options = {}) {
  logInfo('[RAG:OCR:STRUCTURE] 構造情報付きOCR処理開始');

  // Vision APIの結果がない場合は通常の段落復元を使用
  if (!ocrData || !ocrData.pages) {
    logWarn('[RAG:OCR:STRUCTURE] 構造情報なし、標準処理を使用');
    return processTextForRag(text, options);
  }

  // 設定を取得
  const config = { ...PARAGRAPH_CHUNK_CONFIG, ...options };

  // Vision APIの構造情報を使用して段落を検出
  const paragraphsWithStructure = analyzeOcrStructure(ocrData, config);
  
  // 段落復元を続行
  const paragraphs = paragraphsWithStructure.map((para, index) => ({
    id: `p_${index}`,
    text: para.text,
    originalText: para.text,
    index: index,
    charCount: para.text.length,
    isHeader: para.isHeader,
    isListItem: para.isListItem,
    headerLevel: para.headerLevel || 0,
    confidence: para.confidence || 0,
    boundingBox: para.boundingBox,
    fontSize: para.fontSize,
    record: {
      type: para.isHeader ? 'header' : (para.isListItem ? 'list' : 'body'),
      level: para.headerLevel,
      fontSize: para.fontSize,
      boundingBox: para.boundingBox
    }
  }));

  // 見出しと本文の結合
  const mergedParagraphs = mergeHeadersWithBody(paragraphs, config);

  // 短かい段落のマージ
  const finalParagraphs = mergeSmallParagraphs(mergedParagraphs, config);

  // チャンク化
  const chunks = createChunks(finalParagraphs, config);

  // Embedding生成
  const chunksWithEmbedding = generateChunksEmbeddings(chunks);

  return {
    success: true,
    text: text,
    paragraphs: finalParagraphs,
    chunks: chunksWithEmbedding,
    metadata: {
      originalCharCount: text.length,
      paragraphCount: finalParagraphs.length,
      chunkCount: chunksWithEmbedding.length,
      hasOcrStructure: true
    }
  };
}

/**
 * Vision API OCR結果の構造情報を解析します。
 * 
 * @param {Object} ocrData - Vision APIの詳細結果
 * @param {Object} config - 設定オブジェクト
 * @returns {Array} 段落オブジェクトの配列
 */
function analyzeOcrStructure(ocrData, config) {
  if (!ocrData || !ocrData.pages) {
    return [];
  }

  const paragraphs = [];

  // 全ページを処理
  for (const page of ocrData.pages) {
    if (!page.blocks) continue;

    for (const block of page.blocks) {
      if (!block.paragraphs) continue;

      for (const para of block.paragraphs) {
        // テキストを抽出
        let text = '';
        if (para.words) {
          for (const word of para.words) {
            if (word.symbols) {
              for (const symbol of word.symbols) {
                text += symbol.text || '';
              }
            }
            text += ' ';
          }
        }
        text = text.trim();

        if (!text) continue;

        // フォントサイズを推定
        const fontSize = estimateFontSize(para.boundingBox);

        // 見出し判定
        const headerCheck = detectHeader(text, config);

        // リスト項目判定
        const listCheck = detectListItem(text, config);

        // フォントサイズから見出しレベルを推定
        let headerLevel = headerCheck.level;
        if (!headerCheck.isHeader && fontSize > 14) {
          // 大きなフォントは見出しの可能性が高い
          headerLevel = 2;
        }

        paragraphs.push({
          text: text,
          isHeader: headerCheck.isHeader,
          headerLevel: headerLevel,
          isListItem: listCheck.isList,
          confidence: headerCheck.confidence || listCheck.confidence,
          boundingBox: para.boundingBox,
          fontSize: fontSize
        });
      }
    }
  }

  return paragraphs;
}

/**
 * バウンディングボックスからフォントサイズを推定します。
 * 
 * @param {Object} boundingBox - バウンディングボックス
 * @returns {number} 推定フォントサイズ
 */
function estimateFontSize(boundingBox) {
  if (!boundingBox || !boundingBox.vertices) {
    return 12;  // デフォルトフォントサイズ
  }

  const vertices = boundingBox.vertices;
  if (vertices.length < 4) {
    return 12;
  }

  // 高さを計算
  const ys = vertices.map(v => v.y || 0);
  const height = Math.max(...ys) - Math.min(...ys);

  // 高さからフォントサイズを概算（一般的なOCR解析の比例定数）
  // 実際の値はOCR結果に大きく依存するため、概算値として返す
  return Math.max(8, Math.min(24, height / 10));
}

// ================================
// RAG シート追加関数
// ================================

/**
 * 段落復元チャンクをRAGシートに追加します。
 * 
 * @param {Sheet} sheet - RAGシート
 * @param {Object} ragResult - processTextForRagの結果
 * @param {string} fileId - ファイルID
 * @param {string} fileName - ファイル名
 * @param {string} mimeType - MIMEタイプ
 * @returns {boolean} 成功した場合true
 */
function indexParagraphChunks(sheet, ragResult, fileId, fileName, mimeType) {
  if (!ragResult || !ragResult.chunks || ragResult.chunks.length === 0) {
    logWarn('[INDEX:PARAGRAPH] チャンクがありません');
    return false;
  }

  try {
    logInfo('[INDEX:PARAGRAPH] インデックスに追加開始 - ファイル:', fileName, 'チャンク数:', ragResult.chunks.length);

    for (let i = 0; i < ragResult.chunks.length; i++) {
      const chunk = ragResult.chunks[i];

      if (!chunk.embedding) {
        logWarn('[INDEX:PARAGRAPH] Embeddingがありません - chunk:', i);
        continue;
      }

      // メタデータを生成
      const metadata = {
        fileId: fileId,
        fileName: fileName,
        chunkIndex: i,
        totalChunks: ragResult.chunks.length,
        charCount: chunk.charCount,
        preview: chunk.text.substring(0, 100),
        mimeType: mimeType
      };

      // record情報から見出し階層を抽出
      let headingHierarchy = '';
      if (chunk.record && chunk.record.hierarchy) {
        const h = chunk.record.hierarchy;
        if (h.heading) {
          headingHierarchy = `【${h.heading}】`;
        }
      }

      // キーワードを抽出
      const keywords = extractKeywords(chunk.text);

      // TextChunkには自然文段落を保存（JSONではない）
      const textChunk = chunk.text;

      sheet.appendRow([
        metadata.fileId,
        metadata.fileName,
        metadata.mimeType,
        textChunk,                                    // 自然文段落
        JSON.stringify(chunk.embedding),             // Embeddingベクトル
        metadata.chunkIndex,
        new Date(),
        metadata.charCount,
        metadata.preview,
        metadata.totalChunks,
        keywords.join(','),
        headingHierarchy                              // 見出し階層（recordの代わりに）
      ]);

      // API呼び出し間隔を空ける
      Utilities.sleep(300);
    }

    logInfo('[INDEX:PARAGRAPH] インデックス追加完了 - ファイル:', fileName, 'チャンク数:', ragResult.chunks.length);
    return true;

  } catch (error) {
    logError('[INDEX:PARAGRAPH] インデックス追加エラー:', error);
    return false;
  }
}

/**
 * PDFファイルから段落復元チャンクを生成してインデックスに追加します。
 * 
 * @param {string} fileId - Google DriveのファイルID
 * @param {string} fileName - ファイル名
 * @param {string} mimeType - MIMEタイプ
 * @param {Object} options - オプション設定
 * @returns {Object} 処理結果
 */
function processAndIndexWithParagraphRestoration(fileId, fileName, mimeType, options = {}) {
  try {
    logInfo('[RAG:PARAGRAPH:PDF] PDF処理開始 - ファイル:', fileName);

    // テキストを抽出
    const text = extractText(fileId, mimeType, fileName);

    if (!text || text.trim().length === 0) {
      logWarn('[RAG:PARAGRAPH:PDF] テキストが空 - ファイル:', fileName);
      return { success: false, error: 'テキスト抽出失敗' };
    }

    logInfo('[RAG:PARAGRAPH:PDF] テキスト抽出完了 - 文字数:', text.length);

    // 段落復元チャンク処理
    const ragResult = processTextForRag(text, options);

    if (!ragResult.success || ragResult.chunks.length === 0) {
      logWarn('[RAG:PARAGRAPH:PDF] チャンク生成失敗 - ファイル:', fileName);
      return { success: false, error: 'チャンク生成失敗' };
    }

    logInfo('[RAG:PARAGRAPH:PDF] チャンク生成完了 - チャンク数:', ragResult.chunks.length);

    // インデックスに追加
    const sheet = getRagSheet();
    const success = indexParagraphChunks(sheet, ragResult, fileId, fileName, mimeType);

    if (success) {
      logInfo('[RAG:PARAGRAPH:PDF] インデックス追加完了 - ファイル:', fileName);
      return {
        success: true,
        fileId: fileId,
        fileName: fileName,
        totalChunks: ragResult.chunks.length,
        paragraphCount: ragResult.metadata.paragraphCount
      };
    } else {
      return { success: false, error: 'インデックス追加失敗' };
    }

  } catch (error) {
    logError('[RAG:PARAGRAPH:PDF] エラー:', error);
    return { success: false, error: error.message };
  }
}

// ================================
// ユーティリティ関数
// ================================

/**
 * チャンクのサマリーを生成します。
 * 
 * @param {Object} chunk - チャンクオブジェクト
 * @returns {string} サマリーテキスト
 */
function generateChunkSummary(chunk) {
  const lines = [];
  
  if (chunk.parentHeading) {
    lines.push(`【${chunk.parentHeading}】`);
  }
  
  lines.push(chunk.text.substring(0, 200));
  
  if (chunk.text.length > 200) {
    lines.push('...');
  }
  
  return lines.join('\n');
}

/**
 * チャンクのプレビューを生成します。
 * 
 * @param {Object} chunk - チャンクオブジェクト
 * @param {number} maxLength - 最大長
 * @returns {string} プレビューテキスト
 */
function generateChunkPreview(chunk, maxLength = 100) {
  const text = chunk.text.replace(/\n/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + '...';
}

/**
 * チャンクの情報をログに出力します。
 * 
 * @param {Object} chunk - チャンクオブジェクト
 * @param {number} index - インデックス
 */
function logChunkInfo(chunk, index) {
  logTrace(`[CHUNK:${index}]`, {
    id: chunk.id,
    charCount: chunk.charCount,
    isHeader: chunk.isHeader,
    hasBody: chunk.hasBody,
    parentHeading: chunk.parentHeading ? '...' : null,
    preview: generateChunkPreview(chunk, 50)
  });
}

/**
 * チャンク群の統計情報を生成します。
 * 
 * @param {Array} chunks - チャンクオブジェクトの配列
 * @returns {Object} 統計情報
 */
function getChunksStats(chunks) {
  if (!chunks || chunks.length === 0) {
    return {
      totalChunks: 0,
      totalCharCount: 0,
      avgCharCount: 0,
      minCharCount: 0,
      maxCharCount: 0,
      headerChunks: 0,
      bodyChunks: 0
    };
  }

  const charCounts = chunks.map(c => c.charCount);
  const headerChunks = chunks.filter(c => c.isHeader).length;
  const bodyChunks = chunks.filter(c => !c.isHeader).length;

  return {
    totalChunks: chunks.length,
    totalCharCount: charCounts.reduce((a, b) => a + b, 0),
    avgCharCount: Math.round(charCounts.reduce((a, b) => a + b, 0) / chunks.length),
    minCharCount: Math.min(...charCounts),
    maxCharCount: Math.max(...charCounts),
    headerChunks: headerChunks,
    bodyChunks: bodyChunks,
    standaloneHeaders: chunks.filter(c => c.isStandaloneHeader).length
  };
}

// ================================
// テスト関数
// ================================

/**
 * 段落復元チャンク化のテスト
 * 
 * @param {string} testText - テスト用テキスト
 */
function testParagraphRestoration(testText) {
  // テスト用テキスト
  const sampleText = testText || `
第1部: BERT

AIがもたらす科学技術・イノベーションの変革:

深層学習の基礎モデルであるBERTは、
自然言語処理の分野に革命をもたらしました。

BERTの特徴:
• 双方向性の Transformer
• 事前学習とファインチューニング
• 高い精度

適用事例:
文書分類、質問応答、感情分析など。

第2部: GPT

生成AIの発展:

GPTシリーズは大規模言語モデルの代表例です。
文章生成、翻訳、対話など幅広いタスクに対応します。

使用方法:
APIを通じて簡単にアクセス可能。
コスト効率的な実装が可能。
`;

  logInfo('[TEST] 段落復元テスト開始');
  logInfo('[TEST] 入力テキスト長:', sampleText.length);

  // 段落復元を実行
  const result = restoreParagraphs(sampleText, PARAGRAPH_CHUNK_CONFIG);

  logInfo('[TEST] ===== 段落復元結果 =====');
  logInfo('[TEST] 段落数:', result.paragraphs.length);
  logInfo('[TEST] チャンク数:', result.chunks.length);
  logInfo('[TEST] メタデータ:', JSON.stringify(result.metadata));

  // 各チャンクを表示
  logInfo('[TEST] ===== チャンク一覧 =====');
  for (let i = 0; i < result.chunks.length; i++) {
    const chunk = result.chunks[i];
    logInfo(`[TEST] --- チャンク ${i + 1} ---`);
    logInfo(`[TEST] ID: ${chunk.id}`);
    logInfo(`[TEST] 文字数: ${chunk.charCount}`);
    logInfo(`[TEST] 見出し: ${chunk.isHeader}`);
    logInfo(`[TEST] 本文含む: ${chunk.hasBody}`);
    logInfo(`[TEST] 親見出し: ${chunk.parentHeading || 'なし'}`);
    logInfo(`[TEST] テキストプレビュー: ${generateChunkPreview(chunk, 80)}`);
    logInfo('');
  }

  // 統計情報を表示
  const stats = getChunksStats(result.chunks);
  logInfo('[TEST] ===== 統計情報 =====');
  logInfo(`[TEST] 総チャンク数: ${stats.totalChunks}`);
  logInfo(`[TEST] 総文字数: ${stats.totalCharCount}`);
  logInfo(`[TEST] 平均文字数: ${stats.avgCharCount}`);
  logInfo(`[TEST] 最小/最大: ${stats.minCharCount} / ${stats.maxCharCount}`);
  logInfo(`[TEST] 見出しチャンク: ${stats.headerChunks}`);
  logInfo(`[TEST] 本文チャンク: ${stats.bodyChunks}`);
  logInfo(`[TEST] 独立見出し: ${stats.standaloneHeaders}`);

  // RAG処理のテスト
  logInfo('[TEST] ===== RAG処理テスト =====');
  const ragResult = processTextForRag(sampleText, PARAGRAPH_CHUNK_CONFIG);

  logInfo('[TEST] RAG処理成功:', ragResult.success);
  logInfo('[TEST] Embedding生成成功:', ragResult.metadata.embeddingSuccessCount, '/', ragResult.chunks.length);

  return {
    paragraphs: result,
    chunks: result.chunks,
    stats: stats,
    ragResult: ragResult
  };
}

/**
 * サンプルOCR結果の段落復元テスト
 */
function testOcrParagraphRestoration() {
  // OCRでよくある断片的なテキスト例
  const ocrText = `
第１部: BERT
ＡＩがもたらす科学技術・イノベーションの変革
:
深層学習の革命
Transformer アーキテクチャ
双方向エンコーディング
事前学習とファインチューニング
高い精度
文書分類
質問応答
感情分析
第２部: GPT
生成 AI の発展
大規模言語モデル
文章生成
翻訳
対話システム
`;

  logInfo('[TEST:OCR] OCRテキストの段落復元テスト開始');

  const result = testParagraphRestoration(ocrText);

  logInfo('[TEST:OCR] ===== 結果サマリー =====');
  logInfo('[TEST:OCR] チャンク数:', result.chunks.length);
  logInfo('[TEST:OCR] 平均文字数:', result.stats.avgCharCount);
  logInfo('[TEST:OCR] 短かいチャンク（100文字以下）:', result.chunks.filter(c => c.charCount < 100).length);

  return result;
}
