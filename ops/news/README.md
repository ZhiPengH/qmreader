# 纵览News 更新运维

Mac 入口（任意目录执行）：

```bash
bash /Volumes/HzpSSD/Development/qmreader/ops/news/deploy.sh check
bash /Volumes/HzpSSD/Development/qmreader/ops/news/deploy.sh deploy
```

`check` 跑本地测试、生成源码快照，再只读检查 Linux，不停服、不上传。`deploy` 包含这些检查，按下面顺序执行。目标固定为 SSH 别名 `linux`、`/home/cosiohzp/apps/zonglan-news`，只处理 qmreader。要求 SSH 密钥已能无交互连接。

## 流程

1. 本地 `npm test`；打包当前工作树运行源码，记录 HEAD、分支、未提交状态和包 SHA256。允许先部署未提交修改。
2. Linux 锁定部署操作；保存正在运行的旧镜像 ID 与独立回退标签；停容器最多等待 60 秒，再归档完整项目（包括 `.env` 和整个 SQLite/WAL 数据目录，排除 node_modules/.git）。校验归档后恢复旧容器，等待首页可用。
3. SCP 上传源码包到独立备份目录，校验 SHA256。不会把半上传文件写入生产源码。
4. 从暂存源码构建独立版本镜像；此时旧容器继续运行。
5. 构建成功才替换指定运行源码（旧文件另存），更新 Compose 使用的镜像标签并 `up -d --no-build qmreader`。
6. 有限重试首页、`/api/me` 固定身份及实际运行镜像检查。通过后标记机器检查通过，人工验收仍为 pending。
7. 用户测试 Hermes/iPhone 阅读、收藏、取消、刷新；有持久化相关改动再做重启验收。人工通过后再审阅并 commit，push 独立决定。

## 范围与边界

- 上传：Dockerfile、.dockerignore、package.json/lock、server.js、lib、scripts、public、README、LICENSE。目录整批替换，不残留已删除的旧模块；拒绝符号链接。
- 不覆盖远端 `.env`、`data/`、docker-compose.yml，也不自动修改 PUBLIC_ORIGIN。涉及新增环境变量、端口、挂载或其他服务时先单独审核和更新配置，再用脚本部署源码。
- `.dockerignore` 排除全部 `data/` 和本地部署产物，防止数据库进入构建上下文。
- 备份默认永久保留，不自动删备份、镜像或用户数据。长期使用后应检查空间，再人工选择清理。
- 日常终端只输出阶段、结果和路径；详细输出进入本地日志，构建日志在 Linux 的备份目录。日志与备份权限限制为本人，不输出 `.env` 正文。
- 本脚本没有自动 commit/merge/push，也不把 HTTP 200 当成人工功能验收通过。
- 两阶段之间发生其他部署时，通过旧镜像比对拒绝过期快照。不要同时手工操作 Compose 或修改部署目录。

## 日志、失败与回退

本地：`.news-deploy/<时间-随机编号>/deploy.log`、源码包、release.json。
Linux：`/home/cosiohzp/apps/zonglan-news-backups/<同一编号>/`，包含 project.tar.gz、校验和、新旧镜像 ID、source.tar.gz、release.json、build.log 和 result.txt（成功后）。

备份失败会尝试启动原容器；SCP/构建失败不切换旧镜像。若源码安装中断且尚未激活新容器，恢复旧源码。失败返回非零退出码；先看日志，不盲目反复运行。

**激活失败可能导致服务暂不可用。** 新程序可能已经执行数据库迁移，因此不会自动解压旧数据，也不承诺任意版本无损回退。先查看 `docker compose ps` 和日志，检查当前数据与旧版本兼容性；需要回退时使用备份记录的旧镜像 ID/标签，另行明确恢复源码、配置或数据的范围。若需恢复旧数据库，先停服备份当前失败现场，接受备份时点之后写入会丢失这一事实，再单独执行恢复。已有旧备份不会被脚本删除。

Mac 意外断网时，远端可能仍在执行；不要立即再部署，先检查进程、锁和上述结果文件。EXIT/HUP 处理能覆盖常规中断，不能承诺断电、SIGKILL 时自动恢复。

## Git 与省 token 的使用约定

每次常规更新只需一条 deploy 命令，成功时返回“机器检查通过/人工待验收”及日志路径。失败时只提供失败阶段和相关日志，不把完整构建输出粘进聊天。release.json 中的 HEAD 仅代表基线；**源码包 SHA256 才标识本次实际部署快照**。

人工验收后先 `git status --short`、审阅 diff，再有选择地暂存本轮文件（包括新增脚本/测试），确认暂存区后 commit。若验收后又改了运行源码，先重新测试部署，不能将新改动冒充已验收版本。工作记录同步更新；不把提交等同于部署，也不把提交等同于 GitHub 备份。

## 脚本验证

```bash
bash -n ops/news/deploy.sh
bash -n ops/news/remote.sh
python3 ops/news/test_deploy.py
```

模拟测试在临时目录使用假的 Docker/curl/flock，不连接 Linux、不运行真实 Docker；实际运维验收需用户首次运行 deploy 并完成真机检查。
