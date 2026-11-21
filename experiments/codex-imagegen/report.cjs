'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const TOTAL_SAMPLES = 5;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function readAsset(filename) {
  const outsidePrivateState = candidate => !path.resolve(candidate).split(path.sep).includes('.codex');
  if (!outsidePrivateState(filename)) throw new Error('素材路径指向受保护目录');
  const resolved = await fs.realpath(filename);
  if (!outsidePrivateState(resolved)) throw new Error('素材链接指向受保护目录');
  return fs.readFile(resolved);
}

async function loadDataset(datasetDir) {
  const [prompt, manifest] = await Promise.all([
    readAsset(path.join(datasetDir, 'prompt.txt')),
    readAsset(path.join(datasetDir, 'metrics.json')),
  ]);
  const { sources } = JSON.parse(manifest);
  if (!Array.isArray(sources) || sources.length !== TOTAL_SAMPLES ||
      sources.some((s, i) => s.id !== i + 1 || !path.isAbsolute(s.path) ||
        !/^[a-f0-9]{64}$/i.test(s.sha256))) {
    throw new Error('metrics.json 需要按 1 至 5 排列的原画、绝对路径和 SHA-256');
  }
  return { g3: prompt.toString('utf8'), g3Sha256: sha256(prompt), sources };
}

async function prepareSample(datasetDir, source, outputDir) {
  const extension = path.extname(source.path).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) {
    throw new Error('原画文件扩展名不受支持');
  }
  const bytes = await readAsset(source.path);
  const actual = sha256(bytes);
  if (actual !== source.sha256.toLowerCase()) {
    throw new Error(`原画 SHA-256 不匹配（期望 ${source.sha256}，实际 ${actual}）`);
  }
  const sourceImage = `${source.id}-original${extension}`;
  const fluxImage = `${source.id}-G3.png`;
  const flux = await readAsset(path.join(datasetDir, fluxImage));
  await Promise.all([
    fs.writeFile(path.join(outputDir, sourceImage), bytes),
    fs.writeFile(path.join(outputDir, fluxImage), flux),
  ]);
  return { sourceImage, fluxImage };
}

function buckets(response) {
  if (response?.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length) {
    return response.rateLimitsByLimitId;
  }
  const snapshot = response?.rateLimits;
  return snapshot ? { [snapshot.limitId || 'default']: snapshot } : {};
}

function usageChanges(record) {
  const changes = [];
  const before = buckets(record.rateLimitsBefore);
  const after = buckets(record.rateLimitsAfter);
  for (const [id, previous] of Object.entries(before)) {
    for (const window of ['primary', 'secondary']) {
      const start = previous[window];
      const end = after[id]?.[window];
      if (!Number.isFinite(start?.usedPercent) || !Number.isFinite(end?.usedPercent)) continue;
      const comparable = Number.isFinite(start.resetsAt) && start.resetsAt === end.resetsAt &&
        start.windowDurationMins === end.windowDurationMins && end.usedPercent >= start.usedPercent;
      changes.push({
        id, window, beforePercent: start.usedPercent, afterPercent: end.usedPercent,
        changeInPercentagePoints: comparable ? end.usedPercent - start.usedPercent : null,
        note: comparable ? '同一配额窗口' : '额度窗口可能已重置或无法识别',
      });
    }
  }
  return { sample: record.id, changes };
}

function collectFindings(results) {
  const { records } = results;
  const attempted = records.filter(r => r.attempted);
  const coveredAll = attempted.length === TOTAL_SAMPLES;
  const skipped = records.filter(r => !r.attempted && r.status === 'skipped').length;
  const produced = attempted.filter(r => r.imageToolCalled && r.outputImage);
  const first = attempted.find(r => r.id === 1);
  const firstProduced = produced.some(r => r.id === 1);
  const untested = Array.from({ length: TOTAL_SAMPLES }, (_, i) => i + 1)
    .filter(id => !attempted.some(r => r.id === id));
  const referenceMatches = produced.filter(r => r.referenceHashMatched === true);
  const unmatched = produced.filter(r => r.referenceHashMatched === false).map(r => r.id);
  const times = produced.filter(r => r.status === 'success' && Number.isFinite(r.durationMs))
    .map(r => r.durationMs).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const medianMs = times.length ? (times[mid] + times[Math.floor((times.length - 1) / 2)]) / 2 : null;
  const maxMs = times.at(-1) ?? null;
  const failures = attempted.filter(r => r.status === 'failed').map(r => ({
    sample: r.id, durationMs: r.durationMs ?? null, turnStatus: r.turnStatus ?? null,
  }));
  const firstTerminalMs = first?.turnStatus ? first.durationMs ?? null : null;
  const firstTime = first?.status === 'failed' && Number.isFinite(firstTerminalMs) ? '' :
    Number.isFinite(firstTerminalMs) ? `首图从提交到终态用时 ${firstTerminalMs / 1000} 秒。` :
    first ? '首图提交至终态的耗时未能测得。' : '首图未提交，无生成耗时。';
  const usage = attempted.map(usageChanges);
  const changes = usage.flatMap(r => r.changes.filter(c => c.changeInPercentagePoints !== null)
    .map(c => `样本 ${r.sample} ${c.id}/${c.window} 从 ${c.beforePercent}% 到 ${c.afterPercent}%（+${c.changeInPercentagePoints} 个百分点）`));
  const images = produced.map(r => ({
    sample: r.id, file: r.outputImage, format: r.format, width: r.width, height: r.height,
    reportedPath: r.reportedPath ?? null, reportedPathScope: r.reportedPathScope ?? null,
  }));
  const failureModes = results.failureModes ?? {};
  const questions = [
    {
      question: '能否附带原画生成图片？',
      answer: referenceMatches.length ? `已验证图生图。${referenceMatches.length} 张生成结果的图片工具事件记录了与附带原画一致的输入 SHA-256。视觉还原程度请看对比页。` :
        unmatched.length ? `样本 ${unmatched.join('、')} 已取得图片，但工具的输入清单未匹配原画哈希，未通过重绘验收。` :
        produced.length ? '附图请求触发图片工具并取得图片，尚无匹配的输入哈希确认工具采用原画，构图和细节待人工对比。' :
          '未取得携带原画且实际调用图片工具产出图片的证据，图生图能力待验证。',
      matchedSamples: referenceMatches.map(r => r.id),
    },
    {
      question: '首图提交几次、产图几张？其余样本和整组成功率如何？',
      answer: `首图提交 ${first ? 1 : 0} 次，产图 ${firstProduced ? 1 : 0} 张。` +
        (coveredAll ? `整组产图 ${produced.length}/5（${produced.length * 20}%）。` :
          `样本 ${untested.join('、')} 未测。全组成功率未验证。`),
      total: TOTAL_SAMPLES, attempted: attempted.length, produced: produced.length, skipped,
      untested,
      measuredRate: attempted.length ? produced.length / attempted.length : null,
      fullSetRate: coveredAll ? produced.length / TOTAL_SAMPLES : null,
    },
    {
      question: '首图提交至终态多久？成功与失败样本各耗时多少？',
      answer: firstTime + (times.length ? `成功样本 ${times.length} 张，中位数 ${medianMs / 1000} 秒，最大值 ${maxMs / 1000} 秒。` :
        '成功样本 0 张，无中位数或最大值。') + failures.map(f => {
          const end = f.turnStatus ? '至终态' : '至停止等待';
          const sample = f.sample === 1 ? '首图失败' : `样本 ${f.sample} 失败`;
          return `${sample}，从提交${end}耗时${Number.isFinite(f.durationMs) ? ' ' + f.durationMs / 1000 + ' 秒' : '未测得'}。`;
        }).join(''),
      firstTerminalMs, count: times.length, medianMs, maxMs, failures,
    },
    {
      question: '能否观察每张图片的额度消耗？',
      answer: !attempted.length ? '本次未提交原画，没有首图提交前后的额度读数。' :
        changes.length ? `${changes.join('，')}。变化是账号窗口的整数读数，可能受延迟或同时使用影响，不能单独归因于这次出图。` :
        '缺少可比较的同一额度窗口前后读数，每张图片的消耗未知。',
      perSample: usage,
    },
    {
      question: '输出格式、尺寸及文件位置？',
      answer: images.length ? 'images 记录检测到的格式与尺寸、报告副本相对路径及工具报告的位置。仅能观察工具主动报告的路径。' :
        attempted.some(r => r.reportedPath) ? '工具报告了图片路径（见 reportedPaths），未取得可验证的图片文件，格式及尺寸未知。' :
          '未取得图片或工具报告的保存路径，输出格式、尺寸及 Codex 的实际写入位置未知。',
      images,
      reportedPaths: attempted.filter(r => r.reportedPath).map(r => ({
        sample: r.id, path: r.reportedPath, scope: r.reportedPathScope ?? null,
      })),
    },
    {
      question: '未登录、额度用尽、功能关闭时分别返回什么错误？',
      answer: '仅列实际复现的情形。', loggedOut: failureModes.loggedOut ?? '未验证',
      quotaExhausted: failureModes.quotaExhausted ?? '未验证', featureDisabled: failureModes.featureDisabled ?? '未验证',
    },
    {
      question: '本机最小可用性检测步骤？',
      answer: '使用 --check-existing-login 确认桌面端 Codex 两次连接均返回 chatgpt，再使用 --check-image-capability 查询出图开关、供应商能力、模型图片输入及额度。两项均提交 0 张。单次首图入口会在自己的出图权限下重新检查登录与能力，明确有可用普通额度后才提交。实际出图需另有图片工具的完成事件及可解码图片。工具提供输入哈希时须与原画匹配，缺少哈希时需人工对比主体和构图。',
    },
  ];
  return questions.map((finding, i) => ({ number: i + 1, ...finding }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

function imageCell(file, label) {
  if (!file) return '<td>暂无图片</td>';
  return `<td><a href="${encodeURIComponent(file)}"><img src="${encodeURIComponent(file)}" alt="${escapeHtml(label)}"></a></td>`;
}

function outcome(record) {
  if (!record.attempted) return '未提交';
  if (!record.imageToolCalled) return '已提交，未观测到图片工具调用';
  if (!record.outputImage) return '工具已调用，未取得有效图片';
  return record.id === 1 ? '已取得首图' : '已取得图片';
}

async function writeReport(outputDir, results) {
  results.findings = collectFindings(results);
  const rows = results.records.map(r => {
    r.outcome = outcome(r);
    const seconds = Number.isFinite(r.durationMs) ? `${(r.durationMs / 1000).toFixed(2)} 秒` : '无耗时记录';
    const reference = r.outputImage ? (r.referenceHashMatched === true ? ' · 原画输入哈希匹配' :
      r.referenceHashMatched === false ? ' · 原画输入哈希未匹配' : ' · 请人工核对原画主体和构图') : '';
    return `<tbody><tr>${imageCell(r.sourceImage, '原画')}${imageCell(r.fluxImage, '本地 FLUX G3')}${imageCell(r.outputImage, 'Codex')}</tr>
<tr><th colspan="3" scope="rowgroup">样本 ${escapeHtml(r.id)} · ${r.outcome}${reference} · ${seconds}${r.error ? ' · ' + escapeHtml(r.error) : ''}</th></tr></tbody>`;
  }).join('\n');
  const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>G3 原画重绘对比</title><style>
body{margin:2rem auto;padding:0 1rem;max-width:110rem;font:1rem/1.5 system-ui,sans-serif;color:#171717}
table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:.55rem;text-align:left}thead th{border-bottom:2px solid #333}
tbody th{border-bottom:1px solid #aaa;font-weight:normal}td img{display:block;width:100%;max-height:65vh;object-fit:contain}
</style><h1>G3 原画重绘对比</h1>
<table><thead><tr><th scope="col">原画</th><th scope="col">本地 FLUX G3</th><th scope="col">Codex</th></tr></thead>${rows}</table>
${rows ? '' : '<p>本次未提交原画。</p>'}${results.error ? '<p>' + escapeHtml(results.error) + '</p>' : ''}<p><a href="results.json">查看运行记录与七项结论</a></p></html>\n`;
  await Promise.all([
    fs.writeFile(path.join(outputDir, 'results.json'), JSON.stringify(results, null, 2) + '\n'),
    fs.writeFile(path.join(outputDir, 'comparison.html'), html),
  ]);
}

module.exports = { loadDataset, prepareSample, writeReport };
