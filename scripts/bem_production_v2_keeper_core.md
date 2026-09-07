# V2 Keeper 规划器

`bem_production_v2_keeper_core.mjs` 目前只有纯函数规划能力。它不读取私钥、不连接 RPC、不签名、不广播交易，也没有定时服务。正式运行仍需要单独配置并验证专用 Keeper，接入读取、重组检查、费用限制、签名与确认流程。V1 Keeper 保持原样，不能直接用于新合约。

`planV2KeeperActions(profile, snapshot)` 返回当前区块下可执行的候选动作以及 `nextAction`。允许的方法只有 `settle`、`openNextRound`、`openRefunds`、`burnUnclaimed`。不会为用户领取退款；退款由网站用户自行操作并支付 Gas。

每次只能在独立模拟、授权、费用检查通过后选择一个动作。完成或等待该交易后，重新获取并核验状态再规划。`eligible` 是在同一个快照下分别成立的动作列表，不是可以直接连续发送的批处理。

## 输入

`profile` 包含：

- `schemaVersion: 2`、`kind: "bem2075-v2-verified"`、`chainId: 56`。
- `contractName` 为四个固定 V2 最终合约之一；`address` 与完整 `runtimeCodeHash` 为已核对的新部署。
- `getters` 包含实际链上固定读取值，包括金额、容器、2075 处理器、24 小时募集/领取窗口、1000 单笔/5000 地址限制及 VRF 参数。
- `verification` 含 `runtimeVerified: true`、`gettersVerified: true`、相同的地址/链/代码哈希，以及 `blockNumber`、`blockHash`。

上述验证结果必须由调用方读取规范链区块并核验代码与 getters 得出；单纯给 JSON 字段填 `true` 不构成链上验证。本规划器无法证明外部输入的真实性。

`snapshot` 的地址、链、运行代码哈希、区块号和区块哈希必须与本轮 `profile.verification` 完全相同。快照还包括 `timestamp`（链上区块时间）、`currentRoundId`、`seriesAuthorized`、`nextRoundOpensAt`、`totalLiability`、`historyComplete`、`rounds`。

每条 `rounds` 数据包含 `roundId`、`status`、`sold`、`fundingDeadline`、`requestId`、`refundedPrincipal`、`unclaimedPrincipalBurned`、`refundClaimDeadline`。`Ready` 期还需要 `timing.lockedAt` 和 `timing.scheduledDrawAt`。字段名称对应新 ABI 的 `rounds()`、`drawTiming()` 及退款 getters；整数字段支持 BigInt、十进制字符串或安全整数。

`historyComplete: true` 表示提供从 1 到当前期的所有快照，规划器会核对数量、唯一性与总负债。若只提供部分历史，应传 `false`；输出会明确提示历史不全，不会声称已查过全部旧轮。至少必须包含当前期；没有紧邻上一期的状态就不会计划开启下一期。应持续读取尚有退款负债的旧期，防止遗漏过期本金。

## 决策

到期未满额先计划 `openRefunds`，空期同样推进，避免不断调用零金额销毁。到固定领取截止后，只有 Funding/Refunding 期且尚有未领本金才计划 `burnUnclaimed`，金额严格等于该期 `sold × TICKET_PRICE − refundedPrincipal`。Requested、Ready、Settled 期绝不退款或销毁。已退款、已销毁、零金额期不会再次销毁。

优先顺序为：到时结算、开放到期退款、处理过期未领本金、冷却结束后开启下一期。所有输出交易的目标都是验证过的游戏地址，原生币 `value` 固定为零；规划器不生成 `refund`、购买、授权或管理员操作。

本地单元测试：`node --test test/bem-production-v2-keeper.test.mjs`。全部测试使用合成数据，无网络及真实交易。
