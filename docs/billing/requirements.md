# 目标：接入 Creem 计费（免费额度 + 点数包 + 订阅）

> 状态：待执行
> 目标版本：1.2.0
> 适用仓库：`/Users/bytedance/my-projects/Vidsy`
> 关联产物：`docs/billing/creem-setup.md`（Creem 后台配置）、`docs/billing/runbook.md`（上线/对账/回滚）、`docs/billing/STATUS.md`（里程碑状态）

## 0. 执行方式

- 严格按 M0 → M5 顺序推进；每个里程碑完成后把命令日志、验收结果写入 `docs/billing/evidence/mN-YYYY-MM-DD/`，并更新 `docs/billing/STATUS.md`。
- 当前里程碑验收未全部通过，不得进入下一里程碑；失败项必须记录原因与修复证据。
- 任何需要改变现有下载/续传/失败恢复语义的改动，先停下来说明冲突，不得静默绕过。
- 每个涉及扩展构建的里程碑结束前，必须执行 `pnpm build`，同步 `~/Downloads/UUGet/`，并报告 manifest 版本。
- 未经用户确认，不创建生产 Creem 产品、不切换 live 模式、不提交/推送 git。

## 1. 目标

给 UUGet 增加一套可上线、可对账、可回滚的计费系统：

- 免费用户每个自然日（UTC）可下载 2 次；
- 超出后，用户可购买预付点数包按次下载（目标单价约 `$0.10/次`）；
- 或购买 Pro 订阅（月/年），订阅有效期内无限下载；
- 所有授权由服务端判定，扩展端只负责交互、缓存和离线宽限；
- 不改变现有下载、续传、失败恢复、大文件处理语义；
- 支付与税务由 Creem（Merchant of Record）处理，扩展不接触任何卡数据。

## 2. 现状基线（事实锚点）

| 事实 | 位置 |
| --- | --- |
| WXT MV3，manifest 版本 `1.1.0`，已含 `storage`、`alarms`、`downloads`、`offscreen`、`<all_urls>` | `wxt.config.ts` |
| 所有下载的统一入口 | `chrome-extension/src/background/lib/download.ts` 的 `handleDownload`（约 L527） |
| 字幕下载在队列之前直接返回；DRM 在入口拒绝 | `handleDownload` 内 |
| 真正入队与重复任务复用 | `chrome-extension/src/background/lib/download-queue.ts` 的 `enqueueDownload`（约 L248） |
| 队列并发是可注入的异步钩子 | `download-queue.ts` 的 `concurrency: async () => ...`（约 L71） |
| 任务终态投影（success/failed/cancelled） | `download-queue.ts` 的 `projectSnapshot`（约 L105） |
| 扩展消息统一走 `chrome.runtime.onMessage` | `chrome-extension/src/background/index.ts`（约 L190） |
| 存储工厂与 Local/Session 语义 | `packages/storage/lib/base/base.ts`、`packages/storage/lib/impl/media-storage.ts` |
| 共享类型/常量出口 | `packages/shared/index.mts`、`packages/shared/const.ts` |
| Options 页 Tab 与侧栏 | `pages/options/src/Options.tsx`、`pages/options/src/components/Sidebar.tsx` |
| Popup 下载派发 | `pages/popup/src/hooks/useMediaPage.ts` 的 `onDownload`（约 L92） |
| 共享媒体卡下载按钮 | `packages/ui/lib/components/media/MediaCard.tsx`（约 L117） |
| 文案 i18n | `packages/i18n/locales/{en,ko}/messages.json` |
| 根构建脚本 | `package.json`：`build = wxt build && pnpm sync:chrome-artifact` |
| 测试命令 | `pnpm -F chrome-extension test`（`node --import tsx --test "src/**/*.test.ts"`） |
| 工作区 glob | `pnpm-workspace.yaml`，尚无服务端包 |
| 当前无任何计费/许可证代码 | 全仓库检索 `creem/license/billing/subscription` 无业务实现 |
| 构建交付规则 | 每次 Chrome 生产构建后同步到 `~/Downloads/UUGet/`，并报告 manifest 版本 |

Creem 已确认的能力（官方文档）：

- 一次性支付与订阅；订阅周期含 `every-month`、`every-year` 等。
- License Keys：商品可配置签发；`checkout.completed` webhook 的 `object.license_keys[]` 含 `key`；客户门户可查看；`activate/validate/deactivate` 需要 `x-api-key`，只能放在服务端。
- Customer Credits：`POST /v1/customer-credits/accounts`、`.../credit`、`.../debit`、`GET .../balance`；写入需要 `idempotency_key`。
- Webhook：`creem-signature` 头，HMAC-SHA256(原始 body, webhook secret)；失败重试 5 次（30s/5m/30m/6h），24h 后停止；必须幂等。
- 客户门户：`POST /v1/customers/billing`（`customer_id`）返回 `customer_portal_link`。
- 费率：`3.9% + $0.40`/笔；提现每月 1 日/15 日，最低 `$50`，手续费 `$7` 或 `1%` 取高。

## 3. 商业模型与定价

### 3.1 免费层

- 每个设备每个 UTC 自然日 2 次成功下载。
- 失败/取消且未传输字节不消耗额度（授权时预占，失败时释放）。
- 字幕下载不计数（辅助功能，v1 明确不收费）。
- 免费层不限制清晰度、格式（MP4/MP3）、批量等现有能力；v1 不削减既有功能。
- 免费额度不累积、不跨设备合并；设备重装可重置（接受该风险，用 IP 限流兜底）。

### 3.2 点数包（按次）

1 点 = 1 次成功下载。点数不过期；订阅期间优先走订阅，不扣点数。

| 档位 | 价格 | 点数 | 折合单价 | Creem 费 | 净收入 | 净收入率 |
| --- | --- | --- | --- | --- | --- | --- |
| Starter | `$2.99` | 10 | `$0.299` | `$0.5166` | `$2.4734` | 82.7% |
| Standard | `$6.99` | 50 | `$0.140` | `$0.6726` | `$6.3174` | 90.4% |
| Plus | `$9.99` | 120 | `$0.083` | `$0.7896` | `$9.2004` | 92.1% |
| Mega | `$19.99` | 300 | `$0.067` | `$1.1796` | `$18.8104` | 94.1% |

说明：

- 用户目标单价 `$0.10/次` 在 120 点档（`$0.083`）与 300 点档（`$0.067`）成立；若希望 50 点档也精确到 `$0.10`，把价格设为 `$4.99` 即可（净收入 `$4.3954`，费率 11.9%），不需要扩展发版。
- 所有价格与点数集中配置在 Worker 的 `PRODUCTS` 常量/环境变量；扩展只拿 `productKey`，不硬编码价格。
- 价格按含税展示（Creem 产品 `tax_mode: inclusive`），避免结账时加价。
- Creem Customer Credits 可用，但不放在下载热路径：每次下载都调用 Creem API 会增加外部依赖与延迟。本方案以 D1 账本为执行权威，Creem 只作为支付来源；若后续需要在 Creem 后台展示余额，可异步镜像，不影响授权判定。

### 3.3 订阅

| 档位 | 价格 | 权益 |
| --- | --- | --- |
| Pro Monthly | `$4.99/月` | 订阅有效期内无限下载；取消后可用到周期结束 |
| Pro Yearly | `$39/年` | 同上，约 35% 折扣 |

- 订阅不消耗点数；点数保留，订阅结束后继续可用。
- 订阅状态以 Creem webhook 为准；`subscription.paid` 是开通/续费依据；`subscription.scheduled_cancel` 标记“到期不续”；`subscription.canceled` 按事件携带的 `current_period_end` 判断，周期内保留权益；`subscription.expired` / `subscription.paused` 撤销权益。
- 退款/拒付（`refund.created` / `dispute.created`）立即撤销订阅权益，并回冲点数。

### 3.4 为什么不是“每次 $0.10 单独扣款”

Creem 每笔成功交易收 `3.9% + $0.40`：

- `$0.10` 交易手续费 `$0.4039`，净收入 `-$0.3039`，数学上不可行；
- 点数包把多笔小额合并成一次交易，才能让 `$0.10/次` 的边际价格成立。

因此：**产品上展示“按次购买”，支付上使用“预付点数包”**。这是本方案的核心商业约束，不得改成单次扣款。

### 3.5 定价依据（欧美用户接受度）

调研来源：Reddit（r/androidapps、r/SideProject、r/Piracy、r/4kdownloadapps，经 PullPush 归档）与 Hacker News。结论：

- 订阅疲劳真实存在：r/androidapps 102 赞帖子称“受够了每个基础工具都变成 $50/年订阅”；高赞评论“我拒绝为 App 付月费……我想拥有，而不是租”。
- 按量付费被认为更公平：r/SideProject “Do users still hate subscriptions in 2026?” 高赞评论“Usage-based fees are fairer… subscriptions are mostly an arm-twisty way of maximizing revenue”。
- “不是又一个订阅”是正向卖点：r/SideProject 的 $1000 故事里，“Thank god this isn’t another subscription” 是最大验证；一次性/终身方案带来约 10% 转化。
- 但“终身授权被收回”会引发强烈反弹：r/4kdownloadapps 用户抱怨“他们不会兑现终身授权”。
- 浏览器插件付费存在天然敌意：r/Piracy 有“我不会为一个浏览器插件付钱”的高赞言论，并伴随破解教程。

对产品的直接约束：

1. 必须同时提供点数包与订阅，不能只做订阅；
2. v1 不承诺“终身授权”；如未来做，必须写清边界并可长期兑现；
3. 结账前明确展示单价、周期、自动续费、取消路径，不做暗黑模式；
4. 免费层必须真实可用（2 次/天），不要用“免费但不可用”逼单；
5. 不把续传、失败恢复等可靠性能力做成付费墙——用户会直接换工具；
6. 预期存在破解与负面声音，不投入 DRM 式对抗，服务端只做诚实用户与 casual abuse 的边界。

## 4. 范围

### 4.1 包含

1. Cloudflare Worker 计费服务 + D1 数据库。
2. 设备身份、免费额度、点数账本、订阅权益、下载授权/结算。
3. Creem Checkout、Webhook、License Key 激活、客户门户。
4. 扩展端授权拦截、离线宽限、失败释放、待上报重试。
5. Options 计费面板、Popup 付费墙、恢复购买、订阅管理。
6. 隐私政策、服务条款、退款政策、README/CHANGELOG。
7. 里程碑证据归档与上线回滚开关。

### 4.2 不包含

- 不在扩展中保存卡号、CVV、Creem API Key、Webhook Secret。
- 不接入支付宝/微信等国内支付（Creem Checkout 支持的方式为准）。
- 不做终身买断（v1）；不做团队/席位/教育折扣。
- 不做跨账号转移点数、点数提现、点数赠送。
- 不改变现有下载、续传、失败恢复、缓存治理语义。
- 不做账号密码体系；身份以设备令牌 + Creem 邮箱/License Key 恢复。
- 不把 4K、MP3、字幕、批量、并发数做成付费差异（v1 仅按下载次数收费）。
- 不做原生 App / Firefox 计费（Firefox 构建可继续免费或后续单独评估）。

## 5. 不可违背的原则（Invariants）

1. **服务端权威**：超过免费额度的每次下载，必须先由 Worker 返回 `allowed` 才能入队；扩展不得本地自行放行。
2. **密钥边界**：Creem API Key、Webhook Secret、快照签名私钥只存在于 Worker secrets；扩展包内不得出现。
3. **续传/重试不重复收费**：`resume` 绝不重新授权；`retry` 仅在授权已释放时用同一 `downloadKey` 重新授权；`again`（重新下载）在 UI 侧生成新的 `requestId`，按新下载重新授权。
4. **重复任务不重复收费**：`enqueueDownload` 命中已有 paused/failed 任务并恢复时，不得产生新的授权/扣点。
5. **幂等**：`(device_id, download_key)` 唯一；重复 `authorize` 返回同一决定；重复 `report` 不重复退款；重复 webhook 不重复入账。
6. **先预占、后提交**：授权时预占额度/点数；下载成功才 commit；失败/取消且 `bytesDownloaded === 0` 才 release；有字节的失败/取消按已消费处理（带宽已发生）。
7. **离线不阻断进行中的任务**：已授权的任务在断网、扩展重载、浏览器重启后必须可继续；离线宽限最长 72 小时，过期后只阻止“新下载”，绝不阻止续传/完成。
8. **不静默降级**：计费服务不可用时，免费额度内仍可下载；付费用户走签名快照宽限；任何降级都要有可读提示。
9. **金额安全**：点数账本只允许整数；余额不得因并发请求变成负数；退款/拒付允许负余额，由后续入账抵消。
10. **用户可解释**：付费墙必须说明“为什么被拦、还剩多少、如何购买/恢复”；不得只返回 `error`。
11. **隐私最小化**：只收集设备 ID、令牌哈希、Creem 邮箱、购买/订阅状态、每日用量；不采集浏览历史、下载 URL 内容（只存 `urlHash` 可选）。
12. **可回滚**：Worker 提供 `BILLING_ENFORCEMENT=off` 开关，一键放行所有下载；关闭后扩展仍可正常下载。

## 6. 架构

### 6.1 组件

```
┌──────────────────────── Chrome Extension (MV3) ────────────────────────┐
│ popup / options / background                                            │
│   background/lib/license.ts                                             │
│     ├─ device identity (deviceId + deviceToken)                         │
│     ├─ entitlement cache + ECDSA snapshot verify                        │
│     ├─ authorize / report / checkout / portal / activate                │
│     └─ pending reports + offline grace                                  │
│   download-queue.ts  ── authorize before runtime.submit                 │
│   download.ts        ── map PaymentRequiredError -> 402 UI              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS (Bearer deviceToken)
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Cloudflare Worker: uuget-billing                                        │
│   /v1/devices/register  /v1/entitlement                                 │
│   /v1/download/authorize  /v1/download/report                           │
│   /v1/checkout  /v1/portal  /v1/license/activate                        │
│   /webhooks/creem                                                       │
│   D1: accounts/devices/purchases/credit_ledger/daily_usage/             │
│       authorizations/subscriptions/license_keys/webhook_events          │
└───────────────┬─────────────────────────────────┬───────────────────────┘
                │ x-api-key (server only)         │ webhook (HMAC verify)
        ┌───────▼────────┐                ┌───────▼────────┐
        │ Creem REST API │                │ Creem Webhook  │
        └────────────────┘                └────────────────┘
```

### 6.2 Creem 产品与事件

在 Creem 后台创建 6 个产品（测试/生产各一套）：

| `productKey` | 类型 | 周期 | 价格 | 点数 | License Key |
| --- | --- | --- | --- | --- | --- |
| `credits_10` | one-time | `once` | `$2.99` | 10 | 开启，激活上限 3 |
| `credits_50` | one-time | `once` | `$6.99` | 50 | 开启，激活上限 3 |
| `credits_120` | one-time | `once` | `$9.99` | 120 | 开启，激活上限 3 |
| `credits_300` | one-time | `once` | `$19.99` | 300 | 开启，激活上限 3 |
| `pro_monthly` | subscription | `every-month` | `$4.99` | 0 | 开启，激活上限 3 |
| `pro_yearly` | subscription | `every-year` | `$39.00` | 0 | 开启，激活上限 3 |

Checkout 创建时写入：

```json
{
  "product_id": "prod_xxx",
  "request_id": "<deviceId>:<productKey>:<uuid>",
  "success_url": "https://uu0uu.com/billing/success",
  "metadata": { "device_id": "<deviceId>", "product_key": "<productKey>" }
}
```

> Creem 会在 `success_url` 后自动追加 `checkout_id`、`order_id`、`customer_id`、`subscription_id`、`product_id`、`request_id`、`signature` 查询参数；不要手写 `{checkout_id}` 占位符。成功页若展示支付结果，必须用 `signature`（SHA-256，`salt=<apiKey>`）验真；扩展侧不依赖成功页，仍以 webhook + `/v1/entitlement` 为准。

订阅以下 webhook（事件名以 Creem 当前文档/后台测试事件为准）：

- `checkout.completed`：入账点数、保存 `license_keys[]`、建立账号/设备绑定、同步订阅。
- `subscription.paid`：开通/续费，更新 `current_period_end`。
- `subscription.active`：同步状态。
- `subscription.scheduled_cancel`：标记到期不续，保留到期前权益。
- `subscription.canceled`：按事件携带的 `current_period_end` 判断；周期内保留权益。
- `subscription.expired` / `subscription.paused`：撤销权益。
- `refund.created` / `dispute.created`：回冲点数、撤销订阅。

### 6.3 D1 数据模型

`server/migrations/0001_init.sql`：

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                 -- acc_<uuid>
  email TEXT NOT NULL UNIQUE,          -- lower-case, from Creem customer.email
  creem_customer_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,                 -- dev_<uuid>, generated by extension
  token_hash TEXT NOT NULL UNIQUE,     -- SHA-256(base64url deviceToken)
  account_id TEXT REFERENCES accounts(id),
  name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,                 -- Creem order id, idempotency key
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('credits','subscription')),
  credits INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  delta INTEGER NOT NULL,              -- +grant, -reserve, +release, -chargeback
  reason TEXT NOT NULL CHECK (reason IN ('grant','reserve','release','chargeback','adjust')),
  ref TEXT NOT NULL,                   -- grant:<order_id> / reserve:<auth_id> / ...
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, ref)
);

CREATE TABLE daily_usage (
  device_id TEXT NOT NULL REFERENCES devices(id),
  utc_date TEXT NOT NULL,              -- YYYY-MM-DD
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, utc_date)
);

CREATE TABLE authorizations (
  id TEXT PRIMARY KEY,                 -- auth_<uuid>
  device_id TEXT NOT NULL REFERENCES devices(id),
  account_id TEXT REFERENCES accounts(id),
  download_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('free','subscription','credits')),
  state TEXT NOT NULL CHECK (state IN ('reserved','committed','released')),
  credits_reserved INTEGER NOT NULL DEFAULT 0,
  free_reserved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (device_id, download_key)
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,                 -- Creem subscription id
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,                -- active/trialing/canceled/expired/paused
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE license_keys (
  key_hash TEXT PRIMARY KEY,           -- SHA-256(normalized key)
  key_last4 TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  product_id TEXT NOT NULL,
  activation_limit INTEGER,
  status TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,                 -- Creem event id
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
```

关键原子操作：

- 免费额度预占（原子，返回行即成功）：
  ```sql
  INSERT INTO daily_usage (device_id, utc_date, used)
  VALUES (?, ?, 1)
  ON CONFLICT(device_id, utc_date) DO UPDATE SET used = used + 1
  WHERE used < 2
  RETURNING used;
  ```
- 点数预占（余额足够才插入；与 `authorizations` 用 `db.batch()` 同事务）：
  ```sql
  INSERT INTO credit_ledger (id, account_id, delta, reason, ref, created_at)
  SELECT ?, ?, -1, 'reserve', ?, ?
  WHERE (SELECT COALESCE(SUM(delta), 0) FROM credit_ledger WHERE account_id = ?) >= 1
  RETURNING id;
  ```
- 释放：`credit_ledger` 插入 `+1`，`ref = 'release:<auth_id>'`；`daily_usage.used = MAX(0, used - 1)`。
- 订阅权益：`status IN ('active','trialing')`，或 `status = 'canceled' AND current_period_end > now`。
- 24h 未上报的 `reserved` 授权：`state = 'committed'`（防止崩溃白嫖；支持可手工退款）。

### 6.4 API 契约

所有扩展请求带 `Authorization: Bearer <deviceToken>`；Worker 以 `token_hash` 查设备。响应统一 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/devices/register` | `{ deviceId, deviceToken, name? }` → `{ ok }`；按 IP 限流 |
| `GET` | `/v1/entitlement` | 返回 plan、订阅、免费额度、点数、签名快照 |
| `POST` | `/v1/download/authorize` | `{ downloadKey, kind, urlHash? }` → `allowed/source` 或 `402 payment_required` |
| `POST` | `/v1/download/report` | `{ downloadKey, outcome, bytesDownloaded }` → `{ ok, state }` |
| `POST` | `/v1/checkout` | `{ productKey }` → `{ checkoutUrl }` |
| `POST` | `/v1/portal` | → `{ portalUrl }`（Creem `customer_portal_link`） |
| `POST` | `/v1/license/activate` | `{ licenseKey }` → 绑定当前设备并返回 entitlement |
| `POST` | `/webhooks/creem` | Creem webhook；校验 `creem-signature` |
| `GET` | `/health` | 部署/探活 |

`authorize` 响应示例：

```json
{
  "allowed": true,
  "source": "credits",
  "authorizationId": "auth_...",
  "free": { "used": 2, "limit": 2, "utcDate": "2026-11-18" },
  "credits": 36,
  "subscription": null
}
```

402 响应：

```json
{
  "allowed": false,
  "error": "payment_required",
  "free": { "used": 2, "limit": 2, "utcDate": "2026-11-18" },
  "credits": 0,
  "upgrade": {
    "optionsUrl": "chrome-extension://<id>/options.html#license",
    "pricingUrl": "https://uu0uu.com/pricing"
  }
}
```

错误码：`401` 设备令牌无效；`402` 需要付费；`403` License 激活超限；`404` License 不存在；`410` License 过期；`429` 限流；`503` 计费服务暂不可用。

### 6.5 下载授权状态机

```
                 authorize(downloadKey)
   [none] ──────────────────────────────► reserved
                                              │
                    report(success) ──────────┼──► committed（扣点/用掉免费额度）
                    report(failed/cancelled,  │
                      bytesDownloaded = 0) ───┼──► released（退还）
                    report(failed, bytes > 0) ┼──► committed（带宽已发生）
                    24h 无 report ────────────┴──► committed（保守）
   released ── authorize(同一 downloadKey, retry) ──► reserved（重新预占）
```

接入点：

1. `handleDownload` 先生成稳定 key：`const key = payload.key ?? crypto.randomUUID()`。
2. `enqueueDownload` 在**重复任务检测之后、`runtime.submit` 之前**调用 `authorizeDownload`；命中已有 paused/failed 任务时直接恢复，不授权。
3. `resubmitDownload`（`again` 路径）会创建新任务，必须在 `runtime.submit` 前用新 `requestId` 授权。
4. 授权失败抛 `PaymentRequiredError`；`handleDownload` 捕获后返回 `{ ok: false, code: 'PAYMENT_REQUIRED', error, upgrade }`。
5. `runtime.submit` 抛错时，用同一 key 上报 `failed, bytesDownloaded: 0` 释放。
6. `projectSnapshot` 在任务进入 `success` / `failed` / `cancelled` 终态时调用 `reportDownloadOutcome`；重复上报由服务端幂等吸收。
7. `resume` 不重新授权；`retry` 在 `commandDownload` 前检查本地授权状态，若为 `released` 用同一 key 重新授权；`again` 在 UI 侧已生成新的 `requestId`（`useMediaPage` / `DownloadRow` / `MediaCard` 均传 `crypto.randomUUID()`），按新下载重新授权。

### 6.6 离线宽限与对账

- `GET /v1/entitlement` 返回 `snapshot` + ECDSA P-256 `signature`；扩展内嵌公钥，本地验签。
- `snapshot` 字段：`v, deviceId, plan, subscriptionStatus, subscriptionEnd, creditBalance, freeUsed, utcDay, issuedAt, expiresAt`。
- 有效期 72h；验签失败/过期视为无快照。
- 离线时：
  - 订阅有效 → 放行；
  - 免费额度剩余 > 0 → 放行并本地递减；
  - 点数余额 > 0 → 放行并本地递减；
  - 无快照且无网络 → 仅按本地免费额度放行（首日最多 2 次）。
- 扩展持久化 `pendingReports`；恢复网络、启动、6h alarm 时补报并刷新 entitlement。
- 服务端对离线期间的新授权做补记；若余额不足产生负余额，后续入账抵消；不追回已下载文件。

### 6.7 安全边界

- Worker secrets：`CREEM_API_KEY`、`CREEM_WEBHOOK_SECRET`、`SNAPSHOT_PRIVATE_KEY`。
- Webhook：`creem-signature` HMAC-SHA256 原始 body，常量时间比较；`webhook_events.id` 幂等；处理失败返回 5xx 让 Creem 重试。
- 扩展令牌存 `chrome.storage.local`，不参与 `chrome.storage.sync`。
- 限流：`/v1/devices/register` 10/IP/小时；`/v1/checkout` 10/设备/小时；`/v1/download/authorize` 60/设备/分钟。
- CORS：允许 `chrome-extension://<store-id>`、`chrome-extension://<unpacked-id>` 与 `https://uu0uu.com`；CORS 不是安全边界，令牌才是。
- 日志脱敏：不记录完整 deviceToken、License Key、邮箱（只留哈希/尾号）。
- 隐私：`PRIVACY.html` 增加设备 ID、令牌哈希、Creem 邮箱、购买/订阅、每日用量、Cloudflare 日志；提供删除入口。

## 7. 分阶段目标与验收标准

### M0 — 共享契约、存储、本地免费额度（内部，不发布）

实现：

- `packages/shared/lib/license/types.ts`：`Plan`、`EntitlementSnapshot`、`LicenseVerdict`、`FREE_DAILY_LIMIT = 2`、`OFFLINE_GRACE_MS = 72h`。
- `packages/shared/lib/license/index.ts`：`utcDate`、`freeRemaining`、`isSubscriptionEntitled`、`canUseCachedEntitlement`、`normalizeLicenseKey`；在 `packages/shared/index.mts` 导出。
- `packages/storage/lib/impl/license-storage.ts`：
  - `licenseDeviceStorage`：`deviceId`、`deviceToken`、`createdAt`（Local）；
  - `licenseEntitlementStorage`：`snapshot`、`signature`、`verifiedAt`（Local）；
  - `licenseLocalUsageStorage`：`utcDate`、`used`、`credits`（Local）；
  - `licenseAuthorizationsStorage`：`downloadKey -> { state: 'reserved'|'committed'|'released', source, authorizationId }`（Local，用于 resume/retry 判断是否重新授权）；
  - `licensePendingReportsStorage`：待补报队列（Local）。
- `chrome-extension/src/background/lib/license.ts`：本地模式（无网络）实现 `authorizeDownload` / `reportDownloadOutcome`。
- `download-queue.ts`：在 `runtime.submit` 前接入授权；`download.ts` 映射 `PaymentRequiredError`。
- `chrome-extension/src/background/lib/license.test.ts`。

验收：

- 同一天第 1、2 次下载放行，第 3 次返回 `PAYMENT_REQUIRED`；UTC 跨日重置。
- 失败且 0 字节释放额度；`resume` 不重新授权；`retry` 不重复扣；`again` 生成新的 `requestId`，按新下载授权。
- 重复 `authorize` 同 key 只产生一次预占。
- `pnpm type-check`、`pnpm -F chrome-extension test` 通过。

### M1 — Billing Worker、D1、授权/结算

实现：

- 新建 `server/` 工作区包（`@extension/billing-worker`），加入 `pnpm-workspace.yaml`。
- `server/wrangler.toml`：D1 binding、staging/production 环境、vars。
- `server/src/index.ts`：Hono 路由 + 中间件（Bearer、限流、错误映射）。
- `server/src/db.ts`、`server/src/auth.ts`、`server/src/snapshot.ts`、`server/migrations/0001_init.sql`。
- 端点：`/health`、`/v1/devices/register`、`/v1/entitlement`、`/v1/download/authorize`、`/v1/download/report`。
- 测试：`@cloudflare/vitest-pool-workers` + D1 迁移。

验收：

- 两个并发请求争最后一个免费名额：恰好一个成功（D1 原子 SQL）。
- 同 key 重复 `authorize` 返回同一决定，不重复扣点。
- 预占 → commit / release 后余额与每日用量正确。
- 订阅 active 放行、expired 拒绝、canceled 在周期内放行。
- 无效令牌 401；限流 429；`BILLING_ENFORCEMENT=off` 全部放行。
- `pnpm -F @extension/billing-worker test` 通过；`wrangler dev --local` 冒烟通过。

### M2 — Creem Checkout、Webhook、入账

实现：

- `server/src/creem.ts`：`fetch` 封装 `POST /v1/checkouts`、`POST /v1/customers/billing`、`POST /v1/licenses/activate|validate|deactivate`；不使用 SDK，避免额外依赖。
- `POST /v1/checkout`：`productKey` → Creem `product_id`，写 `metadata.device_id/product_key`，返回 `checkoutUrl`。
- `POST /webhooks/creem`：验签、事件幂等、`checkout.completed` 入账、`subscription.*` 同步、`refund/dispute` 回冲。
- `POST /v1/license/activate`：校验 License、调用 Creem activate（`instance_name = deviceId`）、绑定设备到账号；`POST /v1/license/deactivate` 可选。
- `server/src/products.ts`：6 个产品的价格/点数/周期配置。
- `docs/billing/creem-setup.md`：后台建品、License Key 配置、Webhook 注册、测试模式、secrets 设置、测试卡说明。

验收：

- 测试模式购买 `credits_10` → `/v1/entitlement` 显示 10 点；重复 webhook 不重复入账。
- 测试模式购买 `pro_monthly` → 订阅 active；取消后到期前仍放行；过期后拒绝。
- `checkout.completed.object.license_keys[]` 被保存；`/v1/license/activate` 可绑定设备。
- 伪造/错误签名 → 401，D1 无写入。
- `/v1/portal` 返回 `customer_portal_link`。
- 扩展构建产物中检索不到 `CREEM_API_KEY` / webhook secret。

### M3 — 扩展端强制接入与购买 UI

实现：

- `download.ts` / `download-queue.ts`：按 6.5 接入授权、释放、终态上报；覆盖 `enqueueDownload`、`resubmitDownload`、`retry` 三条路径。
- `packages/shared/lib/license/messages.ts`：`LICENSE_MESSAGE = { STATUS, REFRESH, CHECKOUT, PORTAL, ACTIVATE }`；加入共享出口。
- `chrome-extension/src/background/index.ts`：注册 6h `uuget-license-sync` alarm；处理 license 消息；启动时 `syncEntitlement`。
- `pages/options/src/components/LicensePanel.tsx`：状态卡、免费额度、点数、订阅、购买、恢复、管理订阅、刷新、隐私链接。
- `Options.tsx`：`Tab` 增加 `'license'`；读取 `location.hash === '#license'` 深链。
- `Sidebar.tsx`：新增 License 导航项。
- `packages/ui/lib/components/billing/PaywallDialog.tsx`：付费墙；popup `useMediaPage.onDownload` 与 `MediaCard` 的 402 分支复用。
- `packages/i18n/locales/{en,ko}/messages.json`：新增文案。
- 结账流程：`chrome.tabs.create({ url: checkoutUrl })`；License 面板每 3s 轮询 `/v1/entitlement`，最长 2 分钟，或用户点“刷新”。

验收：

- 免费用户：第 1、2 次成功；第 3 次出现付费墙，展示“2/2 used today”、点数包与 Pro 价格、恢复入口。
- 测试模式购买 10 点后，第 3 次下载成功，余额 9。
- 订阅生效后无限下载，点数不变。
- 暂停/恢复/重试/重新下载语义符合 6.5；重复点击不重复扣费。
- 扩展重载/浏览器重启后权益与待上报队列恢复。
- `pnpm type-check`、`pnpm lint`、`pnpm -F chrome-extension test`、`pnpm build` 通过。
- 构建同步到 `~/Downloads/UUGet/`，目标目录与 `.output/chrome-mv3/` 一致，报告 manifest 版本。

### M4 — 恢复购买、订阅管理、离线宽限、对账

实现：

- `POST /v1/license/activate`：校验 Creem License、绑定设备到账号、返回 entitlement；激活上限 3；提供 deactivate 说明。
- License 面板“恢复购买”：输入 Creem 邮件中的 License Key。
- “管理订阅”：Worker `/v1/portal` → `customer_portal_link`，新标签打开。
- 离线宽限：签名快照、72h、pending reports 补报、对账脚本/定时任务。
- 账号数据删除：`DELETE /v1/account`（Bearer）或支持邮箱流程。
- `docs/billing/runbook.md`：对账、退款、拒付、负余额、License 迁移、回滚；同一用户使用不同邮箱购买会产生多个账号，v1 不自动合并，记录手工合并/点数转移流程。

验收：

- 新设备输入 License Key → 权益恢复；第 4 台设备激活返回 403 并提示先 deactivate。
- DevTools 离线：有效快照内 Pro 可下载；快照过期后新下载被拦，但已有任务可续传完成。
- 恢复网络后 pending reports 补报，余额与服务端一致；无重复扣点。
- 客户门户链接可用；账号删除后设备令牌失效、D1 数据按策略清理。
- 对账任务能发现“本地待上报 > 0 / 服务端 reserved 超 24h”的差异并记录。

### M5 — 生产上线

实现：

- 生产 Creem 产品、生产 webhook、生产 secrets、D1 生产库与迁移。
- Cloudflare 自定义域（如 `billing.uu0uu.com`）、WAF/限流、日志与告警。
- `BILLING_ENFORCEMENT` kill switch；生产默认 `on`，异常时一键 `off`。
- `PRIVACY.html`、`TERMS.html`、`REFUND.html` 更新并在 License 面板/结账前链接。
- 在 `uu0uu.com` 提供 `/billing/success` 静态页：提示“支付已完成，请返回 UUGet”；若展示支付结果，必须验 `signature`（SHA-256，`salt=<apiKey>`）。
- `README.md`、`CHANGELOG.md` 更新；版本升到 `1.2.0`。
- 最终证据归档 `docs/billing/evidence/m5-YYYY-MM-DD/`。

验收：

- 生产模式完成一次真实小额购买（或 Creem 允许的最小金额）并退款；webhook、入账、权益、退款回冲全链路通过。
- 订阅开通、取消、到期撤销全链路通过。
- kill switch 打开后所有下载放行；关闭后恢复计费。
- 隐私/条款/退款页可公开访问，结账前可见。
- `pnpm build` 成功并同步 `~/Downloads/UUGet/`；`diff -r` 无差异；报告 manifest 版本。
- `docs/billing/STATUS.md` 记录 M0–M5 全绿；无未解释的失败项。

## 8. 证据要求

每个里程碑必须留下可复现日志，放在 `docs/billing/evidence/mN-YYYY-MM-DD/`：

```bash
pnpm install
pnpm type-check
pnpm lint
pnpm -F @extension/billing-worker test
pnpm -F chrome-extension test
pnpm build
diff -r .output/chrome-mv3 "$HOME/Downloads/UUGet"
node -e "console.log(require('./.output/chrome-mv3/manifest.json').version)"
```

服务端本地：

```bash
cd server
pnpm wrangler d1 migrations apply uuget-billing --local
pnpm wrangler dev --local
```

Creem 测试模式：

```bash
cd server
pnpm wrangler secret put CREEM_API_KEY --env staging
pnpm wrangler secret put CREEM_WEBHOOK_SECRET --env staging
pnpm wrangler secret put SNAPSHOT_PRIVATE_KEY --env staging
```

证据文件至少包含：

- 命令、退出码、关键输出（脱敏）；
- Creem 测试产品 ID、checkout ID、webhook event ID（脱敏）；
- 手工验收步骤与结果（免费 2 次、第 3 次 402、购买后放行、订阅无限、恢复购买、离线宽限）；
- 构建产物 manifest 版本与 `~/Downloads/UUGet/` 对比结果。

禁止在证据中写入：完整 API Key、webhook secret、私钥、完整 License Key、用户邮箱明文。

## 9. 明确不做

- 不做单次 `$0.10` 独立扣款（手续费倒挂）。
- 不做“终身授权”承诺（v1）。
- 不做国内支付、发票、对公转账。
- 不做账号密码、OAuth 登录、跨设备实时同步（点数/订阅以服务端为准，设备通过 License 恢复）。
- 不做 DRM 式客户端防破解；不因计费降低下载可靠性。
- 不把续传、失败恢复、缓存治理、清晰度/格式做成付费墙。
- 不改 Firefox 构建的计费行为（可继续免费）。
- 不引入除 Hono、Vitest/Workers 测试工具外的重型服务端框架。

## 10. 执行前需要用户提供的输入

1. Creem 测试/生产产品 ID（6 个），或授权用 Creem API/CLI 创建。
2. Billing Worker 域名（建议 `billing.uu0uu.com`）与 Cloudflare 账号/Zone。
3. 扩展的商店 ID 与本地 unpacked ID（用于 CORS/深链）。
4. 支持邮箱（退款、恢复购买、账号删除）。
5. 确认免费额度 `2/天`、点数包价格、Pro `$4.99/月`、`$39/年`。
6. 确认点数是否过期（建议不过期）与退款政策（建议 14 天内未使用点数可退）。
7. 确认是否接受“失败/取消且 0 字节才退款；有字节按已消费”的结算规则。

## 11. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 计费服务不可用 | 免费额度本地兜底；付费用户 72h 快照宽限；`BILLING_ENFORCEMENT=off` 一键放行 |
| D1 写冲突/并发 | 原子 SQL + `db.batch()` + 唯一约束；授权表 `(device_id, download_key)` 幂等 |
| Webhook 重复/乱序 | `webhook_events.id` + 业务唯一键（order id、ledger ref）；状态更新幂等 |
| 退款/拒付导致负余额 | 允许负余额，后续入账抵消；订阅立即撤销 |
| 设备重装绕过免费额度 | 接受；IP 限流；后续可加 Turnstile/邮箱 |
| 扩展被破解 | 接受；服务端只保护诚实用户与 casual abuse，不投入 DRM |
| Creem 账户审核/网站合规 | 上线前确保 uu0uu.com 有 Privacy/Terms/Refund 页面与支持联系方式 |
| 提现周期与手续费 | 每月 1/15 日、最低 $50、$7 或 1%；定价已按净收入核算 |
| 版本回滚 | Worker 可独立回滚；扩展保留 `BILLING_ENFORCEMENT=off` 兼容；D1 迁移只增不删 |

## 12. Definition of Done

- M0–M5 全部验收项通过，`docs/billing/STATUS.md` 全绿。
- 生产环境完成一次真实购买 + 退款 + 订阅取消 + License 恢复 + kill switch 演练。
- 免费用户、点数用户、订阅用户、离线用户、恢复购买用户五条路径均有证据。
- 扩展包内无任何 Creem secret；隐私/条款/退款页面可访问。
- `pnpm build` 成功，`~/Downloads/UUGet/` 与 `.output/chrome-mv3/` 一致，manifest 版本为 `1.2.0` 并已报告。
