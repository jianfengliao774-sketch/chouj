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
