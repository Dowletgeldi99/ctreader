# TradeControl FULL_EACH Probe

Одноразовая проверка размещения `3 BUY STOP + 3 SELL STOP` через cTrader
Algo/Automate. Каждый из шести ордеров получает полный выбранный lot.

Настройки теста для FxPro Live `8310587`:

```text
Place 6 Test Orders: Yes
Allow Live Account: Yes
Expected Account Number: 8310587
Lot for EACH order: 0.01
App Pip Size: 0.1
Entry Distance: 50 pips
Stop Loss: 10 pips
TP1: 100 pips
TP2: 200 pips
TP3: 300 pips
Pending Lifetime: 30 sec
```

Для XAUUSD пользовательский pip приложения равен `$0.10`. cBot переводит его
в broker-native pips через `App Pip Size / Symbol.PipSize`. Например, если
FxPro сообщает `Symbol.PipSize = 0.01`, значение `100 app pips` становится
`1000 native pips`, то есть расстоянием `$10` по цене золота.

При успехе в Log появится:

```text
FULL_EACH ACCEPTED: 6/6 pending orders placed
```

Если одна нога отклонена, cBot отменяет уже принятые pending-ордера и пишет
точную ошибку. После успешной установки cBot останавливается, pending-ордера
удаляются брокером по expiration, а успевшие исполниться позиции остаются с
broker-side SL/TP.

Это probe размещения шести ордеров. Он пока не реализует перенос встречных
ордеров на уровень reversal и дальнейшее управление `NEWS_REVERSAL`.
