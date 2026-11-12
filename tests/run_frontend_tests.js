/**
 * 门户前端状态机测试：用最小 DOM/窗口桩在 vm 中运行真实的 portal.js，
 * 验证文档绑定（per-generation nonce）、固定 origin、来源窗口、世代失效、
 * 旧标识重放拒绝与迟到结果丢弃等安全语义。
 *
 * 运行：node tests/run_frontend_tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORTAL_ORIGIN = 'http://localhost:8080';
const VENDOR_ORIGIN = 'http://localhost:8081';
const ROGUE_ORIGIN = 'http://localhost:8082';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

function makeEl(id) {
  const listeners = {};
  const el = {
    id,
    children: [],
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    src: 'about:blank',
    classList: { add() {}, remove() {} },
    style: {},
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    },
    append(...kids) {
      for (const k of kids) this.children.push(k);
    },
    prepend(kid) {
      this.children.unshift(kid);
    },
    querySelector() {
      return makeEl(`${id}-q`);
    },
    remove() {},
  };
  return el;
}

function makeWindow() {
  const listeners = {};
  const posted = [];
  return {
    listeners,
    posted,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
    dispatchMessage(event) {
      for (const fn of listeners.message || []) fn(event);
    },
    open() {},
  };
}

function makeFrame() {
  const listeners = {};
  const frame = {
    src: 'about:blank',
    dataset: {},
    contentWindow: {},
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    },
  };
  return frame;
}

/** 构造一个完整沙箱并加载真实 portal.js；返回操控句柄。 */
async function boot() {
  const frame = makeFrame();
  const win = makeWindow();
  const els = {};
  const byId = new Map();
  for (const id of [
    'portal-origin', 'vendor-origin', 'device-select', 'delay-input', 'vendor-frame',
    'frame-status', 'btn-reload', 'btn-load-rogue', 'btn-load-slow', 'btn-load-replay',
    'btn-open-probe', 'requests', 'event-log',
  ]) {
    const el = id === 'vendor-frame' ? frame : makeEl(id);
    els[id] = el;
    byId.set(id, el);
  }
  els['device-select'].value = 'dev-gw-01';
  els['delay-input'].value = '0';

  const fetchLog = [];
  const pendingApproves = [];
  const pendingLogs = [];
  let tokenSeq = 0;
  let nonceSeq = 0;

  async function fakeFetch(url, opts) {
    fetchLog.push({ url, opts });
    if (url.endsWith('/api/config')) {
      return {
        ok: true,
        json: async () => ({
          role: 'portal', selfOrigin: PORTAL_ORIGIN,
          portalOrigin: PORTAL_ORIGIN, vendorOrigin: VENDOR_ORIGIN,
          rogueOrigin: ROGUE_ORIGIN,
        }),
      };
    }
    if (url.endsWith('/api/devices')) {
      return {
        ok: true,
        json: async () => ({
          devices: [
            { id: 'dev-gw-01', name: '网关 GW-01', model: 'X100' },
            { id: 'dev-pump-02', name: '泵房 PUMP-02', model: 'P2000' },
          ],
        }),
      };
    }
    if (url.endsWith('/api/approve')) {
      return new Promise((resolve) => {
        pendingApproves.push({ resolve, token: `tok-${++tokenSeq}` });
      });
    }
    if (url.includes('/api/logs')) {
      return new Promise((resolve, reject) => {
        pendingLogs.push({ url, resolve, reject });
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  const sandbox = {
    window: win,
    document: {
      getElementById: (id) => byId.get(id),
      createElement: () => makeEl('created'),
    },
    fetch: fakeFetch,
    setInterval: () => 0, // 关闭挑战重发/兜底定时器，由测试显式控制节奏
    clearInterval: () => {},
    setTimeout: (fn) => {
      try { fn(); } catch { /* 40s 提示类计时器不影响状态机 */ }
      return 0;
    },
    clearTimeout: () => {},
    console,
    crypto: {
      randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}`,
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (nonceSeq += 1) % 256;
        return arr;
      },
    },  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const code = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'static', 'portal', 'portal.js'),
    'utf8',
  );
  vm.runInContext(code, sandbox, { filename: 'portal.js' });

  // init() 内含多层 await（config→json→devices→json），用若干个 macrotask
  // 周期确保全部微任务链排空。
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }

  const state = vm.runInContext('state', sandbox);

  // 模拟一次 iframe 文档加载：门户推进世代、签发新 nonce、投递挑战。
  // 返回该世代的 nonce（从挑战消息里取），供后续握手/申请使用。
  function load(sourceWindow) {
    frame.contentWindow = sourceWindow;
    frame.src = `${VENDOR_ORIGIN}/some-doc`;
    frame.dispatch('load', {});
    const challenge = sourceWindow.posted
      .filter((p) => p.message.type === 'portal:challenge')
      .map((p) => p.message)
      .pop();
    return challenge;
  }

  function hello(sourceWindow, origin, nonce, docId, href = '/') {
    win.dispatchMessage({
      origin,
      source: sourceWindow,
      data: { type: 'vendor:hello', nonce, docId, href },
    });
  }

  function request(sourceWindow, origin, nonce, docId, requestId) {
    win.dispatchMessage({
      origin,
      source: sourceWindow,
      data: { type: 'log:request', requestId, nonce, docId },
    });
  }

  // 完成一次“加载→挑战→握手确认”的标准绑定，返回 { sourceWindow, nonce, docId }。
  function establish(docId = 'doc-1', sourceWindow = makeSource()) {
    const challenge = load(sourceWindow);
    hello(sourceWindow, VENDOR_ORIGIN, challenge.nonce, docId);
    return { sourceWindow, nonce: challenge.nonce, docId, epoch: challenge.epoch };
  }

  return {
    sandbox, state, win, frame, els,
    fetchLog, pendingApproves, pendingLogs, load, hello, request, establish,
    flush: () => new Promise((r) => setImmediate(r)),
    sendChallenge: () => vm.runInContext('sendChallenge()', sandbox),
  };
}

function makeSource() {
  const posted = [];
  return { posted, postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); } };
}

async function main() {
  console.log('[A] 固定 origin 与来源窗口校验');
  {
    const h = await boot();
    const frameWin = makeSource();
    const bound = h.establish('doc-1', frameWin);
    check('合法厂商文档凭 nonce 完成绑定', h.state.binding?.confirmed === true && h.state.epoch === 1);
    check('门户已投递挑战且 targetOrigin 固定',
      frameWin.posted.some((p) => p.message.type === 'portal:challenge' && p.targetOrigin === VENDOR_ORIGIN));

    // A1 未获准 origin
    const rogueSource = makeSource();
    h.request(rogueSource, ROGUE_ORIGIN, 'nonce-evil', 'doc-evil', 'req-rogue');
    check('未获准 origin 的申请被拒（不建申请单）', h.state.requests.size === 0);
    check('拒绝原因指向白名单', rogueSource.posted.some((p) => p.message.reason?.includes('白名单')));

    // A2 同源旁窗（portal origin）——先死在 origin 白名单
    const portalSource = makeSource();
    h.request(portalSource, PORTAL_ORIGIN, bound.nonce, 'doc-portal', 'req-portal');
    check('门户同源旁窗被 origin 白名单拒绝', h.state.requests.size === 0);

    // A3 同厂商 origin 但来源窗口不是 iframe
    const sideSource = makeSource();
    h.request(sideSource, VENDOR_ORIGIN, bound.nonce, 'doc-1', 'req-sidewin');
    check('同 origin 旁窗被来源窗口校验拒绝', h.state.requests.size === 0);
    check('拒绝原因指向来源窗口', sideSource.posted.some((p) => p.message.reason?.includes('来源窗口')));

    // A4 iframe 窗口但 nonce 错误（即使 docId 正确也拒绝）
    h.request(frameWin, VENDOR_ORIGIN, 'nonce-wrong', 'doc-1', 'req-badnonce');
    check('nonce 不符的申请被拒（不建单）', !h.state.requests.has('req-badnonce'));

    // A5 合法申请建单
    h.request(frameWin, VENDOR_ORIGIN, bound.nonce, 'doc-1', 'req-ok');
    const reqOk = h.state.requests.get('req-ok');
    check('合法申请进入队列且为 pending', reqOk?.status === 'pending');
    check('申请记录绑定当前 nonce 与世代', reqOk.nonce === bound.nonce && reqOk.epoch === 1);
  }

  console.log('[B] 批准-取数-只回传发起文档，且仅一次');
  {
    const h = await boot();
    const frameWin = makeSource();
    const bound = h.establish('doc-1', frameWin);
    h.request(frameWin, VENDOR_ORIGIN, bound.nonce, 'doc-1', 'req-1');

    const req = h.state.requests.get('req-1');
    vm.runInContext('approveRequest("req-1")', h.sandbox);
    await h.flush();
    check('批准后调用 /api/approve', h.pendingApproves.length === 1);

    h.pendingApproves.shift().resolve({ ok: true, json: async () => ({ token: 'tok-real' }) });
    await h.flush();
    check('拿到令牌后调用 /api/logs', h.pendingLogs.length === 1);
    check('取数 URL 带一次性令牌与设备', h.pendingLogs[0].url.includes('token=tok-real') &&
      h.pendingLogs[0].url.includes('deviceId=dev-gw-01'));

    h.pendingLogs.shift().resolve({
      ok: true,
      json: async () => ({ deviceId: 'dev-gw-01', count: 20, entries: ['line1', 'line2'] }),
    });
    await h.flush();
    check('申请状态变为 delivered', req.status === 'delivered');
    const delivery = frameWin.posted.find((p) => p.message.type === 'log:result' && p.message.ok);
    check('结果只 postMessage 给绑定窗口且 targetOrigin 固定',
      Boolean(delivery) && delivery.targetOrigin === VENDOR_ORIGIN);
    check('回传 20 条结果', delivery.message.data.count === 20);

    const before = h.state.epoch;
    vm.runInContext('approveRequest("req-1")', h.sandbox);
    check('重复批准被拦截、世代不变', h.state.epoch === before);
  }

  console.log('[C] 取数期间刷新/导航：迟到结果不得交给新文档');
  {
    const h = await boot();
    const frameWin = makeSource();
    const bound = h.establish('doc-old', frameWin);
    h.request(frameWin, VENDOR_ORIGIN, bound.nonce, 'doc-old', 'req-late');
    const oldReq = h.state.requests.get('req-late');

    vm.runInContext('approveRequest("req-late")', h.sandbox);
    await h.flush();
    h.pendingApproves.shift().resolve({ ok: true, json: async () => ({ token: 'tok-x' }) });
    await h.flush();
    check('取数在途', h.pendingLogs.length === 1 && oldReq.status === 'approved');

    // iframe 重新加载：load 即推进世代并签发新 nonce，旧申请作废（不依赖新文档是否握手）
    const frameWin2 = makeSource();
    const challenge2 = h.load(frameWin2);
    check('load 后世代立即推进到 2、旧申请作废', h.state.epoch === 2 && oldReq.status === 'invalidated');
    check('load 后绑定处于未确认且持有新 nonce',
      h.state.binding.confirmed === false && h.state.binding.nonce === challenge2.nonce);
    check('新旧 nonce 不同', challenge2.nonce !== bound.nonce);

    // 新文档凭新 nonce 握手确认
    h.hello(frameWin2, VENDOR_ORIGIN, challenge2.nonce, 'doc-new');
    check('新文档凭新 nonce 完成绑定', h.state.binding.confirmed === true && h.state.binding.docId === 'doc-new');

    // 迟到的取数结果返回：新文档窗口在此期间不应收到任何 log:result
    const postedBefore = frameWin2.posted.filter((p) => p.message.type === 'log:result').length;
    h.pendingLogs.shift().resolve({
      ok: true,
      json: async () => ({ deviceId: 'dev-gw-01', count: 20, entries: ['stale'] }),
    });
    await h.flush();
    const postedAfter = frameWin2.posted.filter((p) => p.message.type === 'log:result').length;
    check('迟到结果被丢弃，新文档收不到 log:result', postedAfter === postedBefore);
  }

  console.log('[D] 批准等待期间导航：令牌不发给任何文档并被销毁');
  {
    const h = await boot();
    const frameWin = makeSource();
    const bound = h.establish('doc-a', frameWin);
    h.request(frameWin, VENDOR_ORIGIN, bound.nonce, 'doc-a', 'req-nav');
    const req = h.state.requests.get('req-nav');

    vm.runInContext('approveRequest("req-nav")', h.sandbox);
    await h.flush();
    check('批准请求在途', h.pendingApproves.length === 1);

    // 导航换代（load 即生效，无需等待握手）
    const frameWin2 = makeSource();
    h.load(frameWin2);
    check('导航后世代推进、申请失效', h.state.epoch === 2 && req.status === 'invalidated');

    h.pendingApproves.shift().resolve({ ok: true, json: async () => ({ token: 'tok-late' }) });
    await h.flush();
    const burnCall = h.fetchLog.find((f) => f.url.includes('/api/logs') && f.url.includes('tok-late'));
    check('迟到令牌被主动调 /api/logs 销毁', Boolean(burnCall));
    check('没有任何窗口收到令牌', !h.win.posted.some((p) => JSON.stringify(p).includes('tok-late')));
  }

  console.log('[E] 切换设备：旧设备在途申请失效，绑定文档与 nonce 保留');
  {
    const h = await boot();
    const frameWin = makeSource();
    const bound = h.establish('doc-1', frameWin);
    h.request(frameWin, VENDOR_ORIGIN, bound.nonce, 'doc-1', 'req-dev');
    const req = h.state.requests.get('req-dev');
    const nonceBefore = h.state.binding.nonce;

    h.els['device-select'].value = 'dev-pump-02';
    h.els['device-select'].dispatch('change', {});
    check('切设备推进世代但保留文档绑定与 nonce',
      h.state.epoch === 2 && h.state.binding?.docId === 'doc-1' && h.state.binding.nonce === nonceBefore);
    check('旧设备申请失效', req.status === 'invalidated');
    check('当前设备已更新', h.state.currentDeviceId === 'dev-pump-02');

    // 同一文档用同一 nonce 为新设备发起新申请，可以正常建单
    h.request(frameWin, VENDOR_ORIGIN, bound.nonce, 'doc-1', 'req-dev2');
    const req2 = h.state.requests.get('req-dev2');
    check('新设备申请绑定到新世代与新设备', req2.epoch === 2 && req2.deviceId === 'dev-pump-02');
  }

  console.log('[F] load 后未握手：不接受任何申请（未确认绑定）');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.load(frameWin); // 只 load，不回握手
    check('load 后绑定未确认', h.state.binding.confirmed === false);

    h.request(frameWin, VENDOR_ORIGIN, h.state.binding.nonce, 'doc-x', 'req-unconf');
    check('未确认期间即使 nonce 正确也拒绝建单', !h.state.requests.has('req-unconf'));

    // 未获准站点 load 后永不握手的场景：消息直接被 origin 拒绝
    h.frame.contentWindow = makeSource();
    h.request(makeSource(), ROGUE_ORIGIN, 'rogue-nonce', 'rogue-doc', 'req-rogue2');
    check('未获准站点消息被固定 origin 拒绝', h.state.requests.size === 0);
  }

  console.log('[G] hello/load 先后顺序与重复握手：正常文档总能完成新申请');
  {
    const h = await boot();
    const frameWin = makeSource();

    // G1 hello 早于 load（新文档尚未收到挑战，拿不到 nonce）：必须拒绝且不推进/不绑定
    h.hello(frameWin, VENDOR_ORIGIN, '', 'doc-early');
    check('load 之前的握手（无有效世代/nonce）被拒、无绑定', h.state.binding === null && h.state.epoch === 0);

    // load 推进世代并签发挑战
    const challenge = h.load(frameWin);
    check('load 后世代=1、绑定未确认', h.state.epoch === 1 && h.state.binding.confirmed === false);

    // G2 新文档带着正确 nonce 握手 → 确认
    h.hello(frameWin, VENDOR_ORIGIN, challenge.nonce, 'doc-2');
    check('正确 nonce 握手确认绑定', h.state.binding.confirmed === true && h.state.epoch === 1);

    // G3 同一文档重复握手（150ms 重发）：幂等，世代不变、不重置任何状态
    h.hello(frameWin, VENDOR_ORIGIN, challenge.nonce, 'doc-2');
    check('重复握手幂等、世代仍为 1', h.state.epoch === 1 && h.state.binding.confirmed === true);

    // G4 挑战重发（模拟定时器/消息丢失补偿）后再次握手仍成功
    h.sendChallenge();
    h.hello(frameWin, VENDOR_ORIGIN, challenge.nonce, 'doc-2');
    check('挑战重发后握手依旧成功', h.state.binding.confirmed === true);

    // G5 正常申请在各种握手顺序后仍可建单
    h.request(frameWin, VENDOR_ORIGIN, challenge.nonce, 'doc-2', 'req-normal');
    check('正常文档在重复握手后仍能完成新申请', h.state.requests.get('req-normal')?.status === 'pending');
  }

  console.log('[H] 旧标识重放：复用旧 docId / 重放旧握手 / 旧 nonce 申请全部被拒');
  {
    const h = await boot();
    const oldWin = makeSource();
    const old = h.establish('doc-original', oldWin);
    // 旧文档留下一笔等待批准的申请
    h.request(oldWin, VENDOR_ORIGIN, old.nonce, 'doc-original', 'req-pending');
    check('旧申请存在且 pending', h.state.requests.get('req-pending')?.status === 'pending');

    // 导航到新文档（同源跳转，窗口代理可能复用，但 nonce 已换）
    const newWin = makeSource();
    const newChallenge = h.load(newWin);
    check('导航即作废旧 pending 申请', h.state.requests.get('req-pending')?.status === 'invalidated');

    // H1 新文档重放旧握手：携带旧 nonce，即使复用完全相同的旧 docId
    h.hello(newWin, VENDOR_ORIGIN, old.nonce, 'doc-original');
    check('复用旧 docId + 旧 nonce 的握手被拒、绑定不确认', h.state.binding.confirmed === false);
    check('旧申请仍是 invalidated，未被恢复', h.state.requests.get('req-pending')?.status === 'invalidated');
    const replayDenied = newWin.posted.filter((p) => p.message.type === 'log:denied');
    check('重放握手收到 nonce 不符拒绝', replayDenied.some((p) => String(p.message.reason).includes('nonce')));

    // H2 新文档只发旧 docId、不带 nonce 的握手
    h.hello(newWin, VENDOR_ORIGIN, '', 'doc-original');
    check('无 nonce 握手仍被拒、绑定不确认', h.state.binding.confirmed === false);

    // H3 绕过握手，直接用旧 nonce 发申请：不得建单
    const beforeSize = h.state.requests.size;
    h.request(newWin, VENDOR_ORIGIN, old.nonce, 'doc-original', 'req-replay');
    check('旧 nonce 申请不建单', !h.state.requests.has('req-replay') && h.state.requests.size === beforeSize);

    // H4 门户在被重放后补发当前挑战；新文档改用新 nonce 正常握手
    h.sendChallenge();
    h.hello(newWin, VENDOR_ORIGIN, newChallenge.nonce, 'doc-original'); // 即便 docId 仍复用旧值
    check('凭当前新 nonce 握手成功（docId 不再参与信任判定）',
      h.state.binding.confirmed === true && h.state.binding.nonce === newChallenge.nonce);

    // H5 新文档用新 nonce 发自己的新申请，可正常建单并批准
    h.request(newWin, VENDOR_ORIGIN, newChallenge.nonce, 'doc-original', 'req-fresh');
    check('新文档的新申请正常建单', h.state.requests.get('req-fresh')?.status === 'pending');
  }

  console.log('[I] 慢加载新文档：加载完成前旧申请已作废，完成后凭新 nonce 绑定');
  {
    const h = await boot();
    const oldWin = makeSource();
    const old = h.establish('doc-before-slow', oldWin);
    h.request(oldWin, VENDOR_ORIGIN, old.nonce, 'doc-before-slow', 'req-slow');

    // 导航到慢加载页：load 在文档字节到达后才触发；这里先验证“load 一触发即换代”
    const slowWin = makeSource();
    const challenge = h.load(slowWin);
    check('慢加载文档 load 时旧申请立即作废', h.state.requests.get('req-slow')?.status === 'invalidated');
    check('慢加载期间绑定未确认、挑战已可重发', h.state.binding.confirmed === false);

    // 模拟慢加载期间挑战多次重发（文档脚本尚未运行，无法回应），不影响安全状态
    h.sendChallenge();
    h.sendChallenge();
    check('挑战重发不改变世代、不复活旧申请', h.state.epoch === 2 &&
      h.state.requests.get('req-slow')?.status === 'invalidated');

    // 文档最终加载完成，带当前 nonce 握手
    h.hello(slowWin, VENDOR_ORIGIN, challenge.nonce, 'doc-slow');
    check('慢加载文档完成后正常绑定', h.state.binding.confirmed === true && h.state.binding.docId === 'doc-slow');
    h.request(slowWin, VENDOR_ORIGIN, challenge.nonce, 'doc-slow', 'req-after-slow');
    check('慢加载文档可发起属于自己的新申请', h.state.requests.get('req-after-slow')?.status === 'pending');
  }

  console.log('[J] about:blank 初始 load 不产生世代');
  {
    const h = await boot();
    // 初始 frame.src 为 about:blank，其 load 应被忽略
    h.frame.src = 'about:blank';
    h.frame.dispatch('load', {});
    check('about:blank 的 load 不推进世代、不建绑定', h.state.epoch === 0 && h.state.binding === null);
  }

  console.log('\n结果：%d 通过 / %d 失败', pass, fail);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
