# TradeTm Connector — подключение

Это production transport между Telegram/backend и торговым счётом cTrader.
Один пользователь запускает один экземпляр cBot на своём счёте и управляет
заданиями только через Telegram.

## Установка клиентом только с телефона

1. В Telegram отправьте `/connect_cbot`. Код действует 10 минут и используется один раз.
2. Нажмите Telegram-кнопку **Установить TradeTm cBot** и откройте `.algo` через cTrader Mobile.
3. В cTrader нажмите **Start cBot**, выберите нужный счёт, `XAUUSD` и Cloud execution.
4. Вставьте Telegram-код в `Pairing code`. Для demo оставьте `Allow LIVE trading = No`.
5. Нажмите **Start**. Вернитесь в Telegram и нажмите **Проверить подключение**.
6. Выполните `/test` и выберите счёт с префиксом `cBot`.

Backend URL и безопасные defaults уже находятся внутри `.algo`. Компьютер,
редактор кода, собственный VPS и ручной Build клиенту не нужны. Cloud instance
работает независимо от телефона.

Cloud connector использует только `wss://bot.tradetm.club:25345/api/v1/cbot/ws`.
cTrader Cloud не отправляет HTTP-запросы из cBot, поэтому HTTP остаётся только
для скачивания `.algo`. На VPS должен быть открыт TCP `25345`.

## Автоматический выпуск для оператора

Production Docker build компилирует `TradeTmConnector.csproj` официальным
`cTrader.Automate` package, создаёт sealed `.algo` без исходного кода и кладёт
его в runtime image. Файл доступен по стабильному адресу:

```text
https://bot.tradetm.club/api/v1/cbot/download
```

Если `CBOT_INSTALL_URL` пуст, Telegram автоматически строит адрес как
`PUBLIC_BASE_URL/api/v1/cbot/download`. Для Store/Invite в переменную можно
позже поставить прямую ссылку cTrader — backend менять не потребуется.

После первого pairing секретный token хранится в LocalStorage конкретного
instance. Pairing code при следующих запусках не используется. Если instance
удалён вместе с LocalStorage, создайте новый код через `/connect_cbot`.

## Проверка перед live

На demo последовательно проверьте MARKET BUY, MARKET SELL, OCO, MULTI и
NEWS_REVERSAL минимальным lot. Проверьте реальные broker-side SL/TP, отмену
соседа OCO, отсутствие 5/6 корзины при rejection, `/jobs`, отмену pending и
закрытие позиций. Затем установите `Expected account` равным live account,
осознанно включите `Allow LIVE trading` и разрешите real trading на backend и у
пользователя.

Не запускайте два instance TradeTmConnector для одного счёта и символа.
cBot отклоняет другой активный account при heartbeat, а backend выдаёт задания
только тому instance, который был выбран в Telegram.
