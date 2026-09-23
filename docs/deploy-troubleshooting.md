# 部署排障手册（懒猫 Linux）

> 本文记录 2026-09-23 部署小米 MiMo 预设时排障得到的经验，供下次部署异常时快速定位。
> 部署入口：`bash ops/news/deploy.sh deploy`（Mac 侧执行，目标 `ssh linux` → `~/apps/zonglan-news`）。
> 常规流程、备份与回滚语义见 [ops/news/README.md](../ops/news/README.md)；本文只记异常场景。

## 症状与根因对照

### 1. 部署超慢（10 分钟以上）或卡在「Building image」

**根因链**：`Dockerfile` 第一行 `FROM node:26-slim` 是可变标签，每次构建都要在线向 Docker Hub 解析当前 digest。懒猫到 Docker Hub 的线路只有约 100KB/s，55MB 的基础层拉一次约 12 分钟。

**识别方法**（看最新备份目录的 build.log）：

```bash
ssh linux 'tail -50 ~/apps/zonglan-news-backups/$(ls -t ~/apps/zonglan-news-backups/ | head -1)/build.log'
```

- `#5 sha256:... 55.63MB` 进度行每 5 秒只涨 1MB → 正在慢速拉基础层，**没死，等它**
- `load metadata for docker.io/library/node:26-slim ... DONE 25.2s` → 元数据解析慢但成功

### 2. 构建直接失败：`no such host`

```
ERROR: failed to build: ... registry-1.docker.io: dial tcp: lookup registry-1.docker.io: no such host
```

**根因**：懒猫系统 DNS（`/etc/resolv.conf` → `100.64.0.1`）对境外域名**常态性解析失败**。已实测（2026-09-23）：国内域名（baidu.com、api.xiaomimimo.com）0 秒解析成功，境外域名（registry-1.docker.io、cdn.jsdelivr.net）40~120 秒超时失败，且是 UDP 无声丢包、不返回拒绝。9-21 与 9-23 两次部署失败均为此因。

**验证 DNS 是否瘫痪**（不要用交互式 nslookup，懒猫上没有；getent 在系统 DNS 卡住时 SSH 命令本身会挂 30 秒+）：

```bash
# 从 Mac 上传探针再异步取结果，避免 SSH 命令被 DNS 拖死
scp /path/to/probe.py linux:/tmp/ && ssh linux 'nohup python3 /tmp/probe.py > /tmp/probe.out 2>&1 &'
# probe.py: socket.gethostbyname 各测一个国内/境外域名，setdefaulttimeout(5)
```

**结论口径**：国内域名通、境外域名挂 = 懒猫 DNS 病，等它自愈或去懒猫管理界面处理；此时**重试部署没用**，构建必死。

### 3. 部署脚本被杀后「卡住」——先探测，别重跑

**重要**：deploy.sh 本地超时被杀（或 SSH 断开）后，**远端 remote.sh 可能还在正常跑**。此时立刻重跑 deploy 会撞 `flock`（`Another deployment is running`）——这不是锁泄漏，是上一轮真活着。

**先探测远端状态再决定**：

```bash
# 构建进程还在吗？
ssh linux 'pgrep -af "zonglan-news-release" | head -3'
# 锁被谁持有？
ssh linux 'fuser ~/apps/zonglan-news/.news-deploy.lock 2>&1'
```

- 有 `docker build` 进程 → **等它**。用 `while ssh linux 'pgrep -f <RUN> >/dev/null'; do sleep 60; done` 轮询。
- 无进程但部署未完 → 按下节「半成品状态判定」恢复。

## 半成品状态判定与手工续完

remote.sh 的 release 阶段按顺序执行：build → 装源码 → 打标签 → `docker compose up` → 健康检查。SSH 断在哪一步，产物就停在哪一步。**判断看备份目录里的标记文件**：

```bash
RUN=20260923T074729Z-eb03b9   # 换成实际编号
ssh linux "ls ~/apps/zonglan-news-backups/$RUN/ | sort"
```

| 标记 | 含义 |
|---|---|
| `backup-complete` | 备份阶段完成，旧容器已恢复运行 |
| `new-image-id.txt` | 新镜像已构建完成 |
| `previous-source/` + 源码目录里新文件 | 源码已安装到 `~/apps/zonglan-news` |
| `activation-attempted` | 走到了激活（compose up）环节 |
| `result.txt` | **全流程完成**（http+identity 检查过） |

**续完命令**（镜像已建好、只差换容器的场景，2026-09-23 实测有效）：

```bash
ssh linux 'cd ~/apps/zonglan-news && docker compose up -d --no-build qmreader'
# 然后按脚本原逻辑验收：镜像匹配 + HTTP + 身份
ssh linux 'NEWID=$(cat ~/apps/zonglan-news-backups/<RUN>/new-image-id.txt); CID=$(docker compose -f ~/apps/zonglan-news/docker-compose.yml ps -q qmreader); [ "$(docker inspect -f "{{.Image}}" $CID)" = "$NEWID" ] && echo IMAGE-OK; curl -fsS --max-time 5 http://127.0.0.1:3088/api/me | python3 -c "import json,sys; print((json.load(sys.stdin).get(\"user\") or {}).get(\"id\"))"'
# 通过后补记标记
ssh linux 'printf "http-and-identity=passed\nmanual-qa=pending\n" > ~/apps/zonglan-news-backups/<RUN>/result.txt'
```

## 安全性备忘（排障时的底气）

- release 阶段任何失败：remote.sh 的 `finish()` 会把 `previous-source/` 恢复回项目目录，**不碰 .env 和 data/**；旧容器继续用旧镜像跑。死在 build 阶段时连源码都没动。
- 备份目录含 `project.tar.gz`（完整项目快照，含 .env 和 data）+ `zonglan-news-rollback:<RUN>` 镜像标签，双路回滚。
- flock 保证不会有两个部署同时改生产。

## 遗留决定（未执行，等拍板）

- **Dockerfile digest 固定**：`FROM node:26-slim@sha256:ec7758...` 可让构建彻底不碰 DNS（懒猫 DNS 瘫痪时也能部署），代价是升级基础镜像要手动改 digest。用户 2026-09-23 回复「暂时不用」。
- **懒猫 DNS 治本**：管理界面是否支持自定义 DNS 未查。下次境外解析再瘫，优先查这个。
