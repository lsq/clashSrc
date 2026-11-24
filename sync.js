#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// 1. 解析命令行参数
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('用法: node sync.js <项目A路径> <项目B路径>');
    process.exit(1);
}

const dirA = path.resolve(args[0]);
const dirB = path.resolve(args[1]);

// 2. 计算文件 Hash (使用 Stream 避免大文件撑爆内存)
function getFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256'); // 也可以用 md5 速度更快
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// 3. 递归遍历目录，排除指定文件夹
async function walkDir(dir, ignoreDirs = ['.git', 'node_modules']) {
    let results = [];
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        console.warn(`[Warning] 无法读取目录 ${dir}: ${err.message}`);
        return results;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // 过滤掉不需要的目录
            if (!ignoreDirs.includes(entry.name)) {
                results = results.concat(await walkDir(fullPath, ignoreDirs));
            }
        } else if (entry.isFile()) {
            if (entry.name === 'sync.js') continue;
            results.push(fullPath);
        }
    }
    return results;
}

// 4. 主同步逻辑
async function syncFiles() {
    console.log(`源目录 (A): ${dirA}`);
    console.log(`目标目录(B): ${dirB}\n`);

    // 获取 A 中所有文件
    const filesInA = await walkDir(dirA);
    let updatedCount = 0;
    let copiedCount = 0;

    for (const fileA of filesInA) {
        const realPath = path.relative(dirA, fileA);
        const relativePath = realPath.replaceAll(path.sep, '/').replace('src/electron', 'dist/electron')
        const fileB = path.join(dirB, relativePath);

        try {
            // 检查 B 中是否存在该文件
            await fsp.access(fileB);

            // 存在则比对 Hash
            const hashA = await getFileHash(fileA);
            const hashB = await getFileHash(fileB);

            if (hashA !== hashB) {
                await fsp.copyFile(fileB, fileA);
                console.log(`[Updated] ${relativePath}`);
                updatedCount++;
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                // 如果 B 中不存在该文件（通常也需要同步过去），则创建目录并复制
                // await fsp.mkdir(path.dirname(fileB), { recursive: true });
                // await fsp.copyFile(fileA, fileB);
                console.log(`[Copied]  ${relativePath} Failed!`);
                console.error(`          Code: ${err.code}, Message: ${err.message}`);
                copiedCount++;
            } else {
                console.error(`[Error]   ${relativePath}: ${err.message}`);
            }
        }
    }

    const pakg = path.join(dirA, 'app/main/package.json')
    // 1. 读取源 package.json 原始文本（保留换行符用于检测缩进）
    const rawContent = await fsp.readFile(pakg, 'utf8');
    const pkg = JSON.parse(rawContent);

    // 2. 仅当 main 字段存在且包含 dist/electron 时才替换
    if (pkg.main && typeof pkg.main === 'string') {
        pkg.main = pkg.main.replace('dist/electron', 'src/electron');
    }

    // 3. 检测原文件缩进风格，避免写入后格式变化产生无意义 diff
    const indentMatch = rawContent.match(/^(\s+)"/m);
    const indent = indentMatch ? indentMatch[1] : 2;

    // 4. 写回目标路径（JSON.stringify 第三参数控制缩进）
    await fsp.writeFile(
        pakg,
        JSON.stringify(pkg, null, indent) + '\n',
        'utf8'
    );

    console.log(`\n同步完成: 更新 ${updatedCount} 个文件, 失败 ${copiedCount} 个文件`);
}

syncFiles().catch(console.error);
