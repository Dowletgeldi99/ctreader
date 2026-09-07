# Подписки и подключение cBot

Первая версия подписочной системы поддерживает автоматический Trial, тарифы
Basic/Pro, ручную активацию администратором, ограничение торговых режимов,
одноразовое подключение cBot и аудит изменений.

## Включение

Сначала примените миграции и сгенерируйте Prisma Client:

```bash
npm run prisma:deploy
npm run prisma:generate
```

Добавьте в production environment:

```env
SUBSCRIPTIONS_ENFORCED=true
TELEGRAM_ADMIN_IDS=123456789
```

Несколько Telegram ID перечисляются через запятую. Пока
`SUBSCRIPTIONS_ENFORCED=false`, планы отображаются и pairing работает, но
создание заданий не блокируется — это режим плавной миграции существующих
пользователей.

При старте backend создаёт или обновляет тарифы:

| План | Цена | Срок | Среда | Режимы | Счета | Max lot |
|---|---:|---:|---|---|---:|---:|
| Trial | $0 | 7 дней | Demo | все | 1 | 0.01 |
| Basic | $19 | 30 дней | Demo + Live | MARKET, OCO | 1 | 0.10 |
| Pro | $39 | 30 дней | Demo + Live | все | 3 | 1.00 |

## Telegram

Пользователь:

```text
/plans
/subscription
/connect_cbot
```

Администратор:

```text
/admin_users
/admin_activate TELEGRAM_ID BASIC 30
/admin_activate TELEGRAM_ID PRO 30
/admin_suspend TELEGRAM_ID
```

`/start` создаёт Trial только один раз. Повторный `/start` не продлевает его.

## Admin API

Во всех запросах требуется заголовок `x-admin-api-key`.

```bash
curl -H 'x-admin-api-key: ADMIN_KEY' \
  https://api.tradetm.club/api/v1/admin/subscriptions/users

curl -X POST -H 'content-type: application/json' \
  -H 'x-admin-api-key: ADMIN_KEY' \
  -d '{"telegramId":"123456789","plan":"PRO","days":30}' \
  https://api.tradetm.club/api/v1/admin/subscriptions/grant
```

## cBot pairing API

1. Пользователь получает код командой `/connect_cbot`.
2. cBot один раз вызывает `POST /api/v1/cbot/pairing/claim`.
3. Backend возвращает секретный bearer token только один раз.
4. cBot хранит token локально и использует его для heartbeat и entitlements.

Пример claim payload:

```json
{
  "code": "ABCD2345",
  "instanceKey": "random-instance-uuid",
  "accountNumber": "8310587",
  "broker": "FxPro",
  "environment": "LIVE",
  "symbol": "XAUUSD",
  "version": "0.1.0"
}
```

После pairing:

```text
POST /api/v1/cbot/heartbeat
GET  /api/v1/cbot/entitlements
Authorization: Bearer CBOT_TOKEN
```

Ответ entitlements всегда содержит `manageExistingPositions=true`. Окончание
подписки запрещает новые входы, но не должно прекращать сопровождение уже
открытых позиций.

## Текущая граница версии

В этой версии готовы управление подписками, enforcement и безопасная
идентификация cBot. Автоматический платёжный webhook и передача торговых jobs в
cBot будут следующим этапом. До реализации job transport существующий cTrader
Open API/MT5 execution продолжает работать как раньше.
