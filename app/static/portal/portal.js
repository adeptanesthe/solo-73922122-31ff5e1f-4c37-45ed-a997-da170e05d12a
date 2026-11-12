'use strict';

// 门户主文档：所有安全决策都在这里完成。
// 厂商页面只能通过 postMessage 提申请，永远接触不到批准令牌。
//
// 文档绑定模型（修复“导航后新文档继承旧授权”缺陷）：
// - iframe 每次 load（初始加载、刷新、同源跳转、换源）都由【门户】推进文档世代 epoch，
//   作废该世代之前的全部在途申请，并签发一个全新的随机 nonce（门户侧挑战）。
// - 厂商文档无法自证身份：旧设计信任厂商页自报的 docId，新文档只要重放/复用旧 docId
//   就能让门户误以为“还是同一文档”，旧申请可继续批准、迟到日志会发给新窗口。
// - 新设计下，nonce 由门户在 load 后通过 postMessage 定向投递给“当前 iframe 窗口”，
//   旧文档在导航时已被浏览器销毁，不可能把 nonce 带给新文档。握手与申请都必须回传
//   与当前世代一致的 nonce；复用旧 docId、重放旧握手（携带旧 nonce 或不带 nonce）
//   一律拒绝，且不会恢复任何旧申请。docId 仅作为展示标签，不参与信任判定。

const els = {
  portalOrigin: document.getElementById('portal-origin'),
  vendorOrigin: document.getElementById('vendor-origin'),
  deviceSelect: document.getElementById('device-select'),
  delayInput: document.getElementById('delay-input'),
  frame: document.getElementById('vendor-frame'),
  frameStatus: document.getElementById('frame-status'),
  btnReload: document.getElementById('btn-reload'),
  btnLoadRogue: document.getElementById('btn-load-rogue'),
  btnLoadSlow: document.getElementById('btn-load-slow'),
  btnLoadReplay: document.getElementById('btn-load-replay'),
  btnOpenProbe: document.getElementById('btn-open-probe'),
  requests: document.getElementById('requests'),
  eventLog: document.getElementById('event-log'),
};

/** @type {{role:string,selfOrigin:string,portalOrigin:string,vendorOrigin:string,rogueOrigin:string}} */
const cfg = { role: '', selfOrigin: '', portalOrigin: '', vendorOrigin: '', rogueOrigin: '' };

const state = {
  devices: [],
  currentDeviceId: '',
  // 文档世代号：iframe 每次 load（加载/导航/刷新）+1；切换设备也 +1（同文档、新授权上下文）。
  epoch: 0,
  // 当前 iframe 文档绑定：
  //   { nonce, confirmed, docId, origin, sourceWindow, href }
  // nonce     —— 门户在每次 load 后签发的一次性文档挑战，信任的唯一依据
  // confirmed —— 是否已收到携带正确 nonce 的握手（未确认前不接受任何申请）
  // docId     —— 厂商自报标签，仅用于展示与排查，不参与授权判定
  binding: null,
  /** @type {Map<string, any>} */
  requests: new Map(),
};

const CHALLENGE_RETRY_MS = 250;
const NO_HANDSHAKE_WARN_MS = 2000;

const STATUS_TEXT = {
  pending: '等待批准',
  approving: '批准/取数中',
  approved: '已批准，取数中',
  delivered: '已交付厂商文档',
  denied: '已拒绝',
  failed: '取数失败',
  invalidated: '已失效（文档/设备换代）',
};

function shortId(id) {
  return String(id).slice(0, 8);
}

function nowText() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function mintNonce() {
  // 门户侧随机挑战：长度足够、不可预测，只投递给当前 iframe 窗口。
  const c = globalThis.crypto || window.crypto;
  if (c?.randomUUID) return `nonce-${c.randomUUID()}`;
  const arr = new Uint8Array(32);
  c.getRandomValues(arr);
  return `nonce-${Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function logEvent(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${nowText()}] ${message}`;
  els.eventLog.prepend(line);
  while (els.eventLog.children.length > 200) {
    els.eventLog.lastElementChild.remove();
  }
}

function invalidateRequests(reason, resetBinding) {
  // 推进世代：epoch 单调递增，旧世代的一切申请立即失效。
  // resetBinding=true（文档 load）：同时清空绑定，等待新文档凭新 nonce 重新握手。
  // resetBinding=false（切换设备）：保留当前文档绑定与 nonce，仅作废旧设备申请。
  state.epoch += 1;
  if (resetBinding) {
    state.binding = null;
    els.frameStatus.textContent = 'iframe 文档未绑定（等待新文档携带当前 nonce 握手）。';
  }
  let killed = 0;
  for (const req of state.requests.values()) {
    if (req.status === 'pending' || req.status === 'approving' || req.status === 'approved') {
      req.status = 'invalidated';
      killed += 1;
    }
  }
  renderRequests();
  logEvent(`${reason} 世代推进到 ${state.epoch}，${killed} 笔在途申请作废。`, 'warn');
}

// 进入新的文档世代：作废旧申请、签发新 nonce、向当前 iframe 窗口定向投递挑战。
function beginDocumentGeneration(reason) {
  invalidateRequests(reason, true);
  state.binding = {
    nonce: mintNonce(),
    confirmed: false,
    docId: '',
    origin: cfg.vendorOrigin,
    sourceWindow: els.frame.contentWindow,
    href: '',
  };
  sendChallenge();
  logEvent(`门户已为世代 ${state.epoch} 签发新 nonce 挑战并投递给当前 iframe 窗口。`, 'info');
}

function sendChallenge() {
  if (!state.binding || state.binding.confirmed) return;
  // targetOrigin 固定为厂商源：iframe 若被导航到其他源，浏览器不会把挑战交给该文档。
  state.binding.sourceWindow?.postMessage(
    { type: 'portal:challenge', nonce: state.binding.nonce, epoch: state.epoch },
    cfg.vendorOrigin,
  );
}

function isCurrentBinding(req) {
  // 授权/结果归属判定：必须同时满足
  //  1) 绑定已确认（新文档已凭当前 nonce 完成握手）
  //  2) 申请属于当前世代（load/切设备后旧世代申请一律不通过）
  //  3) 申请回传的 nonce 与当前绑定 nonce 一致（重放旧握手/复用旧 docId 不通过）
  //  4) 来源窗口与固定 origin 仍是当前 iframe（旁窗/换源不通过）
  return (
    state.binding !== null &&
    state.binding.confirmed === true &&
    req.epoch === state.epoch &&
    req.nonce === state.binding.nonce &&
    req.origin === state.binding.origin &&
    req.sourceWindow === state.binding.sourceWindow
  );
}

function postToBinding(message) {
  if (!state.binding) return;
  state.binding.sourceWindow.postMessage(message, state.binding.origin);
}

async function burnToken(token, deviceId) {
  // 文档换代导致令牌不再需要时，主动把一次性令牌用掉，避免遗留可用凭证。
  try {
    await fetch(`/api/logs?deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}&delay=0`);
  } catch {
    /* 忽略：销毁动作不影响主流程 */
  }
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;

  // 校验 1：固定 origin 白名单。同源旁窗（门户自己的源）也过不了这一关。
  if (event.origin !== cfg.vendorOrigin) {
    logEvent(
      `拒绝来自非白名单源的消息：origin=${event.origin}，类型=${data.type ?? '未知'}（固定 origin 校验失败）`,
      'error',
    );
    if (data.type === 'log:request' || data.type === 'vendor:hello') {
      event.source?.postMessage(
        { type: 'log:denied', requestId: data.requestId ?? null, reason: 'origin 不在门户白名单中' },
        event.origin,
      );
    }
    return;
  }

  // 校验 2：来源窗口必须是当前 iframe，而不是同源/同 origin 的其他窗口（旁窗、弹窗）。
  if (event.source !== els.frame.contentWindow) {
    logEvent(
      `拒绝冒充消息：origin 合法（${event.origin}），但来源窗口不是当前绑定的 iframe（疑似旁窗/弹窗冒充）。`,
      'error',
    );
    if (data.type === 'log:request' || data.type === 'vendor:hello') {
      event.source?.postMessage(
        { type: 'log:denied', requestId: data.requestId ?? null, reason: '来源窗口不是已绑定的厂商 iframe' },
        event.origin,
      );
    }
    return;
  }

  if (data.type === 'vendor:hello') {
    handleHello(event, data);
    return;
  }

  if (data.type === 'log:request') {
    handleRequest(event, data);
    return;
  }
});

function handleHello(event, data) {
  // 握手必须回传门户为【当前世代】签发的 nonce。
  // - 正常文档：load 后收到 portal:challenge，把其中 nonce 原样带回 → 确认绑定。
  // - 同一文档重复握手（hello 重发、hello/load 顺序不同）：nonce 仍匹配 → 幂等确认，不推进世代。
  // - 导航后的新文档复用旧 docId / 重放旧握手：携带的是旧 nonce（或没有 nonce），
  //   与当前绑定 nonce 不一致 → 拒绝，且不恢复任何旧申请。
  if (!state.binding) {
    logEvent('握手被拒：门户尚未进入任何文档世代（无有效 nonce 挑战）。', 'error');
    replyReject(event, data.requestId ?? null, '门户无当前文档世代，请等待 load 后的挑战');
    return;
  }
  const gotNonce = String(data.nonce ?? '');
  if (gotNonce !== state.binding.nonce) {
    logEvent(
      `握手重放被拒：文档 ${shortId(String(data.docId ?? ''))} 回传 nonce 与当前世代 ${state.epoch} 不匹配` +
        '（疑似导航后复用旧 docId / 重放旧握手）；旧申请保持作废，不恢复绑定。',
      'error',
    );
    replyReject(event, data.requestId ?? null, 'nonce 与当前文档世代不符（旧握手已失效，请使用当前挑战重新握手）');
    // 立刻补发一次当前挑战，帮助“消息丢失导致拿不到 nonce”的正常新文档尽快完成握手。
    sendChallenge();
    return;
  }

  const firstConfirm = !state.binding.confirmed;
  state.binding.confirmed = true;
  state.binding.docId = String(data.docId ?? '');
  state.binding.origin = event.origin;
  state.binding.sourceWindow = event.source;
  state.binding.href = String(data.href ?? '');
  els.frameStatus.textContent =
    `已绑定文档 ${shortId(state.binding.docId)}…（世代 ${state.epoch}，nonce 已校验），实际 iframe 来源：${event.origin} ${state.binding.href}`;
  logEvent(
    `厂商文档握手确认：docId=${shortId(state.binding.docId)}，origin=${event.origin}，世代=${state.epoch}，nonce 匹配。` +
      (firstConfirm ? '' : '（重复握手，幂等处理，世代不变）'),
    'ok',
  );
  postToBinding({ type: 'portal:hello-ack', portalOrigin: cfg.portalOrigin, epoch: state.epoch });
  postToBinding({
    type: 'state',
    deviceId: state.currentDeviceId,
    deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? '',
    delay: Number(els.delayInput.value) || 0,
  });
}

function handleRequest(event, data) {
  // 申请同样必须携带当前世代 nonce；未确认绑定或 nonce 不符一律不建单。
  if (
    !state.binding ||
    !state.binding.confirmed ||
    String(data.nonce ?? '') !== state.binding.nonce
  ) {
    logEvent(
      '拒绝申请：文档未完成 nonce 握手，或回传 nonce 与当前世代不符（旧文档/重放申请不得建单）。',
      'error',
    );
    replyReject(event, data.requestId ?? null, '文档未绑定或 nonce 不符（请先完成当前世代握手）');
    return;
  }
  const req = {
    requestId: String(data.requestId),
    docId: state.binding.docId,
    nonce: state.binding.nonce,
    origin: event.origin,
    sourceWindow: event.source,
    epoch: state.epoch,
    deviceId: state.currentDeviceId,
    deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? state.currentDeviceId,
    createdAt: nowText(),
    status: 'pending',
  };
  state.requests.set(req.requestId, req);
  logEvent(
    `收到日志申请 ${shortId(req.requestId)}：设备=${req.deviceId}，来源文档=${shortId(req.docId)}，` +
      `世代=${req.epoch}，等待人工批准。`,
  );
  renderRequests();
}

function replyReject(event, requestId, reason) {
  event.source?.postMessage({ type: 'log:denied', requestId, reason }, event.origin);
}

async function approveRequest(requestId) {
  const req = state.requests.get(requestId);
  if (!req || req.status !== 'pending' || !isCurrentBinding(req)) {
    logEvent('批准动作被拦截：申请不存在、已处理或已失效（每笔申请只能批准一次，且只属于发起它的原文档）。', 'warn');
    renderRequests();
    return;
  }
  req.status = 'approving';
  renderRequests();

  let token = null;
  try {
    const resp = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: req.deviceId }),
    });
    if (!resp.ok) throw new Error(`/api/approve -> HTTP ${resp.status}`);
    token = (await resp.json()).token;
  } catch (err) {
    req.status = 'failed';
    renderRequests();
    logEvent(`批准接口调用失败：${err.message}`, 'error');
    return;
  }

  // await 之后必须重新校验：等待期间刷新/导航/切换设备都会让世代推进或 nonce 更换。
  if (!isCurrentBinding(req)) {
    logEvent('批准令牌签发回来时文档/设备已换代，令牌不发给任何文档并立即作废。', 'warn');
    req.status = 'invalidated';
    renderRequests();
    await burnToken(token, req.deviceId);
    return;
  }

  req.status = 'approved';
  renderRequests();
  const delay = Number(els.delayInput.value) || 0;
  const url =
    `/api/logs?deviceId=${encodeURIComponent(req.deviceId)}` +
    `&token=${encodeURIComponent(token)}&delay=${encodeURIComponent(delay)}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`/api/logs -> HTTP ${resp.status}`);
    const payload = await resp.json();

    // 迟到结果判定：取数期间文档/设备一旦换代（epoch/nonce 变化），结果绝不能交给新文档。
    if (!isCurrentBinding(req)) {
      logEvent(
        `取数结果迟到：申请 ${shortId(requestId)} 对应的原文档已不存在（世代/nonce 已变），结果丢弃，新文档不会收到旧数据。`,
        'warn',
      );
      req.status = 'invalidated';
      renderRequests();
      return;
    }
    postToBinding({ type: 'log:result', requestId, ok: true, data: payload, epoch: req.epoch });
    req.status = 'delivered';
    logEvent(
      `申请 ${shortId(requestId)} 已交付：${payload.count} 条脱敏日志仅回传给发起申请的原文档 ${shortId(req.docId)}（世代 ${req.epoch}）。`,
      'ok',
    );
  } catch (err) {
    if (!isCurrentBinding(req)) {
      logEvent(`取数失败返回时文档已换代，错误信息同样丢弃：${err.message}`, 'warn');
      req.status = 'invalidated';
    } else {
      req.status = 'failed';
      postToBinding({ type: 'log:result', requestId, ok: false, error: err.message, epoch: req.epoch });
      logEvent(`取数失败：${err.message}`, 'error');
    }
  }
  renderRequests();
}

function denyRequest(requestId) {
  const req = state.requests.get(requestId);
  if (!req || req.status !== 'pending') return;
  req.status = 'denied';
  if (isCurrentBinding(req)) {
    postToBinding({ type: 'log:denied', requestId, reason: '值班员拒绝了本次申请' });
  }
  logEvent(`申请 ${shortId(requestId)} 已被人工拒绝。`, 'warn');
  renderRequests();
}

function renderRequests() {
  const list = [...state.requests.values()].reverse();
  if (list.length === 0) {
    els.requests.innerHTML = '<p class="hint">暂无申请。</p>';
    return;
  }
  els.requests.innerHTML = '';
  for (const req of list) {
    const card = document.createElement('div');
    card.className = `req-card req-${req.status}`;
    const actionable = req.status === 'pending' && isCurrentBinding(req);
    card.innerHTML = `
      <div class="req-head">
        <span>申请 ${shortId(req.requestId)}</span>
        <span class="req-status">${STATUS_TEXT[req.status] ?? req.status}</span>
      </div>
      <div class="req-meta">设备：${req.deviceName}（${req.deviceId}）</div>
      <div class="req-meta">来源：${req.origin} · 文档 ${shortId(req.docId)} · 世代 ${req.epoch} · nonce ${shortId(req.nonce)}</div>
      <div class="req-meta">发起时间：${req.createdAt}</div>
      <div class="req-actions"></div>`;
    if (actionable) {
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'primary';
      okBtn.textContent = '批准本次申请';
      okBtn.addEventListener('click', () => approveRequest(req.requestId));
      const noBtn = document.createElement('button');
      noBtn.type = 'button';
      noBtn.className = 'warn';
      noBtn.textContent = '拒绝';
      noBtn.addEventListener('click', () => denyRequest(req.requestId));
      card.querySelector('.req-actions').append(okBtn, noBtn);
    }
    els.requests.append(card);
  }
}

// ---- 控件行为 ----

els.frame.addEventListener('load', () => {
  // 刷新、同源跳转、换源（含跳到未获准站点）都会触发 load。
  // about:blank 的初始 load 忽略；其余一律由门户推进世代并签发新 nonce。
  // 这是文档生命周期的权威信号，不依赖厂商页是否/何时发握手。
  if (!els.frame.src || els.frame.src === 'about:blank') return;
  beginDocumentGeneration('iframe 发生加载/导航（权威 load 信号）：');
});

// 挑战重发：新文档脚本可能在挑战投递时尚未注册 message 监听，
// 周期性重发直到收到携带正确 nonce 的握手，覆盖 load/hello 的任意先后顺序。
setInterval(() => {
  if (state.binding && !state.binding.confirmed) {
    sendChallenge();
  }
}, CHALLENGE_RETRY_MS);

// 兜底告警：长时间未完成握手（典型为导航到不发握手的未获准站点/非诊断页）。
// 旧世代在 load 当时即已作废，这里只做提示，不改变安全状态。
setInterval(() => {
  if (state.binding && !state.binding.confirmed) {
    logEvent(
      `iframe 新文档已 ${NO_HANDSHAKE_WARN_MS}ms 未凭当前 nonce 完成握手（可能为未获准站点/非诊断页）；旧申请保持作废。`,
      'warn',
    );
  }
}, NO_HANDSHAKE_WARN_MS);

els.deviceSelect.addEventListener('change', () => {
  // 切换设备：同一文档继续存在（nonce 不变），但旧设备在途申请一律失效
  //（迟到结果不得交给新设备上下文）。
  invalidateRequests('切换设备：', false);
  state.currentDeviceId = els.deviceSelect.value;
  logEvent(`当前设备切换为 ${state.currentDeviceId}。`);
  if (state.binding && state.binding.confirmed) {
    postToBinding({
      type: 'state',
      deviceId: state.currentDeviceId,
      deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? '',
      delay: Number(els.delayInput.value) || 0,
    });
  }
});

els.delayInput.addEventListener('change', () => {
  const v = Math.max(0, Math.min(30, Number(els.delayInput.value) || 0));
  els.delayInput.value = v;
  if (state.binding && state.binding.confirmed) {
    postToBinding({
      type: 'state',
      deviceId: state.currentDeviceId,
      deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? '',
      delay: v,
    });
  }
});

els.btnReload.addEventListener('click', () => {
  // 重新赋值 src 触发全新文档加载，load 事件负责推进世代并签发新 nonce。
  els.frame.src = `${cfg.vendorOrigin}/`;
});

els.btnLoadRogue.addEventListener('click', () => {
  els.frame.src = els.frame.dataset.rogueOrigin || 'http://localhost:8082/';
});

els.btnLoadSlow.addEventListener('click', () => {
  // 同源慢加载新文档：load 在文档字节到达后才触发，触发即推进世代并签发新 nonce。
  els.frame.src = `${cfg.vendorOrigin}/slow?delay=6`;
});

els.btnLoadReplay.addEventListener('click', () => {
  // 旧标识重放演示页：在新文档里重放旧 docId/旧握手，验证 nonce 校验拒绝。
  els.frame.src = `${cfg.vendorOrigin}/replay.html`;
});

els.btnOpenProbe.addEventListener('click', () => {
  // 与门户同源的旁窗：origin 合法但不是 iframe，来源窗口校验会拒绝它。
  window.open('/probe.html', 'portal-probe', 'width=560,height=520');
});

// ---- 初始化 ----

async function init() {
  Object.assign(cfg, await fetch('/api/config').then((r) => r.json()));
  els.portalOrigin.textContent = cfg.selfOrigin;
  els.vendorOrigin.textContent = cfg.vendorOrigin;
  els.frame.dataset.rogueOrigin = cfg.rogueOrigin;

  const resp = await fetch('/api/devices');
  state.devices = (await resp.json()).devices;
  for (const d of state.devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name}（${d.id}）`;
    els.deviceSelect.append(opt);
  }
  state.currentDeviceId = state.devices[0]?.id ?? '';

  logEvent(`门户就绪，固定厂商白名单 origin：${cfg.vendorOrigin}；文档信任基于门户签发的 per-generation nonce。`);
  els.frame.src = `${cfg.vendorOrigin}/`;
}

init().catch((err) => logEvent(`初始化失败：${err.message}`, 'error'));
