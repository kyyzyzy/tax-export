#!/usr/bin/env node
/**
 * build.js —— 打包发布脚本
 *
 * 每次执行:
 *   1. 版本号 patch 位自动 +1(以 manifest.json 为准,同步 package.json)
 *   2. 复制运行时必需文件到 dist/ 干净目录(排除 node_modules/demo/.zcode/.DS_Store)
 *   3. 用 python3 zipfile 压缩(中文文件名带 UTF-8 标志,Windows 解压不乱码)
 *   4. 输出(zip 内含自增后的版本号+打包时间):dist/tax-export-extension-v<版本>-<YYYYMMDD_HHMMSS>.zip
 *
 * 用法: npm run build
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;

/* ---------------- 1. 版本号自增 ---------------- */
function bumpPatch(v) {
  const parts = v.split('.');
  parts[2] = String((parseInt(parts[2], 10) || 0) + 1);
  return parts.join('.');
}

const manifestFile = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const oldVersion = manifest.version;
const newVersion = bumpPatch(oldVersion);

manifest.version = newVersion;
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.version = newVersion;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

/* ---------------- 2. 复制运行时文件 ---------------- */
const FILES = ['manifest.json', 'background.js', 'report.html', 'report.js', '安装说明.md', 'README.md'];
const DIRS = ['content', 'popup', 'icons', 'vendor'];

const distDir = path.join(root, 'dist');
const stage = path.join(distDir, 'stage', 'tax-export');
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

let fileCount = 0;
for (const f of FILES) {
  if (!fs.existsSync(path.join(root, f))) throw new Error('缺少文件: ' + f);
  fs.copyFileSync(path.join(root, f), path.join(stage, f));
  fileCount++;
}
for (const d of DIRS) {
  fs.cpSync(path.join(root, d), path.join(stage, d), {
    recursive: true,
    filter: (src) => path.basename(src) !== '.DS_Store'
  });
}

/* ---------------- 3. 压缩 ---------------- */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
const now = new Date();
const ts = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '_' +
  pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
const zipName = 'tax-export-extension-v' + newVersion + '-' + ts + '.zip';
execSync(`python3 - <<'PY'
import zipfile, os
root = ${JSON.stringify(path.join(distDir, 'stage'))}
out = ${JSON.stringify(path.join(distDir, zipName))}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for f in sorted(filenames):
            if f == '.DS_Store':
                continue
            p = os.path.join(dirpath, f)
            z.write(p, os.path.relpath(p, root))
PY`, { stdio: 'inherit' });

/* ---------------- 4. 清理与输出 ---------------- */
function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}
const total = countFiles(stage);
fs.rmSync(path.join(distDir, 'stage'), { recursive: true, force: true });
const zipPath = path.join(distDir, zipName);
const kb = Math.round(fs.statSync(zipPath).size / 1024);

console.log('');
console.log('✓ 版本号: ' + oldVersion + ' → v' + newVersion + '  (manifest.json / package.json 已同步)');
console.log('✓ 打包完成: dist/' + zipName + '  (' + kb + ' KB, ' + total + ' 个文件)');
console.log('');
console.log('  发给别人:完整解压 → chrome://extensions 开发者模式 → 加载已解压的扩展程序');

