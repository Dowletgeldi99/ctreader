# TradeTm Connector — подключение

Это production transport между Telegram/backend и торговым счётом cTrader.
Один пользователь запускает один экземпляр cBot на своём счёте и управляет
заданиями только через Telegram.

## Установка

1. В Telegram отправьте `/connect_cbot`. Код действует 10 минут и используется один раз.
2. Откройте cTrader Windows/Mac → **Algo** → **New cBot** и назовите его `TradeTmConnector`.
3. Полностью замените созданный C# код содержимым `TradeTmConnector.cs` и нажмите **Build**.
4. Добавьте instance cBot на график **XAUUSD** нужного счёта.
5. Укажите параметры:
   - `Backend URL`: `https://api.tradetm.club` (или фактический URL API);
   - `Pairing code`: код из Telegram;
   - `Expected account`: номер выбранного счёта;
   - `Allow LIVE trading`: `No` для demo; для live включать только после полной demo-проверки;
   - `Poll interval ms`: `500`.
6. Нажмите **Start**. В логе должно появиться `cBot paired`.
7. В Telegram проверьте `/status`, затем `/test` и выберите счёт с префиксом `cBot`.

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
