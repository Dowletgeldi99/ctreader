using System;
using System.Collections.Generic;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots;

[Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
public class TradeControlFullEachProbe : Robot
{
    private const string LabelPrefix = "tc-full-each-";

    [Parameter("Place 6 Test Orders", DefaultValue = false, Group = "Confirmation")]
    public bool PlaceTestOrders { get; set; }

    [Parameter("Allow Live Account", DefaultValue = false, Group = "Confirmation")]
    public bool AllowLiveAccount { get; set; }

    [Parameter("Expected Account Number", DefaultValue = 0, MinValue = 1, Group = "Confirmation")]
    public int ExpectedAccountNumber { get; set; }

    [Parameter("Lot for EACH order", DefaultValue = 0.01, MinValue = 0.01, Step = 0.01, Group = "Orders")]
    public double LotPerOrder { get; set; }

    [Parameter("App Pip Size", DefaultValue = 0.1, MinValue = 0.00001, Group = "Orders")]
    public double AppPipSize { get; set; }

    [Parameter("Entry Distance (pips)", DefaultValue = 50, MinValue = 1, Group = "Orders")]
    public double EntryDistancePips { get; set; }

    [Parameter("Stop Loss (pips)", DefaultValue = 10, MinValue = 1, Group = "Protection")]
    public double StopLossPips { get; set; }

    [Parameter("TP1 (pips)", DefaultValue = 100, MinValue = 1, Group = "Protection")]
    public double TakeProfit1Pips { get; set; }

    [Parameter("TP2 (pips)", DefaultValue = 200, MinValue = 1, Group = "Protection")]
    public double TakeProfit2Pips { get; set; }

    [Parameter("TP3 (pips)", DefaultValue = 300, MinValue = 1, Group = "Protection")]
    public double TakeProfit3Pips { get; set; }

    [Parameter("Pending Lifetime (sec)", DefaultValue = 30, MinValue = 10, MaxValue = 300, Group = "Orders")]
    public int PendingLifetimeSeconds { get; set; }

    protected override void OnStart()
    {
        Print(
            "FULL_EACH probe started. Broker={0}, Account={1}, Live={2}, Type={3}, Symbol={4}, Balance={5}, FreeMargin={6}",
            Account.BrokerName,
            Account.Number,
            Account.IsLive,
            Account.AccountType,
            SymbolName,
            Account.Balance,
            Account.FreeMargin);

        if (!PlaceTestOrders)
        {
            StopWithMessage("No orders sent. Set 'Place 6 Test Orders' to Yes when ready.");
            return;
        }

        if (ExpectedAccountNumber <= 0 || Account.Number != ExpectedAccountNumber)
        {
            StopWithMessage($"Account check failed. Expected {ExpectedAccountNumber}, active account is {Account.Number}.");
            return;
        }

        if (Account.IsLive && !AllowLiveAccount)
        {
            StopWithMessage("Live orders blocked locally. Set 'Allow Live Account' to Yes only for the intended test.");
            return;
        }

        if (Account.AccountType != AccountType.Hedged)
        {
            StopWithMessage($"FULL_EACH requires a Hedged account. Active account type is {Account.AccountType}.");
            return;
        }

        if (HasExistingProbeExposure())
        {
            StopWithMessage("Existing FULL_EACH probe orders or positions found. No duplicate orders were sent.");
            return;
        }

        var requestedVolume = Symbol.QuantityToVolumeInUnits(LotPerOrder);
        var volume = Symbol.NormalizeVolumeInUnits(requestedVolume, RoundingMode.Down);
        if (volume < Symbol.VolumeInUnitsMin || volume > Symbol.VolumeInUnitsMax)
        {
            StopWithMessage(
                $"Volume rejected locally. Normalized={volume}, broker range={Symbol.VolumeInUnitsMin}..{Symbol.VolumeInUnitsMax} units.");
            return;
        }

        var nativePipsPerAppPip = AppPipSize / Symbol.PipSize;
        var nativeStopLossPips = StopLossPips * nativePipsPerAppPip;
        var buyEntry = Math.Round(Symbol.Ask + EntryDistancePips * AppPipSize, Symbol.Digits);
        var sellEntry = Math.Round(Symbol.Bid - EntryDistancePips * AppPipSize, Symbol.Digits);
        var expiration = Server.Time.AddSeconds(PendingLifetimeSeconds);
        var targets = new[]
        {
            TakeProfit1Pips * nativePipsPerAppPip,
            TakeProfit2Pips * nativePipsPerAppPip,
            TakeProfit3Pips * nativePipsPerAppPip
        };
        var accepted = new List<PendingOrder>();

        Print(
            "Pip conversion: AppPipSize={0}, BrokerPipSize={1}, NativePipsPerAppPip={2}",
            AppPipSize,
            Symbol.PipSize,
            nativePipsPerAppPip);
        Print(
            "Placing FULL_EACH: 3 BUY + 3 SELL, each={0} lot ({1} units), entries BUY={2} SELL={3}, app SL={4}, app TP={5}/{6}/{7}, expiry={8:O}",
            LotPerOrder,
            volume,
            buyEntry,
            sellEntry,
            StopLossPips,
            TakeProfit1Pips,
            TakeProfit2Pips,
            TakeProfit3Pips,
            expiration);

        for (var index = 0; index < targets.Length; index++)
        {
            if (!PlaceLeg(TradeType.Buy, buyEntry, volume, nativeStopLossPips, targets[index], index + 1, expiration, accepted) ||
                !PlaceLeg(TradeType.Sell, sellEntry, volume, nativeStopLossPips, targets[index], index + 1, expiration, accepted))
            {
                CancelAcceptedOrders(accepted);
                StopWithMessage("FULL_EACH REJECTED: at least one leg failed; accepted sibling orders were cancelled.");
                return;
            }
        }

        Print(
            "FULL_EACH ACCEPTED: {0}/6 pending orders placed. They expire automatically at {1:O}. Filled positions remain protected by their SL/TP.",
            accepted.Count,
            expiration);
        Stop();
    }

    private bool PlaceLeg(
        TradeType tradeType,
        double entryPrice,
        double volume,
        double nativeStopLossPips,
        double nativeTakeProfitPips,
        int targetNumber,
        DateTime expiration,
        List<PendingOrder> accepted)
    {
        var side = tradeType == TradeType.Buy ? "B" : "S";
        var label = $"{LabelPrefix}{side}{targetNumber}";
        var result = PlaceStopOrder(
            tradeType,
            SymbolName,
            volume,
            entryPrice,
            label,
            nativeStopLossPips,
            nativeTakeProfitPips,
            ProtectionType.Relative,
            expiration,
            "TradeControl FULL_EACH channel test");

        if (!result.IsSuccessful)
        {
            Print(
                "LEG REJECTED: Side={0}, TP={1}, Entry={2}, Error={3}",
                tradeType,
                targetNumber,
                entryPrice,
                result.Error);
            return false;
        }

        accepted.Add(result.PendingOrder);
        Print(
            "LEG ACCEPTED: OrderId={0}, Side={1}, TP={2}, Entry={3}, SL={4} pips, TP distance={5} pips",
            result.PendingOrder.Id,
            tradeType,
            targetNumber,
            entryPrice,
            nativeStopLossPips,
            nativeTakeProfitPips);
        return true;
    }

    private bool HasExistingProbeExposure()
    {
        foreach (var order in PendingOrders)
        {
            if (order.Label != null && order.Label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                return true;
        }

        foreach (var position in Positions)
        {
            if (position.Label != null && position.Label.StartsWith(LabelPrefix, StringComparison.Ordinal))
                return true;
        }

        return false;
    }

    private void CancelAcceptedOrders(IEnumerable<PendingOrder> accepted)
    {
        foreach (var order in accepted)
        {
            var current = PendingOrders.FindById(order.Id);
            if (current != null)
                CancelPendingOrder(current);
        }
    }

    private void StopWithMessage(string message)
    {
        Print(message);
        Stop();
    }
}
