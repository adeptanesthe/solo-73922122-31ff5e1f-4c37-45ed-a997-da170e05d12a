/**
 * 端到端协议集成测试：在同一进程里用“模拟浏览器窗口”同时加载真实的
 * portal.js（门户）与真实的 binding-client.js（厂商文档），让两者通过
 * 模拟 postMessage 真实互通，验证文档绑定修复的端到端语义：
 *
 *  1. 正常：挑战→握手→申请→批准→结果只回发起文档
 *  2. 同源导航到新文档（窗口代理复用）：旧 pending 申请不可再批准、迟到日志不进新文档
 *  3. 新文档重放旧 nonce/旧 docId/无 nonce：全部被拒，旧申请不复活
 *  4. 慢加载：load 后新文档脚本尚未运行期间旧申请已作废，脚本就绪后凭新 nonce 正常绑定
 *  5. 重复握手 / 挑战丢失：正常文档仍能完成申请
 *
 * 运行：node tests/run_integration_tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORTAL_ORIGIN = 'http://localhost:8080';
const VENDOR_ORIGIN = 'http://localhost:8081';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`); }
}

// ---- 极简浏览器窗口模型 ----
// 每个 Window 持有 message 监听者集合与一个“出站目标”。
// iframe 场景：厂商文档的 window.parent 指向门户窗口；门户的 frame.contentWindow
// 是一个稳定的代理对象，同源导航时代理引用不变、但其 postMessage 改投递到新文档窗口。
function makeWindow(name, origin) {
  const listeners = new Set();
  const win = {
    name,
    origin,
    parent: null, // 默认顶层窗口 parent===self（构造后赋值）；iframe 文档改写为门户代理
    listeners,
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener() {},
    deliver(event) {
      for (const fn of [...listeners]) fn(event);
    },
    // 出站：经 route 函数投递，route 由 wire/navigate 配置。
    route: null,
    postMessage(message, targetOrigin) {
      if (!this.route) throw new Error(`${name}: no route target`);
      this.route(message, targetOrigin, win);
    },
  };
  win.parent = win;
  return win;
}

function makeEl(id) {
  const listeners = {};
  return {
    id,
    children: [],
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    src: 'about:blank',
    classList: { add() {}, remove() {} },
    style: {},
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    dispatch(t, ev) { for (const fn of listeners[t] || []) fn(ev); },
    append(...k) { this.children.push(...k); },
    prepend(k) { this.children.unshift(k); },
    querySelector() { return makeEl(`${id}-q`); },
    remove() {},
  };
}

function makeFrame() {
  const listeners = {};
  return {
    src: 'about:blank',
    dataset: {},
    contentWindow: null,
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    dispatch(t, ev) { for (const fn of listeners[t] || []) fn(ev); },
  };
}

// 加载真实 portal.js。
async function bootPortal() {
  const frame = makeFrame();
  const portalWin = makeWindow('portal', PORTAL_ORIGIN);
  const byId = new Map();
  const ids = ['portal-origin', 'vendor-origin', 'device-select', 'delay-input', 'vendor-frame',
    'frame-status', 'btn-reload', 'btn-load-rogue', 'btn-load-slow', 'btn-load-replay',
    'btn-open-probe', 'requests', 'event-log'];
  for (const id of ids) {
    const el = id === 'vendor-frame' ? frame : makeEl(id);
    byId.set(id, el);
  }
  byId.get('device-select').value = 'dev-gw-01';
  byId.get('delay-input').value = '0';

  const pendingApproves = [];
  const pendingLogs = [];
  let tokenSeq = 0;
  async function fakeFetch(url) {
    if (url.endsWith('/api/config')) {
      return { ok: true, json: async () => ({ role: 'portal', selfOrigin: PORTAL_ORIGIN, portalOrigin: PORTAL_ORIGIN, vendorOrigin: VENDOR_ORIGIN, rogueOrigin: 'http://localhost:8082' }) };
    }
    if (url.endsWith('/api/devices')) {
      return { ok: true, json: async () => ({ devices: [{ id: 'dev-gw-01', name: 'GW' }, { id: 'dev-pump-02', name: 'PUMP' }] }) };
    }
    if (url.endsWith('/api/approve')) {
      return new Promise((resolve) => pendingApproves.push({ resolve, token: `tok-${++tokenSeq}` }));
    }
    if (url.includes('/api/logs')) {
      return new Promise((resolve, reject) => pendingLogs.push({ url, resolve, reject }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  const intervals = [];
  const sandbox = {
    window: portalWin,
    document: { getElementById: (id) => byId.get(id), createElement: () => makeEl('x') },
    fetch: fakeFetch,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn) => { try { fn(); } catch { /* ignore */ } return 0; },
    clearTimeout: () => {},
    console,
    crypto: { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}` },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'portal', 'portal.js'), 'utf8'),
    sandbox, { filename: 'portal.js' },
  );
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));

  return {
    frame,
    portalWin,
    state: vm.runInContext('state', sandbox),
    sandbox,
    pendingApproves,
    pendingLogs,
    tickIntervals() { for (const fn of intervals) fn(); },
    approve: (id) => vm.runInContext(`approveRequest(${JSON.stringify(id)})`, sandbox),
  };
}

// 在厂商文档窗口里加载真实 binding-client.js（页面模型：自行注册 message 监听）。
function bootVendorClient(vendorWin, cfg) {
  const helloTimers = [];
  const sandbox = {
    window: vendorWin,
    // 用 getter 读取，确保 wire() 之后设置的 vendorWin.parent（iframe 代理）生效。
    get parent() { return vendorWin.parent; },
    console,
    crypto: { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}` },
    location: { href: `${VENDOR_ORIGIN}/doc`, search: '' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (fn) => { helloTimers.push(fn); return helloTimers.length; },
    clearInterval: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'vendor', 'binding-client.js'), 'utf8'),
    sandbox, { filename: 'binding-client.js' },
  );
  const binding = vm.runInContext(
    `window.createVendorBinding({ cfg: ${JSON.stringify(cfg)}, say: () => {} })`,
    sandbox,
  );
  // 与真实页面一致：文档脚本运行（start）时才注册 window message 监听；
  // 在此之前投递的挑战不会被处理，模拟“文档脚本尚未就绪”的真实时序。
  let registered = false;
  return {
    binding,
    start() {
      if (!registered) {
        vendorWin.addEventListener('message', (event) => binding.handleMessage(event));
        registered = true;
      }
      binding.start();
    },
    tickHello() { for (const fn of helloTimers) fn(); },
  };
}

// 建立 iframe 连线：返回稳定的 contentWindow 代理。
// 代理 postMessage 始终投递到“当前”厂商文档窗口；事件 source 用代理本身，
// 厂商文档的 window.parent 也指向该代理，满足 event.source === window.parent。
function wire(portal, vendorWin) {
  // 该代理同时承担两个方向：
  //  - 门户 -> iframe：targetOrigin=厂商源，投递到当前厂商文档
  //  - 厂商文档 -> window.parent：targetOrigin=门户源，投递回门户窗口
  const frameProxy = {
    postMessage(message, targetOrigin) {
      if (targetOrigin === VENDOR_ORIGIN) {
        portal._currentVendor.deliver({ data: message, origin: PORTAL_ORIGIN, source: frameProxy });
      } else if (targetOrigin === PORTAL_ORIGIN) {
        portal.portalWin.deliver({ data: message, origin: VENDOR_ORIGIN, source: frameProxy });
      } else {
        throw new Error(`unexpected targetOrigin ${targetOrigin}`);
      }
    },
  };
  vendorWin.parent = frameProxy;
  vendorWin.route = (message, targetOrigin, sender) => {
    if (targetOrigin !== PORTAL_ORIGIN) throw new Error('vendor sent wrong targetOrigin');
    portal.portalWin.deliver({ data: message, origin: VENDOR_ORIGIN, source: frameProxy });
  };
  portal._currentVendor = vendorWin;
  portal.frame.contentWindow = frameProxy;
  return frameProxy;
}

// 同源导航：contentWindow 代理不变，仅替换背后文档窗口（新 JS 上下文、新 parent 指向同一代理）。
function navigate(portal, newVendorWin) {
  newVendorWin.parent = portal.frame.contentWindow;
  newVendorWin.route = (message, targetOrigin) => {
    if (targetOrigin !== PORTAL_ORIGIN) throw new Error('vendor sent wrong targetOrigin');
    portal.portalWin.deliver({ data: message, origin: VENDOR_ORIGIN, source: portal.frame.contentWindow });
  };
  portal._currentVendor = newVendorWin;
  // contentWindow 代理引用保持不变
}

async function macro(times = 1) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

async function main() {
  console.log('[1] 正常流程：挑战→握手→申请→批准→结果只回发起文档');
  {
    const portal = await bootPortal();
    const vendorWin = makeWindow('vendor', VENDOR_ORIGIN);
    wire(portal, vendorWin);
    const client = bootVendorClient(vendorWin, { portalOrigin: PORTAL_ORIGIN });

    portal.frame.src = `${VENDOR_ORIGIN}/`;
    portal.frame.dispatch('load', {});
    // 此刻厂商文档脚本尚未启动（未调用 binding.start），先断言门户侧已换代且未确认
    check('load 即推进世代、绑定未确认', portal.state.epoch === 1 && portal.state.binding.confirmed === false);

    client.start();
    portal.tickIntervals(); // 文档监听就绪后，门户重发挑战（模拟 250ms 重发）
    await macro();
    check('厂商客户端收到 nonce 并完成握手', client.binding.isAcked() === true && portal.state.binding.confirmed === true);
    check('双方记录同一世代', client.binding.getEpoch() === portal.state.epoch);

    const reqId = client.binding.requestLog();
    check('门户建单 pending', portal.state.requests.get(reqId)?.status === 'pending');
    portal.approve(reqId);
    await macro();
    portal.pendingApproves.shift().resolve({ ok: true, json: async () => ({ token: 'tok-1' }) });
    await macro();
    portal.pendingLogs.shift().resolve({ ok: true, json: async () => ({ count: 20, entries: ['l1', 'l2'] }) });
    await macro();
    check('申请 delivered', portal.state.requests.get(reqId)?.status === 'delivered');
  }

  console.log('[2] 同源导航新文档（窗口代理复用）：旧申请不可批准、迟到日志不进新文档');
  {
    const portal = await bootPortal();
    const vendorWin = makeWindow('vendor', VENDOR_ORIGIN);
    const frameProxy = wire(portal, vendorWin);
    const oldClient = bootVendorClient(vendorWin, { portalOrigin: PORTAL_ORIGIN });

    portal.frame.src = `${VENDOR_ORIGIN}/`;
    portal.frame.dispatch('load', {});
    oldClient.start();
    portal.tickIntervals();
    await macro();
    const oldReqId = oldClient.binding.requestLog();
    const oldNonce = oldClient.binding.getNonce();

    portal.approve(oldReqId);
    await macro();
    portal.pendingApproves.shift().resolve({ ok: true, json: async () => ({ token: 'tok-z' }) });
    await macro();
    check('取数在途、状态 approved', portal.state.requests.get(oldReqId)?.status === 'approved');

    const newVendorWin = makeWindow('vendor-navigated', VENDOR_ORIGIN);
    navigate(portal, newVendorWin); // 代理 frameProxy 复用
    const newClient = bootVendorClient(newVendorWin, { portalOrigin: PORTAL_ORIGIN });
    const nonceBeforeStart = newClient.binding.getNonce();

    portal.frame.src = `${VENDOR_ORIGIN}/navigated.html`;
    portal.frame.dispatch('load', {});
    check('导航即推进世代、旧申请 invalidated',
      portal.state.epoch === 2 && portal.state.requests.get(oldReqId)?.status === 'invalidated');
    check('contentWindow 代理在导航后保持同一引用', portal.frame.contentWindow === frameProxy);
    check('新文档出生时拿不到旧 nonce（内存隔离）', nonceBeforeStart === '' && newClient.binding.getNonce() !== oldNonce);

    newClient.start();
    portal.tickIntervals();
    await macro();
    check('新文档凭新 nonce 完成握手', newClient.binding.isAcked() && newClient.binding.getNonce() !== oldNonce);

    portal.approve(oldReqId);
    check('旧申请无法再批准', portal.state.requests.get(oldReqId)?.status === 'invalidated');

    const deliveredToNew = [];
    newVendorWin.addEventListener('message', (ev) => { if (ev.data?.type === 'log:result') deliveredToNew.push(ev); });
    portal.pendingLogs.shift().resolve({ ok: true, json: async () => ({ count: 20, entries: ['stale'] }) });
    await macro();
    check('迟到日志未投递给新文档', deliveredToNew.length === 0);
  }

  console.log('[3] 新文档重放旧标识：旧/缺 nonce、复用旧 docId 全部被拒且不复活旧申请');
  {
    const portal = await bootPortal();
    const vendorWin = makeWindow('vendor', VENDOR_ORIGIN);
    wire(portal, vendorWin);
    const oldClient = bootVendorClient(vendorWin, { portalOrigin: PORTAL_ORIGIN });
    portal.frame.src = `${VENDOR_ORIGIN}/`;
    portal.frame.dispatch('load', {});
    oldClient.start();
    portal.tickIntervals();
    await macro();
    const oldReqId = oldClient.binding.requestLog();
    const oldNonce = oldClient.binding.getNonce();
    const oldDocId = oldClient.binding.docId;

    const newWin = makeWindow('vendor-replay', VENDOR_ORIGIN);
    navigate(portal, newWin);
    portal.frame.dispatch('load', {});
    const denies = [];
    newWin.addEventListener('message', (ev) => { if (ev.data?.type === 'log:denied') denies.push(ev.data); });

    function sendFromNewDoc(data) {
      portal.portalWin.deliver({ data, origin: VENDOR_ORIGIN, source: portal.frame.contentWindow });
    }

    // 攻击 1：重放旧握手（旧 nonce + 复用旧 docId）
    sendFromNewDoc({ type: 'vendor:hello', nonce: oldNonce, docId: oldDocId });
    check('旧 nonce+旧 docId 握手被拒、绑定未确认', portal.state.binding.confirmed === false);
    check('旧申请仍 invalidated 未复活', portal.state.requests.get(oldReqId)?.status === 'invalidated');

    // 攻击 2：无 nonce 握手
    sendFromNewDoc({ type: 'vendor:hello', docId: oldDocId });
    check('无 nonce 握手被拒', portal.state.binding.confirmed === false);

    // 攻击 3：旧 nonce 直接发申请
    const before = portal.state.requests.size;
    sendFromNewDoc({ type: 'log:request', requestId: 'attk', nonce: oldNonce, docId: oldDocId });
    check('旧 nonce 申请不建单', !portal.state.requests.has('attk') && portal.state.requests.size === before);
    check('三次攻击均收到拒绝且原因指向 nonce/绑定',
      denies.length >= 3 && denies.every((d) => /nonce|世代|绑定/.test(String(d.reason))));

    // 正常：新文档客户端收到门户重发的挑战后凭新 nonce 握手并成功申请
    const newClient = bootVendorClient(newWin, { portalOrigin: PORTAL_ORIGIN });
    newClient.start();
    portal.tickIntervals();
    await macro();
    newClient.tickHello();
    await macro();
    check('新文档凭当前 nonce 正常绑定', newClient.binding.isAcked() && portal.state.binding.confirmed);
    const freshId = newClient.binding.requestLog();
    check('新文档自己的新申请成功建单', portal.state.requests.get(freshId)?.status === 'pending');
  }

  console.log('[4] 慢加载：脚本就绪前旧申请已作废，就绪后凭新 nonce 绑定');
  {
    const portal = await bootPortal();
    const win = makeWindow('vendor', VENDOR_ORIGIN);
    wire(portal, win);
    const client0 = bootVendorClient(win, { portalOrigin: PORTAL_ORIGIN });
    portal.frame.src = `${VENDOR_ORIGIN}/`;
    portal.frame.dispatch('load', {});
    client0.start();
    portal.tickIntervals();
    await macro();
    const slowReq = client0.binding.requestLog();

    const slowWin = makeWindow('vendor-slow', VENDOR_ORIGIN);
    navigate(portal, slowWin); // 此刻新文档脚本尚未运行（未 boot 客户端）
    portal.frame.src = `${VENDOR_ORIGIN}/slow?delay=6`;
    portal.frame.dispatch('load', {});
    check('慢加载 load 时旧申请立即作废', portal.state.requests.get(slowReq)?.status === 'invalidated');
    portal.tickIntervals();
    portal.tickIntervals();
    check('加载期间世代稳定、不复活旧申请',
      portal.state.epoch === 2 && portal.state.requests.get(slowReq)?.status === 'invalidated');

    const slowClient = bootVendorClient(slowWin, { portalOrigin: PORTAL_ORIGIN });
    check('脚本就绪前客户端 nonce 为空', slowClient.binding.getNonce() === '' && slowClient.binding.isAcked() === false);
    slowClient.start();
    portal.tickIntervals(); // 门户重发挑战，新文档此刻才开始接收
    await macro();
    check('慢加载文档就绪后凭当前 nonce 绑定', slowClient.binding.isAcked() && slowClient.binding.getEpoch() === 2);
    const id = slowClient.binding.requestLog();
    check('慢加载文档可发起自己的新申请', portal.state.requests.get(id)?.status === 'pending');
  }

  console.log('[5] 挑战丢失与重复握手：正常文档仍完成申请');
  {
    const portal = await bootPortal();
    const win = makeWindow('vendor', VENDOR_ORIGIN);
    wire(portal, win);
    const client = bootVendorClient(win, { portalOrigin: PORTAL_ORIGIN });

    // 文档脚本先启动，但门户尚未 load、未发任何挑战
    client.start();
    check('挑战未达时客户端不握手', client.binding.isAcked() === false && client.binding.getNonce() === '');

    portal.frame.src = `${VENDOR_ORIGIN}/`;
    portal.frame.dispatch('load', {}); // 此刻才发首个挑战
    await macro();
    // 模拟首个挑战丢失：重置客户端 nonce（未收到），依靠门户重发
    check('load 后世代为 1', portal.state.epoch === 1);

    portal.tickIntervals(); // 门户重发挑战
    await macro();
    client.tickHello();
    await macro();
    check('挑战重发后完成握手', client.binding.isAcked());

    const epochBefore = portal.state.epoch;
    client.tickHello();
    client.tickHello();
    await macro();
    check('重复握手幂等、世代不变', portal.state.epoch === epochBefore && portal.state.binding.confirmed);
    const id = client.binding.requestLog();
    check('正常申请可建单', portal.state.requests.get(id)?.status === 'pending');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
