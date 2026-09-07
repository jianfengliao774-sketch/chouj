# BEHEMOTH 2075 链上开奖

这是 BNB Chain 主网合约对应的独立网页、中文管理后台、合约源码与自动执行器规划模块。玩家页面支持中英文切换。1 BEM 场用于真实钱包测试，10/50/100 BEM 正式场次保持关闭。

## 新场次版本

首页提供 10、50、100 BEM 场次选择，`/?pool=1` 提供内部 1 BEM 场次。四档均为 10,000 份、单笔最多 1,000 份、每地址每期累计最多 5,000 份。新合约采用 24 小时募集、随后固定 24 小时本金自领期限，超期未领本金可通过链上交易销毁。收款容器改为 `0x001f110422F04a90bF7D6eC96714f75046BD7126`；计算和启动授权继续使用原 2075 处理器及授权容器。

四份新合约已从主网创建交易中找回，并核验完整创建输入、运行代码和固定参数。部署证据见 [recovered-deployments-verified.json](outputs/bem-raffle-2075/production-v2/recovered-deployments-verified.json)。历史状态被公共 RPC 裁剪的部分明确标为不可用，固定参数改在同一最新区块读取。

| 场次 | 已核验地址 |
| --- | --- |
| 1 BEM 内部测试 | `0xE7D8dF903050d875f09cE1BBcE20E837fB55bC0c` |
| 10 BEM | `0x3335ec04A7509aDE8E6C4Bc851fE409EE063a2bc` |
| 50 BEM | `0x498ef8D499ca9940D3b3B1BBd31b2684AB35962B` |
| 100 BEM | `0x2009FDe00618C06Fa2e88bE6a2FA590941437f9D` |

使用 `/start-test.html` 配置 1 BEM 场：订阅管理员添加新消费者，然后 2075 容器的当前持有人通过容器执行一次性启动。当前这两个权限属于同一个 `0x304F…f3a8` 钱包。容器执行协议费固定为 0.0002 BNB，由持有人钱包随执行交易支付，钱包另付网络 Gas；容器不必预存 BNB。两步均单独核对并由用户在钱包确认，达到 12 个确认后验证交易事件和当前状态。

配置完成后，`/?pool=1` 提供精确金额授权、购买、本人退款和手动测试结算。每次提交前核验链、钱包、代码、场次、库存、累计限额、期限及 Gas；待确认或未知结果持续阻止重复提交。1,000 份是 0.1 BEM；完整一轮至少两个参与钱包各 5,000 份，共十笔购买。VRF 返回后使用页面结算按钮，结算可能只推进计算，需要再次明确点击。自动执行服务尚未配置，本版本不宣称自动派奖服务已运行。原合约入口保留在 `/legacy.html`，旧规则和旧身份检查保留。

`/deploy-container.html` 提供四档的独立部署核对、费用估算、钱包部署和回执恢复。页面不会自动开售、注册 VRF 消费者或调用容器授权。候选源码、编译包和规则见 [新合约说明](contracts/production-v2/README.md)，网站和待完成的上线步骤见 [新场次交付说明](contracts/production-v2/WEBSITE-RELEASE.md)。

奖金卡展示 BEM 奖金和独立 BEM/USDT、BEM/WBNB 市场报价换算；后端按地址核验交易对、每 60 秒缓存更新，读取失败明确停止展示实时换算。报价只用于参考展示，不参与任何票价或结算计算。悬浮中奖播报和 `/burns.html` 使用五份合约各自的固定身份索引，只有经过 12 个区块确认、成功回执及主链检查的记录才显示；奖金随实际档位计算，逾期本金销毁保留实际金额和哈希。

## 本地启动

使用 Node.js 24 与 pnpm 11.19.0：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm start
```

本地首页：<http://127.0.0.1:8788/>，后台：<http://127.0.0.1:8788/admin.html>。若端口被占用，可用 `pnpm start --port 8789`。服务只监听本机地址。生产入口为 <https://tapeout.cc.cd/>，由 Nginx 提供 HTTPS，`BEM_PUBLIC_ORIGIN=https://tapeout.cc.cd`。

网站启动时核对链 ID 和已部署代码哈希。它通过只读 RPC 读取主网，服务端不能签名或广播交易。后台使用管理员账号密码登录，现有后台仅查看状态。启动前必须设置 `BEM_ADMIN_CREDENTIALS_FILE`，指向仓库和网页目录之外、权限受限的凭据 JSON 绝对路径。其内容由 `createAdminCredential(username, password)` 生成（见 `bem-production-site/auth.mjs`），只保存 scrypt 盐及散列；不要把真实密码、散列或环境文件提交仓库。已部署服务继续使用原有受保护的凭据文件。

玩家页面合并识别 EIP-6963 和旧接口钱包，连接本身不授权或购买。授权与购买分别由钱包确认。交易记录跟踪原交易以及相同 nonce 的加速/取消交易；没有链上证据时显示待核实，不把超时当作失败，也不会自动重发。

「退回本金」支持查询当前或往期期号，符合退款条件时由用户确认交易，本金直接退回连接的钱包。退款不依赖网站开售开关，无需 BEM 授权，需 BNB 支付网络费。退款条件与金额会在发送前重新读取链上状态。

## 原合约的固定链上配置

| 项目 | 配置 |
| --- | --- |
| 网络 | BNB Chain，chain ID 56 |
| 正式合约 | [`0xBee0848D0c77d434A52d1D0236FcBFdCA0834343`](https://bscscan.com/address/0xBee0848D0c77d434A52d1D0236FcBFdCA0834343) |
| 部署区块 | 120311123 |
| 处理器 | BEHEMOTH #2075，不托管 NFT |
| 组织方收款容器 | `0x358BE84b95224d228f3A61964Fa3c9fB61D7B646` |
| 每期 | 100 BEM，10,000 份，每份 0.01 BEM |
| 每笔购买上限 | 500 份，可自由选号 |
| 结算 | 先转 4 BEM 到黑洞、再转 1 BEM 到 2075 容器、最后转 95 BEM 给中奖钱包；同一交易原子完成 |

黑洞转账不会减少 BEM 的 `totalSupply`。开奖依赖 Chainlink VRF；一分钟为目标时间，受随机数回传及网络确认影响。结算后冷却 60 秒可开下一期；72 小时未凑满可按合约规则退款。

完整订阅 ID、固定参数、部署回执与代码哈希见 [release-plan.json](outputs/bem-raffle-2075/production/release-plan.json) 和 [deployment-verified.json](outputs/bem-raffle-2075/production/deployment-verified.json)。公开报告都有各自快照时间，不应视作实时余额。

## 构建与核查

`pnpm run compile:contracts` 使用锁定的 Solidity 0.8.36 编译 4 份静态生产源码，并写出 ABI、创建字节码及运行时代码模板。模板尚未填入构造参数，与部署后的代码哈希不能直接等同。

`pnpm test` 运行本地合约回归、选号与签名前置检查、RPC 限制、管理登录、历史索引和 keeper 恢复测试。合约测试使用本地 Ganache；测试不发送主网交易。它们会更新公开的 `verification-*.json` 测试报告。

`pnpm run check:chain` 只读核查主网订阅、容器与处理器，并另存带时间戳的报告。`pnpm run keeper:inspect` 仅输出一次 keeper 只读快照。默认命令均不加载 keeper 私钥、不执行交易。

生产 keeper 尚未配置专用钱包、资金或自动运行。实际执行需独立配置与授权；请按 [运行说明](outputs/bem-raffle-2075/production/OPERATIONS.md) 操作。VRF 订阅的 BNB 余额与 keeper 支付网络费的 BNB 余额分开管理，不从 100 BEM 奖池扣除。

## 数据与目录

历史从部署区块开始索引，仅显示确认至少 12 个区块的合约事件与回执；追赶、失败和无记录会区别显示，并支持重组回滚。Windows 索引数据默认放在 `%LOCALAPPDATA%/Bem2075/website/`，其他平台位于用户目录 `.local/share/Bem2075/website/`，不放在网页或仓库中。

发布内容和历史兼容依赖见 [RELEASE-CONTENTS.md](RELEASE-CONTENTS.md)。源码复制清单与 SHA-256 见 [release-files.json](release-files.json)；后续修改文件后需重新记录对应校验值。`.gitattributes` 禁止 Git 自动转换换行，以确保 Windows 和 Linux 克隆后保留合约源码的固定 SHA-256。
