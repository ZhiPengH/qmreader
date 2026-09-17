# 方寸独立凭据接入：Agent 交接文档

交接日期：2026-09-17。范围：macOS Hermes 的 fangcun（方寸）插件、懒猫独立凭据接入及后续页面扩展。

**当前停点：实现和本机安装已经完成，短时运行验收通过。用户准备换 Agent 接手；尚未指定新的页面名称、网址或新的实现任务。** 接手时先核对现场与下述记录，不要从头重做认证，也不要把“写交接文档”理解为再次安装、重启或部署的授权。

本文是一次交接快照。唯一当前工作记录仍是 [NookDeck/docs/zonglan-news.md](/Users/huangzhipeng/Documents/App-ZhiXing/NookDeck/docs/zonglan-news.md)，后续决定、验收和待办继续更新到那里；本文负责提供接手入口，不另起一份持续维护的项目进度。

## 1. 用户要解决的问题与已经确定的方案

用户观察到：在方寸内登录懒猫网页后，懒猫微服 Mac App 需要重新登录；反过来也会影响方寸。原网页登录互相失效的服务端原因尚未确认，不能写成已经查明单会话限制或 Cookie 冲突。

已采用 **Hermes 宿主使用独立凭据访问懒猫应用** 的方案：

- 方寸打开应用时不再要求输入懒猫账号密码，保留懒猫本身的访问认证。
- 使用 `Lzc-Api-Auth-Token` 请求头；凭据绑定懒猫用户 `cosiohzp`，由 `hc api_auth_token` 生成。
- Electron 主进程只在指定持久化分区、精确 HTTPS origin 上注入认证头；不将凭据交给页面、插件 IPC 或 URL。
- 不复制懒猫 Mac App 的 Cookie，不自动填写账号密码，不通过开放匿名访问实现免登录。
- 本轮没有修改 QMReader／Stencil 服务器代码，也没有执行服务器部署、commit、merge 或 push。

现有入口：

| 页面 | URL | Electron partition |
| --- | --- | --- |
| Stencil | `https://stencil-web.jerryhuang.heiyu.space/` | `persist:fangcun-stencil` |
| 纵览News | `https://zonglan-news.jerryhuang.heiyu.space/` | `persist:fangcun-zonglan-news` |

懒猫入口认证与网页应用自己的登录是两个层次；新页面即使通过懒猫认证，也可能仍有自己的登录要求。

## 2. 先读什么，去哪里改

1. 阅读对应仓库 `AGENTS.md` 和全局 [工作约定](/Users/huangzhipeng/.codex/AGENTS.md)。
2. 阅读唯一当前工作记录末尾的「方寸独立凭据正式接入」及本交接入口。前一节「方寸独立凭据验证」是历史试验阶段，其中“正式接入待定”已被后续实施替代。
3. 核对实际源码、未提交修改、运行程序和插件来源，再根据用户的新要求开展工作。

| 用途 | 位置与说明 |
| --- | --- |
| 当前工作记录 | `/Users/huangzhipeng/Documents/App-ZhiXing/NookDeck/docs/zonglan-news.md` |
| 本文所在项目 | `/Volumes/HzpSSD/Development/qmreader`；这是 News 应用仓库，方寸认证代码在下面两个仓库中。 |
| 方寸开发 worktree | `/Volumes/HzpSSD/Development/worktrees/zonglan-news/fangcun`；主要文件 `plugin.js`、`tests/news.test.cjs`、`tests/viewswitch.test.cjs`、`scripts/provision-auth.py`。 |
| 实际安装的方寸插件 | `/Users/huangzhipeng/.hermes/desktop-plugins/fangcun/plugin.js`。 |
| 方寸旧 profile 仓库 | `/Users/huangzhipeng/.hermes/profiles/line/desktop-plugins/fangcun`；此前没有同步此副本，不能假定它是当前运行入口。 |
| Hermes 认证开发 worktree | `/Volumes/HzpSSD/Development/worktrees/hermes-fangcun-auth`；宿主代码在 `apps/desktop/electron/`。 |
| Hermes 本机源码 | `/Users/huangzhipeng/.hermes/hermes-agent/apps/desktop`；认证模块、测试和启动注册已同步到这里。 |
| 已安装的实际程序 | `/Users/huangzhipeng/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app`；安装时 `/Applications/Hermes.app` 只是启动入口，接手时重新核对进程。 |
| 正式认证配置 | `/Users/huangzhipeng/Library/Application Support/Hermes/embedded-session-auth.json`；包含真实凭据，不复制到聊天或项目文档。 |
| 已有安装前备份 | `/Volumes/HzpSSD/Development/Runtime/fangcun-before-independent-auth.20260917-110443/`。 |

认证相关宿主文件：

- `electron/embedded-session-auth.ts`：配置校验、精确 origin 匹配、认证头注入及剥离、登录路径拦截。
- `electron/embedded-session-auth.test.ts`：匹配、跳转、失效凭据、存储及隔离行为测试。
- `electron/main.ts`：调用 `installEmbeddedSessionAuth`，在主进程启动时注册。

### 本次文档交接时的现场核对

以下是 2026-09-17 的只读检查结果；不是重新做了一遍运行验收。

| 仓库 | 分支 / HEAD | 本次写文档前的状态 |
| --- | --- | --- |
| qmreader | `codex/zonglan-news` / `cb2eda11514a` | 工作区干净；本文和入口调整是这次新增的文档改动。 |
| NookDeck | `main` / `348dce8380db` | `docs/handoff-codex.md` 已修改；`AGENTS.md`、`docs/zonglan-news.md`、`docs/evidence/` 尚未跟踪。 |
| 方寸 worktree | `codex/zonglan-news` / `5e4e90ea869e` | `plugin.js` 已修改，`AGENTS.md`、`scripts/`、`tests/` 尚未跟踪。 |
| Hermes 认证 worktree | `codex/fangcun-independent-auth` / `cedf4a3d7867` | `main.ts` 已修改，认证模块及测试尚未跟踪。 |
| Hermes 原仓库 | `main` / `cedf4a3d7867` | 认证改动之外，还存在 Python／飞书相关修改与备份，须保留。 |

另外已核对：

- 方寸开发文件与全局安装文件的 SHA256 一致：`f5deba8e3e7f007da5da631ca5970d3b5090d6f2821c62a663e8d227d182afa6`。
- Hermes 两处源码的认证模块、认证测试内容一致；本机 `main.ts` 含安装调用。
- 正式配置文件存在，权限为 `0600`，所属 UID 为 `501`；本次仅读取文件元数据，没有读取凭据内容。
- 安装程序和旧备份目录存在。本次没有重新检查正在运行的 UI、安装包内容或在线认证。

**未提交的实现不会随一次全新 clone 自动出现。** 换电脑或隔离工作区时，先确认上述未提交文件和脱敏证据可以访问；不要用 `reset`、`clean` 或旧副本覆盖它们。

## 3. 接手必须保留的行为

### 认证与隔离

- 配置格式为 `version: 1`，`entries` 包含 `partition`、`origin`、`header`、`secret`、`blockedPaths`。当前实现每个 partition 只接受一条绑定，不应复用 Hermes 默认或保留分区。
- origin 精确比较协议、主机及端口；不以域名后缀或通配放行。跨 origin 请求和重定向必须剥除配置认证头的所有大小写变体，默认会话不能得到凭据。
- 保持 `sandbox`、`contextIsolation` 和关闭 `nodeIntegration` 的现有隔离；不关闭 `webSecurity`。
- 当前存储沿用 Hermes 的全局策略。安装时该策略为 `off`，所以是受 `0600` 文件权限保护的明文，不是钥匙串加密。不要擅自切换全局策略。
- 凭据具有绑定用户的服务端权限；域名限制是本机宿主控制，不能描述成服务端已限制到两个应用或只读权限。

### 失效与登录跳转

懒猫可能把应用请求重定向到设备主域名 `https://jerryhuang.heiyu.space/sys/login`。因此必须在整个指定分区处理登录路径，不能只拦截 Stencil／News 的 origin；编码路径和尾部斜杠也有对应测试。

认证不可用时，方寸隐藏 guest 页面并显示恢复提示：

> 独立访问凭据不可用。请恢复方寸凭据并重启 Hermes，再重新打开页面。

不要把账号密码表单重新作为恢复路径。认证配置变更后需要完全退出并重启 Hermes，单纯重新打开 webview 不会重新读取主进程配置。

### 脚本与升级限制

`scripts/provision-auth.py` 是既有两项绑定的初始化／撤销工具，**不是通用新增页面命令**。初始化要求配置不存在；撤销要求配置仅含预期的两项绑定、使用同一个明文凭据。不要删除现有配置来强行初始化，也不要在增加新绑定后直接套用旧撤销流程。

这是本机宿主补丁。Hermes 升级后须检查源码、启动调用和实际安装包是否保留；配置文件仍在或缓存页能打开，都不足以证明补丁仍生效。

## 4. 已完成的验收与证据

以下结果来自 2026-09-17 实施阶段的记录和证据，未在本次纯文档交接中重跑。

| 验收 | 结果与边界 |
| --- | --- |
| 自动检查 | 宿主 2 个表驱动测试、方寸 7 项行为测试、Electron TypeScript 检查、新模块及测试 ESLint 通过。 |
| 真实 Electron 网络隔离 | Electron 40.10.2、本地 HTTPS 双站、dummy 凭据：目标 origin 带头、302 跨站不带头、默认会话不带头、跨站及编码登录路径拦截通过。 |
| 页面与重开 | 两应用显示真实正文，切换／重开成功；独立进程退出再启动后的读取通过。 |
| 可逆写入 | Stencil 创建临时条目、读回服务端 revision、精确清理通过；News 收藏 true → 读回 → false，测试状态恢复。 |
| 无效凭据 | 完整 Hermes 隔离实例中，两页均显示恢复提示，没有账号密码表单。 |
| 本机安装 | 当时 app.asar 只变更 `dist/electron-main.mjs`，unpack 标记未变，严格签名检查通过；日常 Hermes 重启后网关就绪，两页正文可见，Stencil 再次重开正常。 |
| 懒猫 Mac App 共存 | 测前及安装后实际刷新内部启动器，仍可正常使用；不是仅凭原生“已连接”标签判断。 |

证据目录：[fangcun-auth-implementation-2026-09-17](/Users/huangzhipeng/Documents/App-ZhiXing/NookDeck/docs/evidence/fangcun-auth-implementation-2026-09-17)。优先读 [summary.json](/Users/huangzhipeng/Documents/App-ZhiXing/NookDeck/docs/evidence/fangcun-auth-implementation-2026-09-17/summary.json)，按需查看：

- `install-report.json`、`candidate-integrity.json`：安装位置、备份、哈希和打包变化。
- `wire-report.json`：真实 Electron 请求隔离。
- `qa-report.json`、`restart-report.json`：读写、清理和重启结果。
- `wire-check.cjs`、`qa-main.cjs` 等：历史复现工具。临时 profile、凭据副本等已经清理，不能假定工具可直接重跑；尤其写入测试须先阅读和重建隔离条件。

未完成或不能下结论的部分：

- 长期登录保持、实机睡眠唤醒、实机断网恢复仍未验收；仅对隔离分区做过模拟离线，缓存页面仍显示，结果不足以证明断网恢复。
- 网页登录互相失效的根因没有查明；当前方案证明了当次测试窗口内的共存。
- Hermes 后续版本升级后的补丁保留情况尚无证据。
- 服务端应用级最小权限没有实现；加密存储尚未启用。若用户要调整，应先说明具体权限或存储变化，再按新任务处理。
- 工具实测通过不等于用户已亲自完成全部验收，也不自动关闭其他 News 产品待办。

## 5. 下一位 Agent 的起步顺序

1. **先做只读接手检查**：读工作记录、查看各仓库状态、确认源码与安装入口。不要重新登录懒猫或生成新凭据来“探路”。
2. **接收用户的下一项具体要求**：可能是检查现有实现、增加页面、修复新问题或补充长期场景验收；这些目前都不是已指定的新开发任务。
3. **如有新实现**：先说明简短计划和验收标准；保留已有未提交修改，并按用户授权决定是否同步本机运行环境。
4. **按改动验证**：新增页面验证新入口及原有两页，刷新懒猫 Mac App 的内部页面作对照；认证失效和跨站隔离使用 dummy 凭据或隔离实例。涉及写入只使用可精确清理的测试数据。
5. **记录结果**：更新唯一当前工作记录，写明实际改动、运行验收、未验证项、备份和下一步；不把既有历史检查当作新改动已经通过。

如用户要求新增页面，需要页面名称、完整 URL 和可选菜单位置。现有应用的同 origin 子路径可评估复用分区；同一懒猫设备上的不同应用使用独立分区并增加准确绑定，先判断能否复用凭据；其他网站或应用自己的登录需单独核对。配置调整保留已有 entries，不重新覆盖成旧的两项配置。

此前“开始实现”的授权已用于完成本机接入。这次写交接文档没有追加 commit、merge、push、服务器部署、撤销正式凭据、修改系统网络／电源或重启日常应用的要求。

## 6. 后续改动可用的检查入口

这些命令从现有测试说明和本机依赖位置核对得到，供后续相关改动使用；本次文档任务未运行。静态／单元检查不能代替真实 Hermes 窗口验收。

方寸测试：

```sh
cd /Volumes/HzpSSD/Development/worktrees/zonglan-news/fangcun
node --test tests/news.test.cjs tests/viewswitch.test.cjs
```

已同步的本机 Hermes 源码检查：

```sh
cd /Users/huangzhipeng/.hermes/hermes-agent/apps/desktop
node ../../node_modules/vitest/vitest.mjs run --project electron electron/embedded-session-auth.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.electron.json
node ../../node_modules/eslint/bin/eslint.js electron/embedded-session-auth.ts electron/embedded-session-auth.test.ts
```

Hermes 使用仓库根目录依赖，不要假定 `apps/desktop/node_modules/.bin` 存在。若后续只修改隔离 worktree，要对实际修改后的那份源码准备依赖并测试，不能用本机旧副本的检查结果替代。

## 7. 恢复和回退

旧备份目录包含完整旧 `Hermes.app`、旧 `plugin.js`、旧 `electron-main.ts` 和旧 `electron-main.mjs`。回退前检查备份后是否已有其他改动，保留当前状态，再按明确的恢复任务退出 Hermes 并恢复匹配文件；不要直接覆盖之后新增的工作。

应用代码回退与凭据撤销是两件事。不要把撤销正式凭据作为普通诊断步骤，也不要把用户数据目录整体还原当作代码回退。配置损坏、凭据失效、宿主升级覆盖应分别核实，再处理对应原因。

安装时主程序 SHA256 记录在 `install-report.json`，可作为比对依据；它是当时快照，不是将来要求所有版本固定保持的哈希。

## 8. 给新 Agent 的开场白

```text
请接手 Hermes 方寸的懒猫独立凭据接入项目。先阅读：
/Volumes/HzpSSD/Development/qmreader/docs/fangcun-auth-handoff.md
以及其中链接的唯一当前工作记录。

现有实现已经安装，并通过短时运行验收。请先只读核对源码、未提交内容和运行入口，向我简要说明当前状态与仍需验证的事项；后续改动按我下一条具体要求执行。保留其他任务的修改，不重新生成或撤销凭据，不自动提交、部署或重启应用。
```

新 Agent 如无法访问本机路径，须说明缺少哪些文件，仅索取必要的脱敏源码、工作记录和证据；不要索取真实凭据或宣称已经完成本机验收。

新增页面的两套可复制指令另见 Obsidian [第 13 篇：方寸免登录扩展](</Users/huangzhipeng/Library/Mobile Documents/iCloud~md~obsidian/Documents/ZhiPengWiki/02-notes/AI Coding经验方法合集（志行）/stencil-web开发经验整理/13-方寸免登录扩展：有上下文指令与跨 Agent 交接.md>)。
