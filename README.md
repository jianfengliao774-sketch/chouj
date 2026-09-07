# BEHEMOTH 2075 链上开奖

这是 BNB Chain 主网合约对应的独立网页、中文管理后台、合约源码与自动执行器。玩家页面支持中英文切换。当前版本保持售票关闭；部署成功和网页可访问不代表已经开售。

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

## 固定链上配置

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
