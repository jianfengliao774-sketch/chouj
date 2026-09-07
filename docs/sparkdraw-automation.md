# SparkDraw 自动开奖与保险箱

生产后台 `/admin.html` 的「自动开奖保险箱」用于绑定 Google Authenticator、启停服务和补充 Gas。初次绑定需要管理员在自己的手机输入设置密钥，并提交当前 6 位验证码。未绑定或暂停时，后台不签发新的交易。

独立执行钱包：`0xb4856db6cd174D5E09b9B844a107cCB6Fdd3CCD8`。五档合约共用这个 Gas 钱包。它不持有 13061 NFT，也不拥有用户奖金或退款的领取权限。网页不提供私钥显示、下载或主钱包私钥导入。

后台只签发五个固定合约的 closeRound、fulfillRandomness、settle、openRefunds、burnUnclaimed 和 burnUnclaimedPrize，交易 value 必须为零。目标未来 drand 轮次由合约确定，证明仍由链上验证；后台负责送达，不能选择中奖号码。奖金与退款仍归原收款钱包领取。

费用默认限制：单笔最高 0.001 BNB、Gas price 最高 0.1 Gwei、每日最多预留 0.003 BNB。超出限制会停止该笔发送并显示状态。预算按 UTC 签发日核算，包括回退交易的实际 Gas。节点、链或随机数服务不可用时重试，不能保证链本身永不延迟。

## 初次启用

1. 登录后台，点击「绑定谷歌验证器」。在 Google Authenticator 选择输入设置密钥、基于时间。
2. 输入验证码，点击「验证并开启自动开奖」。没有 BNB 时会显示等待 Gas。
3. 连接当前持有 13061 容器的钱包，选择拨款金额并在钱包确认。容器执行需额外协议调用费，当前链上 EXEC_FEE 为 0.0002 BNB，由持有人钱包支付；此外还有网络 Gas。执行钱包收到容器拨出的 BNB 后自动运行。

默认显示 0.003 BNB 拨款，但不自动转账。2026-09-07 已进行 0.003 BNB 的 eth_estimateGas 模拟，估算 136,927 Gas；模拟未签名、未发送资金。

## 服务器部署

`ops/sparkdraw-keeper.service` 用独立 sparkdraw-keeper 系统用户执行，flock 防止重复进程。服务器生成的执行私钥和 TOTP 密钥分别通过 systemd-creds 的主机密钥加密，保存在 `/etc/credstore.encrypted`；服务启动时由 systemd 提供只读凭据。主机加密不等于外部 HSM，服务器 root 仍是信任边界。不要将凭据、主机加密密钥、验证码设置密钥或签名交易原文放入仓库和日志。

网站加载 `ops/sparkdraw-vault.conf`，读取独立 TOTP 凭据。验证码用于绑定和启停操作，不用于每次开奖。既有管理员密码、同源检查仍适用。验证码单次使用、允许一个时间步偏差，连续五次错误需等待五分钟。

`/var/lib/sparkdraw-control/control.json` 由 app 用户写入，执行用户通过 app 组只读访问。初始 enabled=false。网站只读取 `/run/sparkdraw-keeper/status.json` 的公开运行状态。

私有交易日志保存在 `/var/lib/sparkdraw-keeper/journal.json`（0600），广播前先持久化签名和哈希；进程恢复只重播同一交易，确认三个区块后继续。已使用钱包缺少日志时拒绝启动，禁止删除日志以“修复”待确认交易。日志可能包含未广播签名，不得公开。

发布新版本后需重启网站和 sparkdraw-keeper 服务。检查 `/api/health`、后台状态与 systemctl is-active。回滚需暂停自动开奖并保留原日志、凭据及控制状态，再切换网站版本，不能重置 nonce 或凭据。

丢失验证器时应通过受控服务器维护重新绑定，保留执行私钥及交易日志。不存在网页绕过验证码的按钮。定期备份加密凭据、主机解密密钥及私有日志到受限存储，不能提交 Git。

## 前端协作

后台 UI 位于 `web/sparkdraw-vault-ui.js` 和 `web/admin.html`。`automation-wallet.js` 仅含公开地址。业务签名约束位于 `sparkdraw-automation-core.mjs`，执行循环位于 `sparkdraw-automation.mjs`。页面修改不得添加任意目标、任意 calldata、私钥导入或自动拨款接口。

运行 `node --test test/bem-sparkdraw-automation.test.mjs test/bem-sparkdraw-service.test.mjs test/bem-sparkdraw-replay.test.mjs` 验证维护白名单、TOTP、后台鉴权和卷轴回放。`node scripts/check_automation_funding.mjs` 只读核对容器费用及模拟拨款，不广播交易。
