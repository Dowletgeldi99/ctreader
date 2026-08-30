# Ubuntu VPS deployment

This deployment runs the NestJS backend, PostgreSQL, Redis and Caddy on one Ubuntu VPS. Only ports 22, 80 and 443 are public. PostgreSQL, Redis and the application port remain inside Docker networks.

Keep cTrader on Demo and `ALLOW_REAL_TRADING=false` during certification.

## 1. VPS and DNS

Recommended starting size for a few cTrader users:

- Ubuntu 24.04 LTS;
- 2 vCPU;
- 4 GB RAM;
- 40–80 GB SSD;
- a static public IPv4 address.

Create an `A` record such as `bot.example.com` pointing to the VPS IPv4 address. If an `AAAA` record exists, it must point to the same VPS and IPv6 ports 80/443 must work; otherwise remove the incorrect `AAAA` record.

## 2. Basic server preparation

Log in with the provider-created administrative user, update packages and configure the firewall:

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y ca-certificates curl git ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

Install Docker Engine and the Compose plugin using Docker's official Ubuntu instructions. Verify:

```bash
docker version
docker compose version
```

Do not expose ports 3000, 5432 or 6379 in the cloud firewall.

## 3. Copy the project

Clone the private repository into a stable location, for example:

```bash
sudo mkdir -p /opt/news-trader
sudo chown "$USER":"$USER" /opt/news-trader
git clone YOUR_PRIVATE_REPOSITORY_URL /opt/news-trader
cd /opt/news-trader
```

If no Git remote exists yet, securely copy the project to `/opt/news-trader` with `rsync` or `scp`. Never copy the local `.env` file or database volume.

## 4. Production secrets

Create the production file:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

Generate independent secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
```

Edit `.env.production` and set:

- `DOMAIN` and `ACME_EMAIL`;
- random PostgreSQL and Redis passwords (hex values avoid URL escaping issues);
- new `ADMIN_API_KEY`, `AGENT_TOKEN_PEPPER` and Telegram webhook secret;
- Telegram BotFather token;
- cTrader client ID, client secret and the existing token encryption key;
- `PUBLIC_BASE_URL` and `CTRADER_REDIRECT_URI` using the real HTTPS domain.

The cTrader encryption key must remain the same if encrypted OAuth connections are migrated from another database. Losing it makes stored cTrader tokens unreadable.

Keep these values initially:

```dotenv
TELEGRAM_MODE=webhook
ALLOW_REAL_TRADING=false
TRADING_KILL_SWITCH=false
CTRADER_ENABLED=true
CTRADER_MOCK_MODE=false
```

In the cTrader Open API portal add the exact redirect URI:

```text
https://bot.example.com/api/v1/ctrader/oauth/callback
```

## 5. First deployment

Run:

```bash
cd /opt/news-trader
./scripts/production/deploy.sh
```

The migration container waits for PostgreSQL health, applies `prisma migrate deploy` once, and exits successfully. Only then does the application start. Caddy waits for application readiness and obtains/renews HTTPS certificates automatically.

Check containers and logs:

```bash
./scripts/production/status.sh
curl https://bot.example.com/api/health/live
curl https://bot.example.com/api/health/ready
```

Expected readiness response:

```json
{"status":"ok","database":"connected"}
```

Telegram webhook registration happens during application startup. Open the bot, run `/start`, `/status` and connect a fresh cTrader Demo user.

## 6. Emergency stop test

Before any trading test, verify the database-backed kill switch:

```bash
set -a
. ./.env.production
set +a

curl -X POST "https://$DOMAIN/api/v1/admin/safety/halt" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"reason":"VPS deployment test"}'

curl "https://$DOMAIN/api/v1/admin/safety" \
  -H "x-admin-api-key: $ADMIN_API_KEY"

curl -X POST "https://$DOMAIN/api/v1/admin/safety/resume" \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

After resume, `/status` must show `Торговля: ACTIVE`.

## 7. Demo certification

Use two different Telegram users and two different cTrader Demo accounts:

1. Both users run `/connect_ctrader` and authorize only their own accounts.
2. User A creates `MARKET BUY 0.01`; user B creates `MARKET SELL 0.01` for the same minute.
3. Verify exactly one position per MARKET job and separate job/account ownership.
4. Test OCO and confirm that the sibling order is cancelled after one fill.
5. Test MULTI with a small lot and verify the requested number of independent orders.
6. Restart `app` while pending jobs exist and verify reconciliation without duplicates:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml restart app
```

7. Halt trading while pending orders exist and verify that pending entries are removed while filled positions retain broker-side SL/TP.

Do not enable LIVE until these checks pass repeatedly.

## 8. Backups

Create and verify a PostgreSQL custom-format backup:

```bash
./scripts/production/backup-postgres.sh
```

Backups are stored under `/opt/news-trader/backups/postgres` and files older than 14 days are removed. Copy backups to another machine or object storage; a backup that exists only on the VPS does not protect against disk loss.

Example daily cron at 03:15 UTC:

```bash
crontab -e
```

```cron
15 3 * * * /opt/news-trader/scripts/production/backup-postgres.sh >> /opt/news-trader/backups/backup.log 2>&1
```

Restore is destructive and requires typing `RESTORE`:

```bash
./scripts/production/restore-postgres.sh /absolute/path/to/newsbot-YYYYMMDDTHHMMSSZ.dump
```

Test restoration on a separate staging VPS before relying on the backup process.

## 9. Updates and rollback preparation

Before updating:

```bash
./scripts/production/backup-postgres.sh
git rev-parse HEAD
git pull --ff-only
./scripts/production/deploy.sh
```

Inspect:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml ps
docker compose --env-file .env.production -f docker-compose.production.yml logs -f --tail=200 app
```

Database migrations are forward operations. Keep a verified database backup before every release; reverting application code does not automatically revert a migration.
