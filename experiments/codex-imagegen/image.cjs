'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');

function identify(bytes) {
  if (bytes.subarray(0, 8).equals(pngSignature) && bytes.subarray(-12).equals(pngEnd)) return 'PNG';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'JPEG';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8) return 'WebP';
  throw new Error('图片内容不完整或格式不受支持');
}

function verifyAndCopy(bytes, tempRoot, outputDir, id, sourceSha) {
  if (createHash('sha256').update(bytes).digest('hex') === sourceSha.toLowerCase()) {
    throw new Error('工具返回的图片与原画逐字节相同，未取得重绘结果');
  }
  const format = identify(bytes);
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'image-check-'));
  try {
    const input = path.join(scratch, 'input');
    const decoded = path.join(scratch, 'decoded.bmp');
    fs.writeFileSync(input, bytes);
    // Converting to a different raster format forces ImageIO to decode the pixels.
    const check = spawnSync('/usr/bin/sips', ['-s', 'format', 'bmp', input, '--out', decoded], {
      encoding: 'utf8', cwd: scratch, timeout: 30000, env: { PATH: '/usr/bin:/bin', TMPDIR: scratch },
    });
    if (check.error || check.status !== 0 || /error|truncat|corrupt|invalid/i.test(check.stderr)) {
      throw new Error('macOS sips 无法完整解码图片');
    }
    const header = Buffer.alloc(26);
    const file = fs.openSync(decoded, 'r');
    try {
      if (fs.readSync(file, header, 0, header.length, 0) !== header.length || header.toString('ascii', 0, 2) !== 'BM') {
        throw new Error('解码后无有效位图');
      }
    } finally { fs.closeSync(file); }
    const width = header.readInt32LE(18);
    const height = Math.abs(header.readInt32LE(22));
    if (width <= 0 || !height) throw new Error('解码后尺寸无效');
    const outputImage = `${id}-codex.${format === 'JPEG' ? 'jpg' : format.toLowerCase()}`;
    fs.writeFileSync(path.join(outputDir, outputImage), bytes, { flag: 'wx' });
    return { outputImage, format, width, height };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function confinedPath(reported, tempRoot, allowedRoots) {
  if (!reported || !path.isAbsolute(reported) || reported.includes('\0') || reported.split(path.sep).includes('..')) return null;
  const physicalRoot = fs.realpathSync(tempRoot);
  // Resolve only the caller-owned root. Never resolve or inspect an external reported path.
  for (const root of [tempRoot, physicalRoot]) {
    const relative = path.relative(root, reported);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      // A private macOS temp directory can also be named through /var or /tmp.
      // Compare both spellings without following anything in the reported path.
      const physical = path.join(physicalRoot, relative);
      const declared = path.join(tempRoot, relative);
      const allowed = allowedRoots.some(dir => {
        const prefix = path.resolve(dir) + path.sep;
        return physical.startsWith(prefix) || declared.startsWith(prefix);
      });
      return { physical, allowed };
    }
  }
  return null;
}

function readConfined(file) {
  if (process.platform !== 'darwin') throw new Error('本实验需要 macOS 的安全文件打开方式和 sips');
  // Darwin's <sys/fcntl.h> defines O_NOFOLLOW_ANY. Node exposes only O_NOFOLLOW,
  // which protects the final component but would still follow a replaced parent directory.
  const O_NOFOLLOW_ANY = 0x20000000;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_NOFOLLOW_ANY);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('上报路径必须是临时目录中的普通独立文件');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function collectImage(item, tempRoot, outputDir, id, sourceSha, allowedRoots = [tempRoot]) {
  const isImage = item?.type === 'imageGeneration';
  const reportedPath = isImage && typeof item.savedPath === 'string' ? item.savedPath : null;
  const localFile = confinedPath(reportedPath, tempRoot, allowedRoots);
  const record = {
    outputImage: null, format: null, width: null, height: null, reportedPath,
    reportedPathScope: reportedPath ? (localFile ? 'inside-temp' : 'outside-or-invalid') : null,
    referenceHashMatched: isImage && Array.isArray(item.inputImages)
      ? item.inputImages.some(image => typeof image?.sha256 === 'string' && image.sha256 === sourceSha) : null,
    imageToolStatus: isImage ? (item.status ?? null) : null, error: null,
  };
  if (!isImage || item.status !== 'completed' || item.failure) {
    record.error = !isImage ? '缺少图片生成工具事件' : '图片工具未成功完成';
    return record;
  }
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('样本编号无效');
  const errors = [];
  if (typeof item.result === 'string' && item.result.length) {
    try {
      const bytes = Buffer.from(item.result, 'base64');
      if (bytes.toString('base64') !== item.result) throw new Error('内联图片编码无效');
      return Object.assign(record, verifyAndCopy(bytes, tempRoot, outputDir, id, sourceSha));
    } catch (error) { errors.push(error.message); }
  }
  if (localFile?.allowed) {
    try {
      return Object.assign(record, verifyAndCopy(readConfined(localFile.physical), tempRoot, outputDir, id, sourceSha));
    } catch (error) {
      errors.push(error.code ? `无法安全读取或保存图片（${error.code}）` : error.message);
    }
  } else if (localFile) {
    errors.push('上报路径不在本次允许读取的图片目录，已拒绝访问');
  } else if (reportedPath) {
    errors.push('上报路径在临时目录之外或无效，已拒绝访问');
  } else if (item.fileId && !item.result) {
    errors.push('图片工具只返回了附件编号，没有返回图片内容或本次临时目录里的文件');
  }
  record.error = errors.join('；') || '工具未返回可取得的图片内容';
  return record;
}

module.exports = { collectImage };
