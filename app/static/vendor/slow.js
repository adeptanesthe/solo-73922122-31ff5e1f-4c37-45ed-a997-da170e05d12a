'use strict';

// 可控慢加载新文档的脚本：文档字节到达、脚本执行后才实例化。
// 重点观察：本页从“出生”起就只持有门户为当前世代投递的新 nonce，
// 加载期间门户已作废旧申请；本页不会、也无法恢复任何旧申请或收到旧日志。

const cfg = { portalOrigin: '' };
const els = {};
['self-origin', 'portal-origin', 'doc-id', 'nonce-value', 'epoch-value', 'delay-arg',
  'comm-log', 'log-output', 'delay-input', 'btn-reload-slow', 'btn-request']
  .forEach((id) => { els[id] = document.getElementById(id); });

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

  const params = new URLSearchParams(location.search);
  const delay = params.get('delay') || '0';
  els['delay-arg'].textContent = delay;
  els['delay-input'].value = Math.max(1, Math.min(20, Number(delay) || 6));

  const binding = window.createVendorBinding({ cfg, say });
  els['doc-id'].textContent = binding.docId;
  say(`文档实例化完成（服务端已延迟 ${delay}s）。本页内存中不存在任何旧 nonce/旧申请。`, 'ok');

  window.addEventListener('message', (event) => {
    const out = binding.handleMessage(event);
    if (!out.handled) return;
    if (out.acked || out.state) {
      els['nonce-value'].textContent = binding.getNonce() ? binding.getNonce().slice(0, 16) + '…' : '—';
      els['epoch-value'].textContent = String(binding.getEpoch());
    }
    if (out.result) {
      const m = out.result;
      if (m.ok) {
        els['log-output'].textContent = m.data.entries.join('\n');
        say(`本页自己的新申请 ${m.requestId.slice(0, 8)} 收到 ${m.data.count} 条日志。`, 'ok');
      } else {
        els['log-output'].textContent = `取数失败：${m.error}`;
      }
    }
    if (out.denied) say(`门户拒绝：${out.denied.reason}`, 'error');
  });

  binding.start();

  els['btn-reload-slow'].addEventListener('click', () => {
    const v = Math.max(1, Math.min(20, Number(els['delay-input'].value) || 6));
    // 再次走服务端慢加载路由：又是一次全新文档 + 全新世代 + 全新 nonce。
    location.href = `/slow?delay=${v}`;
  });

  els['btn-request'].addEventListener('click', () => {
    binding.requestLog();
  });
}

main();
