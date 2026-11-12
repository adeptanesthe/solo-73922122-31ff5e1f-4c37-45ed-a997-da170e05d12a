'use strict';

// 厂商侧文档绑定客户端（各厂商页面共享）。
//
// 协议（与门户 portal.js 对应）：
//   门户 load 后 → postMessage { type:'portal:challenge', nonce, epoch }（固定 targetOrigin 重发）
//   本文档     → 回发  { type:'vendor:hello', nonce, docId, href }
//   门户校验 nonce==当前世代 nonce → 回 { type:'portal:hello-ack', epoch }
//   本文档申请 → { type:'log:request', requestId, docId, nonce }
//
// 安全要点：
// - nonce 不是本页生成的，而是门户为“当前 iframe 文档”定向投递的；每次导航/刷新都是新文档，
//   门户会推进世代并换发新 nonce，旧文档随导航销毁，无法把旧 nonce 交给新文档。
// - 本页不持久化 nonce（不写 sessionStorage/localStorage），从机制上杜绝“新文档继承旧标识”。
// - docId 只是每次加载随机生成的展示标签，授权与结果的归属由门户按 nonce+世代+窗口判定。
// - 所有外发消息固定 targetOrigin=门户源，所有接收消息校验 origin 与 source=window.parent。

window.createVendorBinding = function createVendorBinding(options = {}) {
  const say = options.say || (() => {});
  const cfg = options.cfg || { portalOrigin: '' };
  const docId = `vendor-doc-${crypto.randomUUID()}`;

  // 每个【文档实例】独立的内存态：导航后整个 JS 上下文重建，天然清零，无法继承。
  let currentNonce = '';
  let currentEpoch = 0;
  let acked = false;
  let helloTimer = null;
  const pending = new Map(); // requestId -> 超时计时器

  function embedded() {
    try {
      return window.parent !== window;
    } catch {
      return false;
    }
  }

  function sendToPortal(message) {
    // 显式指定 targetOrigin，防止父窗口被导航到其他源后数据外泄。
    window.parent.postMessage(message, cfg.portalOrigin);
  }

  function sendHello() {
    if (acked) {
      if (helloTimer) {
        clearInterval(helloTimer);
        helloTimer = null;
      }
      return;
    }
    if (!currentNonce) return; // 还没收到门户挑战，无法带 nonce，等待挑战即可
    sendToPortal({ type: 'vendor:hello', nonce: currentNonce, docId, href: location.href });
  }

  function start() {
    if (!embedded()) {
      say('未检测到父窗口，postMessage 申请通道不可用。', 'warn');
      return;
    }
    // 收到挑战后周期性重发握手，直到 hello-ack；消除 load/hello/监听注册的时序竞争。
    helloTimer = setInterval(sendHello, 150);
    say('已就绪，等待门户投递当前文档世代的 nonce 挑战…');
  }

  function handleMessage(event) {
    if (event.origin !== cfg.portalOrigin) {
      say(`忽略来源 ${event.origin} 的消息（非门户源）。`, 'warn');
      return { handled: false };
    }
    if (event.source !== window.parent) {
      say('忽略非父窗口消息（可能是同 origin 旁窗冒充门户）。', 'warn');
      return { handled: false };
    }
    const msg = event.data;
    if (typeof msg !== 'object' || msg === null) return { handled: false };

    if (msg.type === 'portal:challenge') {
      // 门户为当前世代签发的挑战。只接受“更新的/相同的”nonce；
      // 若收到更旧世代的挑战（理论上不会发生），忽略以免降级。
      if (msg.epoch < currentEpoch) {
        say(`忽略过期挑战（世代 ${msg.epoch} < 当前 ${currentEpoch}）。`, 'warn');
        return { handled: true };
      }
      currentNonce = String(msg.nonce);
      currentEpoch = Number(msg.epoch) || 0;
      acked = false;
      say(`收到门户挑战：世代 ${currentEpoch}，nonce=${currentNonce.slice(0, 12)}…，立即回送握手。`, 'info');
      sendHello();
      return { handled: true };
    }

    if (msg.type === 'portal:hello-ack') {
      if (!currentNonce) return { handled: true };
      acked = true;
      if (helloTimer) {
        clearInterval(helloTimer);
        helloTimer = null;
      }
      say(`门户确认绑定（世代 ${msg.epoch ?? currentEpoch}，nonce 已校验），可以发起申请。`, 'ok');
      return { handled: true, acked: true };
    }

    if (msg.type === 'state') {
      return { handled: true, state: msg };
    }

    if (msg.type === 'log:result') {
      // 纵深防御：本文档 pending 表没有的 requestId（旧文档的迟到结果）直接丢弃。
      if (!pending.has(msg.requestId)) {
        say(`丢弃未知申请 ${String(msg.requestId).slice(0, 8)} 的迟到结果（不属于本文档）。`, 'warn');
        return { handled: true, dropped: true };
      }
      clearTimeout(pending.get(msg.requestId));
      pending.delete(msg.requestId);
      return { handled: true, result: msg };
    }

    if (msg.type === 'log:denied') {
      if (msg.requestId && pending.has(msg.requestId)) {
        clearTimeout(pending.get(msg.requestId));
        pending.delete(msg.requestId);
      }
      return { handled: true, denied: msg };
    }

    return { handled: false };
  }

  function requestLog() {
    if (!embedded()) {
      say('未嵌入门户，无法申请。', 'error');
      return null;
    }
    if (!acked || !currentNonce) {
      say('尚未完成当前世代 nonce 握手，不能发起申请。', 'error');
      return null;
    }
    const requestId = crypto.randomUUID();
    sendToPortal({ type: 'log:request', requestId, docId, nonce: currentNonce });
    const timer = setTimeout(() => {
      pending.delete(requestId);
      say(`申请 ${requestId.slice(0, 8)} 长时间无回应（可能文档已换代，申请在门户侧作废）。`, 'warn');
    }, 40000);
    pending.set(requestId, timer);
    say(`已发出日志申请 ${requestId.slice(0, 8)}（世代 ${currentEpoch}，携带当前 nonce），等待逐次人工批准。`);
    return requestId;
  }

  return {
    docId,
    start,
    handleMessage,
    requestLog,
    isAcked: () => acked,
    getNonce: () => currentNonce,
    getEpoch: () => currentEpoch,
  };
};
