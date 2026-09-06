# BEHEMOTH #2075 正式版准备

本目录记录正式版源码、部署与验证结果。正式游戏已部署并核验，尚未开放真实 BEM 参与。`http://127.0.0.1:8788/` 仍是原本的本地测试；发布准备页为 `http://127.0.0.1:8788/production.html`。

正式游戏地址：`0xBee0848D0c77d434A52d1D0236FcBFdCA0834343`。部署交易为 [0x7ba263…70dfa](https://bscscan.com/tx/0x7ba26384f8e36e3e9112a29a40464a7a6e77f59ccb2ec6b3c12ee3e8ca070dfa)，区块 120311123。创建参数和运行时代码已与本地编译产物核对，证据见 `deployment-verified.json`；这与 BscScan 的公开源码验证是独立步骤。

## 已确定的正式配置

- BNB Chain 主网，Chain ID 56；官方 BEM，8 位精度。
- 真实调用 BEHEMOTH #2075 完成开奖计算。VRF 提供随机输入，时间只安排开奖，不作为随机数来源。
- 正式启动授权与每期 1 BEM 收入都使用 #2075 自己的官方容器：`0x358BE84b95224d228f3A61964Fa3c9fB61D7B646`。TapeOut #13043 是此前的测试选择。
- 每期 100 BEM，10,000 个号码，每号 0.01 BEM；可自选或自动分配未售号码。签名固定期号及选择，冲突整笔回滚。正式版每筆最多购买 500 份，可以分别签名多笔交易；页面不自动拆单。上限来自 BNB 主网单笔 Gas 限制及最坏分散选号测试。
- 同一结算交易依次转出 4 BEM 至黑洞、1 BEM 至容器、95 BEM 至中奖钱包。黑洞转移不减少代币 `totalSupply`。
- 72 小时未满允许退款。请求随机数后不取消、不重抽。满额后一分钟是运行目标；如果 VRF 或执行交易延迟，继续等待同一个结果。结算后 60 秒才可开始下一期。
- NFT 不托管；容器一次启动授权之后，不再要求持有人为每期开奖签名。

正式部署目标是 `contracts/production/Bem2075RaffleBSC.sol`，不能把基础层 `BemSelectableRaffle` 或 `BemSelectableRaffleBSC` 当作完整连续开奖产品发布。最外层固定 2075 的处理器和容器，部署参数仅为 VRF 订阅 ID、确认数及回调 Gas 上限。

## 自动发奖与 Gas 资金

中奖人无需提交领奖交易。专用自动开奖钱包（keeper）付 BNB Gas，调用固定规则的 `settle`；抽奖合约按票号归属向中奖钱包支付 95 BEM。它同样可触发下期开盘及未满额退款开放，无权改赢家、改分账或提走奖池。

Gas 资金来源采用用户选择的 2075 容器：持有人通过容器 `execute` 预拨一笔 BNB 给专用 keeper。容器合约不能自行签发普通交易；此方案不包含自动从容器无限扣款的权限。专用 keeper 地址与预算尚需配置，余额不足时暂停推进并提示充值。

VRF 订阅余额另行充值 BNB，支付随机数费用。它与 keeper 余额、容器余额是三处不同的链上余额，都不从每轮 100 BEM 扣取。容器执行操作还需按官方协议支付执行费；读取时的费用及余额见带时间戳的依赖报告。

## 订阅充值与配置顺序

1. 在 [Chainlink VRF](https://vrf.chain.link/) 连接订阅所有者钱包，选择 BNB Chain 主网。
2. 打开要用于正式版的订阅，选择 Actions → Fund subscription，资产选 BNB。中文机器翻译界面可能显示为“基金认购”。
3. 核实完整订阅 ID、所有者及链上到账余额。用户先后创建了多条订阅，不能只按截图尾号或旧创建交易推定本次充值对象。
4. 对最终源码完成验证后部署 `Bem2075RaffleBSC`，保存部署回执、完整参数和实际运行时代码哈希，并公开验证源码。
5. 在该订阅 Add Consumer 中加入真实部署的抽奖合约。消费者不是处理器、容器、NFT 持有人或本地测试合约。
6. 配置生产网页、链上事件索引与 keeper，准备 Gas 余额；最后由 2075 持有人通过容器一次调用 `authorizeSeries()` 开启售票。

已确认的正式订阅为 `77582411398321098948652233841078712279496169525251928512909841261362926957679`，持有人 `0x304F06903324B8056cB1ED627144EfB2C34df3a8`。区块 120312598 的余额是 0.01 BNB，消费者已包含上述正式游戏地址，尚未发生真实 VRF 请求。证据见 `dependencies-readonly-2026-09-06T13-43-56-447Z.json`。

## 用户钱包部署

以下保留部署过程以便复核。本次部署已经完成，不要再次部署；准备脚本和签名页均已禁止重复创建。

运行 `node scripts/prepare_bem_production_deployment.mjs`，核对最终四份源码、完整 12 + 7 项测试及编译资料，读取主网订阅/容器，并模拟部署 Gas。它只生成未签名的部署资料，不发送交易。公开文件 `web/production-deployment.json` 有 30 分钟有效期；准备失败会取消旧的可用资料。

签名页面为 `http://127.0.0.1:8788/deploy-production.html`，需要在安装钱包扩展的浏览器中打开。用户先连接 `0x304F…f3a8` 钱包，再审核真实部署交易。连接不会自动部署，部署不会自动添加消费者或开放售票。

取得部署交易哈希后，运行 `node scripts/record_bem_production_deployment.mjs 0x交易哈希`，核对创建交易原文、成功回执、实际运行时代码与全部固定参数，然后登记真实合约地址。这个核验命令同样不签名、不广播。只有经核实的实际创建地址才能添加到 VRF 消费者中。

官方依据：[订阅充值及消费者配置](https://docs.chain.link/vrf/v2-5/subscription/create-manage)、[BNB 主网 VRF 配置](https://docs.chain.link/vrf/v2-5/supported-networks#bnb-chain-mainnet)、[VRF 安全要求](https://docs.chain.link/vrf/v2-5/security)。

## 构建与证据

独立静态编译：`node scripts/compile_bem_production.mjs`。此命令不连接 RPC、不持有签名钱包，也不会修改旧版合约产物。`*.compile-input.json` 可用于源码核验；`*.artifact.json` 包含源码 SHA-256、编译器和 ABI。编译出的运行时代码是含待填 immutable 的模板，不能当成已部署代码哈希。

只读链上依赖检查：`node scripts/check_bem_production_dependencies.mjs`。报告记录区块号、区块哈希、时间、真实 BEM、2075 网表、容器绑定和订阅状态。读取成功只证明该快照中的相应事实，不表示整局真实 VRF 已验证。

本地单元测试使用隔离内存链与 mock，报告明确标注 `local_mocks`。正式交易的 Gas 需符合 [BNB Chain Mendel / BEP-652 单笔限制](https://docs.bnbchain.org/announce/mendel-bsc/)，不能用放宽 Ganache 区块上限代替主网可发送性验证。

公开真实资金前尚需完成：最终源码独立审查及公开验证、真实依赖及 VRF 全流程验证、独立生产网页的钱包身份校验、可恢复的链上历史索引、keeper 交易状态持久化与运行配置，以及运营后台认证。最后由容器授权启动系列。发布准备页逐项展示证据和未完成项。
