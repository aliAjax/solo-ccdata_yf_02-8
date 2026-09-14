/* 浏览器控制层测试：用 DOM/Worker 桩加载 index.html 的真实主线程脚本。
 * Worker 桩仍执行从同一文件抽取的真实算法源码，覆盖 UI 状态机与 worker 的端到端协作。 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]);
const workerSrc = scripts[0];   // text/plain 中的 Worker 源码
const appSrc = scripts[1];      // 主线程应用脚本

let pass = 0;
const fails = [];
function ok(cond, msg){ if(cond) pass++; else fails.push(msg); }
function assertContains(hay, needle, msg){ ok(String(hay).indexOf(needle) >= 0, `${msg}\n  期望包含: ${needle}\n  实际: ${String(hay).slice(0,200)}`); }
function assertNotContains(hay, needle, msg){ ok(String(hay).indexOf(needle) < 0, `${msg}\n  不应残留: ${needle}`); }

// ---------- Worker 沙箱（真实算法源码） ----------
const wctx = { self: {}, console };
let wLast = null, wHandler = null;
wctx.self.postMessage = (m) => { wLast = m; };
Object.defineProperty(wctx.self, 'onmessage', { set(f){ wHandler = f; }, configurable:true });
vm.createContext(wctx);
vm.runInContext(workerSrc, wctx, { filename: 'worker.js' });

class FakeWorker {
  constructor(){ this.terminated = false; this._data = null; this.onmessage = null; this.onerror = null;
    FakeWorker.instances.push(this); FakeWorker.last = this; }
  postMessage(data){ this._data = data; if(FakeWorker.auto) this._deliver(); }
  _compute(){
    wLast = undefined;
    wHandler({ data: this._data });
    return wLast;
  }
  _deliver(){
    if(this.terminated) return;               // 已 terminate 的 worker 不得再回写
    if(this.onmessage) this.onmessage({ data: this._compute() });
  }
  terminate(){ this.terminated = true; }
}
FakeWorker.instances = [];
FakeWorker.auto = true;

// ---------- 最小 DOM ----------
function makeEl(id){
  return {
    id, value:'', textContent:'', innerHTML:'', style:{},
    __on:{},
    addEventListener(type, fn){ (this.__on[type] = this.__on[type] || []).push(fn); },
    fire(type){ (this.__on[type] || []).forEach(fn => fn()); }
  };
}
const IDS = ['refInput','smpInput','strand','matchSc','mismatchSc','gapOpen','gapExt',
  'refLen','smpLen','errorBox','status','results','demoBtn','clearBtn','worker-src'];
const els = {};
IDS.forEach(id => els[id] = makeEl(id));
els.strand.value = 'forward';
els.matchSc.value = '2'; els.mismatchSc.value = '2';
els.gapOpen.value = '5'; els.gapExt.value = '1';
els.workerSrc = els['worker-src'];
els.workerSrc.textContent = workerSrc;
const document = { getElementById: (id) => els[id] };

const pendingTimers = [];
let nextTimerId = 1;
const sandbox = {
  document, console,
  Blob: function(parts){ this.parts = parts; },
  Worker: FakeWorker,
  URL: { createObjectURL: () => 'blob:fake' },
  performance: { now: (() => { let t = 0; return () => ++t; })() },
  setTimeout: (fn) => { const id = nextTimerId++; pendingTimers.push({ id, fn, cancelled:false }); return id; },
  clearTimeout: (id) => { const t = pendingTimers.find(x => x.id === id); if(t) t.cancelled = true; }
};
vm.createContext(sandbox);
vm.runInContext(appSrc, sandbox, { filename: 'app.js' });

// ---------- 测试辅助 ----------
const P = { match:2, mismatch:2, gapOpen:5, gapExt:1 };
function setParams(){
  els.matchSc.value = String(P.match); els.mismatchSc.value = String(P.mismatch);
  els.gapOpen.value = String(P.gapOpen); els.gapExt.value = String(P.gapExt);
}
function type(ref, smp){
  if(ref !== undefined) els.refInput.value = ref;
  if(smp !== undefined) els.smpInput.value = smp;
  els.refInput.fire('input');
  els.smpInput.fire('input');
}
function setStrand(s){ els.strand.value = s; els.strand.fire('change'); }
function flush(){ for(const t of pendingTimers) if(!t.cancelled) t.fn(); pendingTimers.length = 0; }
function errorShown(substr){ return els.errorBox.style.display === 'block' && els.errorBox.textContent.indexOf(substr) >= 0; }
function errorHidden(){ return els.errorBox.style.display !== 'block'; }
function resultsHas(substr){ return els.results.innerHTML.indexOf(substr) >= 0; }

const RC = (s) => { const C={A:'T',T:'A',C:'G',G:'C',R:'Y',Y:'R',S:'S',W:'W',K:'M',M:'K',B:'V',V:'B',D:'H',H:'D',N:'N',X:'X'};
  return [...s].reverse().map(x=>C[x]).join(''); };

// ---------- 用例 ----------
console.log('— B1. 初始加载 —');
ok(!pendingTimers.length, '初始无待执行计算');
assertContains(els.results.innerHTML, '粘贴参考序列与样本序列', '初始显示中性占位提示');
ok(errorHidden(), '初始无错误条');

console.log('— B2. 正常比对渲染结果 —');
setParams();
type('ATGCCCTTTGGGAAATAA', 'ATGCACTTCTGAAAATAA'); // 错义+同义+无义
flush();
ok(errorHidden(), '合法输入无错误');
assertContains(els.results.innerHTML, '全局比对与一致率', '渲染全局比对');
assertContains(els.results.innerHTML, '读框', '渲染三读框注释');
assertContains(els.results.innerHTML, '无义', '注释中出现无义分类');
const resultAfterValid = els.results.innerHTML;

console.log('— B3. 参考保留、样本清空 → 明确空序列错误，旧结果清除 —');
els.smpInput.value = '';
els.smpInput.fire('input');
flush();
ok(errorShown('样本序列为空'), '样本清空后显示“样本序列为空”错误');
ok(!resultsHas('全局比对与一致率'), '旧全局比对已清除');
ok(!resultsHas('读框'), '旧三读框注释已清除');
assertContains(els.results.innerHTML, '旧比对与注释已清除', '结果区显示“已清除”占位而非普通提示');
assertNotContains(els.results.innerHTML, resultAfterValid, '结果区无任何旧结果残留');
ok(els.status.textContent === '', '状态栏被清空');

console.log('— B4. 纯空白样本 —');
type(undefined, '   \n\t  \r\n ');
flush();
ok(errorShown('样本序列为空'), '纯空白样本显示明确空序列错误');
ok(!resultsHas('全局比对与一致率'), '不残留比对');
assertNotContains(els.results.innerHTML, resultAfterValid, '不残留旧注释');

console.log('— B5. 两条都清空（此前已有结果）→ 均为空错误 —');
type('', '');
flush();
ok(errorShown('均为空'), '两条皆空且曾有结果时显示“均为空”错误，而非中性占位');
ok(!resultsHas('全局比对与一致率'), '结果区无旧内容');

console.log('— B6. 重新输入合法序列 → 恢复渲染且错误消失 —');
type('ATGCCCTTTGGGAAATAA', 'ATGCACTTCTGAAAATAA');
flush();
ok(errorHidden(), '错误条已消失');
assertContains(els.results.innerHTML, '全局比对与一致率', '重新渲染比对');
assertContains(els.results.innerHTML, '无义', '重新渲染注释');

console.log('— B7. 仅输入参考、样本从空 → 立刻报样本为空 —');
type('', '');
flush();
type('ACGTACGT', '');
flush();
ok(errorShown('样本序列为空'), '参考在、样本空时立即明确报错');

console.log('— B8. 非法字符 —');
type('ATGCATGC', 'ATGZATGC');
flush();
ok(errorShown('非法字符'), '非法字符显示明确错误');
assertContains(els.errorBox.textContent, 'Z', '错误中指出非法字符 Z');
ok(!resultsHas('全局比对与一致率'), '非法输入不渲染比对');

console.log('— B9. 无可比对区域 —');
P.match=2; P.mismatch=100; P.gapOpen=0; P.gapExt=0; setParams();
type('AAAA', 'CCCC');
flush();
ok(errorShown('没有可比对的区域'), '全空位最优时报“无可比对区域”');
P.match=2; P.mismatch=2; P.gapOpen=5; P.gapExt=1; setParams();

console.log('— B10. 反向互补 —');
const ref = 'ATGCCCTTTGGGTAA';
type(ref, RC(ref));
setStrand('rc');
flush();
ok(errorHidden(), 'RC 模式无错误');
assertContains(els.results.innerHTML, '100.00%', '反向互补后与参考 100% 一致');
setStrand('forward');

console.log('— B11. 正常比对的错配/差异 —');
type('ATGCATGCA', 'ATGATGCA'); // 缺失 1 碱基
flush();
ok(errorHidden(), '缺失场景无错误');
assertContains(els.results.innerHTML, '缺失', '差异表标注缺失');

console.log('— B12. 只有 FASTA 头部（经 worker 报空错误，旧结果清除）—');
type('ATGCATGCATGC', '>sample header\n   \n');
flush();
ok(errorShown('未找到任何碱基'), '样本仅 FASTA 头时显示“未找到任何碱基”错误');
ok(!resultsHas('全局比对与一致率'), '不残留上一次比对');

console.log('— B13. 进行中改输入：旧 worker 终止；过期结果丢弃 —');
FakeWorker.auto = false; // 手动投递，模拟真实异步在途
type('AAAAAAAA', 'AAAAAAAA');
flush();
const workerA = FakeWorker.last;
ok(workerA && !workerA.terminated, 'A 计算已启动、在途');
type('CCCCGGGG', 'CCCCGGGG');        // A 尚未返回即改输入
ok(workerA.terminated === true, '旧 worker A 已 terminate');
flush();                              // B 的防抖任务触发，创建 workerB
const workerB = FakeWorker.last;
ok(workerB !== workerA && !workerB.terminated, '新 worker B 已创建且在途');
// 旧任务迟到：已终止，结果被丢弃，界面仍停留在“重算中”
workerA._deliver();
assertContains(els.results.innerHTML, '输入已变更', '迟到的 A 结果未覆盖界面（仍为 B 重算中占位）');
workerB._deliver();
assertContains(els.results.innerHTML, '全局比对与一致率', 'B 结果正常渲染');
const htmlB = els.results.innerHTML;
// 额外：即便旧 worker 未终止，runId 守卫也必须丢弃其迟到消息
const stalePayload = workerA._compute();
workerA.onmessage({ data: stalePayload });
ok(els.results.innerHTML === htmlB, 'runId 守卫：过期 run 的回送不改变界面');
FakeWorker.auto = true;

console.log('— B14.「清空」按钮复位到初始中性状态 —');
els.clearBtn.fire('click');
flush();
ok(els.refInput.value === '' && els.smpInput.value === '', '两个输入框被清空');
ok(errorHidden(), '清空按钮后不显示错误条');
assertContains(els.results.innerHTML, '粘贴参考序列与样本序列', '回到初始中性占位');

console.log(`\n浏览器层：通过 ${pass} 项，失败 ${fails.length} 项`);
if(fails.length){ fails.forEach(f => console.log(' ✗ ' + f)); process.exit(1); }
console.log('浏览器层全部通过 ✓');
