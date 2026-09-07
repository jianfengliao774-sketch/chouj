# Tapeout 芯火夺宝 / Tapeout SparkDraw 协作说明

## 分工与分支

- 页面协作者：从 `main` 创建自己的页面分支，例如 `codex/ui/<功能名>`，完成后提交 Pull Request。
- 项目负责人：负责合约、钱包交易、资金规则、服务端索引与部署。V4 正式合约的开发分支为 `codex/formal-v4-work-in-progress`，尚未作为生产版本接入。
- 修改前先拉取最新 `main`。不要强推公共分支；不要将未完成的合约工作直接混入页面改版。
- 每次完成更新后同步到仓库；提交和推送前执行 `git fetch origin`，检查远端新增提交。若协作者已有更新，先合并并验证相关功能，再推送，不能覆盖对方的修改。网络失败时明确记录未同步状态，不把本地提交当作已上传。
- 页面协作者的 GitHub 账号尚未提供，因此这次只同步代码和说明，没有更改仓库访问权限。

## 页面工作范围

| 位置 | 用途 |
| --- | --- |
| `bem-production-site/web/index.html` | 玩家主界面、中奖记录、个人参与记录 |
| `bem-production-site/web/burns.html` | 销毁页片段，构建时复用玩家主界面 |
| `bem-production-site/player-page-template.mjs` | 玩家与销毁页共用模板 |
| `bem-production-site/web/*.css` | 页面布局、字体、配色、适配 |
| `bem-production-site/web/player-i18n.js` | 中英文文案与页面标题 |
| `bem-production-site/web/public-draw-display.js` | 公开开奖进度和结果展示 |
| `bem-production-site/web/personal-records.js` | 个人参与记录展示 |
| `bem-production-site/web/admin.html`、`admin.css`、`admin.js` | 管理后台界面 |

保留已有元素的 `id`、事件名和表单语义。若需要改这些接口，在 Pull Request 中注明，并更新相应交互测试。中文名称固定为 **Tapeout 芯火夺宝**，英文名称固定为 **Tapeout SparkDraw**。

`player-v2.js` 同时连接页面与交易流程，属于双方共享文件：纯布局优先改 HTML/CSS，涉及购买流程的修改由负责人复核。

## 内部机制范围

`contracts/`、`scripts/`、`outputs/bem-raffle-2075/` 的合约与部署证据；`server.mjs`、`rpc.mjs`、`chain-history.mjs`、`pool-status.mjs`、`participation.mjs`；前端的 `*-transactions.js`、`*-guards.js`、`*-profiles.js`、`pool-deployments.js`、`approval-purchase-flow.js` 等。

页面改版不要自行修改合约地址、ABI、网络、授权金额、费率、份数、随机数、结算或钱包交易参数。`dist/` 是构建产物，修改源文件后重新构建。不要提交密钥、服务端环境文件、钱包存储、真实管理员凭据或服务器数据目录。

## 启动与验证

使用 Node.js 24 和仓库锁定的 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start
```

页面入口：`/?pool=1`（1 BEM 测试）、`/#mine`（个人记录）、`/burns.html`（销毁）、`/admin.html`（后台）。测试场使用 BNB 主网真实 BEM；页面预览无需发送钱包交易。

本次界面/服务端修复可运行：

```sh
pnpm run test:player-update
```

个人记录从服务器的已确认链上事件索引生成，持久化目录由 `BEM_DATA_DIR` 配置。部署时保留该目录；不依赖玩家浏览器 localStorage。用户可通过钱包地址跨设备查询公开的参与记录。记录可能落后最新区块，页面会显示同步状态。

## 当前机制状态

1 BEM 测试仍使用已部署的 V2。售满只是封盘和请求 VRF，**不等于已经开奖**；随机数回调之后仍需结算交易。一分钟是目标时间，并非开奖保证；未返回 VRF 时不能伪造号码。当前版本不宣称自动结算服务已运行。

V4 的 5/10/50/100 BEM 分档、每笔 5,000 份和 95% 倒计时在独立分支继续开发。该分支有明确未通过的高 Gas 场景，不可作为已完成、已审计或可直接部署的版本。
