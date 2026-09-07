# 13061 自有容器正式场（V3）

仅新增 10、50、100 BEM 三份独立正式合约。已部署的 1 BEM 测试场以及 V1/V2 源码、编译产物不变；本目录不是原合约升级。

- 启动与 1% 收款容器：`0x001f110422F04a90bF7D6eC96714f75046BD7126`。
- 授权 NFT：TapeOut `0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C`，编号 `13061`。
- 计算合约：Behemoth `0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C`，编号 `2075`。其旧容器不再有启动权限。

部署构造参数仍为 `(uint256 vrfSubscriptionId, uint16 confirmations, uint32 vrfCallbackGasLimit)`。容器、NFT、金额均由各 leaf 固定，不能在构造参数中替换。`CONTAINER`、`AUTHORIZATION_NFT`、`AUTHORIZATION_TOKEN_ID` 与 `REVENUE_*` 对应同一个13061容器；`CIRCUITS` 和 `CIRCUIT_ID` 保持2075。

部署者与容器当前持有人可以不同。部署者不能直接调用 `authorizeSeries()`，13061持有人也不能从个人钱包直接调用；须由13061容器执行该调用。部署与启动都会核对容器 registry、opened 状态及 `token()` 的链/NFT/编号。启动仅一次，后续轮次不需要重复授权。

继承链为 `BemOwnContainer13061SeriesBSC` → `BemSelectableRaffle13061V3BSC` → `BemSelectableRaffleV3`。V3 独立复制原有网络及玩法层，修改购买数量计算，保持原 VRF、2075 计算、资金结算与退款逻辑；不引用或改写已部署 V2 的玩法实现。

`PARTIAL_FILL()` 固定返回 `true`。`buy(expectedRoundId,count)` 与 `buySelected(expectedRoundId,selectedTickets)` 均先验证请求为 1～1000 份，实际成交取请求份数、本期剩余份数、该地址剩余额度三者的最小值。按交易在链上的执行顺序分配。比如请求 1000 份但只剩 800 份，分配 800 份且仅 `transferFrom` 800 份的 BEM；另外 200 份金额从未扣款，留在用户钱包，不需要再发退款交易。授权额度只需覆盖实际扣款金额。

每个合法订单只发出一条 `PurchaseResult(uint256 indexed roundId,address indexed buyer,uint32 requested,uint32 filled,uint256 paid,uint256 unspent)`，其中 `paid = filled * TICKET_PRICE`，`unspent = (requested - filled) * TICKET_PRICE`。原 `TicketsPurchased` 日志仅记录实际分配的号码及其金额。前端须依据已确认的真实收据显示成交数量和未扣款金额，不能把预估份数当成已购份数。

自选号码必须整体合法（零起始、范围 0～9999、严格递增且不重复），包括因份额不足而不成交的尾部。验证后只处理实际成交数量的前缀，已售号码仍按原确定性算法顺延并在末尾回绕补位。

若某地址已达本期 5000 份上限，仍在筹集期的合法请求可零成交成功。若提交时指定的旧轮次刚被其他交易买满，`expectedRoundId < currentRoundId` 且旧轮 `sold == 10000` 的订单也零成交成功；零成交只记录 `PurchaseResult`，不扣款、不分配号码、不请求 VRF，更不会自动买入下一轮。未来或不存在的轮次、未满的旧轮、已截止轮次和非法选号仍拒绝；最终成交触发 VRF 失败时，分配与扣款仍原子回滚。

现有 1 BEM 测试合约不支持升级，本次部分成交行为只属于上述新 V3 正式合约。旧测试场保留原行为，不可仅修改前端就宣称其具备 V3 能力。

| 场次 | 每份 BEM | 总份数 | 销毁4% | 容器1% | 奖金95% |
| --- | --- | --- | --- | --- | --- |
| 10 BEM | 0.001 | 10000 | 0.4 | 0.1 | 9.5 |
| 50 BEM | 0.005 | 10000 | 2 | 0.5 | 47.5 |
| 100 BEM | 0.01 | 10000 | 4 | 1 | 95 |

所有场次单笔最多1000份、同地址同期累计最多5000份。已售选号保留原V2确定性顺延补位。24小时未满可退款，退款领取截至该期原始截止时间再加24小时，之后未退本金可转到dead地址；Requested/Ready/Settled 不进入退款或超时销毁。退款由用户显式发起、自己支付Gas。原合约层面允许第三方自愿调用退款但钱只退给参与者，项目不自动代付。

原VRF配置接口、60秒运营目标、8至30秒计划开奖时间、60秒下期冷却和2075拒绝采样计算均未变。极度离散的1000票可能超过 BSC 的16777216 Gas上限；客户端仍须估算后阻止超限交易，不自动拆单。

离线编译：`node scripts/compile_bem_own_container.mjs`。产物只写入 `outputs/bem-raffle-2075/production-v3/`。编译前后核对 `preserved-v1-v2.sha256.json` 内34个已部署文件，manifest 的总SHA固定在脚本中。运行码模板含immutable占位，部署后必须按实际构造参数和链上getter另行核对，不能把模板hash当实际链上hash。

本地集成测试：`node --test --test-concurrency=1 test/bem-production-own-container.test.mjs`。Windows内存紧张时可用 `node --expose-gc --single-threaded --max-old-space-size=384 --test-isolation=none --test test/bem-production-own-container.test.mjs`。测试使用Ganache依赖模拟，不证明真实VRF订阅/容器账户权限，也不向主网发送交易。

测试 helper 仅编译所需的轻量依赖 mock，并直接部署 V3 编译产物。覆盖三档容器授权、800/1000 自动及自选部分成交、仅实际金额授权、VRF 失败回滚、满额旧轮零成交、同地址额度及实际本金退款。`verification-own-container.json` 只有完整 10 项全部通过才标记 `passed`；筛选运行只记录部分证据。
