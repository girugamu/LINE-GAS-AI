/**
 * RAG シート管理モジュール
 * 
 * このファイルには以下が含まれています：
 * - getRagSheet: RAG用スプレッドシート取得
 * - resetAndInitializeRagSheet: シート初期化
 * - setFileMapping/getFileMapping: ファイルマッピング管理
 * - getLastIndexTime/setLastIndexTime: 最終インデックス時刻管理
 */

/**
 * RAG用のスプレッドシートを取得
 */
function getRagSheet() {
  if (!INDEX_SHEET_ID) {
    throw new Error("INDEX_SHEET_ID が設定されていません。");
  }
  return SpreadsheetApp.openById(INDEX_SHEET_ID).getActiveSheet();
}

/**
 * RAGシートをリセットして初期化
 */
function resetAndInitializeRagSheet() {
  const sheet = getRagSheet();
  sheet.clear();
  sheet.appendRow(SHEET_HEADERS);
  console.log("[INIT] 拡張シート初期化完了:", SHEET_HEADERS);
}

// ================================
//  インデックス管理
// ================================

/**
 * ファイルマッピングをスクリプトプロパティに保存
 */
function setFileMapping(mapping) {
  scriptProps.setProperty(FILE_MAPPING_KEY, JSON.stringify(mapping));
}

/**
 * 最終インデックス時刻を取得
 */
function getLastIndexTime() {
  const lastTime = scriptProps.getProperty(LAST_INDEX_KEY);
  return lastTime ? new Date(lastTime) : null;
}

/**
 * 最終インデックス時刻を保存
 */
function setLastIndexTime(date) {
  scriptProps.setProperty(LAST_INDEX_KEY, date.toISOString());
}

/**
 * ファイルマッピングを取得
 */
function getFileMapping() {
  const mapping = scriptProps.getProperty(FILE_MAPPING_KEY);
  return mapping ? JSON.parse(mapping) : {};
}

// ================================
//  インデックス更新機能
// ================================

/**
 * フォルダ内の全ファイルを再帰的に取得（サブフォルダを含む）
 */
function getAllFilesRecursive(folder, mimeTypes, visitedFolders) {
  const allFiles = [];
  
  const folderId = folder.getId();
  if (visitedFolders.has(folderId)) {
    console.log("【サブフォルダ】循環参照を検出スキップ:", folder.getName());
    return allFiles;
  }
  visitedFolders.add(folderId);
  
  console.log("【サブフォルダ】処理中:", folder.getName());
  
  for (const mimeType of mimeTypes) {
    const iterator = folder.getFilesByType(mimeType);
    while (iterator.hasNext()) {
      allFiles.push(iterator.next());
    }
  }
  
  const subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    const subFolder = subFolders.next();
    const subFiles = getAllFilesRecursive(subFolder, mimeTypes, visitedFolders);
    allFiles.push(...subFiles);
  }
  
  return allFiles;
}

/**
 * 単一ファイルをインデックスにチャンクとして分割して追加
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
        const metadata = createChunkMetadata(chunk, fileId, fileName, index, totalChunks);
        const keywords = extractKeywords(chunk);

        sheet.appendRow([
          metadata.fileId,
          metadata.fileName,
          mimeType,
          metadata.text,
          JSON.stringify(embedding),
          metadata.chunkIndex,
          new Date(),
          metadata.charCount,
          metadata.preview,
          metadata.totalChunks,
          keywords.join(",")
        ]);
      }
      Utilities.sleep(300);
    });

    console.log(`  └ ${chunks.length} チャンクを追加（メタデータ付与済）`);

    // PDFファイルの表データを追加でインデックスに含める
    const isPdf = mimeType === 'application/pdf' || mimeType === MimeType.PDF;
    
    if (isPdf) {
      console.log(`  └ PDFファイルの表データを抽出中: ${fileName}`);
      
      try {
        const tableResult = extractAndIndexTableData(fileId, fileName, mimeType);
        
        if (tableResult && tableResult.success) {
          console.log(`  └ 表データ ${tableResult.recordCount} 行を追加（${tableResult.totalChunks} チャンク）`);
        } else {
          console.log(`  └ 表データは抽出されませんでした（${fileName}）`);
        }
      } catch (tableError) {
        console.log(`  └ 表データ抽出エラー（致命的ではない）: ${tableError.message}`);
      }
    }

    return true;
  } catch (error) {
    console.error(`  └ エラー: ${fileName}`, error);
    return false;
  }
}

/**
 * チャンクのメタデータを作成
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

/**
 * Google Driveのファイルを差分インデックス更新
 */
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
 * ファイルIDに基づいてチャンクを削除
 */
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

/**
 * 表データチャンクをRAGシートに追加
 */
function indexTableDataChunks(sheet, ragResult, mimeType) {
  if (!ragResult || !ragResult.chunks || ragResult.chunks.length === 0) {
    return false;
  }

  try {
    logTrace("[TABLE:INDEX:CHUNKS] チャンクをインデックスに追加:", ragResult.fileName);

    for (const chunk of ragResult.chunks) {
      if (!chunk.embedding) continue;

      const keywords = extractKeywords(chunk.naturalText);

      sheet.appendRow([
        chunk.fileId,
        chunk.fileName,
        mimeType,
        chunk.jsonString,
        JSON.stringify(chunk.embedding),
        chunk.chunkIndex,
        new Date(),
        chunk.charCount,
        chunk.preview,
        chunk.totalChunks,
        keywords.join(",")
      ]);

      Utilities.sleep(300);
    }

    logInfo("[TABLE:INDEX:CHUNKS] インデックス追加完了:", ragResult.fileName, "-", ragResult.chunks.length, "チャンク");
    return true;

  } catch (error) {
    logError("[TABLE:INDEX:CHUNKS] エラー:", error);
    return false;
  }
}

/**
 * 表データ全体をRAG用に処理し、チャンクとEmbeddingを生成
 */
function processTableDataForRag(tableData, fileId, fileName, config) {
  if (!tableData || tableData.length === 0) {
    return null;
  }

  const chunks = splitTableIntoChunks(tableData, config);
  logTrace("[TABLE:CHUNK] チャンク分割完了:", chunks.length, "チャンク");

  const ragChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = generateTableChunkEmbeddingFromChunk(chunk);

    if (result && result.embedding) {
      ragChunks.push({
        chunkIndex: i,
        totalChunks: chunks.length,
        records: chunk.records,
        recordCount: chunk.recordCount,
        jsonString: JSON.stringify(chunk.records, null, 2),
        naturalText: result.naturalText,
        embedding: result.embedding,
        charCount: chunk.charCount,
        preview: chunk.text.substring(0, 100) + (chunk.text.length > 100 ? '...' : ''),
        fileId: fileId,
        fileName: fileName
      });

      Utilities.sleep(100);
    }
  }

  logInfo("[TABLE:CHUNK] RAG処理完了:", ragChunks.length, "チャンク");

  return {
    tableData: tableData,
    chunks: ragChunks,
    totalChunks: ragChunks.length,
    fileId: fileId,
    fileName: fileName
  };
}

/**
 * 表データチャンクからEmbeddingを生成
 */
function generateTableChunkEmbeddingFromChunk(chunk) {
  if (!chunk || !chunk.text) {
    return null;
  }

  const naturalText = chunk.text;
  const embedding = getEmbeddingWithCache(naturalText);

  return {
    embedding: embedding,
    naturalText: naturalText
  };
}

/**
 * PDF/画像ファイルから表データを抽出し、RAGインデックスに追加
 */
function extractAndIndexTableData(fileId, fileName, mimeType) {
  try {
    logInfo("[TABLE:FULL] 表データ抽出・インデックス開始:", fileName);

    const ragResult = extractTableWithStructure(fileId, fileName, mimeType);
    
    if (!ragResult) {
      logWarn("[TABLE:FULL] 表データの抽出に失敗:", fileName);
      return { success: false, error: "表データの抽出に失敗" };
    }

    const chunksResult = processTableDataForRag(
      ragResult.records,
      fileId,
      fileName,
      CHUNK_CONFIG
    );

    if (!chunksResult || chunksResult.chunks.length === 0) {
      logWarn("[TABLE:FULL] チャUNK生成に失敗:", fileName);
      return { success: false, error: "チャンク生成に失敗" };
    }

    const sheet = getRagSheet();
    const success = indexTableDataChunks(sheet, chunksResult, mimeType);

    if (success) {
      logInfo("[TABLE:FULL] 表データインデックス完了:", fileName, "-", chunksResult.totalChunks, "チャンク");
      return {
        success: true,
        fileId: fileId,
        fileName: fileName,
        totalChunks: chunksResult.totalChunks,
        recordCount: ragResult.records.length
      };
    } else {
      logError("[TABLE:FULL] インデックス追加に失敗:", fileName);
      return { success: false, error: "インデックス追加に失敗" };
    }

  } catch (error) {
    logError("[TABLE:FULL] エラー:", error);
    return { success: false, error: error.message };
  }
}

/**
 * 表データ（JSON配列）をチャンクに分割
 */
function splitTableIntoChunks(tableData, config) {
  if (!tableData || tableData.length === 0) {
    return [];
  }

  const chunkConfig = config || CHUNK_CONFIG;
  const chunks = [];
  const records = [];
  
  for (let i = 0; i < tableData.length; i++) {
    const record = tableData[i];
    const recordText = convertTableRecordToNaturalLanguage(record);
    
    records.push({
      index: i,
      text: recordText,
      record: record,
      charCount: recordText.length
    });
  }

  let currentChunk = [];
  let currentCharCount = 0;

  for (const record of records) {
    const textToAdd = currentChunk.length > 0 ? "\n\n" + record.text : record.text;
    const newCharCount = currentCharCount + textToAdd.length;

    if (currentChunk.length > 0 && newCharCount > chunkConfig.MAX_CHUNK_SIZE) {
      chunks.push({
        records: currentChunk,
        text: currentChunk.map(r => r.text).join("\n\n"),
        recordCount: currentChunk.length,
        charCount: currentCharCount
      });

      if (chunkConfig.CHUNK_OVERLAP > 0 && chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        const overlapCount = Math.min(
          Math.ceil(chunkConfig.CHUNK_OVERLAP / 100),
          lastChunk.records.length
        );
        
        const overlapRecords = lastChunk.records.slice(-overlapCount);
        currentChunk = overlapRecords;
        currentCharCount = overlapRecords.reduce((sum, r) => sum + r.text.length + 2, 0);
      } else {
        currentChunk = [];
        currentCharCount = 0;
      }
    }

    currentChunk.push(record);
    currentCharCount += (currentCharCount > 0 ? 2 : 0) + record.charCount;

    if (currentCharCount < chunkConfig.MIN_CHUNK_SIZE) {
      continue;
    }

    chunks.push({
      records: [...currentChunk],
      text: currentChunk.map(r => r.text).join("\n\n"),
      recordCount: currentChunk.length,
      charCount: currentCharCount
    });

    currentChunk = [];
    currentCharCount = 0;
  }

  if (currentChunk.length > 0) {
    chunks.push({
      records: currentChunk,
      text: currentChunk.map(r => r.text).join("\n\n"),
      recordCount: currentChunk.length,
      charCount: currentCharCount
    });
  }

  return chunks;
}
