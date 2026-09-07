# 手机钱包与浏览器连接检查

更新日期：2026-09-08。对象为 `https://tapeout.cc.cd/` 的玩家页面。本记录说明本轮代码实现和模拟验证范围，不作为实体手机、钱包 App 或操作系统版本的兼容认证。

本轮修复的关键区别是：钱包内置浏览器可直接使用其注入的钱包接口；普通手机 Chrome / Safari 通常没有该接口。后者不能通过持续扫描获得连接，本轮提供“在钱包 App 中打开本场次”或复制网址的入口。网页转入钱包后，由用户连接并确认购买。

## 访问路径矩阵

| 用户打开网页的位置 | 本轮连接路径 | 验证范围与边界 |
| --- | --- | --- |
| 币安钱包内置浏览器 | 发现共享或币安专属 EVM provider；用户选择后在当前 App 确认 | 已覆盖模拟注入、授权和购买流程；未以实体币安 App 验证其原生弹窗速度 |
| OKX 钱包内置浏览器 | 发现共享、`okxwallet` 或其 `ethereum` provider；保留用户选中的准确对象 | 已覆盖模拟专属/共享接口和延迟注入；App 自身风险提示、解锁和后台限制仍由钱包控制 |
| TP 钱包内置浏览器 | 发现共享、`tokenpocket` 等专属命名空间中的 EVM provider | 已覆盖模拟接口和支付流程；兼容标识 `isMetaMask` 不应使 TP 被误归类为小狐狸 |
| MetaMask 内置浏览器 | 发现注入接口或 EIP-6963 公告，直接向选中 provider 请求连接和交易 | 已覆盖模拟连接、网络变更、授权与购买；不使用打开外部 App 的路径绕行 |
| Android Chrome | 没有 provider 时，MetaMask / OKX / TP 提供同步点击的 App 链接；其他钱包提供复制网址与打开指引 | Chromium 与 WebKit 中均执行了 Android 身份的页面模拟；这不等于 Android 系统实际派发链接验证 |
| iPhone Chrome | 没有 provider 时，使用同一组 App 链接或复制网址；链接在用户点击时直接导航 | 已在 Chromium 与 WebKit 中模拟 iPhone Chrome 身份；未证明特定 iOS 或 Chrome 版本能实际唤起全部钱包 |
| iPhone Safari | 使用 App 链接或复制网址；不在点击后等待网络再尝试打开 App | 已在两种浏览器引擎中模拟 Safari 身份；iOS 的安装状态、App 链接关联及用户设置仍需实体设备确认 |
| iPad 请求桌面网站 | 除 User-Agent 外结合 `MacIntel` 与多触点识别，仍提供移动钱包入口 | 已覆盖 iPad 桌面身份模拟；不会只因 User-Agent 看起来像 Mac 就要求安装桌面钱包扩展 |
| 桌面 Chrome 等浏览器 | 已注入扩展时继续使用钱包选择弹窗；没有扩展时显示安装/访问指引 | 本轮不新增“桌面网页扫码后在手机签名”的远程会话功能 |

只要存在注入的钱包接口，优先显示已检测钱包并使用该接口。普通手机浏览器的 App 入口不会伪装成“已连接”；进入钱包内的页面后仍需用户连接和确认。

## 本轮实现

### 内置浏览器与 App 返回

- 继续支持 EIP-6963、多钱包共享接口和币安、OKX、TP、MetaMask 等专属命名空间。钱包自己的品牌标识优先于兼容用的 `isMetaMask`，选择卡片不会改换实际 provider。
- 钱包选择弹窗打开期间持续检查延迟注入；初始化事件、页面恢复和焦点返回也触发检查，不再把“几秒内尚未注入”当作永久没有钱包。
- 页面回到前台时重新读取已授权账户和网络，处理部分 App 没有及时发出 `accountsChanged` / `chainChanged` 的情况。恢复会话只读 `eth_accounts` 等状态，不自动申请新权限、购买或重发交易。
- 为可能丢失原生回调的只读/连接等待设置期限。超时会给出完成或取消钱包已有提示后重试的说明；超时不表示交易已取消，也不会自动重试交易发送。
- 交易仍与选中的钱包、账户、网络和本次购买内容绑定，之前已取消的“上一笔待确认就禁止再次购买”限制不重新引入。

### 外部手机浏览器

`wallet-mobile-links.js` 生成如下仅用于打开网页的链接：

| 钱包 | 当前链接格式 | 证据性质 |
| --- | --- | --- |
| MetaMask | `https://link.metamask.io/dapp/{不含 https:// 的网页地址}` | MetaMask 自身官方文档 |
| OKX | `okx://wallet/dapp/url?dappUrl={encodeURIComponent(网页地址)}` | TRON 官方 EVM 钱包适配器的原始实现；并非本轮实体 App 测试 |
| TokenPocket | `tpdapp://open?params={encodeURIComponent(JSON.stringify({url:网页地址}))}` | TP 自身文档确认协议；TRON 官方 EVM 适配器确认仅传 `url` 的实现 |
| 币安、Trust、Rabby、Coinbase 等其他卡片 | 显示可复制网址和钱包内置浏览器指引 | 本轮未核实其任意网页链接格式，不拼接未经确认的内部 App ID 或链编号 |

App 链接是预先准备好的原生链接，由用户点击同步触发，不先等待 RPC、授权检查或网络请求。OKX 官方明确提示 iOS 上点击后的异步步骤可能影响 deeplink 打开，因此这里不把 App 跳转放在异步购买链路末尾。[OKX 连接 FAQ](https://web3.okx.com/onchainos/dev-docs/wallet/dapp-connect/app-connect-faq)

链接被操作系统拒绝、钱包未安装、App 没有打开目标网页时，用户仍可选中并复制网址；剪贴板 API 被拒绝时，保留可选择的文本，不显示虚假的复制成功。

### 跨 App 保留选择

生成的地址只携带公开的场次和选择内容，不复制任意原 URL 参数、钱包地址、管理状态、签名或待发送交易：

- 保留当前开放的 `5` / `10` / `50` 场次。
- 自动选号保留合法的购买份数，范围为 1 至 5,000；最终可买数量仍由新页面读取当前库存后确定。
- 手选号码先校验并压缩为连续区间，例如 `1-1000,2000`，再放入链接。压缩文本超过 1,200 个字符或内容无效时，使用明确的重新选择标记，新页面提示重新填写，不静默改成另一笔购买。
- 跨 App 不迁移浏览器的本地会话或交易日志；不会因为打开链接就自动购买。

### 旧 WebView 与受限存储

缺少原生 `dialog.showModal` 的 WebView 使用兼容弹窗；缺少 `crypto.randomUUID` 时使用 `crypto.getRandomValues` 生成交易标识；移除对新数组 `findLast` 方法的强依赖。之前对缺少 `AbortSignal.timeout` 的兼容继续保留。

若浏览器禁止读取/写入本地交易记录、存储数据损坏、缺少 Web Locks 或缺少安全随机数能力，页面尽量继续展示内容和连接选项，并说明问题。交易开始前检测到这些条件时不发送交易。存储不会退化成可能丢失已提交记录的临时内存日志；若写入异常发生在提交之后，也不能据此认定交易未发送，应按页面提示核对钱包中的结果。

## 验证记录

本轮交付前已完成的模拟验证：

| 验证集 | 本轮结果 | 覆盖内容 |
| --- | --- | --- |
| `test/bem-mobile-external.browser.mjs`，Chromium | 12 个场景通过 | Android / iPhone Chrome / Safari / iPad 身份、App 链接、场次与份数、手选号码、晚注入、禁用/耗尽存储、剪贴板拒绝、旧弹窗、恢复账户和断开连接 |
| 同一外部浏览器验证集，WebKit | 12 个场景通过 | 同一组页面行为在另一浏览器引擎中的验证 |
| `test/bem-binance-mobile.browser.mjs` | 28 个场景通过 | 模拟内置钱包发现、连接、网络和支付链路，包括之前的大份数与授权接购买行为 |
| 主回归测试集 | 174 项通过（主测试 145 + 钱包选择器 20 + RPC 批处理 9） | 回调超时、选择传递、受限存储、已有交易记录、钱包识别及资金流程回归 |

上述浏览器验证使用隔离环境、模拟 provider 和模拟链上响应；App 链接点击被拦截，只检查最终地址与交互，不交给真实操作系统打开钱包。没有使用用户钱包、签名、授权或发送真实交易。WebKit 通过说明该引擎中的页面逻辑通过，不等同 iPhone 上安装的钱包 App 已完成端到端验证。

本轮保留上一轮提前只读准备、并行查询和授权确认提速。这里没有新增真实手机弹窗耗时结论，也不将模拟网络下的时间写成所有用户的实际支付速度。页面到钱包请求、钱包原生确认框展示、用户确认、交易广播与链上确认是不同阶段。

2026-09-08 07:48 CST 已更新生产前端：25 个部署文件哈希一致，公网 15 个资源哈希及健康检查通过，前台服务和 keeper 进程均未变化。完整执行记录保留在本机本轮修复目录。

## 已知限制与后续核验边界

1. 本轮没有接入 WalletConnect、MetaMask Connect 或 OKX Connect 的远程会话。因此普通 Chrome 中点击后进入钱包内置浏览器；不承诺签名完成后自动返回原 Chrome 页面，也不承诺原页面继续持有钱包连接。MetaMask 与 OKX 的官方接入文档均将普通移动浏览器与注入接口的连接方式分开。[MetaMask 支持平台](https://docs.metamask.io/metamask-connect/supported-platforms/)、[OKX 连接前提](https://web3.okx.com/onchainos/dev-docs/wallet/dapp-connect/app-connect-preparation)
2. TP 的 `tpoutside://pull.activity` 是另一套操作协议，包含回调与签名/交易参数。本轮没有使用该协议；其 `callbackSchema` 不能当作 `tpdapp://open` 网页打开链接已支持自动回跳的证据。[TP DeepLink 文档](https://help.tokenpocket.pro/developer-cn/mobile-wallet/deeplink)
3. 钱包安装状态、首次解锁、系统链接关联、App 版本、网络、钱包自身风控或模拟交易耗时，均可能影响原生弹窗。页面无法移除钱包要求的用户确认，也不能保证网络及区块确认耗时。
4. 微信、Telegram、社交应用里的普通 WebView 可能限制外部链接；这类浏览器与真正的钱包内置浏览器不同。当前提供复制网址作为可见退路，不把成功生成 deeplink 当作 App 已打开。MetaMask 官方同样说明第三方 App WebView 的 deeplink 行为不一致。[MetaMask 支持平台](https://docs.metamask.io/metamask-connect/supported-platforms/)
5. 下一步实体设备核验应分别记录手机型号、系统版本、钱包版本、打开网页的应用，以及“点击到网站发出钱包请求”和“请求到原生确认框”的时间。先验证打开网页、连接、切换网络和恢复页面；真实授权/支付需要用户自行确认，不能用模拟结果替代。

## 协议与实现来源

- [MetaMask 官方打开 dapp 链接](https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/)：当前使用 `link.metamask.io/dapp/`，作用是在 MetaMask 内置浏览器打开网页。
- [MetaMask 连接架构](https://docs.metamask.io/metamask-connect/architecture/)：远程 relay、会话和注入连接属于不同传输路径。
- [TP 官方 DeepLink 文档](https://help.tokenpocket.pro/developer-cn/mobile-wallet/deeplink)：区分打开 dapp 和请求钱包操作；参数需编码。
- [TP 官方 JS-SDK 说明](https://help.tokenpocket.pro/developer-en/wallet/js-sdk)：内置浏览器兼容 MetaMask 等网络接口。
- [TRON 官方 TP EVM 适配器](https://github.com/tronweb3/tronwallet-adapter/blob/5afda1af4a4fb58c82a3351b7f040df55170d064/packages/adapters/evm/tokenpocket/src/utils.ts)：仅传 `{url}` 的 `tpdapp` 链接和 `window.tokenpocket.ethereum` 发现方式。
- [TRON 官方 OKX EVM 适配器](https://github.com/tronweb3/tronwallet-adapter/blob/5afda1af4a4fb58c82a3351b7f040df55170d064/packages/adapters/evm/okxwallet/src/utils.ts)：当前采用的 `okx://wallet/dapp/url?dappUrl=` 原生格式。
- [Thirdweb 官方 OKX 适配器](https://github.com/thirdweb-dev/web3-onboard/blob/03b25b0ade48b7cc8d48dd408741c7e211cf22ac/packages/okx/src/index.ts)：提供同一原生格式外包下载页链接的另一种实现，供参考；本轮使用原生链接。

钱包自身文档与第三方框架的原始适配器实现分别标明来源。源码示例可支持链接构造选择，但不代替对应实体 App 的版本验证。
