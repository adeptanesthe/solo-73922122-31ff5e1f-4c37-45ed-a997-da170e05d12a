'use strict';

// 跳转后的新文档：必须凭门户为新世代签发的新 nonce 重新握手；
// 旧文档的任何迟到消息都与本页无关（本页内存里根本不存在旧 nonce/旧 requestId）。

async function main() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const commLog = document.getElementById('comm-log');

  function say(msg, level = 'info') {
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    commLog.prepend(line);
  }

  document.getElementById('doc-id').textContent = '加载中…';
  const binding = window.createVendorBinding({ cfg, say });
  document.getElementById('doc-id').textContent = binding.docId;
  document.getElementById('nonce-value').textContent = '等待门户挑战…';

  window.addEventListener('message', (event) => {
    const out = binding.handleMessage(event);
    if (!out.handled) return;
    if (out.acked) {
      document.getElementById('nonce-value').textContent = binding.getNonce().slice(0, 16) + '…';
      document.getElementById('epoch-value').textContent = String(binding.getEpoch());
      say('门户已绑定本新文档；旧文档的迟到结果不会转发到这里。', 'ok');
    }
    if (out.state) say(`门户当前设备：${out.state.deviceId}，延迟 ${out.state.delay}s。`);
    if (out.result) say(`意外收到日志结果 requestId=${out.result.requestId}（正常流程下不应出现）。`, 'warn');
  });

  binding.start();
  say('新文档已加载，等待门户 nonce 挑战并重新握手。');

  document.getElementById('btn-back').addEventListener('click', () => {
    location.href = '/';
  });
}

main();
