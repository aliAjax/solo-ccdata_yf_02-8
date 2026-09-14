/* 离线比对台算法测试：从 index.html 抽取 Worker 真实源码在 Node 中运行 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ---- 抽取 Worker 源码并在沙箱中加载 ----
const m = html.match(/\/\* === WORKER-START === \*\/([\s\S]*?)\/\* === WORKER-END === \*\//);
if (!m) throw new Error('找不到 WORKER-START/END 标记');
const workerSrc = m[1];

let handler = null;
const sandbox = { self: {}, console };
sandbox.self.postMessage = function (msg) { sandbox.__last = msg; };
Object.defineProperty(sandbox.self, 'onmessage', {
  set(fn) { handler = fn; }, get() { return handler; }, configurable: true
});
vm.createContext(sandbox);
vm.runInContext(workerSrc, sandbox, { filename: 'worker.js' });

function run(refText, smpText, opts = {}) {
  sandbox.__last = undefined;
  handler({
    data: {
      refText, smpText,
      strand: opts.strand || 'forward',
      params: Object.assign({ match: 2, mismatch: 2, gapOpen: 5, gapExt: 1 }, opts.params)
    }
  });
  return sandbox.__last;
}

// ---- 极简断言 ----
let pass = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) pass++;
  else fails.push(msg);
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
}
function groupOf(r, f, refPos) {
  return r.frames[f].groups.find(g => g.refPos === refPos);
}

// ============================================================
console.log('— 1. FASTA 解析与简并碱基 —');
{
  const r = run('>ref desc\nACGT\nacgt', '>s\nARWS KMYN BDVH'); // 含空格/小写/全部简并码
  ok(r.ok, 'FASTA、空格、小写应成功: ' + (r.ok ? '' : r.error));
  eq(r.refSeq, 'ACGTACGT', '小写与换行被规范化');
  eq(r.smpAnalyzed, 'ARWSKMYNBDVH', '简并碱基正常解析（去空格、大写化，12 个 IUPAC 码）');
  // 全部兼容的简并配对：参考全 A，样本 A R R R N
  const r2 = run('AAAAA', 'AR RRN');
  ok(r2.ok, '兼容简并配对应成功');
  eq(r2.stats.matches, 5, 'A/R、A/N 计为可配对列');
  eq(r2.stats.exact, 1, '1 列完全匹配（首位 A/A）');
  eq(r2.stats.degen, 4, '4 列简并兼容（R、R、R、N 对 A）');
  eq(r2.stats.mismatches, 0, '无错配');
  eq(r2.stats.identity, 1, '一致率 100%');
  // 不兼容：A vs Y(C/T)
  const r3 = run('AAA', 'AYA');
  eq(r3.stats.mismatches, 1, 'A 与 Y 不兼容，判为错配');
  // U 按 T 处理
  const r4 = run('ACGU', 'ACGT');
  eq(r4.stats.exact, 4, 'RNA 的 U 按 T 处理');
}

console.log('— 2. 插入 / 缺失全局比对（仿射空位）—');
{
  // 参考 9nt，样本缺失第 4 位 C；默认罚分下应产生单个连续空位
  const r = run('ATGCATGCA', 'ATGATGCA');
  ok(r.ok, '缺失比对成功');
  eq(r.refAln, 'ATGCATGCA', '参考行保持原序列');
  eq(r.smpAln, 'ATG-ATGCA', '样本在第 4 位出现 1 个空位');
  eq(r.stats.delCols, 1, '1 个缺失列');
  eq(r.stats.insCols, 0, '0 插入列');
  eq(r.stats.mismatches, 0, '无错配');
  ok(r.diffs.length === 1 && r.diffs[0].type === 'del', '差异表含 1 条缺失区段');
  eq(r.diffs[0].refBases, 'C', '缺失的是 C');
  eq(r.diffs[0].refPos, 4, '缺失起始于参考第 4 位');

  // 插入：样本多 3 个碱基
  const r2 = run('ATG---GTA'.replace(/-/g, ''), 'ATGCCCGTA');
  eq(r2.refAln, 'ATG---GTA', '参考出现 3 空位');
  eq(r2.smpAln, 'ATGCCCGTA', '样本插入 CCC');
  eq(r2.stats.insCols, 3, '3 个插入列');
  const ins = r2.diffs.find(d => d.type === 'ins');
  ok(ins && ins.smpBases === 'CCC' && ins.smpPos === 4 && ins.smpPosEnd === 6,
    '插入区段位置 4–6、碱基 CCC');
}

console.log('— 3. 反向互补 —');
{
  const ref = 'ATGCCCTTTGGGTAA';
  function rc(s) {
    const C = { A:'T',T:'A',C:'G',G:'C',R:'Y',Y:'R',S:'S',W:'W',K:'M',M:'K',B:'V',V:'B',D:'H',H:'D',N:'N' };
    return [...s].reverse().map(x => C[x]).join('');
  }
  // 样本贴的是参考的反向互补（正链视角），选择 rc 后应与参考完全相同
  const r = run(ref, rc(ref), { strand: 'rc' });
  ok(r.ok, 'RC 模式成功');
  eq(r.smpAnalyzed, ref, '分析链已反向互补还原');
  eq(r.stats.identity, 1, '一致率 100%');
  eq(r.stats.exact, ref.length, '所有列完全匹配');
  // 正链模式（不翻转）应当差异巨大：至少不能完全一致
  const r2 = run(ref, rc(ref));
  ok(r2.stats.identity < 1, '不翻转时不应 100% 一致');
  // 简并碱基的 RC：R 互补为 Y
  const r3 = run('ATGCN', 'NGCAT', { strand: 'rc' });
  eq(r3.smpAnalyzed, 'ATGCN', '简并碱基反向互补正确（N->N, R/Y 等）');
}

console.log('— 4. 三种读框翻译 —');
{
  // 参考长度 15，5 个密码子：M P F G K *  —— 长度 18，6 密码子
  const ref = 'ATGCCCTTTGGGAAATAA';
  const r = run(ref, ref);
  ok(r.ok, '自比对成功');
  eq(r.frames[0].groups.length, 6, '读框+1：6 个完整密码子');
  // frame1: 窗口 2-4,5-7,8-10,11-13,14-16,17-18(末组仅 2 碱基) => 6 组
  eq(r.frames[1].groups.length, 6, '读框+2：6 组，末组为不完整密码子');
  // frame2: 窗口 3-5,6-8,9-11,12-14,15-17 + 第 18 位单独成末组 => 6 组
  eq(r.frames[2].groups.length, 6, '读框+3：6 组（末组 1 碱基不完整）');
  ok(r.frames[2].groups[5].type === 'partial', '读框+3 末组标记为不完整密码子');
  const f0 = r.frames[0].groups;
  eq(f0.map(g => g.refAA).join(''), 'MPFGK*', '读框+1 翻译 M P F G K *');
  eq(f0[0].type, 'syn', '自比对均为同义');
  eq(r.frames[0].counts.refStops, 1, '标出参考终止密码子 1 个');
  eq(r.frames[0].counts.smpStops, 1, '标出样本终止密码子 1 个');

  // 同义突变：TTT(F) -> TTC(F)，密码子第 3 位，位置 9
  const smp = ref.slice(0, 8) + 'C' + ref.slice(9);
  const r2 = run(ref, smp);
  const g = groupOf(r2, 0, 7); // 密码子 TTT 起始位 7
  eq(g.refCodon, 'TTT', '定位到 Phe 密码子');
  eq(g.smpCodon, 'TTC', '样本为 TTC');
  eq(g.refAA, g.smpAA, '氨基酸相同');
  eq(g.type, 'syn', '判为同义突变');
}

console.log('— 5. 错义、无义突变与终止密码子丢失 —');
{
  // 读框+1: ATG(M) AAA(K) AAA(K)
  const ref = 'ATGAAAAAA';
  // 第 2 密码子 AAA->TAA（无义）；第 3 密码子 AAA->CAA（错义, Q）
  const smp = 'ATGTAACAA';
  const r = run(ref, smp);
  const gN = groupOf(r, 0, 4);
  eq(gN.type, 'nonsense', 'AAA->TAA 判为无义');
  eq(gN.smpAA, '*', '样本氨基酸为终止 *');
  const gM = groupOf(r, 0, 7);
  eq(gM.type, 'missense', 'AAA->CAA 判为错义');
  eq(gM.smpAA, 'Q', '样本氨基酸为 Q');
  ok(r.frames[0].counts.nonsense === 1 && r.frames[0].counts.missense === 1,
    '分类计数正确');
  // 终止丢失：参考 TAA，样本 CAA
  const r2 = run('ATGTAA', 'ATGCAA');
  eq(groupOf(r2, 0, 4).type, 'missense', '*->Q 判为错义（终止密码子丢失）');
}

console.log('— 6. 移码与框内 Indel 注释 —');
{
  // 参考 12nt：ATG CCC TTT GGG
  const ref = 'ATGCCCTTTGGG';
  // 样本在第 4 位后插入 1 个 A：ATG A CCC TTT GGG -> 从第 2 密码子起移码
  const smp1 = 'ATGACCC TTTGGG'.replace(/ /g, '');
  const r = run(ref, smp1);
  const f0 = r.frames[0];
  // 插入边界在 ref 位 4 之前（insBefore[3]），归属于第 2 个窗口（a=3）
  const g1 = groupOf(r, 0, 4);
  eq(g1.insBases, 'A', '第 2 密码子窗口捕获 1nt 插入');
  eq(g1.type, 'frameshift', '1nt 插入判为移码');
  // 其后所有密码子均标记 shifted
  const later = f0.groups.slice(2).every(g => g.type === 'frameshift');
  ok(later, '移码点之后的密码子全部标为移码');
  ok(f0.counts.frameshift >= 3, '至少 3 个密码子标移码，实际 ' + f0.counts.frameshift);

  // 3nt 整码插入：ATG + CCC?  -> 框内
  const smp3 = 'ATGAAACCCTTTGGG'; // 在 ATG 后插入 AAA（3nt）
  const r3 = run(ref, smp3);
  const g3 = groupOf(r3, 0, 4);
  eq(g3.type, 'inframe', '3nt 插入判为框内插入/缺失');
  ok(r3.frames[0].counts.frameshift === 0, '3nt 插入后不应出现移码');

  // 1nt 缺失：缺失第 4 位 C
  const r4 = run(ref, 'ATGCCTTTGGG');
  const g4 = groupOf(r4, 0, 4);
  eq(g4.type, 'frameshift', '1nt 缺失判为移码');
  eq(g4.refGaps, 1, '记录 1 个参考碱基对空位');

  // 3nt 缺失：框内
  const r5 = run(ref, 'ATGTTTGGG'); // 缺失 CCC（位 4-6）
  const g5 = r5.frames[0].groups.find(g => g.type === 'inframe');
  ok(!!g5, '3nt 缺失判为框内缺失');
}

console.log('— 7. 非法 / 空 / 超长 / 无可比对区域 —');
{
  let r = run('', 'ACGT');
  ok(!r.ok && /为空|请输入/.test(r.error), '空参考明确报错');
  r = run('ACGT', '   \n  ');
  ok(!r.ok && /为空/.test(r.error), '纯空白样本报空序列错误');
  r = run('>only header\n', 'ACGT');
  ok(!r.ok && /未找到任何碱基/.test(r.error), '只有 FASTA 头报空错误');
  r = run('ACGTZ', 'ACGT');
  ok(!r.ok && /非法字符/.test(r.error) && /Z/.test(r.error), '非法字符 Z 明确报错并指出字符');
  r = run('ACGT123', 'ACGT');
  ok(!r.ok && /非法字符/.test(r.error), '数字字符报错');
  r = run('>a1\nACGT', '>s1\nACGT\n>s2\nACGT');
  ok(!r.ok && /多条 FASTA/.test(r.error), '多条 FASTA 记录报错（样本含两条）');
  r = run('A'.repeat(20001), 'A'.repeat(20001));
  ok(!r.ok && /超长/.test(r.error), '超过 20000nt 报超长错误');
  // 超大文本
  r = run('A'.repeat(200001), 'A');
  ok(!r.ok && /文本超长/.test(r.error), '200k 字符文本直接拒绝');
  // 无可比对区域：错配罚分极高、空位罚分为 0，最优解全部走空位
  r = run('AAAA', 'CCCC', { params: { match: 2, mismatch: 100, gapOpen: 0, gapExt: 0 } });
  ok(!r.ok && /没有可比对的区域/.test(r.error), '全空位比对报“无可比对区域”');
  // 罚分非法
  r = run('ACGT', 'ACGT', { params: { match: 2, mismatch: -1, gapOpen: 5, gapExt: 1 } });
  ok(!r.ok && /罚分参数/.test(r.error), '负罚分报错');
  r = run('ACGT', 'ACGT', { params: { match: 1.5, mismatch: 2, gapOpen: 5, gapExt: 1 } });
  ok(!r.ok && /罚分参数/.test(r.error), '非整数罚分报错');
  // 规模超过 DP 上限（不卡住）：6000×6000 = 3.6×10⁷ > 2.5×10⁷
  const t0 = Date.now();
  r = run('A'.repeat(6000), 'A'.repeat(6000));
  ok(!r.ok && /比对规模过大/.test(r.error), '6000×6000 超 DP 单元上限直接拒绝');
  ok(Date.now() - t0 < 2000, '超限判断在 2s 内返回，不卡顿');
}

console.log('— 8. 随机小序列：Gotoh 比对与独立参考实现对拍 —');
{
  // 独立 3 状态参考实现（直接对象数组，只求分数），并校验回溯一致性
  // 独立 3 状态参考实现（教科书 Gotoh：M 仅对角转移，E/F 只能从匹配态开启）
  function refScore(a, b, P) {
    const m = a.length, n = b.length, N = -1e9;
    const M = [], E = [], F = [];
    for (let i = 0; i <= m; i++) { M.push(new Array(n + 1).fill(N)); E.push(new Array(n + 1).fill(N)); F.push(new Array(n + 1).fill(N)); }
    M[0][0] = 0;
    for (let j = 1; j <= n; j++) { E[0][j] = -(P.gapOpen + P.gapExt * (j - 1)); M[0][j] = E[0][j]; }
    for (let i = 1; i <= m; i++) { F[i][0] = -(P.gapOpen + P.gapExt * (i - 1)); M[i][0] = F[i][0]; }
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      E[i][j] = Math.max(M[i][j - 1] - P.gapOpen, E[i][j - 1] - P.gapExt);
      F[i][j] = Math.max(M[i - 1][j] - P.gapOpen, F[i - 1][j] - P.gapExt);
      M[i][j] = Math.max(M[i - 1][j - 1], E[i - 1][j - 1], F[i - 1][j - 1])
        + (a[i - 1] === b[j - 1] ? P.match : -P.mismatch);
    }
    return Math.max(M[m][n], E[m][n], F[m][n]);
  }
  // 按列重算（同方向连续算一次空位；规范模型下不同方向空位列不会相邻）
  function rescore(A, B, P){
    let s = 0, prev = 0;
    for (let i = 0; i < A.length; i++) {
      if (A[i] !== '-' && B[i] !== '-') { prev = 0; s += A[i] === B[i] ? P.match : -P.mismatch; }
      else if (B[i] === '-') { s -= prev === 2 ? P.gapExt : P.gapOpen; prev = 2; }
      else { s -= prev === 3 ? P.gapExt : P.gapOpen; prev = 3; }
    }
    return s;
  }
  function checkAlignment(a, b, r, P) {
    const A = r.refAln, B = r.smpAln;
    if (A.length !== B.length) return '比对行长度不一致';
    if (A.replace(/-/g, '') !== a) return '去空位后参考行 != 原序列';
    if (B.replace(/-/g, '') !== b) return '去空位后样本行 != 原序列';
    if (rescore(A, B, P) !== r.score) return `回溯得分 ${r.score} != 按列重算 ${rescore(A, B, P)}`;
    return null;
  }
  let seed = 1234567;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  const bases = 'ACGT';
  let allScore = true, allTrace = true;
  for (let t = 0; t < 300; t++) {
    const la = 1 + Math.floor(rnd() * 14), lb = 1 + Math.floor(rnd() * 14);
    let a = '', b = '';
    for (let i = 0; i < la; i++) a += bases[Math.floor(rnd() * 4)];
    for (let i = 0; i < lb; i++) b += bases[Math.floor(rnd() * 4)];
    const P = { match: 1 + Math.floor(rnd() * 4), mismatch: 1 + Math.floor(rnd() * 4), gapOpen: 1 + Math.floor(rnd() * 6), gapExt: Math.floor(rnd() * 3) };
    const r = run(a, b, { params: P });
    if (!r.ok) {
      if (/没有可比对的区域/.test(r.error)) continue; // 随机罚分下全空位为合法最优
      allScore = false; allTrace = false; console.log('  意外失败', a, b, r.error); continue;
    }
    if (r.score !== refScore(a, b, P)) {
      allScore = false; console.log(`  分数不符 a=${a} b=${b} P=${JSON.stringify(P)} got ${r.score} want ${refScore(a, b, P)}`);
    }
    const err = checkAlignment(a, b, r, P);
    if (err) { allTrace = false; console.log('  回溯错误', a, b, err, '\n  ', r.refAln, '\n  ', r.smpAln); }
  }
  ok(allScore, '300 组随机序列得分全部与独立实现一致');
  ok(allTrace, '300 组随机序列回溯列全部可重建且得分自洽');
}

console.log('— 9. 性能：可处理的较大序列不卡死 —');
{
  const a = 'ACGT'.repeat(750);               // 3000 nt
  // b：a 基础上制造约 1% 点突变
  let b = a.split('');
  let seed = 999;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < b.length; i++) if (rnd() < 0.01) b[i] = 'ACGT'[Math.floor(rnd() * 4)];
  const t0 = Date.now();
  const r = run(a, b.join(''));
  const dt = Date.now() - t0;
  ok(r.ok, `3000×3000 比对成功（${dt} ms）` + (r.ok ? '' : ': ' + r.error));
  ok(dt < 5000, '3000×3000 在 5s 内完成，不卡顿');
}

// ---- 语法检查：HTML 内全部 <script> 块 ----
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]);
let syntaxOk = true;
scripts.forEach((s, i) => {
  try { new vm.Script(s, { filename: `script-${i}.js` }); }
  catch (e) { syntaxOk = false; console.log('  脚本语法错误:', e.message); }
});
ok(syntaxOk, `全部 ${scripts.length} 个内联脚本通过语法检查`);

// ---- 汇总 ----
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('\n失败明细:');
  fails.forEach(f => console.log(' ✗ ' + f));
  process.exit(1);
}
console.log('全部测试通过 ✓');
