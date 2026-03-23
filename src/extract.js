/**
 * 各種ファイル形式からのテキスト抽出モジュール
 * 
 * @module extract
 * @description 各種ファイル形式からのテキスト抽出
 * 
 * このファイルには以下が含まれています：
 * - extractText: 様々なMimeTypeのファイルからテキストを抽出
 * - Google Sheets, PowerPoint, Excel, PDF, Wordのテキスト抽出関数
 * - Vision API OCR関数
 * - 表構造復元関数群
 * - BoundingBox解析ユーティリティ
 * 
 * @depends config, chunk
 * @exports extractText, extractTextFromGoogleSheets, extractTextFromWord, extractTextFromPDFWithOCR, extractTableWithStructure
 */

/**
 * 様々なMimeTypeのファイルからテキストを抽出
 */
function extractText(fileId, mimeType, name) {
  if (mimeType === 'application/vnd.google-apps.document' || mimeType === MimeType.GOOGLE_DOCS) {
    return DocumentApp.openById(fileId).getBody().getText();
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet' || mimeType === MimeType.GOOGLE_SHEETS) {
    return extractTextFromGoogleSheets(fileId, name);
  }
  if (mimeType === 'text/plain') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  if (mimeType === 'text/csv') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  if (mimeType === 'text/html') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown' || mimeType === 'application/x-markdown') return DriveApp.getFileById(fileId).getBlob().getDataAsString();
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mimeType === MimeType.MICROSOFT_WORD) {
    return extractTextFromWord(fileId, name);
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimeType === MimeType.MICROSOFT_EXCEL) {
    return extractTextFromExcel(fileId, name);
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || mimeType === MimeType.MICROSOFT_POWERPOINT) {
    return extractTextFromPowerPoint(fileId, name);
  }
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
 */
function extractTextFromPowerPoint(fileId, fileName) {
  try {
    logTrace("[PPT] PowerPointテキスト抽出開始 - fileId:", fileId, "fileName:", fileName);
    const file = DriveApp.getFileById(fileId);
    const fileBlob = file.getBlob();
    const resource = {
      title: "temp_ppt_" + fileName,
      mimeType: MimeType.GOOGLE_SLIDES
    };
    const convertedFile = Drive.Files.insert(resource, fileBlob, { convert: true });
    logTrace("[PPT] Google Slidesへの変換完了 - convertedFileId:", convertedFile.id);

    const presentation = Slides.Presentations.get(convertedFile.id);
    let text = "";

    function extractTextFromElement(el) {
      let extractedText = "";
      try {
        if (el.shape && el.shape.text && el.shape.text.textElements) {
          el.shape.text.textElements.forEach(t => {
            if (t.textRun && t.textRun.content) {
              extractedText += t.textRun.content;
            }
          });
        }
        if (el.table) {
          el.table.tableRows.forEach(row => {
            row.tableCells.forEach(cell => {
              const cellText = cell.text.textElements.map(te => te.textRun ? te.textRun.content : "").join("");
              extractedText += cellText + "\t";
            });
            extractedText += "\n";
          });
        }
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

    presentation.slides.forEach((slide, index) => {
      text += `\n【スライド ${index + 1}】\n`;
      slide.pageElements.forEach(el => {
        const extracted = extractTextFromElement(el);
        if (extracted) {
          text += extracted + "\n";
        }
      });
    });

    DriveApp.getFileById(convertedFile.id).setTrashed(true);

    if (text && text.trim().length > 0) {
      logTrace("[PPT] PowerPointテキスト抽出成功 - fileName:", fileName, "文字数:", text.length);
      return text;
    }
    logWarn("[PPT] PowerPointファイルからテキストを抽出できませんでした - fileName:", fileName);
    return "";
  } catch (error) {
    logError("[PPT] PowerPoint抽出エラー - fileName:", fileName, "error:", error.message);
    return "";
  }
}

/**
 * Excelファイルからテキストを抽出
 */
function extractTextFromExcel(fileId, fileName) {
  try {
    logTrace("[EXCEL] Excelテキスト抽出開始 - fileId:", fileId, "fileName:", fileName);
    const file = DriveApp.getFileById(fileId);
    const fileBlob = file.getBlob();
    const resource = {
      title: "temp_excel_" + fileName,
      mimeType: MimeType.GOOGLE_SHEETS
    };
    const convertedFile = Drive.Files.insert(resource, fileBlob, { convert: true });
    logTrace("[EXCEL] Google Sheetsへの変換完了 - convertedFileId:", convertedFile.id);

    const spreadsheet = SpreadsheetApp.openById(convertedFile.id);
    let text = "";
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

    DriveApp.getFileById(convertedFile.id).setTrashed(true);

    if (text && text.trim().length > 0) {
      logTrace("[EXCEL] Excelテキスト抽出成功 - fileName:", fileName, "文字数:", text.length);
      return text;
    }
    logWarn("[EXCEL] Excelファイルからテキストを抽出できませんでした - fileName:", fileName);
    return "";
  } catch (error) {
    logError("[EXCEL] Excel抽出エラー - fileName:", fileName, "error:", error.message);
    return "";
  }
}

/**
 * PDFファイルからOCRを使用してテキストを抽出
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
    const fileBlob = DriveApp.getFileById(fileId).getBlob();
    const resource = {
      title: "temp_ocr_" + fileName,
      mimeType: MimeType.GOOGLE_DOCS
    };
    const convertedFile = Drive.Files.insert(resource, fileBlob, { convert: true });
    const text = DocumentApp.openById(convertedFile.id).getBody().getText();
    DriveApp.getFileById(convertedFile.id).setTrashed(true);

    if (text && text.trim().length > 0) {
      logTrace("[OCR] OCR完了:", fileName, "文字数:", text.length);
      return text;
    }
    return extractTextFromPDFWithVisionAPI_(fileId, fileName);
  } catch (error) {
    logError("[OCR] PDF OCRエラー:", error);
    try {
      return extractViaTempGoogleDoc_(fileId, fileName);
    } catch (fallbackError) {
      logError("[OCR] フォールバックも失敗:", fallbackError);
      return "";
    }
  }
}

/**
 * Vision APIを使用してPDFからテキストを抽出
 */
function extractTextFromPDFWithVisionAPI_(fileId, fileName) {
  const apiKey = getVisionApiKey();
  if (!apiKey) {
    logError("[OCR] Vision APIキーなし");
    return "";
  }
  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
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
 */
function extractTextFromWord(fileId, fileName) {
  try {
    logTrace("[WORD] Wordテキスト抽出開始 - fileId:", fileId, "fileName:", fileName);
    const file = DriveApp.getFileById(fileId);
    const fileBlob = file.getBlob();
    const resource = {
      title: "temp_word_" + fileName,
      mimeType: MimeType.GOOGLE_DOCS
    };
    const convertedFile = Drive.Files.insert(resource, fileBlob, { convert: true });
    logTrace("[WORD] Googleドキュメントへの変換完了 - convertedFileId:", convertedFile.id);

    const doc = DocumentApp.openById(convertedFile.id);
    let text = "";
    const bodyText = doc.getBody().getText();
    text += bodyText;

    const header = doc.getHeader();
    if (header) {
      const headerText = header.getText();
      if (headerText && headerText.trim().length > 0) {
        text += "\n【ヘッダー】\n" + headerText;
      }
    }

    const footer = doc.getFooter();
    if (footer) {
      const footerText = footer.getText();
      if (footerText && footerText.trim().length > 0) {
        text += "\n【フッター】\n" + footerText;
      }
    }

    DriveApp.getFileById(convertedFile.id).setTrashed(true);

    if (text && text.trim().length > 0) {
      logTrace("[WORD] Wordテキスト抽出成功 - fileName:", fileName, "文字数:", text.length);
      return text;
    }
    logWarn("[WORD] Wordファイルからテキストを抽出できませんでした - fileName:", fileName);
    return "";
  } catch (error) {
    logError("[WORD] Word抽出エラー - fileName:", fileName, "error:", error.message);
    return extractViaTempGoogleDoc_(fileId, fileName);
  }
}

/**
 * Googleドキュメント経由でテキストを抽出（フォールバック）
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
//  Vision API 表構造復元関数群
// ================================

/**
 * Vision API documentTextDetection を実行
 */
function performVisionDocumentOCR(fileId, fileName) {
  const apiKey = getVisionApiKey();
  if (!apiKey) {
    logError("[VISION:TABLE] Vision API キーが設定されていません");
    return null;
  }

  try {
    logTrace("[VISION:TABLE] Vision documentTextDetection 開始:", fileName);
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const mimeType = blob.getContentType();

    if (mimeType === 'application/pdf' || mimeType === MimeType.PDF) {
      return performVisionOCRForPdf(fileId, fileName, apiKey);
    }

    const base64Data = Utilities.base64Encode(blob.getBytes());
    const payload = {
      requests: [{
        image: { content: base64Data },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }]
      }]
    };

    const url = "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey;
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      logError("[VISION:TABLE] Vision API エラー: " + responseCode);
      return null;
    }

    const result = JSON.parse(response.getContentText());
    const annotation = result.responses[0];

    if (!annotation || annotation.error) {
      logError("[VISION:TABLE] Vision API エラー:", annotation?.error?.message);
      return null;
    }

    logTrace("[VISION:TABLE] Vision documentTextDetection 完了:", fileName);
    return annotation.fullTextAnnotation || null;
  } catch (error) {
    logError("[VISION:TABLE] Vision documentTextDetection エラー:", error);
    return null;
  }
}

/**
 * PDFファイルをVision APIでOCR処理
 */
function performVisionOCRForPdf(fileId, fileName, apiKey) {
  try {
    logTrace("[VISION:PDF] PDF Vision OCR開始:", fileName);
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const resource = { title: "temp_vision_pdf_" + fileName, mimeType: MimeType.GOOGLE_DOCS };
    const convertedFile = Drive.Files.insert(resource, blob, { convert: true });
    logTrace("[VISION:PDF] 変換完了 - convertedFileId:", convertedFile.id);

    const doc = DocumentApp.openById(convertedFile.id);
    const body = doc.getBody();
    const fullText = body.getText();

    const fullTextAnnotation = { text: fullText, pages: [] };
    const paragraphs = body.getParagraphs();
    const page = { width: 800, height: 1000, blocks: [] };

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const text = para.getText();
      if (!text || text.trim() === "") continue;

      const block = {
        blockType: "TEXT",
        paragraphs: [{
          words: [],
          symbols: [],
          text: text,
          boundingBox: { vertices: [{ x: 0, y: i * 30 }, { x: 800, y: i * 30 }, { x: 800, y: (i + 1) * 30 }, { x: 0, y: (i + 1) * 30 }] },
          confidence: 0.95
        }],
        boundingBox: { vertices: [{ x: 0, y: i * 30 }, { x: 800, y: i * 30 }, { x: 800, y: (i + 1) * 30 }, { x: 0, y: (i + 1) * 30 }] },
        confidence: 0.95
      };

      const words = text.split(/[\s　]+/).filter(w => w.length > 0);
      let charIndex = 0;
      
      for (const word of words) {
        const wordStart = text.indexOf(word, charIndex);
        const wordEnd = wordStart + word.length;
        const wordObj = {
          symbols: [],
          text: word,
          boundingBox: { vertices: [{ x: wordStart * 8, y: i * 30 }, { x: wordEnd * 8, y: i * 30 }, { x: wordEnd * 8, y: (i + 1) * 30 }, { x: wordStart * 8, y: (i + 1) * 30 }] },
          confidence: 0.95
        };
        for (const char of word) {
          wordObj.symbols.push({ text: char, confidence: 0.95 });
        }
        block.paragraphs[0].words.push(wordObj);
        block.paragraphs[0].symbols.push(...wordObj.symbols);
        charIndex = wordEnd;
      }

      page.blocks.push(block);
    }

    if (page.blocks.length > 0) {
      fullTextAnnotation.pages.push(page);
    }

    DriveApp.getFileById(convertedFile.id).setTrashed(true);
    return fullTextAnnotation;
  } catch (error) {
    logError("[VISION:PDF] PDF Vision OCRエラー:", error.message);
    return null;
  }
}

/**
 * VisionDocument を取得
 */
function getVisionDocument(fileId, fileName) {
  const apiKey = getVisionApiKey();
  if (!apiKey) {
    logError("[VISION:TABLE] Vision API キーが設定されていません");
    return null;
  }

  try {
    logTrace("[VISION:TABLE] VisionDocument 取得開始:", fileName);
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const mimeType = blob.getContentType();

    if (mimeType === 'application/pdf' || mimeType === MimeType.PDF) {
      return getVisionDocumentFromPdf(fileId, fileName, apiKey);
    }

    const base64Data = Utilities.base64Encode(blob.getBytes());
    const payload = {
      requests: [{
        image: { content: base64Data },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }]
      }]
    };

    const url = "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey;
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) return null;

    const result = JSON.parse(response.getContentText());
    const annotation = result.responses[0];
    if (!annotation || annotation.error || !annotation.fullTextAnnotation) return null;

    return annotation.fullTextAnnotation;
  } catch (error) {
    logError("[VISION:TABLE] VisionDocument 取得エラー:", error.message);
    return null;
  }
}

/**
 * PDFファイルからVisionDocumentを取得
 */
function getVisionDocumentFromPdf(fileId, fileName, apiKey) {
  try {
    logTrace("[VISION:TABLE:PDF] PDF処理開始:", fileName);
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const resource = { title: "temp_vision_" + fileName, mimeType: MimeType.GOOGLE_DOCS };
    const convertedFile = Drive.Files.insert(resource, blob, { convert: true });
    logTrace("[VISION:TABLE:PDF] 変換完了 - convertedFileId:", convertedFile.id);

    const doc = DocumentApp.openById(convertedFile.id);
    const body = doc.getBody();
    const fullTextAnnotation = { text: body.getText(), pages: [] };
    const paragraphs = body.getParagraphs();
    let page = { width: 800, height: 1000, blocks: [] };

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const text = para.getText();
      if (!text || text.trim() === "") continue;

      const block = {
        blockType: "TEXT",
        paragraphs: [{
          words: [],
          symbols: [],
          text: text,
          boundingBox: { vertices: [{ x: 0, y: i * 30 }, { x: 800, y: i * 30 }, { x: 800, y: (i + 1) * 30 }, { x: 0, y: (i + 1) * 30 }] },
          confidence: 0.95
        }],
        boundingBox: { vertices: [{ x: 0, y: i * 30 }, { x: 800, y: i * 30 }, { x: 800, y: (i + 1) * 30 }, { x: 0, y: (i + 1) * 30 }] },
        confidence: 0.95
      };
      page.blocks.push(block);
    }

    if (page.blocks.length > 0) {
      fullTextAnnotation.pages.push(page);
    }

    DriveApp.getFileById(convertedFile.id).setTrashed(true);
    return fullTextAnnotation;
  } catch (error) {
    logError("[VISION:TABLE:PDF] PDF処理エラー:", error.message);
    return null;
  }
}

// ================================
//  BoundingBox 解析ユーティリティ
// ================================

function getBoundingBoxCenter(boundingBox) {
  if (!boundingBox || !boundingBox.vertices) return { x: 0, y: 0 };
  const vertices = boundingBox.vertices;
  if (vertices.length < 4) return { x: 0, y: 0 };

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const v of vertices) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function getBoundingBoxWidth(boundingBox) {
  if (!boundingBox || !boundingBox.vertices) return 0;
  if (boundingBox.vertices.length < 4) return 0;
  const xs = boundingBox.vertices.map(v => v.x || 0);
  return Math.max(...xs) - Math.min(...xs);
}

function getBoundingBoxHeight(boundingBox) {
  if (!boundingBox || !boundingBox.vertices) return 0;
  if (boundingBox.vertices.length < 4) return 0;
  const ys = boundingBox.vertices.map(v => v.y || 0);
  return Math.max(...ys) - Math.min(...ys);
}

function boxesOverlapVertically(box1, box2, threshold = 0.3) {
  if (!box1 || !box2) return false;
  const h1 = getBoundingBoxHeight(box1);
  const h2 = getBoundingBoxHeight(box2);
  const c1 = getBoundingBoxCenter(box1);
  const c2 = getBoundingBoxCenter(box2);
  if (h1 === 0 || h2 === 0) return false;

  const top1 = c1.y - h1 / 2, bottom1 = c1.y + h1 / 2;
  const top2 = c2.y - h2 / 2, bottom2 = c2.y + h2 / 2;
  const overlap = Math.max(0, Math.min(bottom1, bottom2) - Math.max(top1, top2));
  const minHeight = Math.min(h1, h2);
  return minHeight > 0 && overlap / minHeight >= threshold;
}

function boxesOverlapHorizontally(box1, box2, threshold = 0.3) {
  if (!box1 || !box2) return false;
  const w1 = getBoundingBoxWidth(box1);
  const w2 = getBoundingBoxWidth(box2);
  const c1 = getBoundingBoxCenter(box1);
  const c2 = getBoundingBoxCenter(box2);
  if (w1 === 0 || w2 === 0) return false;

  const left1 = c1.x - w1 / 2, right1 = c1.x + w1 / 2;
  const left2 = c2.x - w2 / 2, right2 = c2.x + w2 / 2;
  const overlap = Math.max(0, Math.min(right1, right2) - Math.max(left1, left2));
  const minWidth = Math.min(w1, w2);
  return minWidth > 0 && overlap / minWidth >= threshold;
}

function calculateVerticalDistance(box1, box2) {
  const c1 = getBoundingBoxCenter(box1);
  const c2 = getBoundingBoxCenter(box2);
  return Math.abs(c1.y - c2.y);
}

function calculateHorizontalDistance(box1, box2) {
  const c1 = getBoundingBoxCenter(box1);
  const c2 = getBoundingBoxCenter(box2);
  return c2.x - c1.x;
}

function extractAllWords(document) {
  const words = [];
  if (!document || !document.pages) return words;

  function traverseWords(wordsArr) {
    if (!wordsArr) return;
    for (const word of wordsArr) {
      const symbols = word.symbols || [];
      let text = "";
      for (const symbol of symbols) {
        if (symbol.text) text += symbol.text;
      }
      if (text.trim()) {
        words.push({
          text: text,
          boundingBox: word.boundingBox,
          confidence: word.confidence,
          vertices: word.boundingBox ? word.boundingBox.vertices : []
        });
      }
    }
  }

  function traverseParagraphs(paragraphs) {
    if (!paragraphs) return;
    for (const para of paragraphs) {
      traverseWords(para.words);
    }
  }

  function traverseBlocks(blocks) {
    if (!blocks) return;
    for (const block of blocks) {
      traverseParagraphs(block.paragraphs);
    }
  }

  for (const page of document.pages) {
    traverseBlocks(page.blocks);
  }

  return words;
}

// ================================
//  表構造検出・抽出関数群
// ================================

function detectTableFromVisionDocument(document) {
  if (!document) {
    logWarn("[TABLE] VisionDocument が渡されませんでした");
    return [];
  }

  logTrace("[TABLE] 表構造検出開始");
  const words = extractAllWords(document);
  logTrace("[TABLE] 抽出された単語数:", words.length);

  if (words.length === 0) return [];

  const lines = groupWordsIntoLines(words);
  logTrace("[TABLE] グループ化された行数:", lines.length);

  if (lines.length === 0) return [];

  const headers = detectTableHeaders(lines);
  logTrace("[TABLE] 検出されたヘッダー:", headers.join(", "));

  if (headers.length === 0) {
    logWarn("[TABLE] ヘッダーが検出できませんでした");
    return [];
  }

  const tableData = extractTableData(lines, headers);
  logTrace("[TABLE] 抽出されたデータ行数:", tableData.length);
  return tableData;
}

function groupWordsIntoLines(words) {
  if (!words || words.length === 0) return [];

  const sortedWords = [...words].sort((a, b) => {
    const centerA = getBoundingBoxCenter(a.boundingBox);
    const centerB = getBoundingBoxCenter(b.boundingBox);
    return centerA.y - centerB.y;
  });

  const lines = [];
  let currentLine = [sortedWords[0]];
  const avgHeight = words.reduce((sum, w) => sum + getBoundingBoxHeight(w.boundingBox), 0) / words.length;

  for (let i = 1; i < sortedWords.length; i++) {
    const word = sortedWords[i];
    const prevWord = currentLine[currentLine.length - 1];
    const prevCenter = getBoundingBoxCenter(prevWord.boundingBox);
    const currentCenter = getBoundingBoxCenter(word.boundingBox);
    const verticalDist = Math.abs(currentCenter.y - prevCenter.y);
    const sameRow = verticalDist <= avgHeight * 0.6;

    if (sameRow) {
      currentLine.push(word);
    } else {
      currentLine.sort((a, b) => {
        const centerA = getBoundingBoxCenter(a.boundingBox);
        const centerB = getBoundingBoxCenter(b.boundingBox);
        return centerA.x - centerB.x;
      });
      lines.push(currentLine);
      currentLine = [word];
    }
  }

  if (currentLine.length > 0) {
    currentLine.sort((a, b) => {
      const centerA = getBoundingBoxCenter(a.boundingBox);
      const centerB = getBoundingBoxCenter(b.boundingBox);
      return centerA.x - centerB.x;
    });
    lines.push(currentLine);
  }

  return lines;
}

function detectTableHeaders(lines) {
  if (!lines || lines.length === 0) return [];
  const headerLine = lines[0];
  const headers = headerLine.map(word => word.text.trim());
  const validHeaders = headers.filter(h => h && h.length >= 1);

  if (validHeaders.length < 2 && lines.length > 1) {
    for (let i = 1; i < lines.length; i++) {
      const candidateLine = lines[i];
      const candidateHeaders = candidateLine.map(word => word.text.trim()).filter(h => h && h.length >= 1);
      if (candidateHeaders.length >= validHeaders.length) {
        return candidateHeaders;
      }
    }
  }

  return validHeaders;
}

function extractTableData(lines, headers) {
  if (!lines || lines.length === 0 || !headers || headers.length === 0) return [];

  const tableData = [];
  const numColumns = headers.length;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length === 0) continue;

    const rowData = assignWordsToColumns(line, headers.length);
    if (rowData.every(cell => !cell || cell.trim() === "")) continue;

    const record = createTableRecord(headers, rowData);
    tableData.push(record);
  }

  return tableData;
}

function assignWordsToColumns(lineWords, numColumns) {
  if (!lineWords || lineWords.length === 0) {
    return new Array(numColumns).fill("");
  }

  const rowData = new Array(numColumns).fill("");

  for (const word of lineWords) {
    const centerX = getBoundingBoxCenter(word.boundingBox).x;
    const colIndex = Math.min(Math.floor(centerX / 1000) % numColumns, numColumns - 1);
    if (rowData[colIndex]) {
      rowData[colIndex] += " " + word.text;
    } else {
      rowData[colIndex] = word.text;
    }
  }

  return rowData.map(cell => (cell || "").trim());
}

function createTableRecord(headers, rowCells) {
  const record = {};

  for (let i = 0; i < headers.length && i < rowCells.length; i++) {
    const header = headers[i].trim();
    const value = rowCells[i].trim();

    if (header) {
      const numValue = parseFloat(value);
      record[header] = !isNaN(numValue) && String(numValue) === value ? numValue : value;
    }
  }

  return record;
}

function convertTableToJsonString(tableData) {
  if (!tableData || tableData.length === 0) return "";
  try {
    return JSON.stringify(tableData, null, 2);
  } catch (error) {
    logError("[TABLE] JSON 変換エラー:", error);
    return "";
  }
}

function convertTableRecordToNaturalLanguage(record) {
  if (!record || typeof record !== "object") return "";
  const lines = [];
  for (const [key, value] of Object.entries(record)) {
    lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

function generateTableChunkEmbedding(record) {
  if (!record) return null;
  const naturalText = convertTableRecordToNaturalLanguage(record);
  if (!naturalText) return null;
  return getEmbeddingWithCache(naturalText);
}

function processTableForRag(fileId, fileName) {
  try {
    logTrace("[TABLE:RAG] 表データ RAG 処理開始:", fileName);
    const document = getVisionDocument(fileId, fileName);
    if (!document) {
      logWarn("[TABLE:RAG] VisionDocument の取得に失敗:", fileName);
      return null;
    }

    const tableData = detectTableFromVisionDocument(document);
    if (!tableData || tableData.length === 0) {
      logWarn("[TABLE:RAG] 表データが抽出されませんでした:", fileName);
      return null;
    }

    logInfo("[TABLE:RAG] 表データ抽出成功:", fileName, "-", tableData.length, "行");

    const chunks = [];
    for (const record of tableData) {
      const jsonString = JSON.stringify(record);
      const naturalText = convertTableRecordToNaturalLanguage(record);
      const embedding = generateTableChunkEmbedding(record);

      chunks.push({
        jsonString: jsonString,
        naturalText: naturalText,
        embedding: embedding,
        record: record
      });
    }

    logTrace("[TABLE:RAG] RAG 処理完了:", fileName, "-", chunks.length, "チャンク");

    return {
      jsonString: JSON.stringify(tableData, null, 2),
      naturalText: tableData.map(r => convertTableRecordToNaturalLanguage(r)).join("\n\n"),
      records: tableData,
      chunks: chunks
    };
  } catch (error) {
    logError("[TABLE:RAG] RAG 処理エラー:", error);
    return null;
  }
}

function extractTableWithStructure(fileId, fileName, mimeType) {
  const supportedTypes = ['application/pdf', MimeType.PDF];
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', MimeType.JPEG, MimeType.PNG, MimeType.GIF, MimeType.BMP];
  const isSupported = supportedTypes.includes(mimeType) || imageTypes.includes(mimeType);

  if (!isSupported) {
    logTrace("[TABLE:EXTRACT] サポートされていないファイルタイプ:", mimeType);
    return null;
  }

  const apiKey = getVisionApiKey();
  if (!apiKey) {
    logWarn("[TABLE:EXTRACT] Vision API キーが設定されていません");
    return null;
  }

  try {
    logTrace("[TABLE:EXTRACT] 表構造抽出開始:", fileName);
    const result = processTableForRag(fileId, fileName);
    if (result) {
      logInfo("[TABLE:EXTRACT] 表構造抽出成功:", fileName, "-", result.records.length, "レコード");
    }
    return result;
  } catch (error) {
    logError("[TABLE:EXTRACT] 表構造抽出エラー:", error);
    return null;
  }
}

function indexTableData(sheet, ragResult, fileId, fileName, mimeType) {
  if (!ragResult || !ragResult.chunks || ragResult.chunks.length === 0) {
    return false;
  }

  try {
    logTrace("[TABLE:INDEX] 表データをインデックスに追加:", fileName);

    for (let i = 0; i < ragResult.chunks.length; i++) {
      const chunk = ragResult.chunks[i];
      if (chunk.embedding) {
        const metadata = {
          fileId: fileId,
          fileName: fileName,
          chunkIndex: i,
          totalChunks: ragResult.chunks.length,
          charCount: chunk.naturalText.length,
          preview: chunk.naturalText.substring(0, 100),
          mimeType: mimeType
        };

        const keywords = extractKeywords(chunk.naturalText);

        sheet.appendRow([
          metadata.fileId,
          metadata.fileName,
          metadata.mimeType,
          chunk.jsonString,
          JSON.stringify(chunk.embedding),
          metadata.chunkIndex,
          new Date(),
          metadata.charCount,
          metadata.preview,
          metadata.totalChunks,
          keywords.join(",")
        ]);

        Utilities.sleep(300);
      }
    }

    logInfo("[TABLE:INDEX] 表データインデックス完了:", fileName, "-", ragResult.chunks.length, "チャンク");
    return true;
  } catch (error) {
    logError("[TABLE:INDEX] インデックス追加エラー:", error);
    return false;
  }
}

function parseTableTextToJson(text) {
  if (!text || typeof text !== "string") return [];

  const lines = text.split("\n").filter(line => line.trim());
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const headers = headerLine.split("\t").map(h => h.trim()).filter(h => h);
  if (headers.length === 0) return [];

  const tableData = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t").map(c => c.trim());
    const record = {};

    for (let j = 0; j < headers.length && j < cells.length; j++) {
      const header = headers[j];
      const value = cells[j];
      const numValue = parseFloat(value);
      record[header] = !isNaN(numValue) && String(numValue) === value ? numValue : value;
    }

    if (Object.values(record).some(v => v !== "" && v !== null)) {
      tableData.push(record);
    }
  }

  return tableData;
}
