<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>胎压监测</title>
<style>
  :root { --bg:#f5f7fa; --card:#fff; --line:#e3e8ef; --txt:#1f2933; --mut:#687385;
          --pri:#2563eb; --pri-d:#1d4ed8; --ok:#0f9d58; --bad:#d93025; --warn:#e37400; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:20px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--mut); margin:0 0 18px; font-size:13px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:560px){ .grid { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
          padding:18px; box-shadow:0 1px 2px rgba(16,24,40,.04); position:relative; overflow:hidden; }
  .card .bar { position:absolute; left:0; top:0; bottom:0; width:6px; background:var(--ok); }
  .card.warn .bar { background:var(--warn); }
  .card.bad  .bar { background:var(--bad); }
  .card.stale .bar { background:var(--mut); }
  .pos { font-size:13px; color:var(--mut); font-weight:600; letter-spacing:.5px; }
  .val { font-size:42px; font-weight:700; line-height:1.1; margin:6px 0 2px; }
  .val small { font-size:16px; font-weight:600; color:var(--mut); margin-left:4px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; }
  .badge.ok { background:#e6f4ea; color:var(--ok); }
  .badge.warn { background:#fef3e0; color:var(--warn); }
  .badge.bad { background:#fce8e6; color:var(--bad); }
  .badge.mut { background:#eceff3; color:var(--mut); }
  .meta { margin-top:12px; font-size:12px; color:var(--mut); display:grid; grid-template-columns:auto 1fr; gap:2px 10px; }
  .meta b { color:var(--txt); font-weight:600; }
  .temp { margin-top:10px; font-size:13px; color:var(--mut); }
  .temp b { color:var(--txt); }
  /* 候选·未校准徽章 —— 对齐电池页「校准中」琥珀徽章（warningBorder 底 / onWarning 字 / 圆角8） */
  .cand { display:inline-block; margin-left:6px; padding:2px 8px; border-radius:8px;
          font-size:11px; font-weight:600; background:#fde68a; color:#92400e; vertical-align:middle; }
  .note { margin-top:16px; font-size:12px; color:var(--mut); background:#eef2f7; border-radius:10px; padding:10px 12px; }
  /* 胎温候选说明卡 —— 对齐电池页「校准中」琥珀卡片（warningLight 底 / warningBorder 边） */
  .note-cand { margin-top:12px; font-size:12px; color:#92400e; background:#fffbeb;
               border:1px solid #fde68a; border-radius:10px; padding:10px 12px; line-height:1.5; }
  .btnrow { display:flex; gap:10px; align-items:center; margin:4px 0 18px; }
  button { cursor:pointer; border:none; border-radius:8px; padding:9px 16px;
           background:var(--pri); color:#fff; font-weight:600; font:inherit; }
  button:hover { background:var(--pri-d); }
  button.ghost { background:#eef2f7; color:var(--txt); }
  button.ghost:hover { background:#e2e8f1; }
  .status { font-size:13px; margin-left:auto; color:var(--mut); }
</style>
</head>
<body>
<div class="wrap">
  <h1>胎压监测</h1>
  <p class="sub">JH.TPMS 传感器 · 服务端解码（relay 自动抓包，无需重装 APK）</p>

  <div class="btnrow">
    <button id="refresh">立即刷新</button>
    <label style="display:flex;align-items:center;gap:6px;color:var(--mut);font-size:13px;">
      <input type="checkbox" id="auto" checked> 自动轮询（10s）
    </label>
    <span class="status" id="status">—</span>
  </div>

  <div class="grid">
    <div class="card" id="card-front"><div class="bar"></div>
      <div class="pos">前轮 FRONT</div>
      <div class="val" id="front-val">—<small>bar</small></div>
      <span class="badge mut" id="front-badge">等待数据</span>
      <div class="meta" id="front-meta"></div>
      <div class="temp">胎温：<b id="front-temp">待采集</b><span class="cand" id="front-temptag" style="display:none">候选·未校准</span></div>
    </div>
    <div class="card" id="card-rear"><div class="bar"></div>
      <div class="pos">后轮 REAR</div>
      <div class="val" id="rear-val">—<small>bar</small></div>
      <span class="badge mut" id="rear-badge">等待数据</span>
      <div class="meta" id="rear-meta"></div>
      <div class="temp">胎温：<b id="rear-temp">待采集</b><span class="cand" id="rear-temptag" style="display:none">候选·未校准</span></div>
    </div>
  </div>

  <div class="note" id="note"></div>
  <div class="note-cand" id="note-cand" style="display:none"></div>
</div>

<script>
// 标称值与告警阈值（bar）。低于 LOW 或高于 HIGH 触发红色告警；偏离标称 > DEV 触发黄色提示。
const NOMINAL = { front: 2.1, rear: 2.2 };
const LOW = 1.8, HIGH = 3.0, DEV = 0.4, STALE = 1800; // 30 分钟无更新视为休眠

function classify(pos, p, age) {
  if (p === null) return { cls: 'mut', label: age === null ? '无数据' : '未解析' };
  if (age !== null && age > STALE) return { cls: 'mut', label: '休眠·数值有效' };
  if (p < LOW) return { cls: 'bad', label: '低压告警' };
  if (p > HIGH) return { cls: 'bad', label: '高压告警' };
  if (Math.abs(p - NOMINAL[pos]) > DEV) return { cls: 'warn', label: '偏离标称' };
  return { cls: 'ok', label: '正常' };
}

function setWheel(pos, d) {
  const card = document.getElementById('card-' + pos);
  const valEl = document.getElementById(pos + '-val');
  const badge = document.getElementById(pos + '-badge');
  const meta = document.getElementById(pos + '-meta');
  const temp = document.getElementById(pos + '-temp');

  const p = d.pressure;
  const age = d.age_seconds;
  const c = classify(pos, p, age);
  card.className = 'card' + (c.cls === 'mut' ? ' stale' : (c.cls === 'ok' ? '' : ' ' + c.cls));

  valEl.innerHTML = (p === null ? '—' : p.toFixed(2)) + '<small>bar</small>';
  badge.className = 'badge ' + c.cls;
  badge.textContent = c.label;

  let metaHtml = '';
  if (d.updated_at) metaHtml += '<span>更新时间</span><b>' + d.updated_at + '</b>';
  if (age !== null) metaHtml += '<span>距现在</span><b>' + fmtAge(age) + '</b>';
  if (d.rssi !== null && d.rssi !== undefined) metaHtml += '<span>信号</span><b>' + d.rssi + ' dBm</b>';
  if (d.token) metaHtml += '<span>原始帧</span><b>' + escapeHtml(d.token) + '</b>';
  if (d.capture_id) metaHtml += '<span>抓包ID</span><b>#' + d.capture_id + '</b>';
  if (age !== null && age > 300 && age <= STALE) {
    metaHtml += '<span>状态</span><b style="color:var(--warn)">可能滞后（弱信号易漏抓旧帧）</b>';
  }
  meta.innerHTML = metaHtml;

  const tempTag = document.getElementById(pos + '-temptag');
  if (d.temp_c !== null && d.temp_c !== undefined) {
    temp.textContent = Math.round(d.temp_c) + ' °C';
    if (tempTag) tempTag.style.display = '';
  } else {
    temp.textContent = '待采集';
    if (tempTag) tempTag.style.display = 'none';
  }
}

function fmtAge(s) {
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分';
  return (s / 3600).toFixed(1) + ' 小时';
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function load() {
  const st = document.getElementById('status');
  st.textContent = '加载中…';
  try {
    const r = await fetch('/api/tpms/current', { credentials: 'include' });
    if (!r.ok) { st.textContent = 'HTTP ' + r.status; return; }
    const j = await r.json();
    setWheel('front', j.front || {});
    setWheel('rear', j.rear || {});
    const note = document.getElementById('note');
    note.textContent = j.note || '';
    const nc = document.getElementById('note-cand');
    if (j.temp_note) { nc.textContent = j.temp_note; nc.style.display = ''; }
    else { nc.style.display = 'none'; }
    const fa = j.front && j.front.age_seconds, ra = j.rear && j.rear.age_seconds;
    const fresh = Math.min(fa ?? 1e9, ra ?? 1e9);
    st.textContent = '已更新 · ' + new Date().toLocaleTimeString();
  } catch (e) {
    st.textContent = '请求失败：' + e.message;
  }
}

document.getElementById('refresh').onclick = load;
let timer = null;
function syncAuto() {
  if (timer) { clearInterval(timer); timer = null; }
  if (document.getElementById('auto').checked) timer = setInterval(load, 10000);
}
document.getElementById('auto').onchange = syncAuto;
syncAuto();
load();
</script>
</body>
</html>
