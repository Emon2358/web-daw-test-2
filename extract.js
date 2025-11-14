const fs = require('fs');
const path = require('path');
const Xmp = require('xmp-js'); // npm install xmp-js
const lamejs = require('lamejs'); // npm install lamejs

// --- 設定 ---
const VALID_EXTENSIONS = ['.mod', '.xm', '.s3m', '.it'];
const XMP_SAMPLE_16BIT = 4; // libxmpフラグ: サンプルが16ビット
const MP3_KBPS = 128; // MP3のビットレート
const MP3_BLOCK_SIZE = 1152; // LAMEの推奨ブロックサイズ

/**
 * Node.js の Buffer を ArrayBuffer に変換 (xmp-js が ArrayBuffer を期待するため)
 * @param {Buffer} buffer 
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * 8ビットまたは16ビットのサンプルデータを 16ビットPCM (Int16Array) に正規化
 * @param {object} sampleInfo - xmp.getModuleData().samples[i]
 * @returns {Int16Array} - 16ビットPCMデータ
 */
function normalizeToPcm16(sampleInfo) {
    const sampleData = sampleInfo.data;
    const is16bit = (sampleInfo.flg & XMP_SAMPLE_16BIT) !== 0;

    if (is16bit) {
        if (sampleData instanceof Int16Array) {
            return sampleData;
        }
        // Int8Array (バイトバッファ) として返された場合、Int16Arrayに再解釈
        else if (sampleData instanceof Int8Array) {
            return new Int16Array(sampleData.buffer, sampleData.byteOffset, sampleData.length / 2);
        } else {
            throw new Error("不明な16ビットサンプルデータ形式です。");
        }
    } else {
        // 8ビット (符号付き) を 16ビット (Int16) に拡張
        if (!(sampleData instanceof Int8Array)) {
            throw new Error("不明な8ビットサンプルデータ形式です。");
        }
        const pcm16 = new Int16Array(sampleData.length);
        for (let j = 0; j < sampleData.length; j++) {
            pcm16[j] = sampleData[j] << 8; // 8-bit signed を 16-bit に拡張
        }
        return pcm16;
    }
}

/**
 * 16ビットPCMデータをMP3にエンコード
 * @param {Int16Array} pcm16 - 16ビットPCMデータ
 * @param {number} targetSampleRate - MP3のサンプルレート
 * @returns {Buffer} - MP3データのBuffer
 */
function encodeToMp3(pcm16, targetSampleRate) {
    // モノラル、指定されたサンプルレート、128kbps
    const mp3Encoder = new lamejs.Mp3Encoder(1, targetSampleRate, MP3_KBPS);
    const mp3Data = []; // Int8Arrayのチャンクがここに入る

    for (let k = 0; k < pcm16.length; k += MP3_BLOCK_SIZE) {
        const sampleChunk = pcm16.subarray(k, k + MP3_BLOCK_SIZE);
        // encodeBufferは Int8Array を返す
        const mp3buf = mp3Encoder.encodeBuffer(sampleChunk);
        if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
        }
    }
    const mp3buf = mp3Encoder.flush(); // 最後のデータをフラッシュ
    if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
    }

    // Int8Arrayの配列をNode.jsの単一Bufferに結合
    const buffers = mp3Data.map(arr => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    return Buffer.concat(buffers);
}

/**
 * 1つのトラッカーファイルを処理
 * @param {string} filePath - トラッカーファイルのパス
 * @param {string} outputDir - 出力先ディレクトリ
 * @param {number} targetSampleRate - MP3サンプルレート
 */
function processFile(filePath, outputDir, targetSampleRate) {
    console.log(`[処理中] ${filePath}`);
    
    let moduleData;
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const arrayBuffer = toArrayBuffer(fileBuffer);

        const xmp = new Xmp();
        xmp.loadModule(arrayBuffer);
        moduleData = xmp.getModuleData();

    } catch (error) {
        console.error(`  [エラー] ${filePath} のロード失敗: ${error.message || error}`);
        return;
    }

    if (!moduleData || !moduleData.samples || moduleData.samples.length === 0) {
        console.log(`  [情報] ${filePath} にはサンプルが含まれていません。`);
        return;
    }

    // モジュール名のディレクトリを作成 (例: output/module_name/)
    const moduleName = moduleData.name.trim().replace(/[^a-z0-9]/gi, '_') || path.basename(filePath, path.extname(filePath));
    const moduleOutputDir = path.join(outputDir, moduleName);
    fs.mkdirSync(moduleOutputDir, { recursive: true });

    let extractedCount = 0;
    for (let i = 0; i < moduleData.samples.length; i++) {
        const sampleInfo = moduleData.samples[i];
        const sampleNameRaw = sampleInfo.name.trim() || `Sample ${i+1}`;
        // ファイル名としてサニタイズ
        const sampleName = sampleNameRaw.replace(/[^a-z0-9]/gi, '_');

        if (sampleInfo.len <= 0 || !sampleInfo.data || sampleInfo.data.length === 0) {
            // console.log(`  - (スキップ) ${String(i+1).padStart(2, '0')}: ${sampleNameRaw} (空)`);
            continue;
        }

        try {
            // 1. PCM正規化
            const pcm16 = normalizeToPcm16(sampleInfo);

            // 2. MP3エンコード
            const mp3Buffer = encodeToMp3(pcm16, targetSampleRate);

            // 3. ファイル書き出し
            const outputFileName = `${String(i+1).padStart(2, '0')}_${sampleName}.mp3`;
            const outputFilePath = path.join(moduleOutputDir, outputFileName);
            
            fs.writeFileSync(outputFilePath, mp3Buffer);
            // console.log(`  -> ${outputFilePath}`);
            extractedCount++;

        } catch (err) {
            console.error(`  [エラー] サンプル ${i} (${sampleNameRaw}) のエンコード失敗: ${err.message}`);
        }
    }
    console.log(`  [完了] ${extractedCount} / ${moduleData.samples.length} 個のサンプルを ${moduleOutputDir} に抽出しました。`);
}

/**
 * メイン実行関数
 */
function main() {
    const inputPath = process.argv[2]; // 入力ファイルまたはディレクトリ
    const outputDir = process.argv[3]; // 出力先ディレクトリ
    const sampleRate = parseInt(process.argv[4] || '22050', 10);

    if (!inputPath || !outputDir) {
        console.error("使用方法: node extract.js <input_path> <output_dir> [sample_rate]");
        console.error("例: node extract.js ./music ./extracted_samples 22050");
        process.exit(1);
    }

    if (!fs.existsSync(inputPath)) {
        console.error(`エラー: 入力パスが見つかりません: ${inputPath}`);
        process.exit(1);
    }

    // 出力ディレクトリ作成
    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`--- サンプル抽出開始 ---`);
    console.log(`入力: ${path.resolve(inputPath)}`);
    console.log(`出力: ${path.resolve(outputDir)}`);
    console.log(`レート: ${sampleRate} Hz`);
    console.log(`---`);

    const stats = fs.statSync(inputPath);

    if (stats.isDirectory()) {
        // ディレクトリの場合、再帰的に検索
        console.log(`[ディレクトリ検索中] ${inputPath}`);
        const files = fs.readdirSync(inputPath);
        files.forEach(file => {
            const filePath = path.join(inputPath, file);
            if (fs.statSync(filePath).isFile() && VALID_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
                processFile(filePath, outputDir, sampleRate);
            }
        });
    } else if (stats.isFile() && VALID_EXTENSIONS.includes(path.extname(inputPath).toLowerCase())) {
        // 単一ファイルの場合
        processFile(inputPath, outputDir, sampleRate);
    } else {
        console.error(`エラー: ${inputPath} は有効なトラッカーファイルまたはディレクトリではありません。`);
    }

    console.log(`--- 処理完了 ---`);
}

main();
