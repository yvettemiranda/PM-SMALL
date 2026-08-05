# Linux服务器部署

本部署只运行`PAPER + LIVE_DISABLED`。它不会接入钱包、签名、真实订单或链上操作，也不得计入正式长期PAPER验收。

## 访问边界

- Docker默认把网页端口绑定到`127.0.0.1`，不能从公网直接访问；
- 若要直接通过服务器IP短时验收，只能先在云防火墙中把应用端口限制为当前可信公网IPv4的`/32`，再将`APP_BIND_ADDRESS`改为`0.0.0.0`；
- 不得创建来源为`0.0.0.0/0`的应用端口规则；跨网络或长期手机访问应改用正式域名、HTTPS和反向代理认证，或受控私网；
- `.env`、`data/`、数据库、备份和运行日志不得提交Git。

## 首次部署

服务器需要Docker Engine及Docker Compose插件。安装后以普通运维用户执行：

```bash
git clone https://github.com/yvettemiranda/PM-SMALL.git pm-small
cd pm-small
cp .env.example .env
mkdir -p data
chmod 700 data
docker compose config
docker compose up -d --build
docker compose ps
```

默认仅可在服务器本机检查：

```bash
curl --fail --silent --show-error http://127.0.0.1:3000/api/status?compact=true
curl --fail --silent --show-error http://127.0.0.1:3000/api/paper/validation
```

新数据库的策略状态应为`STOPPED`，`executionMode`必须为`PAPER`，`liveExecutionEnabled`必须为`false`。只有人工点击`开始TEST`或调用对应接口后，才会进入`RUNNING`。

## 受限公网短时验收

先在云防火墙中添加仅允许当前可信公网IPv4访问TCP应用端口的规则，再在服务器`.env`中设置：

```dotenv
APP_BIND_ADDRESS=0.0.0.0
APP_PUBLIC_PORT=3000
```

重建端口映射并复核：

```bash
docker compose up -d
docker compose ps
```

验收完成后，若不需要继续从该网络访问，应删除该云防火墙规则，并把`APP_BIND_ADDRESS`恢复为`127.0.0.1`。

## 更新与回滚

更新前先确认GitHub `main`的目标提交并备份`data/`。数据库备份必须在容器停止后完成：

```bash
docker compose stop bot
cp -a data "data.backup-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose start bot
git fetch origin main
git pull --ff-only origin main
docker compose up -d --build
```

更新后必须复核网页、`/api/status?compact=true`、`/api/paper/validation`、SQLite持久化和同库重启恢复。失败时保留数据库及日志现场，不得通过删除数据库或关闭验证绕过安全门槛。
