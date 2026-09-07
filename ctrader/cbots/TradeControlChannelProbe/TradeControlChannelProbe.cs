using System;
using cAlgo.API;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class TradeControlChannelProbe : Robot
{
    private const string PositionLabel = "tradecontrol-channel-probe";

    [Parameter("Send One Test Order", DefaultValue = false, Group = "Confirmation")]
    public bool SendTestOrder { get; set; }

    [Parameter("Allow Live Account", DefaultValue = false, Group = "Confirmation")]
    public bool AllowLiveAccount { get; set; }

    [Parameter("Expected Account Number", DefaultValue = 0, MinValue = 1, Group = "Confirmation")]
    public int ExpectedAccountNumber { get; set; }

    [Parameter("Direction", DefaultValue = "BUY", Group = "Order")]
    public string Direction { get; set; } = "BUY";

    [Parameter("Volume (lots)", DefaultValue = 0.01, MinValue = 0.01, Step = 0.01, Group = "Order")]
    public double VolumeInLots { get; set; }

    [Parameter("Stop Loss (pips)", DefaultValue = 10, MinValue = 1, Group = "Protection")]
    public double StopLossInPips { get; set; }

    [Parameter("Take Profit (pips)", DefaultValue = 20, MinValue = 1, Group = "Protection")]
    public double TakeProfitInPips { get; set; }

    protected override void OnStart()
    {
        Print(
            "TradeControl channel probe started. Broker={0}, Account={1}, Live={2}, Symbol={3}, Balance={4}, FreeMargin={5}",
            Account.BrokerName,
            Account.Number,
            Account.IsLive,
            SymbolName,
            Account.Balance,
            Account.FreeMargin);

        if (!SendTestOrder)
        {
            StopWithMessage("No order sent. Set 'Send One Test Order' to Yes when ready.");
            return;
        }

        if (ExpectedAccountNumber <= 0 || Account.Number != ExpectedAccountNumber)
        {
            StopWithMessage($"Account check failed. Expected {ExpectedAccountNumber}, active account is {Account.Number}.");
            return;
        }

        if (Account.IsLive && !AllowLiveAccount)
        {
            StopWithMessage("Live order blocked locally. Set 'Allow Live Account' to Yes only for the intended test.");
            return;
        }

        var direction = (Direction ?? string.Empty).Trim().ToUpperInvariant();
        if (direction != "BUY" && direction != "SELL")
        {
            StopWithMessage("Direction must be BUY or SELL.");
            return;
        }

        var requestedVolume = Symbol.QuantityToVolumeInUnits(VolumeInLots);
        var volume = Symbol.NormalizeVolumeInUnits(requestedVolume, RoundingMode.Down);
        if (volume < Symbol.VolumeInUnitsMin || volume > Symbol.VolumeInUnitsMax)
        {
            StopWithMessage(
                $"Volume rejected locally. Normalized={volume}, broker range={Symbol.VolumeInUnitsMin}..{Symbol.VolumeInUnitsMax} units.");
            return;
        }

        if (Positions.FindAll(PositionLabel, SymbolName).Length > 0)
        {
            StopWithMessage("An open channel-probe position already exists. No duplicate order was sent.");
            return;
        }

        var tradeType = direction == "BUY" ? TradeType.Buy : TradeType.Sell;
        Print(
            "Sending one test order: Type={0}, Symbol={1}, Lots={2}, Units={3}, SL={4} pips, TP={5} pips",
            tradeType,
            SymbolName,
            VolumeInLots,
            volume,
            StopLossInPips,
            TakeProfitInPips);

        var result = ExecuteMarketOrder(
            tradeType,
            SymbolName,
            volume,
            PositionLabel,
            StopLossInPips,
            TakeProfitInPips,
            "TradeControl cBot channel test");

        if (!result.IsSuccessful)
        {
            Print("CHANNEL PROBE REJECTED: Error={0}", result.Error);
            Stop();
            return;
        }

        Print(
            "CHANNEL PROBE FILLED: PositionId={0}, EntryPrice={1}, Volume={2}. The position remains protected by broker-side SL/TP.",
            result.Position.Id,
            result.Position.EntryPrice,
            result.Position.VolumeInUnits);
        Stop();
    }

    private void StopWithMessage(string message)
    {
        Print(message);
        Stop();
    }
}
