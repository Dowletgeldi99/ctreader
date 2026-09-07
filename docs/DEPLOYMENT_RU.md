# Деплой News Trader на Ubuntu VPS

Эта инструкция предназначена для первого production-деплоя Telegram-бота и cTrader Open API backend с macOS на Ubuntu VPS.

На одном VPS будут работать:

- NestJS backend;
- PostgreSQL;
- Redis;
- Caddy с автоматическим HTTPS;
- Telegram webhook;
- cTrader Open API execution worker.

На VPS не устанавливается MetaTrader 5. Текущая production-схема использует cTrader Open API.

> До завершения demo-тестов оставьте `ALLOW_REAL_TRADING=false` и используйте только cTrader Demo.

## 1. Требования

Рекомендуемая минимальная конфигурация:

- Ubuntu 24.04 LTS;
- 2 vCPU;
- 4 GB RAM;
- 40 GB NVMe SSD;
- публичный IPv4;
- домен или поддомен;
- SSH-доступ `root` или пользователь с `sudo`.

Примеры значений в этой инструкции:

```text
VPS IP: 203.0.113.10
Домен: bot.example.com
Пользователь VPS: root
Папка проекта: /opt/news-trader
```

Замените их своими значениями.

## 2. Настройка DNS

У регистратора домена создайте запись:

```text
Type: A
Name: bot
Value: IP_ВАШЕГО_VPS
TTL: Auto
```

Например:

```text
bot.example.com → 203.0.113.10
```

Проверьте с Mac:

```bash
dig +short bot.example.com
```

Команда должна вернуть IP VPS.

Если присутствует `AAAA`, но IPv6 на VPS не настроен, удалите неправильную `AAAA` запись. Иначе Caddy может не получить сертификат.

Для Telegram webhook и cTrader OAuth нужен публичный HTTPS-домен. `localhost` для VPS не подходит.

## 3. Первое подключение к VPS

На Mac:

```bash
ssh root@IP_ВАШЕГО_VPS
```

Обновите систему:

```bash
apt update
apt upgrade -y
apt install -y ca-certificates curl git ufw rsync openssl
```

Настройте firewall:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw enable
ufw status
```

Наружу не нужно открывать:

```text
3000 — NestJS
5432 — PostgreSQL
6379 — Redis
```

Эти сервисы доступны только во внутренних Docker networks.

## 4. Установка Docker Engine

Удалите конфликтующие неофициальные пакеты, если они установлены:

```bash
apt remove -y docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc || true
```

Добавьте официальный Docker repository:

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

Установите Docker:

```bash
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
```

Проверьте:

```bash
docker version
docker compose version
docker run --rm hello-world
```

## 5. Создание папки проекта

На VPS:

```bash
mkdir -p /opt/news-trader
chmod 755 /opt/news-trader
exit
```

## 6. Передача проекта с macOS

Текущая локальная папка проекта:

```text
/Users/dovlet/Documents/dev/meta/v1
```

На Mac выполните:

```bash
cd /Users/dovlet/Documents/dev/meta/v1
```

```bash
rsync -az \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude .env.production \
  --exclude backups \
  ./ root@IP_ВАШЕГО_VPS:/opt/news-trader/
```

Не передавайте локальный `.env`, `node_modules`, `dist` или локальную базу данных.

Подключитесь снова:

```bash
ssh root@IP_ВАШЕГО_VPS
cd /opt/news-trader
ls -la
```

Должны присутствовать:

```text
Dockerfile
docker-compose.production.yml
package.json
package-lock.json
prisma/
src/
deploy/
scripts/
docs/
```

## 7. Создание `.env.production`

На VPS:

```bash
cd /opt/news-trader
cp .env.production.example .env.production
chmod 600 .env.production
```

Сгенерируйте отдельные секреты. Выполните команду несколько раз и сохраните разные результаты:

```bash
openssl rand -hex 32
```

Она нужна для:

```text
POSTGRES_PASSWORD
REDIS_PASSWORD
ADMIN_API_KEY
AGENT_TOKEN_PEPPER
TELEGRAM_WEBHOOK_SECRET
```

Ключ шифрования cTrader tokens:

```bash
openssl rand -base64 32
```

Откройте файл:

```bash
nano .env.production
```

Заполните:

```dotenv
NODE_ENV=production

DOMAIN=bot.example.com
ACME_EMAIL=admin@example.com

POSTGRES_PASSWORD=REPLACE_WITH_RANDOM_HEX
REDIS_PASSWORD=REPLACE_WITH_ANOTHER_RANDOM_HEX
ADMIN_API_KEY=REPLACE_WITH_ANOTHER_RANDOM_HEX
AGENT_TOKEN_PEPPER=REPLACE_WITH_ANOTHER_RANDOM_HEX

TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOTFATHER_TOKEN
TELEGRAM_WEBHOOK_SECRET=REPLACE_WITH_ANOTHER_RANDOM_HEX
TELEGRAM_MODE=webhook

# Оставить false до завершения demo-сертификации.
ALLOW_REAL_TRADING=false
TRADING_KILL_SWITCH=false

# Расчётный risk limit управляется отдельно в Telegram и по умолчанию выключен.
MAX_RISK_PERCENT=0.50
MAX_DAILY_LOSS_PERCENT=1.00

# 3.00 позволяет использовать SPLIT TOTAL 3 lot.
MAX_FIXED_LOT=3.00
MAX_OPEN_POSITIONS_PER_USER=10
CTRADER_MARGIN_BUFFER_PERCENT=25
CTRADER_JOB_LEASE_SECONDS=45
PAIRING_CODE_TTL_SECONDS=600

CTRADER_ENABLED=true
CTRADER_MOCK_MODE=false
CTRADER_CLIENT_ID=REPLACE_WITH_CTRADER_CLIENT_ID
CTRADER_CLIENT_SECRET=REPLACE_WITH_CTRADER_CLIENT_SECRET
CTRADER_TOKEN_ENCRYPTION_KEY=REPLACE_WITH_BASE64_32_BYTE_KEY

# Эти два URL переопределяются docker-compose.production.yml.
DATABASE_URL=postgresql://placeholder
REDIS_URL=redis://placeholder

PUBLIC_BASE_URL=https://bot.example.com
CTRADER_REDIRECT_URI=https://bot.example.com/api/v1/ctrader/oauth/callback
```

Правила:

- в `DOMAIN` указывается только домен, без `https://` и без `/` в конце;
- в `PUBLIC_BASE_URL` указывается полный `https://` URL;
- `CTRADER_REDIRECT_URI` должен точно совпадать с URL в cTrader Open API portal;
- не используйте одинаковый пароль для PostgreSQL, Redis и admin API;
- не отправляйте `.env.production` в Telegram или Git;
- потеря `CTRADER_TOKEN_ENCRYPTION_KEY` сделает сохранённые OAuth tokens нечитаемыми.

Сохранение в `nano`:

```text
Ctrl+O
Enter
Ctrl+X
```

## 8. Настройка cTrader Open API

В настройках cTrader Open API Application добавьте production redirect URI:

```text
https://bot.example.com/api/v1/ctrader/oauth/callback
```

Он должен совпадать символ в символ с:

```dotenv
CTRADER_REDIRECT_URI=https://bot.example.com/api/v1/ctrader/oauth/callback
```

Проверьте:

- приложение cTrader имеет статус `Active`;
- выбран personal use или разрешён public use;
- scope приложения позволяет trading;
- `client ID` и `client secret` принадлежат этому приложению;
- redirect использует HTTPS.

Production-БД будет пустой, поэтому после деплоя cTrader-счета потребуется подключить заново через `/connect_ctrader`.

## 9. Проверка Docker Compose

На VPS:

```bash
cd /opt/news-trader
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  config --quiet
```

Если команда завершилась без вывода — Compose configuration корректна.

Посмотреть итоговую конфигурацию без секретов не следует публиковать. Команда `docker compose config` может показать значения environment variables.

## 10. Первый запуск

```bash
cd /opt/news-trader
chmod +x scripts/production/*.sh
./scripts/production/deploy.sh
```

Deployment script:

1. проверит Compose configuration;
2. соберёт Docker images;
3. установит Node dependencies внутри build image;
4. запустит PostgreSQL и Redis;
5. применит `prisma migrate deploy`;
6. применит миграцию `NEWS_REVERSAL` и `TradeJobLeg`;
7. запустит NestJS backend;
8. дождётся healthcheck приложения;
9. запустит Caddy;
10. получит HTTPS-сертификат.

Вручную запускать `npm install` на VPS не нужно.

Первый build может занять несколько минут.

## 11. Проверка контейнеров

```bash
./scripts/production/status.sh
```

Или:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml ps
```

Ожидаемые состояния:

```text
postgres   healthy
redis      healthy
migrate    exited (0)
app        healthy
caddy      running
```

Контейнер `migrate` должен завершиться с кодом `0`. Это нормально — он не должен постоянно работать.

## 12. Проверка HTTPS и health endpoints

```bash
curl https://bot.example.com/api/health/live
```

```bash
curl https://bot.example.com/api/health/ready
```

Ожидается примерно:

```json
{"status":"ok"}
```

```json
{"status":"ok","database":"connected"}
```

Если домен ещё не обновился:

```bash
dig +short bot.example.com
```

## 13. Просмотр логов

Backend:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs -f --tail=200 app
```

Нормальный startup включает сообщения:

```text
Telegram webhook configured
cTrader Open API execution worker started
Nest application successfully started
```

Caddy и HTTPS:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs -f --tail=200 caddy
```

Миграции:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=200 migrate
```

PostgreSQL:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=100 postgres
```

Выйти из live logs:

```text
Ctrl+C
```

## 14. Если приложение не запускается

Проверьте состояние:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml ps -a
```

Повторно посмотреть app logs:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=300 app
```

Частые причины:

### `migrate` завершился с ошибкой

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=300 migrate
```

Проверьте `POSTGRES_PASSWORD` и состояние `postgres`.

### Caddy не получает сертификат

Проверьте:

- DNS `A` указывает на VPS;
- порты 80/443 открыты у VPS-провайдера и в UFW;
- отсутствует неправильная `AAAA`;
- `DOMAIN` не содержит `https://`;
- другой процесс не использует 80/443.

Проверка портов на VPS:

```bash
ss -lntup | grep -E ':80|:443'
```

### Telegram не отвечает

Проверьте:

- `TELEGRAM_BOT_TOKEN`;
- HTTPS health endpoint;
- app startup logs;
- `TELEGRAM_MODE=webhook`;
- `PUBLIC_BASE_URL`.

### cTrader OAuth возвращает redirect error

Почти всегда не совпадает:

```text
cTrader portal redirect URI
CTRADER_REDIRECT_URI
реальный callback URL
```

## 15. Первый вход в Telegram

После успешного deployment:

```text
/start
/status
/connect_ctrader
```

Авторизуйте только cTrader Demo account.

После callback проверьте:

```text
/status
```

Должен отображаться cTrader Demo account.

## 16. Проверка аварийной остановки

На VPS:

```bash
cd /opt/news-trader
set -a
. ./.env.production
set +a
```

Остановить новые торговые операции:

```bash
curl -X POST "https://$DOMAIN/api/v1/admin/safety/halt" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"reason":"First VPS safety test"}'
```

Проверить:

```bash
curl "https://$DOMAIN/api/v1/admin/safety" \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

Возобновить:

```bash
curl -X POST "https://$DOMAIN/api/v1/admin/safety/resume" \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

В Telegram:

```text
/status
```

Ожидается:

```text
Торговля: ACTIVE
```

## 17. Настройка NEWS REVERSAL template

Посмотреть текущий шаблон:

```text
/reversal_settings
```

Рекомендуемый начальный template:

```text
SPLIT_TOTAL 50 10 100 200 300 10 30 300
```

Расшифровка:

```text
SPLIT_TOTAL — выбранный lot является общим объёмом
50          — entry distance
10          — SL
100         — TP1
200         — TP2
300         — TP3
10          — reversal gap после первоначального SL
30          — initial pending expiry, секунд
300         — maximum management time, секунд
```

## 18. Первый demo-тест NEWS REVERSAL

Начните с маленького объёма:

```text
/test
→ cTrader Demo
→ Lot 0.1
→ News Reversal · 3 TP
→ SPLIT TOTAL
→ Подтвердить
```

Не начинайте VPS-тест с `1 lot`.

Проверьте в cTrader:

- создано ровно три BUY Stop и три SELL Stop;
- у трёх BUY одинаковый entry;
- у трёх SELL одинаковый entry;
- TP равны 100/200/300 pips;
- общий volume для `SPLIT TOTAL 0.1` равен 0.1 lot;
- после первого fill поздние initial pending не остаются;
- противоположная сторона ставится на 10 pips дальше первоначального SL;
- после TP1 остаются две reversal-части, но reversal entry не переносится;
- SL оставшихся initial-позиций после TP1 не переносится;
- после TP2 остаётся одна reversal-часть, но reversal entry не переносится;
- SL оставшейся initial-позиции после TP2 не переносится;
- после TP3 все pending задания отменены;
- повторный reversal невозможен.

Проверьте команды:

```text
/jobs
Отменить pending
Закрыть позиции
/close_all
```

`Отменить pending` не закрывает уже открытые защищённые позиции. `Закрыть позиции` закрывает позиции по рынку и отменяет pending.

## 19. Demo-сертификация перед LIVE

Не включайте LIVE после одного успешного события.

Минимальная проверка:

1. MARKET BUY и MARKET SELL;
2. OCO;
3. старый MULTI;
4. NEWS REVERSAL SPLIT TOTAL;
5. NEWS REVERSAL FULL LOT EACH;
6. BUY initial fill;
7. SELL initial fill;
8. SL до TP1 и один reversal;
9. TP1 и откат;
10. TP2 и откат;
11. полный TP3;
12. истечение pending через 30 секунд;
13. `/cancel_job`;
14. `/close_job`;
15. `/close_all`;
16. restart backend с открытыми pending;
17. restart backend после TP1;
18. временный cTrader WebSocket disconnect;
19. два Telegram-пользователя одновременно;
20. отсутствие повторных ордеров после restart.

Restart app для проверки recovery:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml restart app
```

После restart сверяйте cTrader positions/orders и `/jobs`.

## 20. Включение LIVE позже

Только после demo-сертификации:

```bash
nano /opt/news-trader/.env.production
```

Изменить:

```dotenv
ALLOW_REAL_TRADING=true
```

Перезапустить deployment:

```bash
cd /opt/news-trader
./scripts/production/deploy.sh
```

После этого каждый пользователь всё равно должен отдельно разрешить Real trading в Telegram settings. Системное разрешение не должно автоматически включать LIVE всем пользователям.

## 21. Backup PostgreSQL

Создать backup:

```bash
cd /opt/news-trader
./scripts/production/backup-postgres.sh
```

Файлы сохраняются в:

```text
/opt/news-trader/backups/postgres
```

Проверить:

```bash
ls -lh /opt/news-trader/backups/postgres
```

Храните копию backup вне VPS.

Ежедневный backup в 03:15 UTC:

```bash
crontab -e
```

Добавьте:

```cron
15 3 * * * /opt/news-trader/scripts/production/backup-postgres.sh >> /opt/news-trader/backups/backup.log 2>&1
```

Restore является потенциально разрушительной операцией. Сначала проверяйте восстановление на отдельном staging VPS.

## 22. Обновление приложения с Mac

Перед обновлением создайте backup:

```bash
ssh root@IP_ВАШЕГО_VPS
cd /opt/news-trader
./scripts/production/backup-postgres.sh
exit
```

Передайте обновлённый код:

```bash
cd /Users/dovlet/Documents/dev/meta/v1
```

```bash
rsync -az \
  --exclude node_modules \
  --exclude dist \
  --exclude .env \
  --exclude .env.production \
  --exclude backups \
  ./ root@IP_ВАШЕГО_VPS:/opt/news-trader/
```

Запустите deployment:

```bash
ssh root@IP_ВАШЕГО_VPS
cd /opt/news-trader
./scripts/production/deploy.sh
```

Проверьте:

```bash
./scripts/production/status.sh
docker compose --env-file .env.production -f docker-compose.production.yml logs --tail=200 app
curl https://bot.example.com/api/health/ready
```

## 23. Полезные команды

Статус:

```bash
cd /opt/news-trader
./scripts/production/status.sh
```

App logs:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml logs -f --tail=200 app
```

Перезапустить только app:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml restart app
```

Перезапустить весь stack:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml restart
```

Повторно собрать и применить миграции:

```bash
./scripts/production/deploy.sh
```

Использование диска:

```bash
df -h
docker system df
```

Не запускайте `docker system prune --volumes`: volumes содержат PostgreSQL и Redis data.

## 24. Финальный checklist

- [ ] DNS `A` указывает на VPS.
- [ ] Порты 22, 80 и 443 открыты.
- [ ] Порты 3000, 5432 и 6379 не опубликованы.
- [ ] Docker и Compose установлены.
- [ ] `.env.production` имеет permission `600`.
- [ ] Все секреты разные.
- [ ] `ALLOW_REAL_TRADING=false`.
- [ ] `CTRADER_MOCK_MODE=false` для настоящего Demo API.
- [ ] cTrader redirect URI совпадает.
- [ ] PostgreSQL healthy.
- [ ] Redis healthy.
- [ ] `migrate` завершился с кодом 0.
- [ ] App healthy.
- [ ] Caddy работает и HTTPS доступен.
- [ ] Telegram отвечает на `/start`.
- [ ] cTrader Demo подключён.
- [ ] Kill switch проверен.
- [ ] NEWS REVERSAL проверен с 0.1 lot.
- [ ] Recovery после restart проверен.
- [ ] Backup создан и скопирован вне VPS.
