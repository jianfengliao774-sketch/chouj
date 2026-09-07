# 钱包连接与 5,000 份购买验证

## 反向代理请求大小

`buySelected(uint256,uint16[])` 的数组元素仍各占 32 字节 ABI 编码空间。5,000 个号码编码为 JSON-RPC 估算请求后约为 **320,401 字节**，超过 Nginx `256k`。服务器会先返回 HTTP 413，浏览器无法进入钱包支付请求。

线上 `/rpc` 位置必须与 `sparkdraw-service.mjs` 的 512 KiB 请求上限保持一致。在现有 location 内添加以下设置，保留其余代理、限流和来源校验：

```nginx
location = /rpc {
    client_max_body_size 512k;
    # 保留原有 proxy_pass、限流和代理头设置。
}
```

备份原配置，先执行 `nginx -t`，通过后 reload。不要通过提高购买份数、Gas 上限或跳过费用估算解决这个错误。

网页只读 RPC 按最多 25 项且最多 524,288 字节分批；两个大型估算不会挤进同一个超限请求。钱包授权、签名、发送交易不进入这个自动重试通道。

## 币安与等待时间

依据 [Binance EVM Provider 官方文档](https://developers.binance.com/en/docs/products/web3-connect/evm-compatible-provider)，识别 `window.binancew3w.ethereum`，以及 App 浏览器中带 `isBinance` 标记的 `window.ethereum`。每个不同 provider 对象仍独立保留。只在用户选择后请求连接，发现过程不请求账户权限。

弹窗打开后的前三秒补充检测延迟注入，并响应初始化和返回页面事件。EIP-6963 元数据仍优先用于同一个 provider 对象。

购买开始后立即显示进度。份数、余额、授权额度等独立读取并发执行并合并 HTTP 请求，链上代码校验、Gas 预算、账户/网络校验、跨标签锁和未决交易保护继续生效。真实设备的网络与钱包处理时间仍会影响弹窗速度。

## 回归验证

```sh
node --test test/bem-production-wallet-picker.test.mjs test/bem-read-rpc-batcher.test.mjs test/bem-sparkdraw-player.test.mjs test/bem-sparkdraw-random-tickets.test.mjs test/bem-sparkdraw-service.test.mjs test/bem-sparkdraw-recovery.test.mjs
pnpm test
pnpm run build
node test/bem-binance-mobile.browser.mjs
```

浏览器验证需 Playwright；可通过 `PLAYWRIGHT_MODULE` 指定现有安装模块，通过 `CHROME_PATH` 指定 Chrome。覆盖电脑随机 5,000 份、电脑手选 5,000 份、手机尺寸下币安延迟注入，以及先授权再弹出购买请求。所有浏览器网络均拦截为本地模拟响应；钱包发送请求由模拟器截获，购买请求模拟用户取消，不广播交易。字节码 fixture 是公开链上代码，并用现行配置中的运行时代码哈希校验。

2026-09-08 验证：105 项单元/服务回归通过，3 个浏览器场景通过；生产只读 5,000 份费用估算请求由 HTTP 413 恢复为 HTTP 200。探测账户无资金，返回合约查询错误属于预期，不代表真实购买成功。

## 支付准备提速与剩余购买上限

购买点击时先取得新块号，再在同一区块并发读取期号、场次、个人持票、余额、授权额度和未售号码。页面期号只作为查询参数，必须与该区块的真实期号一致。已有足额授权时复用本次点击的新鲜读取；需要先授权时，在授权确认后重新读取期号、个人额度和未售号码。

交易管理器并发核验初始钱包身份、合约代码和费用，之后取得钱包的最新 pending nonce，再次核验账户、网络与页面上下文，最后才发送请求。没有使用缓存余额或缓存费用，也没有减少交易费用检查、跨标签锁或未决交易保护。

固定模拟条件（每次只读 RPC 延迟 200 ms、钱包只读请求延迟 120 ms）下，从购买点击到首个 `eth_sendTransaction` 请求：

| 场景 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 电脑随机 5,000 份，已有授权 | 1,797 ms | 927 ms |
| 手机先授权，首个授权请求 | 1,339 ms | 887 ms |
| 电脑手选 5,000 份 | 1,370 ms | 934 ms |

这是模拟网络下的页面准备耗时，未包含真实钱包界面渲染、用户确认、区块确认，不能当作真实手机的承诺速度。

购买输入下方显示当前可买上限，取单笔上限 5,000、本场剩余份数和钱包本期剩余额度三者最小值。自动选号的所有快捷按钮和手动数量输入都按此值限制：例如只剩 800 份，输入 1,000、3,000、5,000 均改为 800；输入 500 保持 500，BEM 金额同步。售完或个人额度耗尽时显示 0 并禁止购买；切换钱包、网络、场次或期号后重新核对额度。自由选号保留用户具体选择，支付前仍读取链上真实库存与额度。

新增 `test/bem-purchase-limit.test.mjs`、`test/bem-wallet-preflight-speed.test.mjs` 已纳入 `pnpm test`。本轮共 115 项单元/服务回归通过；浏览器验证扩展为 6 个场景，涵盖钱包剩余 800 份、切换账户后重新计算、场次剩余 1,200 份和售罄。可用 `RPC_DELAY_MS=200 WALLET_DELAY_MS=120` 复现固定延迟条件。
