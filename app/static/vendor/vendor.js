'use strict';

// 获准厂商诊断页。
// 边界：本页不知道、也拿不到门户的批准令牌；只能向父窗口发 postMessage 申请。
// 文档绑定通过门户签发的 per-generation nonce 完成（见 binding-client.js）：
// 每次加载/导航都是全新文档，必须重新握手；复用旧 docId、重放旧握手都过不了 nonce 校验。

const cfg = { role: '', selfOrigin: '', portalOrigin: '', vendorOrigin: '' };

const els = {
  selfOrigin: document.getElementById('self-origin'),
  portalOrigin: document.getElementById('portal-origin'),
  bindStatus: document.getElementById('bind-status'),
  deviceName: document.getElementById('device-name'),
  delayValue: document.getElementById('delay-value'),
  docId: document.getElementById('doc-id'),
  nonceValue: document.getElementById('nonce-value'),
  epochValue: document.getElementById('epoch-value'),
  commLog: document.getElementById('comm-log'),
  logOutput: document.getElementById('log-output'),
  btnRequest: document.getElementById('btn-request'),
  btnDirectFetch: document.getElementById('btn-direct-fetch'),
  btnOpenProbe: document.getElementById('btn-open-probe'),
  btnNavigate: document.getElementById('btn-navigate'),
  btnReplay: document.getElementById('btn-replay'),
  btnSlow: document.getElementById('btn-slow'),
};

function say(msg, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  els.commLog.prepend(line);
}

async function main() {
  Object.assign(cfg, await fetch('/api/config').then((r) => r.json()));
  els.selfOrigin.textContent = cfg.selfOrigin;
  els.portalOrigin.textContent = cfg.portalOrigin;

  const binding = window.createVendorBinding({ cfg, say });
  els.docId.textContent = binding.docId;

  window.addEventListener('message', (event) => {
    const out = binding.handleMessage(event);
    if (!out.handled) return;
    if (out.acked) {
      els.bindStatus.textContent = '已与门户完成文档绑定（nonce 校验通过），可以发起申请。';
      els.nonceValue.textContent = binding.getNonce().slice(0, 16) + '…';
      els.epochValue.textContent = String(binding.getEpoch());
    }
    if (out.state) {
      els.deviceName.textContent = `${out.state.deviceName}（${out.state.deviceId}）`;
      els.delayValue.textContent = String(out.state.delay);
      els.epochValue.textContent = String(binding.getEpoch());
    }
    if (out.result) {
      const msg = out.result;
      if (msg.ok) {
        els.logOutput.textContent = msg.data.entries.map((line) => line).join('\n');
        say(`申请 ${msg.requestId.slice(0, 8)} 成功：收到 ${msg.data.count} 条脱敏日志。`, 'ok');
      } else {
        els.logOutput.textContent = `取数失败：${msg.error}`;
        say(`申请 ${msg.requestId.slice(0, 8)} 失败：${msg.error}`, 'error');
      }
    }
    if (out.denied) {
      say(`申请 ${out.denied.requestId ? out.denied.requestId.slice(0, 8) : ''} 被门户拒绝：${out.denied.reason}`, 'error');
    }
  });

  binding.start();
  if (!binding.isAcked()) {
    els.bindStatus.textContent = '等待门户 nonce 挑战与绑定确认…';
  }

  els.btnRequest.addEventListener('click', () => {
    binding.requestLog();
  });

  els.btnDirectFetch.addEventListener('click', async () => {
    // 演示厂商无法绕过门户：既没有一次性令牌，跨源请求也没有 CORS 许可。
    const attempts = [
      `${cfg.portalOrigin}/api/logs?deviceId=dev-gw-01&token=guessed-token&delay=0`,
      `${cfg.portalOrigin}/api/approve`,
      `${cfg.portalOrigin}/api/devices`,
    ];
    for (const url of attempts) {
      try {
        const resp = await fetch(url, {
          method: url.includes('/approve') ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: url.includes('/approve') ? JSON.stringify({ deviceId: 'dev-gw-01' }) : undefined,
        });
        say(`直连 ${url} -> HTTP ${resp.status}（未获得数据）`, 'warn');
      } catch (err) {
        say(`直连 ${url} 被浏览器拦截：${err.message}`, 'error');
      }
    }
  });

  els.btnOpenProbe.addEventListener('click', () => {
    window.open('/probe.html', 'vendor-probe', 'width=560,height=520');
  });

  els.btnNavigate.addEventListener('click', () => {
    // 同源跳转到新文档：浏览器销毁当前文档与全部内存态（含 nonce），
    // 门户 load 事件推进世代、作废旧申请；新文档须凭新 nonce 重新握手。
    location.href = '/navigated.html';
  });

  els.btnReplay.addEventListener('click', () => {
    // 旧标识重放演示页：在“新文档”里手工重放旧 docId/旧握手，验证门户拒绝。
    location.href = '/replay.html';
  });

  els.btnSlow.addEventListener('click', () => {
    // 可控慢加载新文档：服务端延迟吐出页面，观察加载期间旧申请已作废、新文档实收消息。
    location.href = '/slow.html?delay=6';
  });
}

main();
