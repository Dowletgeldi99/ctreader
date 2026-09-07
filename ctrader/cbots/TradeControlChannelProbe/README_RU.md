# TradeControl cBot Channel Probe

Минимальный одноразовый cBot для проверки, разрешает ли FxPro торговые
операции через cTrader Algo/Automate, когда тот же счёт отклоняет Open API с
`CHANNEL_IS_BLOCKED`.

Это ещё не Telegram-агент и не реализация `NEWS_REVERSAL`. Успешный тест
подтверждает только возможность использовать cBot как новый execution adapter.

## Безопасность

- по умолчанию `Send One Test Order = No`;
- Live-счёт требует `Allow Live Account = Yes`;
- активный счёт должен точно совпасть с `Expected Account Number`;
- одновременно допускается только одна probe-позиция с этим label;
- после одного запроса cBot останавливается;
- успешно открытая позиция **не закрывается** при остановке cBot: она остаётся
  с установленными broker-side SL/TP.

## Установка в cTrader Mac/Windows

1. Откройте cTrader и войдите в cTrader ID, к которому подключён FxPro-счёт.
2. Откройте **Algo** → **cBots** → **New** → **C#**.
3. Назовите cBot `TradeControlChannelProbe`.
4. Полностью замените созданный код содержимым файла
   `TradeControlChannelProbe.cs`.
5. Нажмите **Build**. Сборка должна завершиться без ошибок.
6. Создайте instance на символе `XAUUSD` и нужном FxPro-счёте.

## Первый безопасный запуск

Сначала запустите с настройками по умолчанию. В Log должно появиться:

```text
No order sent. Set 'Send One Test Order' to Yes when ready.
```

Для одного Live-теста на счёте `8310587` установите:

```text
Send One Test Order: Yes
Allow Live Account: Yes
Expected Account Number: 8310587
Direction: BUY
Volume (lots): 0.01
Stop Loss (pips): 10
Take Profit (pips): 20
```

Перед запуском убедитесь, что выбран именно `XAUUSD` и на счёте достаточно
свободной маржи. Нажмите **Start** только один раз.

## Как понять результат

Успех:

```text
CHANNEL PROBE FILLED: PositionId=...
```

Это означает, что FxPro разрешает cBot/Automate trading и можно переносить в
cBot получение Telegram-заданий, idempotency, `MARKET`, `OCO`, `MULTI` и
`NEWS_REVERSAL`.

Отказ:

```text
CHANNEL PROBE REJECTED: Error=...
```

Скопируйте всю строку из вкладки **Log**. Если cBot также отклонён, переход на
cBot не обойдёт ограничение данного FxPro-счёта.
