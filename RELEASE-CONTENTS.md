# 发布包范围

本目录从原工作区按显式白名单导出。已复制的源码与源文件字节一致，未复制其他项目，也没有更改原工作区 Git remote。`release-files.json` 记录这次复制的路径、大小与 SHA-256；它是导出快照，不替代后续 Git 提交校验。

## 包含

- `contracts/production-v2/` 与 `outputs/bem-raffle-2075/production-v2/`：四档已部署合约、明确白名单的公开编译文件、新容器只读核查、部署恢复证据及本地测试报告。部署与启动状态分别展示。
- 玩家场次选择、奖金行情卡、悬浮中奖播报、销毁记录页、钱包部署核对页，以及独立的 1 BEM 启动和测试交易入口。10/50/100 BEM 场次保持关闭。V2 Keeper 当前仅为不发送交易的计划生成器，接入要求见新合约交付说明。

- `bem-production-site/`：生产站点源码、双语玩家页面、中文后台、只读 RPC、登录鉴权和持久化历史组件。
- `contracts/production/`：原 4 份生产合约；`Bem2075RaffleBSC` 是旧站保留的已部署目标。
- `scripts/`：固定源码编译、主网依赖只读核查、生产 keeper、部署准备和回执登记源码。
- `outputs/bem-raffle-2075/production/`：最终合约 ABI 与编译证据、公开部署/订阅报告、发布配置与相关文档。
- `test/`：正式站点、生产合约及 keeper 的本地测试，包含钱包混合发现、交易替换、退款和实际页面事件回归。

## 保留的兼容依赖

`contracts/BemCircuitRaffle.sol` 与 `contracts/mocks/` 下的两个文件仅为生产合约回归测试提供本地依赖，不是新的部署目标。

`scripts/run_bem_raffle_keeper.mjs` 被生产 keeper 核心导入其读取与决策函数，因此保留其原始源码及 `BemContainerRaffleBSC.abi.json`。运行生产 keeper 应使用 `run_bem_production_keeper.mjs`，不应将旧入口用于已部署的生产合约。

`deployment-preferences.json`、`subscription-readonly.json` 与 `circuit-2075.json` 是依赖核查脚本的公开输入。旧订阅报告只提供 ABI/历史证据；当前订阅选择以发布计划和最新只读核查为准。

部署准备和登记脚本原本会写入 `local-bem-demo/web/production-deployment.json`。为保持源文件不变，本包只保留空兼容目录，不包含旧 demo 网页或部署按钮。当前已有部署记录，准备脚本会拒绝重复部署；日常启动网站无需运行这两个归档操作脚本。回执登记虽不写链，会更新本地公开配置，不应当作无副作用的状态查询命令。

## 排除

不包含构建后的 `dist`、`node_modules`、链节点、运行日志、索引缓存、钱包文件、环境文件、管理员会话、签名交易日志、私有 keeper 状态或其他项目源码。安装与构建产生的目录受 `.gitignore` 排除。

旧本地演示站点、旧状态页及旧部署页测试不属于现有正式站点，未复制。一次性的旧订阅探针、旧分叉测试和无关历史报告也未复制。正式网站的最新验证结论见 `outputs/bem-raffle-2075/production/WEBSITE-VERIFICATION.md`；最终安装/构建/测试结果由发布前核验补充。
