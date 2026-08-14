<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>中继手机远控</title>
<style>
  :root { --bg:#f5f7fa; --card:#fff; --line:#e3e8ef; --txt:#1f2933; --mut:#687385;
          --pri:#2563eb; --pri-d:#1d4ed8; --ok:#0f9d58; --bad:#d93025; --warn:#e37400; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:920px; margin:0 auto; padding:20px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--mut); margin:0 0 18px; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:16px 18px; margin-bottom:16px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  label { display:block; font-size:12px; color:var(--mut); margin:0 0 4px; }
  input,select,textarea,button { font:inherit; color:var(--txt); }
  input[type=text],input[type=number],select,textarea {
    width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px;
    background:#fff; outline:none; }
  input:focus,select:focus,textarea:focus { border-color:var(--pri); }
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  .row > div { flex:1 1 140px; }
  button { cursor:pointer; border:none; border-radius:8px; padding:9px 16px;
           background:var(--pri); color:#fff; font-weight:600; }
  button:hover { background:var(--pri-d); }
  button.ghost { background:#eef2f7; color:var(--txt); }
  button.ghost:hover { background:#e2e8f1; }
  .btnrow { display:flex; gap:10px; align-items:center; margin-top:12px; }
  .status { font-size:13px; margin-left:auto; color:var(--mut); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mut); font-weight:600; font-size:12px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; }
  .pill.done { background:#e6f4ea; color:var(--ok); }
  .pill.failed { background:#fce8e6; color:var(--bad); }
  .pill.pending,.pill.dispatched { background:#fef3e0; color:var(--warn); }
  .pill.expired { background:#eceff3; color:var(--mut); }
  pre { margin:0; white-space:pre-wrap; word-break:break-all; background:#f4f6f9;
        border:1px solid var(--line); border-radius:6px; padding:8px; max-height:160px; overflow:auto; }
  img.shot { max-width:200px; max-height:320px; border:1px solid var(--line); border-radius:8px; }
  .hint { color:var(--mut); font-size:12px; margin-top:6px; }
  code { background:#eef2f7; padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>中继手机远控</h1>
  <p class="sub">通过服务器中继通道，向已 root 的中继手机下发 shell / 点击 / 滑动 / 按键 / 截屏指令。需先登录仪表盘。</p>

  <div class="card">
    <div class="row">
      <div style="flex:1 1 240px;">
        <label>设备序列号 (device_sn)</label>
        <input type="text" id="deviceSn" value="">
      </div>
      <div style="flex:1 1 200px;">
        <label>指令类型</label>
        <select id="cmdType">
          <option value="screencap">截屏 (screencap)</option>
          <option value="shell">Shell 命令 (shell)</option>
          <option value="tap">点击 (tap)</option>
          <option value="swipe">滑动 (swipe)</option>
          <option value="key">按键 (key)</option>
          <option value="photo">相机拍照 (photo)</option>
          <option value="update_apk">更新中继固件 (update_apk)</option>
          <option value="flush">强制回传 (flush)</option>
          <option value="restart">重启中继 (restart)</option>
          <option value="clear-backlog">清空离线缓存 (clear-backlog)</option>
        </select>
      </div>
    </div>

    <div id="payloadArea" style="margin-top:12px;"></div>

    <div class="btnrow">
      <button id="sendBtn">下发指令</button>
      <button class="ghost" id="refreshBtn" type="button">立即刷新</button>
      <span class="status" id="status">就绪</span>
    </div>
    <div class="hint" id="payloadHint"></div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 10px;">指令历史（自动刷新）</h3>
    <table>
      <thead>
        <tr><th>#</th><th>指令</th><th>状态</th><th>执行时间</th><th>结果</th></tr>
      </thead>
      <tbody id="historyBody"><tr><td colspan="5" style="color:var(--mut);">加载中…</td></tr></tbody>
    </table>
  </div>
</div>

<script>
const DEFAULT_SN = @json('');

// 各指令需要的 payload 字段定义
const PAYLOAD_FIELDS = {
  shell:    [{k:'cmd',  t:'textarea', ph:'例如：curl -o /sdcard/x.apk https://example.com/a.apk', label:'命令 (cmd)'}],
  tap:      [{k:'x', t:'number', ph:'像素 X', label:'X'},{k:'y', t:'number', ph:'像素 Y', label:'Y'}],
  swipe:    [{k:'x1', t:'number', ph:'起点 X', label:'X1'},{k:'y1', t:'number', ph:'起点 Y', label:'Y1'},
             {k:'x2', t:'number', ph:'终点 X', label:'X2'},{k:'y2', t:'number', ph:'终点 Y', label:'Y2'},
             {k:'duration_ms', t:'number', ph:'毫秒(默认300)', label:'时长ms'}],
  key:      [{k:'code', t:'text', ph:'KEYCODE_HOME 或 26', label:'按键码 (code)'}],
  photo:    [{k:'facing', t:'text', ph:'screen 或 back', label:'镜头 (facing, 默认 screen)'}],
};
const NO_PAYLOAD = new Set(['screencap','update_apk','flush','restart','clear-backlog']);

const HINTS = {
  screencap: '抓取当前屏幕（root screencap），结果以图片显示。',
  shell:     '以 root 执行任意 shell 命令；可用来下载安装包（curl/wget）。输出上限 4000 字。',
  tap:       '在屏幕坐标 (x,y) 注入一次点击。坐标需按中继手机实际分辨率填写。',
  swipe:     '从 (x1,y1) 滑到 (x2,y2)，时长毫秒。',
  key:       '注入按键，如 KEYCODE_HOME / KEYCODE_BACK / KEYCODE_POWER 或数字码（26=电源）。',
  photo:     '用相机拍照（尾箱场景通常无用），facing=screen 同截屏。',
  update_apk:'从服务器拉取最新中继 APK 并安装（需 Magisk 已对该 App 设“总是允许”）。',
  flush:     '立即触发一次离线缓存回传。',
  restart:   '重启中继服务。',
  'clear-backlog': '清空本地离线缓存队列。',
};

function renderPayload() {
  const type = document.getElementById('cmdType').value;
  const area = document.getElementById('payloadArea');
  const hint = document.getElementById('payloadHint');
  hint.textContent = HINTS[type] || '';
  if (NO_PAYLOAD.has(type)) { area.innerHTML = ''; return; }
  const fields = PAYLOAD_FIELDS[type] || [];
  area.innerHTML = '<div class="row">' + fields.map(f => {
    const ctrl = f.t === 'textarea'
      ? `<textarea id="pf_${f.k}" rows="3" placeholder="${f.ph}"></textarea>`
      : `<input type="${f.t}" id="pf_${f.k}" placeholder="${f.ph}">`;
    return `<div><label>${f.label}</label>${ctrl}</div>`;
  }).join('') + '</div>';
}

function buildPayload() {
  const type = document.getElementById('cmdType').value;
  if (NO_PAYLOAD.has(type)) return {};
  const fields = PAYLOAD_FIELDS[type] || [];
  const p = {};
  for (const f of fields) {
    let v = document.getElementById('pf_' + f.k).value.trim();
    if (v === '') continue;
    if (f.t === 'number') v = Number(v);
    p[f.k] = v;
  }
  return p;
}

async function sendCommand() {
  const sn = document.getElementById('deviceSn').value.trim();
  const type = document.getElementById('cmdType').value;
  const status = document.getElementById('status');
  if (!sn) { status.textContent = '请填写 device_sn'; status.style.color = 'var(--bad)'; return; }
  const payload = buildPayload();
  status.textContent = '下发中…'; status.style.color = 'var(--mut)';
  try {
    const r = await fetch('/api/dashboard/bms-relay/command', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      credentials: 'same-origin',
      body: JSON.stringify({device_sn: sn, command: type, payload})
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
    status.textContent = '已下发 #' + j.command.id + '，等待手机轮询执行'; status.style.color = 'var(--ok)';
    loadHistory();
  } catch (e) {
    status.textContent = '失败：' + e.message; status.style.color = 'var(--bad)';
  }
}

function esc(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

function renderResult(cmd) {
  const res = cmd.result || {};
  if (res.photo_url) return `<a href="${esc(res.photo_url)}" target="_blank"><img class="shot" src="${esc(res.photo_url)}"></a>`;
  if (res.output !== undefined && res.output !== '') return `<pre>${esc(res.output)}</pre>`;
  if (cmd.error) return `<span style="color:var(--bad)">${esc(cmd.error)}</span>`;
  return '<span style="color:var(--mut)">—</span>';
}

async function loadHistory() {
  const sn = document.getElementById('deviceSn').value.trim();
  const body = document.getElementById('historyBody');
  try {
    const r = await fetch('/api/dashboard/bms-relay/commands?device_sn=' + encodeURIComponent(sn), {credentials:'same-origin'});
    const j = await r.json();
    const cmds = (j.commands || []).slice(0, 20);
    if (!cmds.length) { body.innerHTML = '<tr><td colspan="5" style="color:var(--mut)">暂无指令</td></tr>'; return; }
    body.innerHTML = cmds.map(c => {
      const st = c.status || '';
      return `<tr>
        <td>${c.id}</td>
        <td><code>${esc(c.command)}</code></td>
        <td><span class="pill ${st}">${esc(st)}</span></td>
        <td>${c.executed_at ? esc(c.executed_at) : '<span style="color:var(--mut)">—</span>'}</td>
        <td>${renderResult(c)}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    body.innerHTML = '<tr><td colspan="5" style="color:var(--bad)">加载失败：' + esc(e.message) + '</td></tr>';
  }
}

document.getElementById('cmdType').addEventListener('change', renderPayload);
document.getElementById('sendBtn').addEventListener('click', sendCommand);
document.getElementById('refreshBtn').addEventListener('click', loadHistory);
renderPayload();
loadHistory();
setInterval(loadHistory, 4000);
</script>
</body>
</html>
