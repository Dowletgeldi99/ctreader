#property copyright "MT5 News Trader"
#property version   "0.48"
#property strict

input string InpApiBaseUrl          = "http://127.0.0.1:3000/api";
input string InpPairingCode         = "";
input string InpAgentName           = "My MT5";
input bool   InpAllowRealTrading    = false;
input int    InpTimerMilliseconds   = 50;
input int    InpHeartbeatSeconds    = 15;
input int    InpPollSeconds         = 5;
input int    InpMaxTickAgeSeconds   = 30;
input ulong  InpMagicBase           = 51000000;
input bool   InpSyncEconomicCalendar = true;
input int    InpCalendarSyncMinutes  = 60;
input int    InpCalendarDaysAhead    = 7;
input bool   InpEnableStrategyV2      = false;
input string InpStrategySymbol        = "XAUUSD";

const string AGENT_VERSION = "0.4.8";
const string IDENTITY_FILE = "mt5-news-agent.identity";
const string LEDGER_FILE   = "mt5-news-agent.ledger";

struct TradeJob
  {
   string   id;
   string   idempotency_key;
   long     account_login;
   string   account_server;
   string   account_environment;
   string   symbol;
   string   direction;
   string   execution_mode;
   string   risk_mode;
   double   fixed_lot;
   double   risk_percent;
   int      stop_loss_points;
   int      take_profit_points;
   int      deviation_points;
   int      max_spread_points;
   int      arm_seconds;
   int      max_lateness_ms;
   int      entry_distance_points;
   int      pending_expiry_seconds;
   datetime execute_at;
   datetime expires_at;
   int      version;
   int      state; // 0=SYNCED, 1=ARMED, 2=SUBMITTED, 3=FINAL
   ulong    magic;
   ulong    buy_order_ticket;
   ulong    sell_order_ticket;
   bool     has_fill;
   int      multi_trades_per_side;
   int      multi_next_step_points;
   int      multi_next_sl_points;
   int      multi_next_tp_points;
   ulong    multi_buy_tickets[5];
   ulong    multi_sell_tickets[5];
  };

TradeJob g_jobs[];
string   g_api_base_url = "";
string   g_device_id    = "";
string   g_agent_token  = "";
ulong    g_last_heartbeat_ms = 0;
ulong    g_last_poll_ms       = 0;
ulong    g_last_chart_tick_ms = 0;
ulong    g_last_calendar_sync_ms = 0;
datetime g_anchor_server_sec  = 0;
ulong    g_anchor_tick_ms     = 0;
int      g_server_utc_offset_seconds = 0;
datetime g_last_strategy_m15_bar = 0;
datetime g_last_strategy_h1_bar  = 0;

int OnInit()
  {
   g_api_base_url=InpApiBaseUrl;
   while(StringLen(g_api_base_url)>0 && StringSubstr(g_api_base_url,StringLen(g_api_base_url)-1,1)=="/")
      g_api_base_url=StringSubstr(g_api_base_url,0,StringLen(g_api_base_url)-1);

   if(!LoadIdentity())
     {
      g_device_id=CreateDeviceId();
      if(StringLen(InpPairingCode)!=8 || !ClaimPairingCode())
        {
         Print("No agent identity. Set InpPairingCode from Telegram /connect and ensure ",
               g_api_base_url," is allowed in Tools > Options > Expert Advisors.");
         return INIT_FAILED;
        }
     }

   if(!EventSetMillisecondTimer(MathMax(10,InpTimerMilliseconds)))
     {
      Print("Cannot start millisecond timer. Error: ",GetLastError());
      return INIT_FAILED;
     }

   RefreshTimeAnchor();
   SendHeartbeat();
   PollJobs();
   if(InpSyncEconomicCalendar)
      SyncEconomicCalendar();
   if(InpEnableStrategyV2)
      SyncStrategyHistory();
   Print("MT5 News Trader agent started. Device: ",g_device_id);
   return INIT_SUCCEEDED;
  }

void OnTick()
  {
   g_last_chart_tick_ms=GetTickCount64();
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   RefreshTimeAnchor();
   const ulong now_ticks=GetTickCount64();

   if(now_ticks-g_last_heartbeat_ms>=(ulong)MathMax(5,InpHeartbeatSeconds)*1000)
      SendHeartbeat();
   if(now_ticks-g_last_poll_ms>=(ulong)MathMax(1,InpPollSeconds)*1000)
      PollJobs();
   if(InpSyncEconomicCalendar &&
      now_ticks-g_last_calendar_sync_ms>=(ulong)MathMax(5,InpCalendarSyncMinutes)*60000)
      SyncEconomicCalendar();
   if(InpEnableStrategyV2 && now_ticks-g_last_poll_ms<=(ulong)MathMax(1,InpPollSeconds)*1000+100)
      SyncLatestStrategyCandles();

   ProcessJobs();
  }

void OnTradeTransaction(const MqlTradeTransaction &transaction,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
  {
   if(transaction.type!=TRADE_TRANSACTION_DEAL_ADD || transaction.deal==0)
      return;

   if(!HistoryDealSelect(transaction.deal))
      return;
   const ulong deal_magic=(ulong)HistoryDealGetInteger(transaction.deal,DEAL_MAGIC);
   const long deal_entry=HistoryDealGetInteger(transaction.deal,DEAL_ENTRY);

   for(int i=0;i<ArraySize(g_jobs);i++)
     {
      if(g_jobs[i].magic!=deal_magic)
         continue;

      if(deal_entry==DEAL_ENTRY_OUT || deal_entry==DEAL_ENTRY_OUT_BY)
        {
         const long deal_reason=HistoryDealGetInteger(transaction.deal,DEAL_REASON);
         string close_reason="Position closed";
         if(deal_reason==DEAL_REASON_SL) close_reason="Position closed by Stop Loss";
         else if(deal_reason==DEAL_REASON_TP) close_reason="Position closed by Take Profit";
         else if(deal_reason==DEAL_REASON_CLIENT || deal_reason==DEAL_REASON_MOBILE ||
                 deal_reason==DEAL_REASON_WEB) close_reason="Position closed manually";
         else if(deal_reason==DEAL_REASON_EXPERT) close_reason="Position closed by Expert Advisor";

         const string close_suffix=StringFormat(":CLOSED:%I64u",transaction.deal);
         SendReport(g_jobs[i],"CLOSED",close_suffix,(long)transaction.order,
                    (long)transaction.deal,result.retcode,transaction.price,
                    transaction.volume,close_reason);
         if(g_jobs[i].execution_mode=="MARKET")
            g_jobs[i].state=3;
         continue;
        }

      if(g_jobs[i].state!=2 || deal_entry!=DEAL_ENTRY_IN)
         continue;

      const string suffix=StringFormat(":FILLED:%I64u",transaction.deal);
      SendReport(g_jobs[i],"FILLED",suffix,(long)transaction.order,(long)transaction.deal,
                 result.retcode,transaction.price,transaction.volume,"Trade transaction filled");
      if(g_jobs[i].execution_mode=="STRADDLE")
        {
         if(g_jobs[i].has_fill)
           {
            SendReport(g_jobs[i],"ERROR",StringFormat(":DOUBLE_FILL:%I64u",transaction.deal),
                       (long)transaction.order,(long)transaction.deal,result.retcode,
                       transaction.price,transaction.volume,"OCO race: both pending orders filled");
            if(AccountInfoInteger(ACCOUNT_MARGIN_MODE)==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
               CloseDoubleFillPosition(g_jobs[i],transaction.position);
           }
         g_jobs[i].has_fill=true;
         const ulong sibling=(transaction.order==g_jobs[i].buy_order_ticket)
                             ? g_jobs[i].sell_order_ticket : g_jobs[i].buy_order_ticket;
         if(sibling>0)
            DeletePendingOrder(g_jobs[i],sibling,"OCO sibling removed after first fill");
        }
      else if(g_jobs[i].execution_mode=="MARKET")
         g_jobs[i].state=3;
     }
  }

void ProcessJobs()
  {
   const long now_ms=ServerTimeMilliseconds();
   for(int i=0;i<ArraySize(g_jobs);i++)
     {
      if(g_jobs[i].state==3)
         continue;

      if((g_jobs[i].execution_mode=="STRADDLE" || g_jobs[i].execution_mode=="MULTI") && g_jobs[i].state==2)
        {
         if(now_ms>=(long)g_jobs[i].expires_at*1000)
           {
            DeletePendingOrder(g_jobs[i],g_jobs[i].buy_order_ticket,"Pending window expired");
            DeletePendingOrder(g_jobs[i],g_jobs[i].sell_order_ticket,"Pending window expired");
            if(g_jobs[i].execution_mode=="MULTI")
              for(int level=0;level<g_jobs[i].multi_trades_per_side;level++)
                {
                 DeletePendingOrder(g_jobs[i],g_jobs[i].multi_buy_tickets[level],"MULTI pending window expired");
                 DeletePendingOrder(g_jobs[i],g_jobs[i].multi_sell_tickets[level],"MULTI pending window expired");
                }
            if(!g_jobs[i].has_fill)
               SendReport(g_jobs[i],"CANCELLED",":EXPIRED",0,0,0,0,0,
                          "No pending order filled before expiry");
            g_jobs[i].state=3;
           }
         continue;
        }

      const long execute_ms=(long)g_jobs[i].execute_at*1000;
      const long arm_ms=execute_ms-(long)g_jobs[i].arm_seconds*1000;

      if(g_jobs[i].state==0 && now_ms>=arm_ms)
        {
         if(LedgerContains(g_jobs[i].id))
           {
            if(g_jobs[i].execution_mode=="STRADDLE" && RecoverStraddleJob(i))
               continue;
            RecoverLedgerJob(g_jobs[i]);
            g_jobs[i].state=3;
            continue;
           }
         SendReport(g_jobs[i],"ARMED",":ARMED",0,0,0,0,0,"Local execution timer armed");
         g_jobs[i].state=1;
         if(g_jobs[i].execution_mode=="STRADDLE" || g_jobs[i].execution_mode=="MULTI")
            ExecuteJob(i);
        }

      if(g_jobs[i].execution_mode=="MARKET" && g_jobs[i].state==1 && now_ms>=execute_ms)
        {
         if(now_ms>execute_ms+(long)g_jobs[i].max_lateness_ms)
           {
            SendReport(g_jobs[i],"MISSED",":MISSED",0,0,0,0,0,"Execution deadline was missed");
            g_jobs[i].state=3;
            continue;
           }
         ExecuteJob(i);
        }
     }
  }

void ExecuteJob(const int index)
  {
   TradeJob job=g_jobs[index];
   string rejection="";
   MqlTick tick={};
   double volume=0;

   if(!Preflight(job,tick,volume,rejection))
     {
      SendReport(job,"PREFLIGHT_REJECTED",":PREFLIGHT",0,0,0,0,0,rejection);
      g_jobs[index].state=3;
      return;
     }

   if(job.execution_mode=="STRADDLE")
     {
      ExecuteStraddle(index,job,tick,volume);
      return;
     }
   if(job.execution_mode=="MULTI")
     {
      ExecuteMulti(index,job,tick,volume);
      return;
     }

   MqlTradeRequest request={};
   MqlTradeCheckResult check={};
   MqlTradeResult result={};
   const double point=SymbolInfoDouble(job.symbol,SYMBOL_POINT);
   const int digits=(int)SymbolInfoInteger(job.symbol,SYMBOL_DIGITS);
   const bool is_buy=(job.direction=="BUY");

   request.action=TRADE_ACTION_DEAL;
   request.magic=job.magic;
   request.symbol=job.symbol;
   request.volume=volume;
   request.type=is_buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   request.price=is_buy ? tick.ask : tick.bid;
   request.sl=NormalizeDouble(is_buy ? request.price-job.stop_loss_points*point
                                     : request.price+job.stop_loss_points*point,digits);
   request.tp=NormalizeDouble(is_buy ? request.price+job.take_profit_points*point
                                     : request.price-job.take_profit_points*point,digits);
   request.deviation=(ulong)job.deviation_points;
   request.type_time=ORDER_TIME_GTC;
   request.type_filling=ResolveFillingMode(job.symbol);
   request.comment="news:"+StringSubstr(job.id,0,12);

   ResetLastError();
   const bool check_ok=OrderCheck(request,check);
   // Some MetaTrader 5 builds (notably the macOS/Wine package) return true with
   // retcode 0 and comment "Done" for a successful local OrderCheck.
   if(!check_ok || (check.retcode!=0 && check.retcode!=TRADE_RETCODE_DONE))
     {
      rejection=StringFormat("OrderCheck rejected: %u %s",check.retcode,check.comment);
      SendReport(job,"PREFLIGHT_REJECTED",":ORDERCHECK",0,0,(int)check.retcode,
                 request.price,0,rejection);
      g_jobs[index].state=3;
      return;
     }

   // Write-ahead ledger intentionally prefers a missed trade over a duplicated trade after a crash.
   if(!AppendLedger(job.id))
     {
      SendReport(job,"PREFLIGHT_REJECTED",":LEDGER",0,0,0,request.price,0,
                 "Cannot persist idempotency ledger");
      g_jobs[index].state=3;
      return;
     }

   g_jobs[index].state=2;
   const bool sent=OrderSend(request,result);
   if(!sent || (result.retcode!=TRADE_RETCODE_DONE &&
                result.retcode!=TRADE_RETCODE_DONE_PARTIAL &&
                result.retcode!=TRADE_RETCODE_PLACED))
     {
      rejection=StringFormat("OrderSend rejected: %u %s, terminal error %d",
                             result.retcode,result.comment,GetLastError());
      SendReport(job,"REJECTED",":REJECTED",(long)result.order,(long)result.deal,
                 (int)result.retcode,result.price,result.volume,rejection);
      g_jobs[index].state=3;
      return;
     }

   SendReport(job,"SUBMITTED",":SUBMITTED",(long)result.order,(long)result.deal,
              (int)result.retcode,request.price,result.volume,result.comment);

   if(result.retcode==TRADE_RETCODE_DONE || result.retcode==TRADE_RETCODE_DONE_PARTIAL)
     {
      const string phase=(result.retcode==TRADE_RETCODE_DONE ? "FILLED" : "PARTIALLY_FILLED");
      SendReport(job,phase,":"+phase,(long)result.order,(long)result.deal,
                 (int)result.retcode,result.price,result.volume,result.comment);
      if(result.retcode==TRADE_RETCODE_DONE)
         g_jobs[index].state=3;
     }
  }

bool Preflight(const TradeJob &job,MqlTick &tick,double &volume,string &reason)
  {
   if(job.execution_mode!="MARKET" && job.execution_mode!="STRADDLE" && job.execution_mode!="MULTI")
     { reason="Unsupported execution mode"; return false; }
   if(AccountInfoInteger(ACCOUNT_LOGIN)!=job.account_login ||
      AccountInfoString(ACCOUNT_SERVER)!=job.account_server)
     { reason="Job account does not match the active MT5 account"; return false; }
   if(job.account_environment=="REAL" && !InpAllowRealTrading)
     { reason="Real trading is disabled in EA inputs"; return false; }
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))
     { reason="Terminal is disconnected"; return false; }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ||
      !MQLInfoInteger(MQL_TRADE_ALLOWED) ||
      !AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
     { reason="Automated trading is disabled"; return false; }
   if(!SymbolSelect(job.symbol,true) || !SymbolInfoTick(job.symbol,tick))
     { reason="Symbol or current tick is unavailable"; return false; }
   // FBS can expose quote timestamps in a different time base. For the chart
   // symbol, measure freshness by the actual local OnTick arrival instead.
   if(job.account_environment=="REAL")
     {
      if(job.symbol!=_Symbol)
        { reason="For REAL trading the EA must be attached to the job symbol chart"; return false; }
      if(g_last_chart_tick_ms==0)
        { reason="No local OnTick received since EA startup"; return false; }
      const ulong now_ticks=GetTickCount64();
      const ulong tick_age_ms=now_ticks-g_last_chart_tick_ms;
      if(tick_age_ms>(ulong)InpMaxTickAgeSeconds*1000)
        { reason=StringFormat("No local OnTick received within %d sec",InpMaxTickAgeSeconds); return false; }
     }

   const double point=SymbolInfoDouble(job.symbol,SYMBOL_POINT);
   if(point<=0)
     { reason="Invalid symbol point size"; return false; }
   const int spread_points=(int)MathRound((tick.ask-tick.bid)/point);
   if(job.max_spread_points>0 && spread_points>job.max_spread_points)
     { reason=StringFormat("Spread %d exceeds limit %d",spread_points,job.max_spread_points); return false; }

   if(job.execution_mode=="STRADDLE" || job.execution_mode=="MULTI")
     {
      const long order_mode=SymbolInfoInteger(job.symbol,SYMBOL_ORDER_MODE);
      if((order_mode&SYMBOL_ORDER_STOP)!=SYMBOL_ORDER_STOP)
        { reason="Broker does not allow Stop pending orders for this symbol"; return false; }
      const int minimum_distance=(int)SymbolInfoInteger(job.symbol,SYMBOL_TRADE_STOPS_LEVEL);
      if(job.entry_distance_points<minimum_distance)
        { reason=StringFormat("Entry distance %d is below broker minimum %d",
                              job.entry_distance_points,minimum_distance); return false; }
      const int expiration_mode=(int)SymbolInfoInteger(job.symbol,SYMBOL_EXPIRATION_MODE);
      if((expiration_mode&SYMBOL_EXPIRATION_GTC)!=SYMBOL_EXPIRATION_GTC)
        { reason="Broker does not support GTC pending orders for this symbol"; return false; }
     }

   if(job.risk_mode=="FIXED_LOT")
      volume=NormalizeVolume(job.symbol,job.fixed_lot);
   else if(job.risk_mode=="RISK_PERCENT")
      volume=RiskBasedVolume(job);
   else
     { reason="Unsupported risk mode"; return false; }

   if(volume<=0)
     { reason="Calculated volume is below broker minimum or invalid"; return false; }
   return true;
  }

void ExecuteMulti(const int index,const TradeJob &job,const MqlTick &tick,const double volume)
  {
   const long account_mode=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if((account_mode!=ACCOUNT_TRADE_MODE_DEMO && account_mode!=ACCOUNT_TRADE_MODE_REAL) ||
      AccountInfoInteger(ACCOUNT_MARGIN_MODE)!=ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
     { SendReport(job,"PREFLIGHT_REJECTED",":MULTI_ACCOUNT",0,0,0,0,0,"MULTI requires MT5 DEMO/REAL HEDGING account"); g_jobs[index].state=3; return; }
   if(!AppendLedger(job.id))
     { SendReport(job,"PREFLIGHT_REJECTED",":LEDGER",0,0,0,0,0,"Cannot persist idempotency ledger"); g_jobs[index].state=3; return; }
   const double point=SymbolInfoDouble(job.symbol,SYMBOL_POINT);
   g_jobs[index].state=2;
   int placed=0;
   for(int level=0;level<job.multi_trades_per_side;level++)
     {
      const int distance=job.entry_distance_points+level*job.multi_next_step_points;
      const int sl_points=(level==0 ? job.stop_loss_points : job.multi_next_sl_points);
      const int tp_points=job.take_profit_points+level*job.multi_next_tp_points;
      for(int side=0;side<2;side++)
        {
         MqlTradeRequest request={}; MqlTradeCheckResult check={}; MqlTradeResult result={};
         const bool buy=(side==0);
         request.action=TRADE_ACTION_PENDING; request.magic=job.magic; request.symbol=job.symbol;
         request.volume=volume; request.type=buy ? ORDER_TYPE_BUY_STOP : ORDER_TYPE_SELL_STOP;
         request.type_time=ORDER_TIME_GTC; request.type_filling=ORDER_FILLING_RETURN;
         request.comment=StringFormat("multi-%s-%d:%s",buy ? "b" : "s",level+1,StringSubstr(job.id,0,8));
         bool accepted=false;
         string failure="";
         // Price can move while six requests are sent. Refresh once and retry
         // one rejected leg instead of terminating the entire MULTI basket.
         for(int attempt=0;attempt<2 && !accepted;attempt++)
           {
            MqlTick current={};
            if(!SymbolInfoTick(job.symbol,current))
              { failure="Cannot refresh current tick"; continue; }
            request.price=NormalizeTradePrice(job.symbol,buy ? current.ask+distance*point : current.bid-distance*point,buy);
            request.sl=NormalizeTradePrice(job.symbol,buy ? request.price-sl_points*point : request.price+sl_points*point,!buy);
            request.tp=NormalizeTradePrice(job.symbol,buy ? request.price+tp_points*point : request.price-tp_points*point,buy);
            ZeroMemory(check); ZeroMemory(result); ResetLastError();
            const bool checked=OrderCheck(request,check);
            if(!checked || (check.retcode!=0 && check.retcode!=TRADE_RETCODE_DONE))
              { failure=StringFormat("OrderCheck %u: %s",check.retcode,check.comment); continue; }
            const bool sent=OrderSend(request,result);
            accepted=sent && (result.retcode==TRADE_RETCODE_DONE || result.retcode==TRADE_RETCODE_PLACED);
            if(!accepted) failure=StringFormat("OrderSend %u: %s",result.retcode,result.comment);
           }
         if(!accepted)
           { SendReport(job,"ERROR",StringFormat(":MULTI_LEG_ERROR_%s_%d",buy ? "BUY" : "SELL",level+1),(long)result.order,0,(int)result.retcode,request.price,0,failure); continue; }
         if(buy) g_jobs[index].multi_buy_tickets[level]=result.order;
         else g_jobs[index].multi_sell_tickets[level]=result.order;
         placed++;
         SendReport(job,"SUBMITTED",StringFormat(":MULTI_%s_%d:%I64u",buy ? "BUY" : "SELL",level+1,result.order),(long)result.order,0,(int)result.retcode,request.price,volume,request.comment);
        }
     }
   const int expected=job.multi_trades_per_side*2;
   if(placed==0)
     { SendReport(job,"REJECTED",":MULTI_ALL_REJECTED",0,0,0,0,0,"All MULTI legs were rejected"); g_jobs[index].state=3; }
   else
     SendReport(job,"SUBMITTED",":MULTI_SUMMARY",0,0,0,0,volume,
                StringFormat("MULTI basket placed: %d of %d orders",placed,expected));
  }

void ExecuteStraddle(const int index,const TradeJob &job,const MqlTick &tick,const double volume)
  {
   const double point=SymbolInfoDouble(job.symbol,SYMBOL_POINT);
   const int digits=(int)SymbolInfoInteger(job.symbol,SYMBOL_DIGITS);
   MqlTradeRequest buy={};
   MqlTradeRequest sell={};
   MqlTradeCheckResult buy_check={};
   MqlTradeCheckResult sell_check={};

   buy.action=TRADE_ACTION_PENDING;
   buy.magic=job.magic;
   buy.symbol=job.symbol;
   buy.volume=volume;
   buy.type=ORDER_TYPE_BUY_STOP;
   buy.price=NormalizeDouble(tick.ask+job.entry_distance_points*point,digits);
   buy.sl=NormalizeDouble(buy.price-job.stop_loss_points*point,digits);
   buy.tp=NormalizeDouble(buy.price+job.take_profit_points*point,digits);
   // MetaQuotes-Demo and some brokers advertise ORDER_TIME_SPECIFIED but reject
   // short expirations with TRADE_RETCODE_INVALID_EXPIRATION (10022). The EA
   // removes both GTC pending orders at job.expires_at in ProcessJobs().
   buy.type_time=ORDER_TIME_GTC;
   buy.expiration=0;
   buy.type_filling=ORDER_FILLING_RETURN;
   buy.comment="news-oco-b:"+StringSubstr(job.id,0,8);

   sell=buy;
   sell.type=ORDER_TYPE_SELL_STOP;
   sell.price=NormalizeDouble(tick.bid-job.entry_distance_points*point,digits);
   sell.sl=NormalizeDouble(sell.price+job.stop_loss_points*point,digits);
   sell.tp=NormalizeDouble(sell.price-job.take_profit_points*point,digits);
   sell.comment="news-oco-s:"+StringSubstr(job.id,0,8);

   ResetLastError();
   const bool buy_ok=OrderCheck(buy,buy_check);
   const bool sell_ok=OrderCheck(sell,sell_check);
   if(!buy_ok || (buy_check.retcode!=0 && buy_check.retcode!=TRADE_RETCODE_DONE) ||
      !sell_ok || (sell_check.retcode!=0 && sell_check.retcode!=TRADE_RETCODE_DONE))
     {
      const string reason=StringFormat("OCO OrderCheck rejected: buy=%u %s; sell=%u %s",
                                       buy_check.retcode,buy_check.comment,
                                       sell_check.retcode,sell_check.comment);
      SendReport(job,"PREFLIGHT_REJECTED",":OCO_CHECK",0,0,0,0,0,reason);
      g_jobs[index].state=3;
      return;
     }

   if(!AppendLedger(job.id))
     {
      SendReport(job,"PREFLIGHT_REJECTED",":LEDGER",0,0,0,0,0,
                 "Cannot persist idempotency ledger");
      g_jobs[index].state=3;
      return;
     }

   MqlTradeResult buy_result={};
   MqlTradeResult sell_result={};
   g_jobs[index].state=2;
   const bool buy_sent=OrderSend(buy,buy_result);
   if(!buy_sent || (buy_result.retcode!=TRADE_RETCODE_DONE &&
                    buy_result.retcode!=TRADE_RETCODE_PLACED))
     {
      SendReport(job,"REJECTED",":OCO_BUY_REJECTED",(long)buy_result.order,0,
                 (int)buy_result.retcode,buy.price,0,buy_result.comment);
      g_jobs[index].state=3;
      return;
     }
   g_jobs[index].buy_order_ticket=buy_result.order;

   const bool sell_sent=OrderSend(sell,sell_result);
   if(!sell_sent || (sell_result.retcode!=TRADE_RETCODE_DONE &&
                     sell_result.retcode!=TRADE_RETCODE_PLACED))
     {
      DeletePendingOrder(g_jobs[index],g_jobs[index].buy_order_ticket,
                         "Buy Stop rolled back because Sell Stop was rejected");
      SendReport(job,"REJECTED",":OCO_SELL_REJECTED",(long)sell_result.order,0,
                 (int)sell_result.retcode,sell.price,0,sell_result.comment);
      g_jobs[index].state=3;
      return;
     }
   g_jobs[index].sell_order_ticket=sell_result.order;
   if(g_jobs[index].has_fill)
      DeletePendingOrder(g_jobs[index],g_jobs[index].sell_order_ticket,
                         "Sell Stop removed because Buy Stop filled during placement");
   SendReport(job,"SUBMITTED",":OCO_SUBMITTED",(long)buy_result.order,0,
              (int)sell_result.retcode,0,volume,
              StringFormat("OCO placed (local T+%d expiry): Buy Stop %I64u at %s; Sell Stop %I64u at %s",
                           job.pending_expiry_seconds,
                           buy_result.order,DoubleToString(buy.price,digits),
                           sell_result.order,DoubleToString(sell.price,digits)));
  }

bool DeletePendingOrder(const TradeJob &job,const ulong ticket,const string message)
  {
   if(ticket==0 || !OrderSelect(ticket))
      return true;
   MqlTradeRequest request={};
   MqlTradeResult result={};
   request.action=TRADE_ACTION_REMOVE;
   request.order=ticket;
   const bool sent=OrderSend(request,result);
   if(!sent || result.retcode!=TRADE_RETCODE_DONE)
     {
      SendReport(job,"ERROR",StringFormat(":REMOVE_FAILED:%I64u",ticket),(long)ticket,0,
                 (int)result.retcode,0,0,"Could not remove pending order: "+result.comment);
      return false;
     }
   Print("Job ",job.id,": ",message,". Ticket ",ticket);
   return true;
  }

bool CloseDoubleFillPosition(const TradeJob &job,const ulong position_ticket)
  {
   if(position_ticket==0 || !PositionSelectByTicket(position_ticket))
      return false;
   const string symbol=PositionGetString(POSITION_SYMBOL);
   const double volume=PositionGetDouble(POSITION_VOLUME);
   const ENUM_POSITION_TYPE position_type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   MqlTick tick={};
   if(volume<=0 || !SymbolInfoTick(symbol,tick))
      return false;

   MqlTradeRequest request={};
   MqlTradeResult result={};
   request.action=TRADE_ACTION_DEAL;
   request.position=position_ticket;
   request.magic=job.magic;
   request.symbol=symbol;
   request.volume=volume;
   request.type=(position_type==POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price=(request.type==ORDER_TYPE_BUY) ? tick.ask : tick.bid;
   request.deviation=(ulong)job.deviation_points;
   request.type_filling=ResolveFillingMode(symbol);
   request.comment="oco-double-fill-close";
   const bool sent=OrderSend(request,result);
   if(!sent || (result.retcode!=TRADE_RETCODE_DONE &&
                result.retcode!=TRADE_RETCODE_DONE_PARTIAL))
     {
      SendReport(job,"ERROR",StringFormat(":DOUBLE_CLOSE_FAILED:%I64u",position_ticket),
                 (long)result.order,(long)result.deal,(int)result.retcode,
                 result.price,result.volume,"Could not close second OCO position: "+result.comment);
      return false;
     }
   SendReport(job,"ERROR",StringFormat(":DOUBLE_CLOSE:%I64u",position_ticket),
              (long)result.order,(long)result.deal,(int)result.retcode,
              result.price,result.volume,"Second OCO position closed by emergency policy");
   return true;
  }

bool RecoverStraddleJob(const int index)
  {
   int pending_count=0;
   for(int i=OrdersTotal()-1;i>=0;i--)
     {
      const ulong ticket=OrderGetTicket(i);
      if(ticket==0 || (ulong)OrderGetInteger(ORDER_MAGIC)!=g_jobs[index].magic)
         continue;
      const ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type==ORDER_TYPE_BUY_STOP)
        { g_jobs[index].buy_order_ticket=ticket; pending_count++; }
      else if(type==ORDER_TYPE_SELL_STOP)
        { g_jobs[index].sell_order_ticket=ticket; pending_count++; }
     }

   bool has_position=false;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket!=0 && (ulong)PositionGetInteger(POSITION_MAGIC)==g_jobs[index].magic)
        { has_position=true; break; }
     }

   if(has_position)
     {
      g_jobs[index].has_fill=true;
      DeletePendingOrder(g_jobs[index],g_jobs[index].buy_order_ticket,
                         "Recovered OCO sibling removed after restart");
      DeletePendingOrder(g_jobs[index],g_jobs[index].sell_order_ticket,
                         "Recovered OCO sibling removed after restart");
      g_jobs[index].state=2;
      SendReport(g_jobs[index],"FILLED",":RECOVERED_OCO_FILLED",0,0,0,0,0,
                 "Recovered an open OCO position after restart");
      return true;
     }

   if(pending_count==2)
     {
      g_jobs[index].state=2;
      SendReport(g_jobs[index],"SUBMITTED",":RECOVERED_OCO",(long)g_jobs[index].buy_order_ticket,
                 0,0,0,0,"Recovered both OCO pending orders after restart");
      return true;
     }

   if(pending_count==1)
     {
      DeletePendingOrder(g_jobs[index],g_jobs[index].buy_order_ticket,
                         "Incomplete recovered OCO pair removed");
      DeletePendingOrder(g_jobs[index],g_jobs[index].sell_order_ticket,
                         "Incomplete recovered OCO pair removed");
      SendReport(g_jobs[index],"CANCELLED",":RECOVERED_INCOMPLETE_OCO",0,0,0,0,0,
                 "Incomplete OCO pair was removed after restart");
      g_jobs[index].state=3;
      return true;
     }
   long close_order=0;
   long close_deal=0;
   double close_price=0;
   double close_volume=0;
   if(FindClosedExecution(g_jobs[index],close_order,close_deal,close_price,close_volume))
     {
      SendReport(g_jobs[index],"CLOSED",StringFormat(":RECOVERED_CLOSED:%I64d",close_deal),
                 close_order,close_deal,0,close_price,close_volume,
                 "Recovered closed MT5 position from deal history");
      g_jobs[index].state=3;
      return true;
     }
   return false;
  }

double RiskBasedVolume(const TradeJob &job)
  {
   const double equity=AccountInfoDouble(ACCOUNT_EQUITY);
   const double point=SymbolInfoDouble(job.symbol,SYMBOL_POINT);
   const double tick_size=SymbolInfoDouble(job.symbol,SYMBOL_TRADE_TICK_SIZE);
   const double tick_value=SymbolInfoDouble(job.symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(equity<=0 || point<=0 || tick_size<=0 || tick_value<=0 || job.stop_loss_points<=0)
      return 0;

   const double risk_money=equity*job.risk_percent/100.0;
   const double price_distance=job.stop_loss_points*point;
   const double loss_per_lot=(price_distance/tick_size)*tick_value;
   if(loss_per_lot<=0)
      return 0;
   return NormalizeVolume(job.symbol,risk_money/loss_per_lot);
  }

double NormalizeTradePrice(const string symbol,const double requested,const bool round_up)
  {
   const double tick_size=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE);
   const int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   if(tick_size<=0) return NormalizeDouble(requested,digits);
   const double steps=requested/tick_size;
   const double aligned=(round_up ? MathCeil(steps-1e-9) : MathFloor(steps+1e-9))*tick_size;
   return NormalizeDouble(aligned,digits);
  }

double NormalizeVolume(const string symbol,const double requested)
  {
   const double minimum=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   const double maximum=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
   const double step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   if(requested<minimum || minimum<=0 || maximum<=0 || step<=0)
      return 0;
   const double bounded=MathMin(requested,maximum);
   const double steps=MathFloor((bounded-minimum+1e-12)/step);
   return NormalizeDouble(minimum+steps*step,8);
  }

ENUM_ORDER_TYPE_FILLING ResolveFillingMode(const string symbol)
  {
   const int modes=(int)SymbolInfoInteger(symbol,SYMBOL_FILLING_MODE);
   if((modes&SYMBOL_FILLING_FOK)==SYMBOL_FILLING_FOK)
      return ORDER_FILLING_FOK;
   if((modes&SYMBOL_FILLING_IOC)==SYMBOL_FILLING_IOC)
      return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

void SendHeartbeat()
  {
   g_last_heartbeat_ms=GetTickCount64();
   const int raw_utc_offset=(int)(TimeTradeServer()-TimeGMT());
   g_server_utc_offset_seconds=(int)MathRound(raw_utc_offset/900.0)*900;
   string environment="REAL";
   const long trade_mode=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(trade_mode==ACCOUNT_TRADE_MODE_DEMO) environment="DEMO";
   else if(trade_mode==ACCOUNT_TRADE_MODE_CONTEST) environment="CONTEST";

   string margin_mode="UNKNOWN";
   const long margin=AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   if(margin==ACCOUNT_MARGIN_MODE_RETAIL_NETTING) margin_mode="NETTING";
   else if(margin==ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) margin_mode="HEDGING";
   else if(margin==ACCOUNT_MARGIN_MODE_EXCHANGE) margin_mode="EXCHANGE";

   const bool terminal_trade=(bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
   const bool expert_trade=(bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT) &&
                           (bool)MQLInfoInteger(MQL_TRADE_ALLOWED);
   const string body=StringFormat(
      "{\"login\":\"%I64d\",\"broker\":\"%s\",\"server\":\"%s\","
      "\"currency\":\"%s\",\"environment\":\"%s\",\"marginMode\":\"%s\","
      "\"terminalBuild\":%d,\"agentVersion\":\"%s\",\"leverage\":%d,"
      "\"serverUtcOffsetSeconds\":%d,"
      "\"balance\":%s,\"equity\":%s,\"tradeAllowed\":%s,\"expertTradeAllowed\":%s}",
      AccountInfoInteger(ACCOUNT_LOGIN),JsonEscape(AccountInfoString(ACCOUNT_COMPANY)),
      JsonEscape(AccountInfoString(ACCOUNT_SERVER)),JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)),
      environment,margin_mode,(int)TerminalInfoInteger(TERMINAL_BUILD),AGENT_VERSION,
      (int)AccountInfoInteger(ACCOUNT_LEVERAGE),g_server_utc_offset_seconds,
      DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2),
      DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2),BoolJson(terminal_trade),BoolJson(expert_trade));

   int status=0;
   string response="";
   if(!HttpRequest("POST","/v1/agent/heartbeat",body,true,status,response) || status<200 || status>=300)
      Print("Heartbeat failed. HTTP ",status," response: ",response);
  }

void PollJobs()
  {
   g_last_poll_ms=GetTickCount64();
   int status=0;
   string response="";
   if(!HttpRequest("GET","/v1/agent/jobs.mt5?horizonMinutes=1440","",true,status,response) ||
      status<200 || status>=300)
     {
      Print("Job polling failed. HTTP ",status," response: ",response);
      return;
     }

   string lines[];
   const ushort newline=(ushort)StringGetCharacter("\n",0);
   const int line_count=StringSplit(response,newline,lines);
   for(int i=0;i<line_count;i++)
     {
      if(StringFind(lines[i],"JOB2|")==0)
         ParseJobLine(lines[i]);
      else if(StringFind(lines[i],"JOB3|")==0)
         ParseMultiJobLine(lines[i]);
      else if(StringFind(lines[i],"CANCEL|")==0)
         ParseCancellationLine(lines[i]);
     }
  }

void SyncEconomicCalendar()
  {
   g_last_calendar_sync_ms=GetTickCount64();
   MqlCalendarValue values[];
   const datetime from=TimeTradeServer();
   const datetime to=from+(datetime)MathMax(1,InpCalendarDaysAhead)*86400;
   ResetLastError();
   const int total=CalendarValueHistory(values,from,to);
   if(total<0)
     {
      Print("Economic calendar read failed: ",GetLastError());
      return;
     }

   string body="{\"events\":[";
   int batch_count=0;
   int sent_total=0;
   for(int i=0;i<total;i++)
     {
      MqlCalendarEvent event={};
      MqlCalendarCountry country={};
      if(!CalendarEventById(values[i].event_id,event))
         continue;
      if(event.importance!=CALENDAR_IMPORTANCE_HIGH ||
         event.time_mode!=CALENDAR_TIMEMODE_DATETIME)
         continue;
      if(!CalendarCountryById(event.country_id,country) || StringLen(country.currency)<3)
         continue;

      if(batch_count>0) body+=",";
      body+=StringFormat(
         "{\"externalId\":\"%I64u\",\"title\":\"%s\",\"currency\":\"%s\","
         "\"countryCode\":\"%s\",\"importance\":\"HIGH\","
         "\"scheduledAtServerUnix\":%I64d,\"forecast\":%s,\"previous\":%s,\"actual\":%s}",
         values[i].id,JsonEscape(event.name),JsonEscape(country.currency),JsonEscape(country.code),
         (long)values[i].time,CalendarNumber(values[i].HasForecastValue(),values[i].GetForecastValue()),
         CalendarNumber(values[i].HasPreviousValue(),values[i].GetPreviousValue()),
         CalendarNumber(values[i].HasActualValue(),values[i].GetActualValue()));
      batch_count++;

      if(batch_count>=100)
        {
         body+="]}";
         if(SendCalendarBatch(body)) sent_total+=batch_count;
         body="{\"events\":[";
         batch_count=0;
        }
     }

   if(batch_count>0)
     {
      body+="]}";
      if(SendCalendarBatch(body)) sent_total+=batch_count;
     }
   Print("Economic calendar sync completed. Events sent: ",sent_total);
  }

void SyncStrategyHistory()
  {
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_DEMO)
     {
      Print("Strategy V2 is demo-only; candle sync disabled on this account");
      return;
     }
   if(!SymbolSelect(InpStrategySymbol,true))
     {
      Print("Strategy V2 symbol is unavailable: ",InpStrategySymbol);
      return;
     }
   string body="{\"candles\":[";
   int count=0;
   MqlRates h1[];
   MqlRates m15[];
   ArraySetAsSeries(h1,true);
   ArraySetAsSeries(m15,true);
   const int h1_count=CopyRates(InpStrategySymbol,PERIOD_H1,1,220,h1);
   const int m15_count=CopyRates(InpStrategySymbol,PERIOD_M15,1,40,m15);
   for(int i=h1_count-1;i>=0;i--)
     {
      if(count>0) body+=",";
      body+=StrategyCandleJson(h1[i],"H1");
      count++;
     }
   for(int i=m15_count-1;i>=0;i--)
     {
      if(count>0) body+=",";
      body+=StrategyCandleJson(m15[i],"M15");
      count++;
     }
   body+="]}";
   if(count==0) return;
   int status=0;
   string response="";
   if(HttpRequest("POST","/v1/agent/strategy-v2/candles/batch",body,true,status,response) && status>=200 && status<300)
     {
      if(m15_count>0) g_last_strategy_m15_bar=m15[0].time;
      if(h1_count>0) g_last_strategy_h1_bar=h1[0].time;
      Print("Strategy V2 history synced: ",count," candles");
     }
   else Print("Strategy V2 history sync failed. HTTP ",status," response: ",response);
  }

void SyncLatestStrategyCandles()
  {
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_DEMO) return;
   if(!SymbolSelect(InpStrategySymbol,true)) return;
   MqlRates m15[];
   MqlRates h1[];
   ArraySetAsSeries(m15,true);
   ArraySetAsSeries(h1,true);
   const int m15_count=CopyRates(InpStrategySymbol,PERIOD_M15,1,1,m15);
   const int h1_count=CopyRates(InpStrategySymbol,PERIOD_H1,1,1,h1);
   string body="{\"candles\":[";
   int count=0;
   datetime next_h1_bar=g_last_strategy_h1_bar;
   datetime next_m15_bar=g_last_strategy_m15_bar;
   if(h1_count>0 && h1[0].time>g_last_strategy_h1_bar)
     {
      body+=StrategyCandleJson(h1[0],"H1");
      next_h1_bar=h1[0].time;
      count++;
     }
   if(m15_count>0 && m15[0].time>g_last_strategy_m15_bar)
     {
      if(count>0) body+=",";
      body+=StrategyCandleJson(m15[0],"M15");
      next_m15_bar=m15[0].time;
      count++;
     }
   body+="]}";
   if(count==0) return;
   int status=0;
   string response="";
   if(!HttpRequest("POST","/v1/agent/strategy-v2/candles/batch",body,true,status,response) || status<200 || status>=300)
      Print("Strategy V2 candle sync failed. HTTP ",status," response: ",response);
   else
     {
      g_last_strategy_h1_bar=next_h1_bar;
      g_last_strategy_m15_bar=next_m15_bar;
     }
  }

string StrategyCandleJson(const MqlRates &rate,const string timeframe)
  {
   MqlTick tick={};
   int spread=0;
   if(SymbolInfoTick(InpStrategySymbol,tick))
     {
      const double point=SymbolInfoDouble(InpStrategySymbol,SYMBOL_POINT);
      if(point>0) spread=(int)MathRound((tick.ask-tick.bid)/point);
     }
   return StringFormat(
      "{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"openTime\":\"%s\","
      "\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s,\"spreadPoints\":%d,\"point\":%s}",
      JsonEscape(InpStrategySymbol),timeframe,IsoTime(rate.time-g_server_utc_offset_seconds),
      DoubleToString(rate.open,10),DoubleToString(rate.high,10),DoubleToString(rate.low,10),
      DoubleToString(rate.close,10),spread,DoubleToString(SymbolInfoDouble(InpStrategySymbol,SYMBOL_POINT),10));
  }

bool SendCalendarBatch(const string body)
  {
   int status=0;
   string response="";
   const bool ok=HttpRequest("POST","/v1/agent/economic-events/sync",body,true,status,response);
   if(!ok || status<200 || status>=300)
      Print("Calendar sync failed. HTTP ",status," response: ",response);
   return ok && status>=200 && status<300;
  }

string CalendarNumber(const bool present,const double value)
  {
   if(!present || !MathIsValidNumber(value)) return "null";
   return DoubleToString(value,10);
  }

void ParseCancellationLine(const string line)
  {
   string fields[];
   const ushort pipe=(ushort)StringGetCharacter("|",0);
   if(StringSplit(line,pipe,fields)<3) return;
   const int index=FindJob(fields[1]);
   if(index<0 || g_jobs[index].state>=2) return;

   const int version=(int)StringToInteger(fields[2]);
   if(version<g_jobs[index].version) return;
   SendReport(g_jobs[index],"CANCELLED",":CANCELLED:"+fields[2],0,0,0,0,0,
              "Cancellation received before the armed window");
   g_jobs[index].state=3;
   g_jobs[index].version=version;
  }

void ParseJobLine(const string line)
  {
   string fields[];
   const ushort pipe=(ushort)StringGetCharacter("|",0);
   if(StringSplit(line,pipe,fields)<23)
     {
      Print("Invalid job wire record: ",line);
      return;
     }

   TradeJob incoming;
   incoming.id=fields[1];
   incoming.idempotency_key=fields[2];
   incoming.account_login=(long)StringToInteger(fields[3]);
   incoming.account_server=fields[4];
   incoming.account_environment=fields[5];
   incoming.symbol=fields[6];
   incoming.direction=fields[7];
   incoming.execution_mode=fields[8];
   incoming.risk_mode=fields[9];
   incoming.fixed_lot=StringToDouble(fields[10]);
   incoming.risk_percent=StringToDouble(fields[11]);
   incoming.stop_loss_points=(int)StringToInteger(fields[12]);
   incoming.take_profit_points=(int)StringToInteger(fields[13]);
   incoming.deviation_points=(int)StringToInteger(fields[14]);
   incoming.max_spread_points=(int)StringToInteger(fields[15]);
   incoming.arm_seconds=(int)StringToInteger(fields[16]);
   incoming.max_lateness_ms=(int)StringToInteger(fields[17]);
   incoming.entry_distance_points=(int)StringToInteger(fields[18]);
   incoming.pending_expiry_seconds=(int)StringToInteger(fields[19]);
   incoming.execute_at=(datetime)StringToInteger(fields[20]);
   incoming.expires_at=(datetime)StringToInteger(fields[21]);
   incoming.version=(int)StringToInteger(fields[22]);
   incoming.state=0;
   incoming.magic=JobMagic(incoming.id);
   incoming.buy_order_ticket=0;
   incoming.sell_order_ticket=0;
   incoming.has_fill=false;

   const int existing=FindJob(incoming.id);
   if(existing>=0)
     {
      const int old_state=g_jobs[existing].state;
      if(incoming.version>=g_jobs[existing].version)
        {
         const ulong old_buy_ticket=g_jobs[existing].buy_order_ticket;
         const ulong old_sell_ticket=g_jobs[existing].sell_order_ticket;
         const bool old_has_fill=g_jobs[existing].has_fill;
         g_jobs[existing]=incoming;
         g_jobs[existing].state=old_state;
         g_jobs[existing].buy_order_ticket=old_buy_ticket;
         g_jobs[existing].sell_order_ticket=old_sell_ticket;
         g_jobs[existing].has_fill=old_has_fill;
        }
      return;
     }

   const int size=ArraySize(g_jobs);
   ArrayResize(g_jobs,size+1);
   g_jobs[size]=incoming;
   Print("Job received: ",incoming.id," ",incoming.symbol," ",incoming.direction,
         " execute at server time ",TimeToString(incoming.execute_at,TIME_DATE|TIME_SECONDS));
  }

void ParseMultiJobLine(const string line)
  {
   string f[]; const ushort pipe=(ushort)StringGetCharacter("|",0);
   if(StringSplit(line,pipe,f)<24) { Print("Invalid JOB3 record: ",line); return; }
   TradeJob incoming;
   incoming.id=f[1]; incoming.idempotency_key=f[2]; incoming.account_login=(long)StringToInteger(f[3]);
   incoming.account_server=f[4]; incoming.account_environment=f[5]; incoming.symbol=f[6];
   incoming.direction="BUY"; incoming.execution_mode="MULTI"; incoming.risk_mode=f[7];
   incoming.fixed_lot=StringToDouble(f[8]); incoming.risk_percent=StringToDouble(f[9]);
   incoming.stop_loss_points=(int)StringToInteger(f[10]); incoming.take_profit_points=(int)StringToInteger(f[11]);
   incoming.deviation_points=(int)StringToInteger(f[12]); incoming.max_spread_points=(int)StringToInteger(f[13]);
   incoming.arm_seconds=(int)StringToInteger(f[14]); incoming.max_lateness_ms=1000;
   incoming.entry_distance_points=(int)StringToInteger(f[15]); incoming.pending_expiry_seconds=(int)StringToInteger(f[16]);
   incoming.multi_trades_per_side=(int)StringToInteger(f[17]); incoming.multi_next_step_points=(int)StringToInteger(f[18]);
   incoming.multi_next_sl_points=(int)StringToInteger(f[19]); incoming.multi_next_tp_points=(int)StringToInteger(f[20]);
   incoming.execute_at=(datetime)StringToInteger(f[21]); incoming.expires_at=(datetime)StringToInteger(f[22]); incoming.version=(int)StringToInteger(f[23]);
   incoming.state=0; incoming.magic=JobMagic(incoming.id); incoming.buy_order_ticket=0; incoming.sell_order_ticket=0; incoming.has_fill=false;
   const int existing=FindJob(incoming.id); if(existing>=0) return;
   const int size=ArraySize(g_jobs); ArrayResize(g_jobs,size+1); g_jobs[size]=incoming;
   Print("MULTI job received: ",incoming.id," levels per side: ",incoming.multi_trades_per_side);
  }

bool ClaimPairingCode()
  {
   const string body=StringFormat(
      "{\"code\":\"%s\",\"deviceId\":\"%s\",\"name\":\"%s\","
      "\"version\":\"%s\",\"terminalBuild\":%d}",
      JsonEscape(InpPairingCode),JsonEscape(g_device_id),JsonEscape(InpAgentName),
      AGENT_VERSION,(int)TerminalInfoInteger(TERMINAL_BUILD));
   int status=0;
   string response="";
   if(!HttpRequest("POST","/v1/pairing/claim",body,false,status,response) || status<200 || status>=300)
     {
      Print("Pairing failed. HTTP ",status," response: ",response);
      return false;
     }

   g_agent_token=ExtractJsonString(response,"token");
   if(StringLen(g_agent_token)<20)
     {
      Print("Pairing response did not contain a valid token");
      return false;
     }
   return SaveIdentity();
  }

bool SendReport(const TradeJob &job,const string phase,const string report_suffix,
                const long order_ticket,const long deal_ticket,const int retcode,
                const double price,const double volume,const string message)
  {
   const string report_key=job.id+report_suffix;
   const string body=StringFormat(
      "{\"reportKey\":\"%s\",\"phase\":\"%s\",\"occurredAt\":\"%s\","
      "\"orderTicket\":\"%I64d\",\"dealTicket\":\"%I64d\",\"retcode\":%d,"
      "\"filledPrice\":%s,\"filledVolume\":%s,\"message\":\"%s\"}",
      JsonEscape(report_key),phase,IsoTime(TimeTradeServer()-g_server_utc_offset_seconds),
      order_ticket,deal_ticket,retcode,
      DoubleToString(MathMax(0,price),10),DoubleToString(MathMax(0,volume),4),JsonEscape(message));
   int status=0;
   string response="";
   const bool ok=HttpRequest("POST","/v1/agent/jobs/"+job.id+"/reports",body,true,status,response);
   if(!ok || status<200 || status>=300)
      Print("Report ",phase," failed. HTTP ",status," response: ",response);
   else
      Print("Job ",job.id," status ",phase,": ",message);
   return ok && status>=200 && status<300;
  }

void RecoverLedgerJob(const TradeJob &job)
  {
   long order_ticket=0;
   long deal_ticket=0;
   double price=0;
   double volume=0;
   if(FindClosedExecution(job,order_ticket,deal_ticket,price,volume))
     {
      SendReport(job,"CLOSED",StringFormat(":RECOVERED_CLOSED:%I64d",deal_ticket),
                 order_ticket,deal_ticket,0,price,volume,
                 "Recovered closed MT5 position from deal history");
      return;
     }
   if(FindExistingExecution(job,order_ticket,deal_ticket,price,volume))
     {
      SendReport(job,"SUBMITTED",":RECOVERED_SUBMITTED",order_ticket,deal_ticket,0,price,volume,
                 "Recovered from local idempotency ledger");
      SendReport(job,"FILLED",":RECOVERED_FILLED",order_ticket,deal_ticket,0,price,volume,
                 "Existing MT5 execution recovered after restart");
     }
   else
     {
      SendReport(job,"MISSED",":LEDGER_MISSED",0,0,0,0,0,
                 "Duplicate prevented by local write-ahead ledger; no execution found");
     }
  }

bool FindClosedExecution(const TradeJob &job,long &order_ticket,long &deal_ticket,
                         double &price,double &volume)
  {
   if(!HistorySelect(job.execute_at-86400,TimeTradeServer()+60))
      return false;
   for(int i=HistoryDealsTotal()-1;i>=0;i--)
     {
      const ulong ticket=HistoryDealGetTicket(i);
      if(ticket==0 || (ulong)HistoryDealGetInteger(ticket,DEAL_MAGIC)!=job.magic)
         continue;
      const long entry=HistoryDealGetInteger(ticket,DEAL_ENTRY);
      if(entry!=DEAL_ENTRY_OUT && entry!=DEAL_ENTRY_OUT_BY)
         continue;
      deal_ticket=(long)ticket;
      order_ticket=(long)HistoryDealGetInteger(ticket,DEAL_ORDER);
      price=HistoryDealGetDouble(ticket,DEAL_PRICE);
      volume=HistoryDealGetDouble(ticket,DEAL_VOLUME);
      return true;
     }
   return false;
  }

bool FindExistingExecution(const TradeJob &job,long &order_ticket,long &deal_ticket,
                           double &price,double &volume)
  {
   if(HistorySelect(job.execute_at-86400,TimeTradeServer()+60))
     {
      for(int i=HistoryDealsTotal()-1;i>=0;i--)
        {
         const ulong ticket=HistoryDealGetTicket(i);
         if(ticket==0 || (ulong)HistoryDealGetInteger(ticket,DEAL_MAGIC)!=job.magic)
            continue;
         deal_ticket=(long)ticket;
         order_ticket=(long)HistoryDealGetInteger(ticket,DEAL_ORDER);
         price=HistoryDealGetDouble(ticket,DEAL_PRICE);
         volume=HistoryDealGetDouble(ticket,DEAL_VOLUME);
         return true;
        }
     }

   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      const ulong ticket=PositionGetTicket(i);
      if(ticket!=0 && (ulong)PositionGetInteger(POSITION_MAGIC)==job.magic)
        {
         order_ticket=(long)ticket;
         price=PositionGetDouble(POSITION_PRICE_OPEN);
         volume=PositionGetDouble(POSITION_VOLUME);
         return true;
        }
     }
   return false;
  }

bool HttpRequest(const string method,const string path,const string body,const bool authorized,
                 int &status,string &response)
  {
   char payload[];
   char result[];
   string response_headers="";
   string headers="Accept: application/json\r\nContent-Type: application/json\r\n";
   if(authorized)
      headers+="Authorization: Bearer "+g_agent_token+"\r\n";

   if(StringLen(body)>0)
     {
      StringToCharArray(body,payload,0,StringLen(body),CP_UTF8);
     }
   else
      ArrayResize(payload,0);

   ResetLastError();
   status=WebRequest(method,g_api_base_url+path,headers,5000,payload,result,response_headers);
   response=CharArrayToString(result,0,-1,CP_UTF8);
   if(status==-1)
     {
      Print("WebRequest failed: ",GetLastError()," URL: ",g_api_base_url+path);
      return false;
     }
   return true;
  }

void RefreshTimeAnchor()
  {
   const datetime server_now=TimeTradeServer();
   if(server_now!=g_anchor_server_sec)
     {
      g_anchor_server_sec=server_now;
      g_anchor_tick_ms=GetTickCount64();
     }
  }

long ServerTimeMilliseconds()
  {
   ulong elapsed=GetTickCount64()-g_anchor_tick_ms;
   if(elapsed>999) elapsed=999;
   return (long)g_anchor_server_sec*1000+(long)elapsed;
  }

int FindJob(const string id)
  {
   for(int i=0;i<ArraySize(g_jobs);i++)
      if(g_jobs[i].id==id) return i;
   return -1;
  }

ulong JobMagic(const string id)
  {
   uint hash=2166136261;
   for(int i=0;i<StringLen(id);i++)
     {
      hash^=(uint)StringGetCharacter(id,i);
      hash*=16777619;
     }
   return InpMagicBase+(ulong)(hash%4000000000);
  }

string CreateDeviceId()
  {
   MathSrand((int)(GetTickCount()+(uint)TimeLocal()));
   return StringFormat("mt5-%I64d-%08X%08X",AccountInfoInteger(ACCOUNT_LOGIN),
                       (uint)MathRand(),(uint)GetTickCount());
  }

bool LoadIdentity()
  {
   const int handle=FileOpen(IDENTITY_FILE,FILE_READ|FILE_TXT|FILE_ANSI);
   if(handle==INVALID_HANDLE) return false;
   g_device_id=FileReadString(handle);
   g_agent_token=FileReadString(handle);
   FileClose(handle);
   return StringLen(g_device_id)>0 && StringLen(g_agent_token)>20;
  }

bool SaveIdentity()
  {
   const int handle=FileOpen(IDENTITY_FILE,FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(handle==INVALID_HANDLE) return false;
   FileWrite(handle,g_device_id);
   FileWrite(handle,g_agent_token);
   FileFlush(handle);
   FileClose(handle);
   return true;
  }

bool LedgerContains(const string job_id)
  {
   const int handle=FileOpen(LEDGER_FILE,FILE_READ|FILE_TXT|FILE_ANSI);
   if(handle==INVALID_HANDLE) return false;
   while(!FileIsEnding(handle))
     {
      if(FileReadString(handle)==job_id)
        { FileClose(handle); return true; }
     }
   FileClose(handle);
   return false;
  }

bool AppendLedger(const string job_id)
  {
   const int handle=FileOpen(LEDGER_FILE,FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(handle==INVALID_HANDLE) return false;
   FileSeek(handle,0,SEEK_END);
   FileWrite(handle,job_id);
   FileFlush(handle);
   FileClose(handle);
   return true;
  }

string ExtractJsonString(const string json,const string key)
  {
   const string marker="\""+key+"\"";
   int start=StringFind(json,marker);
   if(start<0) return "";
   start=StringFind(json,":",start+StringLen(marker));
   start=StringFind(json,"\"",start+1);
   if(start<0) return "";
   const int finish=StringFind(json,"\"",start+1);
   if(finish<0) return "";
   return StringSubstr(json,start+1,finish-start-1);
  }

string JsonEscape(string value)
  {
   StringReplace(value,"\\","\\\\");
   StringReplace(value,"\"","\\\"");
   StringReplace(value,"\r","\\r");
   StringReplace(value,"\n","\\n");
   return value;
  }

string BoolJson(const bool value)
  {
   return value ? "true" : "false";
  }

string IsoTime(const datetime value)
  {
   MqlDateTime parts={};
   TimeToStruct(value,parts);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",parts.year,parts.mon,parts.day,
                       parts.hour,parts.min,parts.sec);
  }
