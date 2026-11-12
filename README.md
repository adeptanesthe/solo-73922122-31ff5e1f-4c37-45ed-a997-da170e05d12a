# 厂商诊断日志 · 逐次授权演示台

值班门户对嵌入的厂商诊断页读取设备日志实行**逐次人工批准**，防止 iframe 跳转、
刷新、切换设备后沿用旧授权。三源架构（FastAPI + 原生 JavaScript，零前端依赖）：

| 角色 | 源（origin） | 容器端口 | 职责 |
| --- | --- | --- | --- |
| 值班门户 portal | `http://localhost:8080` | 8080→8000 | 设备选择、申请展示、人工批准、日志取数与回传 |
| 获准厂商 vendor | `http://localhost:8081` | 8081→8000 | 诊断页，只能经 `postMessage` 申请，拿不到令牌 |
| 未获准站点 rogue | `http://localhost:8082` | 8082→8000 | 白名单之外的来源，所有申请被拒绝 |

三个容器使用同一镜像，按环境变量 `APP_ROLE` 切换角色；端口不同即浏览器意义上的不同源。

## 文档绑定缺陷与修复（nonce 挑战协议）

### 旧实现的缺陷：信任了厂商页自报的 docId

旧设计让厂商文档每次加载随机生成 `docId` 并在 `vendor:hello` 握手里上报，门户仅以
“`docId` 是否变化”判断是否发生了文档换代。这把文档身份的判定权交给了不可信的被嵌入页：

1. **同源跳转的新文档复用旧 `docId` 握手**：门户看到相同 `docId` 就不推进世代、不作废申请，
   于是**等待批准的旧申请仍可继续批准**；
2. **已批准的迟到日志发给新页**：同源导航复用同一个 iframe 窗口代理（`contentWindow` 不变），
   旧取数结果回来后门户按窗口回传，**新文档会收到本不属于它的旧日志**；
3. 重放旧握手（不带/带旧标识）即可让门户误以为“还是同一文档”，恢复旧授权上下文。

### 修复：门户签发 per-generation nonce，厂商页无法自证身份

文档生命周期的权威信号是门户侧 iframe 的 `load` 事件，而非厂商页的任何上报：

- 每次 `load`（初始加载、刷新、同源跳转、换源）门户**立即推进世代 `epoch`、作废该世代之前的
  全部在途申请**，并生成一个全新的随机 `nonce`，通过 `postMessage` 以固定 `targetOrigin`
  定向投递给当前 iframe 窗口（`portal:challenge`，周期重发直到握手确认）。
- 厂商文档的握手 `vendor:hello` 与申请 `log:request` **必须回传与当前世代一致的 `nonce`**；
  门户校验 `nonce === 当前绑定 nonce`、来源窗口、固定 origin 全部通过才确认绑定/建单。
- 导航时浏览器销毁旧文档及其全部 JS 内存，旧 `nonce` 不可能被新文档继承；绑定客户端也**绝不
  持久化 nonce**（不写 `sessionStorage/localStorage`）。
- 因此新文档即使**尚未触发 load 之外的任何脚本、复用旧 `docId`、或重放旧握手**，都会因
  `nonce` 与当前世代不符被拒：旧申请保持 `invalidated` 不恢复，迟到日志在 `isCurrentBinding()`
  （世代 + nonce + 窗口 + origin）判定下被丢弃，新文档收不到任何旧数据。`docId` 降级为纯展示标签。
- 正常页面在 `hello` 与 `load` 先后顺序不同、挑战消息丢失、重复握手时都能完成新申请：
  门户周期重发挑战，厂商页收到挑战后周期重发握手直到 `hello-ack`，重复握手按幂等处理不推进世代。

## 启动

```bash
docker compose up --build
```

浏览器入口：**<http://localhost:8080>**（建议 Chrome/Edge/Firefox 近期版本）。
停止：`Ctrl+C` 后 `docker compose down`。

无 Docker 环境时，本机安装 `pip install -r app/requirements.txt` 后开三个终端：

```bash
APP_ROLE=portal SELF_ORIGIN=http://localhost:8080 PORTAL_ORIGIN=http://localhost:8080 \
  VENDOR_ORIGIN=http://localhost:8081 ROGUE_ORIGIN=http://localhost:8082 \
  uvicorn --app-dir app main:app --port 8080
APP_ROLE=vendor SELF_ORIGIN=http://localhost:8081 PORTAL_ORIGIN=http://localhost:8080 \
  VENDOR_ORIGIN=http://localhost:8081 ROGUE_ORIGIN=http://localhost:8082 \
  uvicorn --app-dir app main:app --port 8081
APP_ROLE=rogue  SELF_ORIGIN=http://localhost:8082 PORTAL_ORIGIN=http://localhost:8080 \
  VENDOR_ORIGIN=http://localhost:8081 ROGUE_ORIGIN=http://localhost:8082 \
  uvicorn --app-dir app main:app --port 8082
```

## 演示剧本

### 1. 正常逐次授权

1. 门户顶部选择设备（两台样例：边缘网关 `dev-gw-01`、泵房控制器 `dev-pump-02`）。
2. 厂商 iframe 内点 **申请最近 20 条脱敏日志**。
3. 门户右侧“申请队列”出现申请卡片，点 **批准本次申请**（或“拒绝”）。
4. 批准后门户后端签发**一次性令牌**，门户用它调日志接口，再把 20 条脱敏结果
   仅 `postMessage` 回传给发起申请的那个文档。
5. 同一申请的批准按钮随即消失，再次调用也会被拦截；重复取数因令牌已消费返回 403。

### 2. 旁窗冒充（同源也不行）

- 门户按钮 **打开同源旁窗**：旁窗与门户同源，`event.origin` 合法，但它不是 iframe，
  被 `event.source === iframe.contentWindow` 校验拒绝。
- 厂商页按钮 **打开本厂商源旁窗**：与 iframe 同源（能过固定 origin 白名单），
  但来源窗口不同，同样被拒，不能形成绑定。
- 消息拒绝原因会分别显示在门户事件日志与旁窗结果区。

### 3. 未获准站点

- 门户点 **载入未获准站点**，iframe 跳到 8082；在该页点“发送日志申请/握手”，
  门户第一道**固定 origin 白名单**即拒绝，事件日志可见 `origin=...8082` 被拦。
- 该页“直接 fetch 门户日志接口”因无令牌且无 CORS 许可失败。

### 4. 跳转/刷新后的迟到结果

1. 把门户“取数延迟”调到 8 秒（0–30 可调，服务端钳制）。
2. 厂商页发起申请并批准，取数在途时立刻点 **重新加载 iframe**、
   或在厂商页点 **页内跳转**、或直接切换设备。
3. 门户在 iframe `load` 当时即推进“文档世代”并换发新 nonce，旧申请标记为**已失效**；
   迟到的取数结果回来后只做丢弃，新文档（新 nonce）收不到任何旧数据。若令牌在批准往返期间
   就已换代，门户会主动把该令牌消费销毁，不发给任何窗口。

### 5. 厂商不能直读日志

厂商页 **直接 fetch 门户日志接口**：没有一次性令牌（令牌只存在门户主文档内存），
且门户不返回任何 CORS 头，跨源读取被浏览器拦截；`/api/approve`、`/api/devices` 同理。

### 6. 可控慢加载新文档（`/slow?delay=6`）

- 门户点 **载入可控慢加载新文档**，或厂商页点对应按钮。服务端在 `delay` 秒（1–20，钳制）后
  才吐出 HTML，文档字节到达前 iframe 内不存在任何 JS 上下文。
- 观察门户事件日志：`load` 触发即推进世代、作废旧申请，并持续重发 `portal:challenge`；
  慢加载期间任何旧申请都不可批准。
- 文档实例化后只能收到**当前世代的新 nonce**，凭它完成握手；页面“实收消息”区只显示当前世代的
  挑战/确认/本页自己的结果，不含任何旧日志。可在页内改延迟再次慢加载，重复验证。

### 7. 旧标识重放（`/replay.html`）

- 门户点 **载入旧标识重放演示页**（也可先在厂商页制造一笔 pending 申请再导航过去）。
- 在新文档里依次点：**重放旧握手（带旧 nonce + 旧 docId）**、**重放握手（不带 nonce）**、
  **用旧 nonce 直接发申请**。门户事件日志与本页“实收消息”均显示以
  `nonce 与当前文档世代不符` 拒绝；旧申请保持已失效、不恢复，本页收不到任何 `log:result`。
- 最后点 **用当前新 nonce 正常握手并发新申请**：新文档走标准流程即可成功，证明修复没有
  靠禁用同源导航，正常业务在任意握手时序/重复握手下都可用。

## 安全设计与需求对应

| 需求 | 实现位置 |
| --- | --- |
| 逐次批准，无自动授权 | 每笔 `log:request` 生成独立申请卡片，仅 `pending` 且绑定有效时可批准一次 |
| 固定 origin 校验 | 门户消息处理第一道校验 `event.origin === VENDOR_ORIGIN`；后端 `/api/approve` 独立校验 `Origin` 头 |
| 实际 iframe 来源校验 | 第二道校验 `event.source === iframe.contentWindow`，同源旁窗/弹窗无法冒充 |
| 授权/结果只属于发起申请的原文档 | 回传使用申请记录里的 `sourceWindow` + 固定 `targetOrigin`，并经 `isCurrentBinding()` 核对世代/nonce/窗口 |
| 文档身份由门户而非厂商页决定 | iframe `load` 即推进世代并签发 per-generation `nonce`；`docId` 仅展示，不参与信任判定 |
| 复用旧 docId/重放旧握手无法恢复授权 | 握手与申请必须回传当前 `nonce`；旧/缺 nonce 一律拒绝，旧申请保持 `invalidated`，不复活 |
| 每次加载重新绑定文档 | `load` 后 `portal:challenge` 投递新 nonce，厂商页 `vendor:hello` 回传 nonce 确认；双方周期重发消除时序竞争 |
| hello/load 任意顺序、重复握手可正常完成 | 挑战 250ms 重发 + 握手 150ms 重发直到 ack；重复握手幂等，不推进世代 |
| 每笔申请只能批准一次 | 前端状态机一次性流转 + 后端令牌 `pop` 消费，复用/错设备/伪造均 403 |
| 刷新/导航/切设备使旧申请失效 | 文档世代 `epoch` 单调递增，`load` 当时即作废在途申请；切设备保留 nonce 但推进世代 |
| 迟到结果不交给新文档 | 取数 `await` 前后两次 `isCurrentBinding()` 判定（含 nonce），失败即丢弃；厂商侧对未知 `requestId` 结果也丢弃 |
| 厂商无法直读日志接口 | 日志接口强制一次性令牌；无 CORS 头；令牌永不出门户主文档 |
| 设备与脱敏 | 两台设备各 24 条原始日志，接口只返回最近 20 条，服务端正则脱敏 IP/邮箱/手机号/Bearer 令牌/十六进制摘要 |

其他加固：CSP（`default-src 'self'`、门户 `frame-src` 限定两个演示源、
各角色 `frame-ancestors` 限定门户）、`nosniff`、`Referrer-Policy: no-referrer`、
`base-uri 'none'`。

## 测试

无需第三方依赖（后端用标准库 + FastAPI 最小桩，前端用 Node `vm` + DOM 桩）：

```bash
bash tests/run_all.sh                   # 一键跑全部三套测试
python3 -I tests/run_backend_tests.py   # 45 项：脱敏、origin 校验、一次性令牌、角色隔离、延迟钳制、/slow 慢加载
node tests/run_frontend_tests.js        # 55 项：nonce 绑定、冒充拒绝、世代失效、重放拒绝、慢加载、迟到丢弃、握手时序
node tests/run_integration_tests.js     # 29 项：真实 portal.js + binding-client.js 端到端互通（含同源导航窗口代理复用）
```

- 前端状态机测试重点覆盖修复目标：[H] 旧标识重放（复用旧 docId、旧/缺 nonce 握手、旧 nonce 申请全部被拒且
  不复活旧申请，新 nonce 可正常建单）、[I] 慢加载新文档、[G] hello/load 先后顺序与重复握手。
- 端到端集成测试用模拟浏览器窗口同时加载两份真实脚本，复现“同源导航复用同一 `contentWindow` 代理、
  但文档 JS 上下文全新”的现实约束，验证旧 pending 申请不可再批准、迟到日志不进新文档、三类重放攻击被拒。

## 目录结构

```
app/
  main.py              # FastAPI 应用：安全头、批准/取数接口、一次性令牌、角色隔离、/slow 慢加载
  devices.py           # 两台设备样例与原始日志
  redact.py            # 日志脱敏
  requirements.txt
  Dockerfile
  static/
    portal/            # 8080 门户（index/probe + portal.js/probe.js）
    vendor/            # 8081 厂商诊断页
      binding-client.js  # 共享：挑战-nonce 握手客户端（不持久化 nonce）
      index/vendor.js    # 主诊断页
      navigated.*        # 同源跳转后的新文档
      slow.html/slow.js  # 可控慢加载新文档（后端 /slow 延迟吐页）
      replay.html/replay.js # 旧标识重放攻击演示
      probe.*           # 同厂商源旁窗冒充演示
    rogue/             # 8082 未获准站点
docker-compose.yml     # 三容器三源
tests/                 # 标准库/Node 测试与桩
```

## 演示性质说明

令牌存储为单进程内存（uvicorn 单 worker），仅用于演示；生产环境应替换为带
TTL 的共享存储并加入审计、速率限制与认证。授权生命周期由门户侧“文档世代 + per-generation
nonce”主控（不信任被嵌入页自报的任何标识），后端一次性令牌与 origin 校验构成纵深防御。
nonce 仅在门户主文档与当前 iframe 文档的内存中经由固定 `targetOrigin` 的 `postMessage` 传递，
不落任何持久化存储，文档导航即随旧 JS 上下文销毁。
