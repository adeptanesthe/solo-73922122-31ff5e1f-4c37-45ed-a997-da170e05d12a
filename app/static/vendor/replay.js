'use strict';

// 旧标识重放攻击演示（运行在导航后的“新文档”里）。
// - 攻击按钮：手工构造携带【旧 docId / 旧 nonce / 无 nonce】的握手与申请，
//   门户必须以 nonce 不符拒绝，且不恢复任何旧申请、不投递任何旧日志。
// - 正常按钮：用门户为当前世代签发的新 nonce 走标准握手，证明导航后的新文档仍可正常完成新申请。

const cfg = { portalOrigin: '' };
const els = {};
['self-origin', 'portal-origin', 'doc-id', 'good-nonce', 'epoch-value', 'old-docid', 'old-nonce',
  'comm-log', 'log-output', 'btn-replay-hello-nonce', 'btn-replay-hello-nononce',
  'btn-replay-request', 'btn-legit-request'].forEach((id) => { els[id] = document.getElementById(id); });

function say(msg, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  els['comm-log'].prepend(line);
}

async function main() {
  Object.assign(cfg, await fetch('/api/config').then((r) => r.json()));
  els['self-origin'].textContent = cfg.selfOrigin;
  els['portal-origin'].textContent = cfg.portalOrigin;

  // 正常通道：仅用于接收门户挑战、完成合法新握手与新申请。
  const binding = window.createVendorBinding({ cfg, say });
  els['doc-id'].textContent = binding.docId;

  window.addEventListener('message', (event) => {
    // 先让标准客户端处理（更新当前 nonce/epoch、处理合法结果）。
    const out = binding.handleMessage(event);
    if (out.handled && (out.acked || out.state)) {
      els['good-nonce'].textContent = binding.getNonce() ? binding.getNonce().slice(0, 20) + '…' : '尚未收到挑战';
      els['epoch-value'].textContent = String(binding.getEpoch());
    }
    if (out.result) {
      const m = out.result;
      if (m.ok) {
        els['log-output'].textContent = m.data.entries.join('\n');
        say(`✅ 合法新申请 ${m.requestId.slice(0, 8)} 收到 ${m.data.count} 条日志（属于本新文档）。`, 'ok');
      } else {
        els['log-output'].textContent = `取数失败：${m.error}`;
      }
    }
    if (out.denied) {
      say(`🛑 门户拒绝（符合预期）：${out.denied.reason}`, 'error');
    }
  });
  binding.start();

  function postRaw(message) {
    // 攻击消息固定发往门户，模拟新文档里的恶意/被污染脚本重放旧标识。
    window.parent.postMessage(message, cfg.portalOrigin);
    say(`→ 已发送攻击消息：${JSON.stringify(message).slice(0, 120)}`, 'warn');
  }

  els['btn-replay-hello-nonce'].addEventListener('click', () => {
    // 复用旧 docId + 重放旧 nonce 的握手：门户当前世代 nonce 已更换，必须拒绝。
    postRaw({
      type: 'vendor:hello',
      nonce: els['old-nonce'].value,
      docId: els['old-docid'].value,
      href: location.href,
    });
  });

  els['btn-replay-hello-nononce'].addEventListener('click', () => {
    // 只带旧 docId、不带任何 nonce 的握手：同样必须拒绝。
    postRaw({ type: 'vendor:hello', docId: els['old-docid'].value, href: location.href });
  });

  els['btn-replay-request'].addEventListener('click', () => {
    // 绕过握手，直接用旧 nonce + 旧 docId 发申请：不得建单。
    postRaw({
      type: 'log:request',
      requestId: crypto.randomUUID(),
      docId: els['old-docid'].value,
      nonce: els['old-nonce'].value,
    });
  });

  els['btn-legit-request'].addEventListener('click', () => {
    // 对照：用门户当前世代的新 nonce 走标准流程（binding 内部会先确认已 ack 再发）。
    const id = binding.requestLog();
    if (id === null) {
      say('尚未完成合法握手：请确认本页已收到门户挑战并自动握手（见上方新 nonce）。', 'warn');
    }
  });
}

main();
