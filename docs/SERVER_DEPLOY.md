# Linux服务器部署

本部署只运行`PAPER + LIVE_DISABLED`。它不会接入钱包、签名、真实订单或链上操作，也不得计入正式长期PAPER验收。

## 访问边界

- Docker始终把应用端口绑定到`127.0.0.1`，公网不得直接访问3000端口；
- 手机和电脑跨网络访问只经过Nginx的80/443端口：80仅用于证书验证和跳转，443同时要求受信任HTTPS证书与登录认证；
- 云防火墙不得保留任何应用3000端口放行规则；公网只看到反向代理，认证头不得继续传给应用；
- 当前HTTP Basic Authentication只用于单用户TEST阶段。未来若进入LIVE设计，必须另行评估账户、会话、CSRF、审计和更强身份认证，不能直接沿用本配置；
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

## 手机和电脑直接访问

TEST交付使用指向固定公网IPv4的主机名、Nginx、Certbot和名称匹配的受信任HTTPS证书。用户无需安装额外客户端，在手机或电脑浏览器直接打开同一个`https://<PUBLIC_HOSTNAME>/`链接并输入登录凭据。裸IPv4只用于服务器定位，不再作为用户入口。

先确认云防火墙只为网页开放TCP 80和443，不开放3000；服务器`.env`必须保持：

```dotenv
APP_BIND_ADDRESS=127.0.0.1
APP_PUBLIC_PORT=3000
```

安装Nginx与Certbot后，先让Nginx从`/var/www/certbot`提供`/.well-known/acme-challenge/`，确认主机名已解析到该服务器，再申请主机名证书：

```bash
sudo certbot certonly \
  --non-interactive \
  --agree-tos \
  --email <ADMIN_EMAIL> \
  --webroot \
  --webroot-path /var/www/certbot \
  --domains <PUBLIC_HOSTNAME> \
  --cert-name pm-small-host
```

不能依赖人工续期。Certbot定时器必须启用，并在`/etc/letsencrypt/renewal-hooks/deploy/`放置通过`nginx -t`后重载Nginx的可执行脚本。

登录密码必须随机生成且只保存在仓库外的`0600`文件中；Nginx只保存密码哈希。例如：

```bash
umask 077
ACCESS_USER=pm-small
ACCESS_PASSWORD="$(openssl rand -hex 12)"
printf 'username=%s\npassword=%s\n' "$ACCESS_USER" "$ACCESS_PASSWORD" > "$HOME/.pm-small-access"
ACCESS_HASH="$(openssl passwd -6 "$ACCESS_PASSWORD")"
printf '%s:%s\n' "$ACCESS_USER" "$ACCESS_HASH" | sudo tee /etc/nginx/.pm-small.htpasswd >/dev/null
sudo chown root:www-data /etc/nginx/.pm-small.htpasswd
sudo chmod 640 /etc/nginx/.pm-small.htpasswd
unset ACCESS_PASSWORD ACCESS_HASH
```

HTTPS反向代理至少要满足以下约束：

- 80端口保留ACME验证路径，其余请求永久跳转到`https://<PUBLIC_HOSTNAME>`；
- 443只接受`<PUBLIC_HOSTNAME>`并加载`/etc/letsencrypt/live/pm-small-host/`中的证书和私钥；
- 所有路径都经过`auth_basic`，并代理到`http://127.0.0.1:3000`；
- 清除上游`Authorization`头，拒绝浏览器标记为`cross-site`的请求，并设置`frame-ancestors 'none'`等基础安全响应头；
- 配置修改后必须先执行`sudo nginx -t`，通过后才重载。

短时验收至少包括：

```bash
# HTTP应跳转，未登录HTTPS应返回401，正确登录应返回200
curl -I "http://<PUBLIC_HOSTNAME>/"
curl -I "https://<PUBLIC_HOSTNAME>/"
. "$HOME/.pm-small-access"
curl -u "$username:$password" "https://<PUBLIC_HOSTNAME>/api/status?compact=true"
unset username password

# 续期、服务和监听边界
sudo certbot renew --dry-run --cert-name pm-small-host --run-deploy-hooks
systemctl is-active nginx
docker compose ps
sudo ss -ltnp | grep -E ':(80|443|3000)[[:space:]]'
```

预期只有Nginx监听公网80/443，应用3000只监听`127.0.0.1`。浏览器登录后仍必须确认`executionMode=PAPER`、`liveExecutionEnabled=false`以及策略处于预期状态。

仓库提供`scripts/check-public-access.sh`做严格验收；不得添加`--insecure`绕过证书名称检查：

```bash
. "$HOME/.pm-small-access"
PM_SMALL_ACCESS_USER="$username" \
PM_SMALL_ACCESS_PASSWORD="$password" \
./scripts/check-public-access.sh "https://<PUBLIC_HOSTNAME>"
unset username password
```

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
