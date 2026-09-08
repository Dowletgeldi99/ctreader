using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class TradeTmConnector : Robot
    {
        [Parameter("Backend URL", DefaultValue = "https://bot.tradetm.club")]
        public string BackendUrl { get; set; }

        [Parameter("Pairing code", DefaultValue = "")]
        public string PairingCode { get; set; }

        [Parameter("Expected account", DefaultValue = "")]
        public string ExpectedAccount { get; set; }

        [Parameter("Allow LIVE trading", DefaultValue = false)]
        public bool AllowLiveTrading { get; set; }

        [Parameter("Poll interval ms", DefaultValue = 500, MinValue = 250, MaxValue = 5000)]
        public int PollIntervalMs { get; set; }

        [Parameter("API timeout sec", DefaultValue = 5, MinValue = 1, MaxValue = 30)]
        public int ApiTimeoutSeconds { get; set; }

        [Parameter("Max managed exposure", DefaultValue = 20, MinValue = 1, MaxValue = 100)]
        public int MaxManagedExposure { get; set; }

        [Parameter("Margin buffer %", DefaultValue = 10, MinValue = 0, MaxValue = 100)]
        public double MarginBufferPercent { get; set; }

        private const string TokenKey = "TradeTm Token";
        private const string InstanceKeyKey = "TradeTm Instance";
        private const string Version = "1.0.0";
        private readonly JsonSerializerOptions _json = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            NumberHandling = JsonNumberHandling.AllowReadingFromString,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };
        private readonly Dictionary<string, JobRuntime> _jobs = new Dictionary<string, JobRuntime>();
        private readonly Queue<PendingReport> _reportOutbox = new Queue<PendingReport>();
        private string _token;
        private string _instanceId;
        private string _instanceKey;
        private DateTime _lastPoll = DateTime.MinValue;
        private DateTime _lastHeartbeat = DateTime.MinValue;
        private long _reportSequence;
        private bool _busy;
        private bool _acceptNewJobs = true;

        protected override void OnStart()
        {
            BackendUrl = (BackendUrl ?? "").Trim().TrimEnd('/');
            if (!BackendUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) &&
                !BackendUrl.StartsWith("http://localhost", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Backend URL must use HTTPS (localhost is allowed for development)");
            if (!string.IsNullOrWhiteSpace(ExpectedAccount) && ExpectedAccount.Trim() != Account.Number.ToString(CultureInfo.InvariantCulture))
                throw new InvalidOperationException("Wrong account. Expected " + ExpectedAccount + ", active " + Account.Number);
            if (Account.IsLive && !AllowLiveTrading)
                throw new InvalidOperationException("LIVE account blocked. Enable 'Allow LIVE trading' only after demo verification");

            _instanceKey = LocalStorage.GetString(InstanceKeyKey);
            if (string.IsNullOrWhiteSpace(_instanceKey))
            {
                _instanceKey = Guid.NewGuid().ToString("N");
                LocalStorage.SetString(InstanceKeyKey, _instanceKey);
                LocalStorage.Flush(LocalStorageScope.Instance);
            }
            _token = LocalStorage.GetString(TokenKey);

            PendingOrders.Filled += OnPendingFilled;
            Positions.Closed += OnPositionClosed;

            if (string.IsNullOrWhiteSpace(_token)) Pair();
            else Heartbeat();

            Timer.Start(TimeSpan.FromMilliseconds(Math.Max(250, PollIntervalMs)));
            Print("TradeTm connector {0}: {1} {2}, symbol {3}", Version, Account.BrokerName, Account.Number, SymbolName);
        }

        protected override void OnTimer()
        {
            if (_busy || string.IsNullOrWhiteSpace(_token)) return;
            _busy = true;
            try
            {
                var now = DateTime.UtcNow;
                FlushReportOutbox();
                if ((now - _lastHeartbeat).TotalSeconds >= 20) Heartbeat();
                if ((now - _lastPoll).TotalMilliseconds >= PollIntervalMs) Poll();
                ProcessJobs(now);
            }
            catch (Exception ex) { Print("TradeTm timer error: {0}", ex.Message); }
            finally { _busy = false; }
        }

        protected override void OnException(Exception exception) { Print("TradeTm exception: {0}", exception); }

        private void Pair()
        {
            if (string.IsNullOrWhiteSpace(PairingCode))
                throw new InvalidOperationException("Create /connect_cbot in Telegram and enter Pairing code in cBot parameters");
            var body = new PairRequest
            {
                Code = PairingCode.Trim().ToUpperInvariant(), InstanceKey = _instanceKey,
                AccountNumber = Account.Number.ToString(CultureInfo.InvariantCulture),
                Broker = Account.BrokerName, Environment = Account.IsLive ? "LIVE" : "DEMO",
                Symbol = SymbolName, Version = Version
            };
            var response = Send<PairResponse>("/api/v1/cbot/pairing/claim", "POST", body, false);
            _token = response.Token;
            _instanceId = response.InstanceId;
            LocalStorage.SetString(TokenKey, _token);
            LocalStorage.Flush(LocalStorageScope.Instance);
            Print("cBot paired. Instance: {0}", _instanceId);
        }

        private void Heartbeat()
        {
            var response = Send<HeartbeatResponse>("/api/v1/cbot/heartbeat", "POST", new
            {
                accountNumber = Account.Number.ToString(CultureInfo.InvariantCulture),
                broker = Account.BrokerName,
                environment = Account.IsLive ? "LIVE" : "DEMO",
                symbol = SymbolName,
                version = Version
            }, true);
            _instanceId = response.Id;
            _lastHeartbeat = DateTime.UtcNow;
        }

        private void Poll()
        {
            var response = Send<PollResponse>("/api/v1/cbot/jobs?horizonMinutes=1440", "GET", null, true);
            _lastPoll = DateTime.UtcNow;
            _acceptNewJobs = response.AcceptNewJobs;
            foreach (var dto in response.Jobs ?? Array.Empty<JobDto>())
            {
                JobRuntime runtime;
                if (!_jobs.TryGetValue(dto.Id, out runtime))
                {
                    runtime = new JobRuntime(dto);
                    _jobs[dto.Id] = runtime;
                }
                else runtime.Update(dto);
            }
        }

        private void ProcessJobs(DateTime now)
        {
            foreach (var runtime in _jobs.Values.ToArray())
            {
                var job = runtime.Job;
                if (!string.Equals(job.Symbol, SymbolName, StringComparison.OrdinalIgnoreCase))
                {
                    if (!runtime.TerminalReported)
                    {
                        Report(runtime, "PREFLIGHT_REJECTED", "Wrong chart symbol: expected " + job.Symbol + ", active " + SymbolName);
                        runtime.TerminalReported = true;
                    }
                    continue;
                }
                if (job.CloseRequested) { CloseExposure(runtime); continue; }
                if (job.CancelRequested) { CancelPending(runtime); continue; }
                if (!_acceptNewJobs)
                {
                    if (runtime.Submitted)
                    {
                        CancelWhere(runtime, o => true);
                    }
                    else if (!runtime.TerminalReported)
                    {
                        Report(runtime, "CANCELLED", "New entries disabled by subscription or emergency switch");
                        runtime.TerminalReported = true;
                    }
                    continue;
                }

                if (!string.IsNullOrWhiteSpace(job.ManagementExpiresAt) && now >= ParseUtc(job.ManagementExpiresAt))
                {
                    CancelWhere(runtime, o => true);
                    if (!Positions.Any(p => IsJobLabel(p.Label, runtime.Prefix)) && !runtime.TerminalReported)
                    {
                        Report(runtime, "CLOSED", "Management window ended; remaining pending orders cancelled");
                        runtime.TerminalReported = true;
                    }
                    continue;
                }

                var executeAt = ParseUtc(job.ExecuteAt);
                var expiresAt = ParseUtc(job.ExpiresAt);
                var armAt = executeAt.AddSeconds(-job.ArmSeconds);
                if (!runtime.Armed && now >= armAt)
                {
                    runtime.Armed = true;
                    Report(runtime, "ARMED", "Local execution timer armed");
                }
                if (runtime.Submitted || now < (job.ExecutionMode == "MARKET" ? executeAt : armAt)) continue;
                if (now > expiresAt || (job.ExecutionMode == "MARKET" && (now - executeAt).TotalMilliseconds > job.MaxLatenessMs))
                {
                    Report(runtime, "MISSED", "Execution window missed");
                    runtime.Submitted = runtime.TerminalReported = true;
                    continue;
                }
                Submit(runtime);
            }
        }

        private void Submit(JobRuntime runtime)
        {
            var job = runtime.Job;
            if (SpreadPoints() > job.MaxSpreadPoints)
            {
                Report(runtime, "PREFLIGHT_REJECTED", "Spread exceeds limit: " + SpreadPoints() + " > " + job.MaxSpreadPoints);
                runtime.Submitted = runtime.TerminalReported = true;
                return;
            }
            if (!Symbol.IsTradingEnabled)
            {
                Report(runtime, "PREFLIGHT_REJECTED", "Trading is disabled for " + SymbolName);
                runtime.Submitted = runtime.TerminalReported = true;
                return;
            }
            if ((job.ExecutionMode == "MULTI" || job.ExecutionMode == "NEWS_REVERSAL") && Account.AccountType != AccountType.Hedged)
            {
                Report(runtime, "PREFLIGHT_REJECTED", job.ExecutionMode + " requires a Hedged account");
                runtime.Submitted = runtime.TerminalReported = true;
                return;
            }
            var perOrderVolume = VolumeInUnits(LotForOrder(job));
            if (perOrderVolume < Symbol.VolumeInUnitsMin || perOrderVolume > Symbol.VolumeInUnitsMax)
            {
                Report(runtime, "PREFLIGHT_REJECTED", "Normalized volume " + perOrderVolume +
                    " is outside broker range " + Symbol.VolumeInUnitsMin + ".." + Symbol.VolumeInUnitsMax);
                runtime.Submitted = runtime.TerminalReported = true;
                return;
            }
            var orderCount = ExpectedOrderCount(job);
            var existingExposure = Positions.Count + PendingOrders.Count;
            if (existingExposure + orderCount > MaxManagedExposure)
            {
                Report(runtime, "PREFLIGHT_REJECTED", "Exposure limit: " + existingExposure + " existing + " + orderCount +
                    " requested exceeds " + MaxManagedExposure);
                runtime.Submitted = runtime.TerminalReported = true;
                return;
            }
            var estimatedMargin = Math.Max(Symbol.GetEstimatedMargin(TradeType.Buy, perOrderVolume),
                Symbol.GetEstimatedMargin(TradeType.Sell, perOrderVolume)) * orderCount;
            if (estimatedMargin * (1.0 + MarginBufferPercent / 100.0) > Account.FreeMargin)
            {
                Report(runtime, "PREFLIGHT_REJECTED", "Estimated margin " + estimatedMargin.ToString("F2") +
                    " plus buffer exceeds free margin " + Account.FreeMargin.ToString("F2"));
                runtime.Submitted = runtime.TerminalReported = true;
                return;
            }
            if (HasExposure(runtime.Prefix))
            {
                runtime.Submitted = true;
                Report(runtime, "SUBMITTED", "Recovered existing broker exposure; duplicate submission skipped");
                return;
            }

            runtime.Submitted = true;
            runtime.AnchorAsk = Symbol.Ask;
            runtime.AnchorBid = Symbol.Bid;
            var results = new List<TradeResult>();
            if (job.ExecutionMode == "MARKET") results.Add(PlaceMarket(runtime, job.Direction == "SELL" ? TradeType.Sell : TradeType.Buy));
            else if (job.ExecutionMode == "STRADDLE")
            {
                results.Add(PlaceStop(runtime, TradeType.Buy, 1, job.EntryDistancePoints, job.StopLossPoints, job.TakeProfitPoints, "O"));
                results.Add(PlaceStop(runtime, TradeType.Sell, 1, job.EntryDistancePoints, job.StopLossPoints, job.TakeProfitPoints, "O"));
            }
            else if (job.ExecutionMode == "MULTI") PlaceMulti(runtime, results);
            else if (job.ExecutionMode == "NEWS_REVERSAL") PlaceInitialReversalBasket(runtime, results);
            else
            {
                Report(runtime, "REJECTED", "Unsupported execution mode " + job.ExecutionMode);
                runtime.TerminalReported = true;
                return;
            }

            var accepted = results.Count(x => x != null && x.IsSuccessful);
            if (accepted != results.Count)
            {
                CancelWhere(runtime, o => true);
                var error = results.FirstOrDefault(x => x != null && !x.IsSuccessful);
                Report(runtime, "REJECTED", "Atomic basket rejected (" + accepted + "/" + results.Count + "). " +
                    (error == null ? "No order result" : error.Error.ToString()));
                runtime.TerminalReported = true;
                return;
            }
            Report(runtime, "SUBMITTED", accepted + "/" + results.Count + " orders accepted");
            if (job.ExecutionMode == "MARKET" && results[0].Position != null)
                Report(runtime, "FILLED", "Market position opened", null, results[0].Position.Id.ToString(),
                    results[0].Position.EntryPrice, results[0].Position.VolumeInUnits);
        }

        private TradeResult PlaceMarket(JobRuntime runtime, TradeType type)
        {
            var job = runtime.Job;
            var volume = VolumeInUnits(job.FixedLot);
            var label = Label(runtime, "M", type, 1);
            var result = ExecuteMarketOrder(type, SymbolName, volume, label, PointsToPips(job.StopLossPoints), PointsToPips(job.TakeProfitPoints), "TradeTm " + job.Id);
            return result;
        }

        private void PlaceMulti(JobRuntime runtime, List<TradeResult> results)
        {
            var j = runtime.Job;
            var count = Math.Max(2, j.MultiTradesPerSide);
            for (var i = 1; i <= count; i++)
            {
                var entry = j.EntryDistancePoints + (i - 1) * j.MultiNextStepPoints;
                var sl = i == 1 ? j.StopLossPoints : j.MultiNextSlPoints;
                var tp = j.TakeProfitPoints + (i - 1) * j.MultiNextTpPoints;
                results.Add(PlaceStop(runtime, TradeType.Buy, i, entry, sl, tp, "I"));
                results.Add(PlaceStop(runtime, TradeType.Sell, i, entry, sl, tp, "I"));
            }
        }

        private void PlaceInitialReversalBasket(JobRuntime runtime, List<TradeResult> results)
        {
            var j = runtime.Job;
            for (var i = 1; i <= 3; i++)
            {
                var tp = i == 1 ? j.TakeProfitPoints : i == 2 ? j.TakeProfit2Points : j.TakeProfit3Points;
                results.Add(PlaceStop(runtime, TradeType.Buy, i, j.EntryDistancePoints, j.StopLossPoints, tp, "I"));
                results.Add(PlaceStop(runtime, TradeType.Sell, i, j.EntryDistancePoints, j.StopLossPoints, tp, "I"));
            }
        }

        private TradeResult PlaceStop(JobRuntime runtime, TradeType type, int level, int entryPoints, int slPoints, int tpPoints, string leg)
        {
            var distance = entryPoints * Symbol.TickSize;
            var anchor = type == TradeType.Buy ? runtime.AnchorAsk : runtime.AnchorBid;
            var target = Math.Round(type == TradeType.Buy ? anchor + distance : anchor - distance, Symbol.Digits);
            var expiry = ParseUtc(runtime.Job.ExpiresAt);
            var volume = VolumeInUnits(LotForOrder(runtime.Job));
            return PlaceStopOrder(type, SymbolName, volume, target, Label(runtime, leg, type, level),
                PointsToPips(slPoints), PointsToPips(tpPoints), ProtectionType.Relative, expiry, "TradeTm " + runtime.Job.Id, false);
        }

        private void OnPendingFilled(PendingOrderFilledEventArgs args)
        {
            var runtime = RuntimeForLabel(args.PendingOrder.Label);
            if (runtime == null) return;
            Report(runtime, "FILLED", "Pending order filled", args.PendingOrder.Id.ToString(), args.Position.Id.ToString(), args.Position.EntryPrice, args.Position.VolumeInUnits);
            var j = runtime.Job;
            if (j.ExecutionMode == "STRADDLE")
                CancelWhere(runtime, o => o.TradeType != args.Position.TradeType);
            else if (j.ExecutionMode == "NEWS_REVERSAL" && args.PendingOrder.Label.Contains(":I:") && !runtime.ReversalPlaced)
            {
                runtime.ReversalPlaced = true;
                CancelWhere(runtime, o => o.Label.Contains(":I:") && o.TradeType != args.Position.TradeType);
                PlaceReversal(runtime, args.Position);
            }
        }

        private void PlaceReversal(JobRuntime runtime, Position trigger)
        {
            var j = runtime.Job;
            if (j.MaxReversals < 1) return;
            var opposite = trigger.TradeType == TradeType.Buy ? TradeType.Sell : TradeType.Buy;
            var triggerSl = trigger.StopLoss;
            if (!triggerSl.HasValue)
            {
                Report(runtime, "ERROR", "Cannot place reversal: trigger position has no broker SL");
                return;
            }
            var offset = j.ReversalGapPoints * Symbol.TickSize;
            var target = Math.Round(opposite == TradeType.Sell ? triggerSl.Value - offset : triggerSl.Value + offset, Symbol.Digits);
            for (var i = 1; i <= 3; i++)
            {
                var tp = i == 1 ? j.TakeProfitPoints : i == 2 ? j.TakeProfit2Points : j.TakeProfit3Points;
                var result = PlaceStopOrder(opposite, SymbolName, VolumeInUnits(LotForOrder(j)), target,
                    Label(runtime, "R", opposite, i), PointsToPips(j.StopLossPoints), PointsToPips(tp),
                    ProtectionType.Relative,
                    ParseUtc(string.IsNullOrWhiteSpace(j.ManagementExpiresAt) ? j.ExpiresAt : j.ManagementExpiresAt),
                    "TradeTm reversal " + j.Id, false);
                if (!result.IsSuccessful) Report(runtime, "ERROR", "Reversal level " + i + ": " + result.Error);
            }
            Report(runtime, "ERROR", "One reversal basket placed at trigger SL plus gap");
        }

        private void OnPositionClosed(PositionClosedEventArgs args)
        {
            var runtime = RuntimeForLabel(args.Position.Label);
            if (runtime == null) return;
            BeginInvokeOnMainThread(() =>
            {
                if (!HasExposure(runtime.Prefix))
                {
                    Report(runtime, "CLOSED", "All job positions and orders are closed");
                    runtime.TerminalReported = true;
                }
            });
        }

        private void CancelPending(JobRuntime runtime)
        {
            CancelWhere(runtime, o => true);
            if (!Positions.Any(p => IsJobLabel(p.Label, runtime.Prefix)))
            {
                Report(runtime, "CANCELLED", "Pending orders cancelled");
                runtime.TerminalReported = true;
            }
        }

        private void CloseExposure(JobRuntime runtime)
        {
            CancelWhere(runtime, o => true);
            foreach (var position in Positions.Where(p => IsJobLabel(p.Label, runtime.Prefix)).ToArray()) ClosePosition(position);
            if (!HasExposure(runtime.Prefix))
            {
                Report(runtime, "CLOSED", "Emergency close completed");
                runtime.TerminalReported = true;
            }
        }

        private void CancelWhere(JobRuntime runtime, Func<PendingOrder, bool> filter)
        {
            foreach (var order in PendingOrders.Where(o => IsJobLabel(o.Label, runtime.Prefix) && filter(o)).ToArray())
                CancelPendingOrder(order);
        }

        private bool HasExposure(string prefix)
        {
            return PendingOrders.Any(o => IsJobLabel(o.Label, prefix)) || Positions.Any(p => IsJobLabel(p.Label, prefix));
        }

        private static bool IsJobLabel(string label, string prefix) { return !string.IsNullOrEmpty(label) && label.StartsWith(prefix + ":", StringComparison.Ordinal); }

        private JobRuntime RuntimeForLabel(string label)
        {
            if (string.IsNullOrWhiteSpace(label)) return null;
            return _jobs.Values.FirstOrDefault(x => IsJobLabel(label, x.Prefix));
        }

        private string Label(JobRuntime runtime, string leg, TradeType side, int level)
        {
            return runtime.Prefix + ":" + leg + ":" + (side == TradeType.Buy ? "B" : "S") + ":" + level;
        }

        private double LotForOrder(JobDto j)
        {
            if (j.ExecutionMode == "NEWS_REVERSAL" && j.VolumeAllocationMode == "SPLIT_TOTAL") return j.FixedLot / 3.0;
            return j.FixedLot;
        }

        private int ExpectedOrderCount(JobDto j)
        {
            if (j.ExecutionMode == "MARKET") return 1;
            if (j.ExecutionMode == "STRADDLE") return 2;
            if (j.ExecutionMode == "MULTI") return Math.Max(2, j.MultiTradesPerSide) * 2;
            if (j.ExecutionMode == "NEWS_REVERSAL") return 6;
            return 0;
        }

        private double VolumeInUnits(double lots)
        {
            var raw = Symbol.QuantityToVolumeInUnits(lots);
            return Symbol.NormalizeVolumeInUnits(raw, RoundingMode.Down);
        }

        private double PointsToPips(int points) { return points * Symbol.TickSize / Symbol.PipSize; }
        private int SpreadPoints() { return (int)Math.Ceiling((Symbol.Ask - Symbol.Bid) / Symbol.TickSize); }

        private void Report(JobRuntime runtime, string phase, string message, string orderId = null,
            string positionId = null, double? price = null, double? volumeUnits = null)
        {
            try
            {
                var report = new ReportRequest
                {
                    ReportKey = runtime.Job.Id + ":" + DateTime.UtcNow.Ticks + ":" + (++_reportSequence),
                    Phase = phase, OccurredAt = DateTime.UtcNow.ToString("O"), Message = message,
                    OrderTicket = orderId, DealTicket = positionId, FilledPrice = price,
                    FilledVolume = volumeUnits.HasValue ? Symbol.VolumeInUnitsToQuantity(volumeUnits.Value) : (double?)null,
                    SpreadPoints = SpreadPoints()
                };
                var path = "/api/v1/cbot/jobs/" + runtime.Job.Id + "/reports";
                try { Send<ReportResponse>(path, "POST", report, true); }
                catch
                {
                    if (_reportOutbox.Count < 500) _reportOutbox.Enqueue(new PendingReport { Path = path, Body = report });
                    throw;
                }
            }
            catch (Exception ex) { Print("Report {0} failed for {1}: {2}", phase, runtime.Job.Id, ex.Message); }
        }

        private void FlushReportOutbox()
        {
            var count = _reportOutbox.Count;
            for (var i = 0; i < count && _reportOutbox.Count > 0; i++)
            {
                var pending = _reportOutbox.Peek();
                try
                {
                    Send<ReportResponse>(pending.Path, "POST", pending.Body, true);
                    _reportOutbox.Dequeue();
                }
                catch { break; }
            }
        }

        private T Send<T>(string path, string method, object body, bool authenticated)
        {
            var request = new HttpRequest(new Uri(BackendUrl + path));
            request.Method = method == "POST" ? HttpMethod.Post : HttpMethod.Get;
            request.Timeout = TimeSpan.FromSeconds(ApiTimeoutSeconds);
            request.Headers.Add("Accept", "application/json");
            if (authenticated)
            {
                if (string.IsNullOrWhiteSpace(_token)) throw new InvalidOperationException("cBot is not paired");
                request.Headers.Add("Authorization", "Bearer " + _token);
            }
            if (body != null)
            {
                request.Headers.Add("Content-Type", "application/json");
                request.Body = JsonSerializer.Serialize(body, _json);
            }
            var response = Http.Send(request);
            if (!response.IsSuccessful) throw new InvalidOperationException("HTTP " + response.StatusCode + ": " + response.Body);
            return JsonSerializer.Deserialize<T>(response.Body, _json);
        }

        private static DateTime ParseUtc(string value)
        {
            return DateTime.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        }

        private sealed class JobRuntime
        {
            public JobDto Job { get; private set; }
            public string Prefix { get; private set; }
            public bool Armed { get; set; }
            public bool Submitted { get; set; }
            public bool ReversalPlaced { get; set; }
            public bool TerminalReported { get; set; }
            public double AnchorAsk { get; set; }
            public double AnchorBid { get; set; }
            public JobRuntime(JobDto job) { Job = job; Prefix = "tt" + job.Id.Replace("-", "").Substring(0, 14); }
            public void Update(JobDto job) { Job = job; }
        }

        private sealed class PairRequest
        {
            public string Code { get; set; }
            public string InstanceKey { get; set; }
            public string AccountNumber { get; set; }
            public string Broker { get; set; }
            public string Environment { get; set; }
            public string Symbol { get; set; }
            public string Version { get; set; }
        }
        private sealed class PairResponse { public string InstanceId { get; set; } public string Token { get; set; } }
        private sealed class HeartbeatResponse { public string Id { get; set; } }
        private sealed class PollResponse { public bool AcceptNewJobs { get; set; } public bool TradingHalted { get; set; } public JobDto[] Jobs { get; set; } }
        private sealed class ReportResponse { public bool Accepted { get; set; } }
        private sealed class PendingReport { public string Path { get; set; } public ReportRequest Body { get; set; } }
        private sealed class ReportRequest
        {
            public string ReportKey { get; set; }
            public string Phase { get; set; }
            public string OccurredAt { get; set; }
            public string OrderTicket { get; set; }
            public string DealTicket { get; set; }
            public string Message { get; set; }
            public double? FilledPrice { get; set; }
            public double? FilledVolume { get; set; }
            public int? SpreadPoints { get; set; }
        }
        private sealed class JobDto
        {
            public string Id { get; set; }
            public int Version { get; set; }
            public string Symbol { get; set; }
            public string Direction { get; set; }
            public string ExecutionMode { get; set; }
            public double FixedLot { get; set; }
            public int StopLossPoints { get; set; }
            public int TakeProfitPoints { get; set; }
            public int EntryDistancePoints { get; set; }
            public int DeviationPoints { get; set; }
            public int MaxSpreadPoints { get; set; }
            public int ArmSeconds { get; set; }
            public int MaxLatenessMs { get; set; }
            public int PendingExpirySeconds { get; set; }
            public int MultiTradesPerSide { get; set; }
            public int MultiNextStepPoints { get; set; }
            public int MultiNextSlPoints { get; set; }
            public int MultiNextTpPoints { get; set; }
            public string VolumeAllocationMode { get; set; }
            public int TakeProfit2Points { get; set; }
            public int TakeProfit3Points { get; set; }
            public int ReversalGapPoints { get; set; }
            public int MaxReversals { get; set; }
            public string ExecuteAt { get; set; }
            public string ExpiresAt { get; set; }
            public string ManagementExpiresAt { get; set; }
            public bool CancelRequested { get; set; }
            public bool CloseRequested { get; set; }
        }
    }
}
