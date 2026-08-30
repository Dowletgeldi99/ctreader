import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Bot, Context, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import { PairingService } from "../pairing/pairing.service";
import { UsersService } from "../users/users.service";
import { EconomicEventsService } from "../economic-events/economic-events.service";
import { TradeJobsService } from "../trade-jobs/trade-jobs.service";
import {
  ExecutionModeDto,
  RiskModeDto,
  TradeDirectionDto,
  VolumeAllocationModeDto,
} from "../trade-jobs/dto/create-trade-job.dto";
import { TelegramSessionsService } from "./telegram-sessions.service";
import { CTraderService } from "../ctrader/ctrader.service";
import { CTraderMockExecutionService } from "../ctrader/ctrader-mock-execution.service";
import { ExecutionVenueDto } from "../trade-jobs/dto/create-trade-job.dto";
import { ProbeStrategyService } from "../strategy-v2/probe-strategy.service";
import { SafetyService } from "../safety/safety.service";

interface TradeDraft {
  eventId?: string;
  eventTitle?: string;
  executeAt?: string;
  accountId?: string;
  symbol?: string;
  executionMode?: ExecutionModeDto;
  direction?: TradeDirectionDto;
  entryDistancePoints?: number;
  pendingExpirySeconds?: number;
  stopLossPoints?: number;
  takeProfitPoints?: number;
  riskMode?: RiskModeDto;
  fixedLot?: number;
  riskPercent?: number;
  executionVenue?: ExecutionVenueDto;
  multiTradesPerSide?: number;
  multiNextStepPoints?: number;
  multiNextSlPoints?: number;
  multiNextTpPoints?: number;
  volumeAllocationMode?: VolumeAllocationModeDto;
  takeProfit2Points?: number;
  takeProfit3Points?: number;
  reversalTp1BufferPoints?: number;
  reversalTp2BufferPoints?: number;
  managementSeconds?: number;
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly bot?: Bot;
  private readonly mode: "disabled" | "polling" | "webhook";
  private readonly publicBaseUrl?: string;
  private readonly webhookSecret?: string;

  constructor(
    config: ConfigService,
    private readonly users: UsersService,
    private readonly pairing: PairingService,
    private readonly events: EconomicEventsService,
    private readonly tradeJobs: TradeJobsService,
    private readonly sessions: TelegramSessionsService,
    private readonly cTrader: CTraderService,
    private readonly cTraderMock: CTraderMockExecutionService,
    private readonly probeStrategy: ProbeStrategyService,
    private readonly safety: SafetyService,
  ) {
    const token = config.get<string>("TELEGRAM_BOT_TOKEN");
    this.mode = config.getOrThrow("TELEGRAM_MODE");
    this.publicBaseUrl = config.get<string>("PUBLIC_BASE_URL");
    this.webhookSecret = config.get<string>("TELEGRAM_WEBHOOK_SECRET");

    if (token && this.mode !== "disabled") {
      this.bot = new Bot(token);
      this.registerHandlers(this.bot);
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.bot) {
      this.logger.warn("Telegram integration is disabled");
      return;
    }

    await this.bot.init();
    await this.bot.api.setMyCommands([
      { command: "start", description: "Открыть главное меню" },
      { command: "connect", description: "Подключить MT5" },
      { command: "connect_ctrader", description: "Подключить cTrader" },
      { command: "news", description: "Выбрать новость и создать задание" },
      { command: "custom", description: "Задание на своё время Ашхабада" },
      { command: "test", description: "Создать тестовое задание через 1 минуту" },
      { command: "jobs", description: "Активные задания" },
      { command: "close_all", description: "Закрыть все cTrader-задания" },
      { command: "mock_results", description: "Результаты cTrader mock" },
      { command: "strategy_v2", description: "Probe Entry стратегия" },
      { command: "strategy_demo", description: "Запустить demo-сценарий V2" },
      { command: "status", description: "Проверить MT5 и счета" },
      { command: "settings", description: "Показать настройки риска" },
      { command: "multi_settings", description: "Шаблон MULTI trades" },
      { command: "reversal_settings", description: "Шаблон NEWS REVERSAL" },
      { command: "help", description: "Помощь" },
    ]);

    if (this.mode === "polling") {
      void this.bot.start({
        allowed_updates: ["message", "callback_query"],
        onStart: () => this.logger.log("Telegram long polling started"),
      });
      return;
    }

    if (!this.publicBaseUrl || !this.webhookSecret) {
      throw new Error("PUBLIC_BASE_URL and TELEGRAM_WEBHOOK_SECRET are required in webhook mode");
    }
    await this.bot.api.setWebhook(`${this.publicBaseUrl}/api/v1/telegram/webhook`, {
      secret_token: this.webhookSecret,
      allowed_updates: ["message", "callback_query"],
    });
    this.logger.log("Telegram webhook configured");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bot?.isRunning()) await this.bot.stop();
  }

  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot is disabled");
    await this.bot.handleUpdate(update);
  }

  private registerHandlers(bot: Bot): void {
    bot.catch((error) => this.logger.error("Telegram update failed", error.error));

    bot.command("start", async (ctx) => {
      if (!ctx.from) return;
      await this.upsertContextUser(ctx.from);
      await ctx.reply(
        "MT5 News Trader\n\nПо умолчанию разрешены только demo-счета. Подключите терминал, затем можно будет создавать задания на новости.",
        { reply_markup: this.mainMenu() },
      );
    });

    bot.command("help", async (ctx) => {
      await ctx.reply(
        [
          "/connect — получить одноразовый код для советника",
          "/connect_ctrader — подключить cTrader или локальный mock-счёт",
          "/news — выбрать новость и подготовить сделку",
          "/test — создать тестовое задание через 1 минуту",
          "/jobs — посмотреть или отменить активное задание",
          "/mock_results — последние отчёты cTrader mock",
          "/status — состояние агентов и счетов",
          "/settings — текущие ограничения риска",
          "",
          "Логин и пароль брокера никогда не отправляйте в Telegram.",
        ].join("\n"),
      );
    });

    bot.command("connect", async (ctx) => this.sendPairingCode(ctx));
    bot.callbackQuery("connect", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendPairingCode(ctx);
    });

    bot.command("connect_ctrader", async (ctx) => this.sendCTraderAuthorization(ctx));
    bot.callbackQuery("connect_ctrader", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendCTraderAuthorization(ctx);
    });

    bot.command("status", async (ctx) => this.sendStatus(ctx));
    bot.callbackQuery("status", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendStatus(ctx);
    });

    bot.command("settings", async (ctx) => this.sendSettings(ctx));
    bot.command("multi_settings", async (ctx) => this.sendMultiSettings(ctx));
    bot.command("reversal_settings", async (ctx) => this.sendReversalSettings(ctx));
    bot.callbackQuery("settings", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendSettings(ctx);
    });

    bot.callbackQuery("real_trading:request_on", async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        "ВНИМАНИЕ: после включения бот сможет создавать задания на REAL-счетах и торговать реальными деньгами. Убыток может превышать расчётный SL из-за spread, gap и slippage. Подтвердите включение.",
        { reply_markup: new InlineKeyboard()
          .text("Понимаю риск · Включить", "real_trading:confirm_on")
          .row()
          .text("Отмена", "settings") },
      );
    });

    bot.callbackQuery("real_trading:confirm_on", async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        await this.users.setRealTradingEnabled(BigInt(ctx.from.id), true);
        await ctx.reply("Real trading для вашего пользователя: ON. Также требуются ALLOW_REAL_TRADING=true на backend и InpAllowRealTrading=true в EA.");
      } catch (error) {
        await ctx.reply(this.errorMessage(error));
      }
    });

    bot.callbackQuery("real_trading:off", async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        await this.users.setRealTradingEnabled(BigInt(ctx.from.id), false);
        await ctx.reply("Real trading для вашего пользователя: OFF.");
      } catch (error) {
        await ctx.reply(this.errorMessage(error));
      }
    });

    bot.callbackQuery(/^risk_limit:(on|off)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        const enabled = ctx.match[1] === "on";
        await this.users.setRiskLimitEnabled(BigInt(ctx.from.id), enabled);
        await ctx.reply(`Расчётный risk limit: ${enabled ? "ON" : "OFF"}. Margin и position limits остаются включены.`);
      } catch (error) {
        await ctx.reply(this.errorMessage(error));
      }
    });

    bot.callbackQuery(/^risk_mode:(FIXED_LOT|RISK_PERCENT)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        await this.users.updateTradingDefault(BigInt(ctx.from.id), {
          field: "defaultRiskMode",
          value: ctx.match[1] as RiskModeDto,
        });
        await ctx.reply(`Режим расчёта объёма изменён на ${ctx.match[1]}.`);
      } catch (error) {
        await ctx.reply(this.errorMessage(error));
      }
    });

    bot.callbackQuery(/^edit_setting:(lot|risk|arm)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user) return;
      const prompts = {
        lot: "Введите default lot, например 0.01:",
        risk: "Введите риск в процентах, например 0.25:",
        arm: "Введите время подготовки от 3 до 60 секунд:",
      };
      await this.sessions.set(user.id, `SETTING_${ctx.match[1].toUpperCase()}`, {});
      await ctx.reply(prompts[ctx.match[1] as keyof typeof prompts]);
    });
    bot.callbackQuery("edit_multi_template", async (ctx) => {
      await ctx.answerCallbackQuery(); const user = await this.users.findByTelegramId(BigInt(ctx.from.id)); if (!user) return;
      await this.sessions.set(user.id, "SETTING_MULTI_TEMPLATE", {});
      await ctx.reply("Введите 8 целых чисел через пробел:\ntrades firstEntry firstSL firstTP entryStep nextSL tpStep expiry\nНапример: 3 50 10 100 30 10 100 30");
    });
    bot.callbackQuery("edit_reversal_template", async (ctx) => {
      await ctx.answerCallbackQuery(); const user = await this.users.findByTelegramId(BigInt(ctx.from.id)); if (!user) return;
      await this.sessions.set(user.id, "SETTING_REVERSAL_TEMPLATE", {});
      await ctx.reply("Введите mode и 9 целых чисел через пробел:\nSPLIT_TOTAL|FULL_EACH entry SL TP1 TP2 TP3 buffer1 buffer2 pendingSeconds managementSeconds\nНапример: SPLIT_TOTAL 50 10 100 200 300 20 20 30 300");
    });

    bot.command("news", async (ctx) => this.sendNews(ctx));
    bot.callbackQuery("news", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendNews(ctx);
    });
    bot.command("custom", async (ctx) => this.startCustomTrade(ctx));
    bot.callbackQuery("custom_trade", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.startCustomTrade(ctx);
    });

    bot.command("test", async (ctx) => this.startTestTrade(ctx));
    bot.callbackQuery("test_trade", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.startTestTrade(ctx);
    });

    bot.callbackQuery(/^event:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const user = await this.upsertContextUser(ctx.from);
      const event = await this.events.findById(ctx.match[1]);
      if (!event || event.scheduledAt.getTime() <= Date.now() + 20_000) {
        await ctx.reply("Новость уже прошла или находится слишком близко к текущему времени.");
        return;
      }

      await this.sessions.set(user.id, "SELECT_ACCOUNT", {
        eventId: event.id,
        eventTitle: event.title,
        executeAt: event.scheduledAt.toISOString(),
      });
      const fullUser = await this.users.findByTelegramId(BigInt(ctx.from.id));
      const mt5Accounts = fullUser?.accounts ?? [];
      const cTraderAccounts = fullUser ? await this.cTrader.listUserAccounts(fullUser.id) : [];
      if (mt5Accounts.length + cTraderAccounts.length === 0) {
        await ctx.reply("Сначала подключите MT5 или cTrader.");
        return;
      }
      const keyboard = new InlineKeyboard();
      for (const account of mt5Accounts) {
        keyboard.text(
          this.mt5AccountLabel(account),
          `account:MT5:${account.id}`,
        ).row();
      }
      for (const account of cTraderAccounts) {
        keyboard.text(
          `cTrader · ${account.traderLogin?.toString() ?? account.ctidTraderAccountId.toString()} ${account.environment}`,
          `account:CTRADER:${account.id}`,
        ).row();
      }
      await ctx.reply(`Новость: ${event.title}\nВыберите торговый счёт:`, {
        reply_markup: keyboard,
      });
    });

    bot.callbackQuery(/^account:(MT5|CTRADER):(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user) return;
      const session = await this.sessions.get(user.id);
      const executionVenue = ctx.match[1] as ExecutionVenueDto;
      const cTraderAccounts = await this.cTrader.listUserAccounts(user.id);
      const account = executionVenue === ExecutionVenueDto.MT5
        ? user.accounts.find((item) => item.id === ctx.match[2])
        : cTraderAccounts.find((item) => item.id === ctx.match[2]);
      if (!session || session.state !== "SELECT_ACCOUNT" || !account) {
        await ctx.reply("Сессия устарела. Начните заново: /news или /test");
        return;
      }
      const draft = session.data as unknown as TradeDraft;
      await this.sessions.set(user.id, "SELECT_LOT", {
        ...draft,
        accountId: account.id,
        executionVenue,
        symbol: user.settings?.defaultSymbol ?? "XAUUSD",
      });
      await ctx.reply(`Символ: ${user.settings?.defaultSymbol ?? "XAUUSD"}\nВыберите lot:`, {
        reply_markup: new InlineKeyboard()
          .text("0.1", "trade_lot:0.1").text("0.5", "trade_lot:0.5").text("1.0", "trade_lot:1")
          .row().text(`Default (${user.settings?.defaultFixedLot.toString() ?? "0.01"})`, "trade_lot:DEFAULT")
          .row().text(`Risk % (${user.settings?.defaultRiskPercent.toString() ?? "0.25"}%)`, "trade_lot:RISK")
          .row().text("Отмена", "cancel_trade"),
      });
    });

    bot.callbackQuery(/^trade_lot:(DEFAULT|RISK|0\.1|0\.5|1)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user?.settings) return;
      const session = await this.sessions.get(user.id);
      if (!session || session.state !== "SELECT_LOT") return void await ctx.reply("Сессия устарела. Начните заново.");
      const draft = session.data as unknown as TradeDraft;
      const useRisk = ctx.match[1] === "RISK";
      const fixedLot = useRisk ? undefined : ctx.match[1] === "DEFAULT" ? Number(user.settings.defaultFixedLot) : Number(ctx.match[1]);
      await this.sessions.set(user.id, "SELECT_EXECUTION_MODE", { ...draft, fixedLot,
        riskMode: useRisk ? RiskModeDto.RISK_PERCENT : RiskModeDto.FIXED_LOT,
        riskPercent: useRisk ? Number(user.settings.defaultRiskPercent) : undefined });
      await ctx.reply("Выберите режим исполнения:", { reply_markup: new InlineKeyboard()
        .text("Рыночный BUY/SELL", "execution_mode:MARKET").row()
        .text("Две стороны · OCO", "execution_mode:STRADDLE").row()
        .text("Две стороны · MULTI", "execution_mode:MULTI").row()
        .text("News Reversal · 3 TP", "execution_mode:NEWS_REVERSAL").row()
        .text("Отмена", "cancel_trade") });
    });

    bot.callbackQuery(/^direction:(BUY|SELL)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user) return;
      const session = await this.sessions.get(user.id);
      if (!session || session.state !== "SELECT_DIRECTION") {
        await ctx.reply("Сессия устарела. Начните заново: /news или /test");
        return;
      }
      const draft = session.data as unknown as TradeDraft;
      await this.sessions.set(user.id, "ENTER_STOPS", {
        ...draft,
        direction: ctx.match[1],
      });
      await ctx.reply("Введите Stop Loss и Take Profit в pips через пробел. Например: 10 200");
    });

    bot.callbackQuery(/^execution_mode:(MARKET|STRADDLE|MULTI|NEWS_REVERSAL)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user) return;
      const session = await this.sessions.get(user.id);
      if (!session || session.state !== "SELECT_EXECUTION_MODE") {
        await ctx.reply("Сессия устарела. Начните заново: /news или /test");
        return;
      }
      const draft = session.data as unknown as TradeDraft;
      const executionMode = ctx.match[1] as ExecutionModeDto;
      if (executionMode === ExecutionModeDto.MARKET) {
        await this.sessions.set(user.id, "SELECT_DIRECTION", { ...draft, executionMode });
        await ctx.reply("Выберите направление сделки:", {
          reply_markup: new InlineKeyboard()
            .text("BUY", "direction:BUY")
            .text("SELL", "direction:SELL")
            .row()
            .text("Отмена", "cancel_trade"),
        });
        return;
      }
      if (executionMode === ExecutionModeDto.MULTI) {
        await this.sessions.set(user.id, "SELECT_MULTI_COUNT", { ...draft, executionMode, direction: TradeDirectionDto.BUY, pendingExpirySeconds: 30 });
        await ctx.reply("Сколько pending trades поставить в каждую сторону?", { reply_markup: new InlineKeyboard()
          .text("2", "multi_count:2").text("3", "multi_count:3").text("4", "multi_count:4").text("5", "multi_count:5")
          .row().text("Использовать MULTI template", "multi_use_template") });
        return;
      }
      if (executionMode === ExecutionModeDto.NEWS_REVERSAL) {
        if (draft.executionVenue !== ExecutionVenueDto.CTRADER) {
          await ctx.reply("NEWS REVERSAL пока доступен только для cTrader.");
          return;
        }
        if (draft.riskMode !== RiskModeDto.FIXED_LOT) {
          await ctx.reply("NEWS REVERSAL пока работает только с fixed lot.");
          return;
        }
        await this.sessions.set(user.id, "SELECT_REVERSAL_VOLUME_MODE", { ...draft, executionMode, direction: TradeDirectionDto.BUY });
        await ctx.reply("Как использовать выбранный lot?", { reply_markup: new InlineKeyboard()
          .text("SPLIT TOTAL", "reversal_volume:SPLIT_TOTAL").row()
          .text("FULL LOT EACH", "reversal_volume:FULL_EACH").row()
          .text("Отмена", "cancel_trade") });
        return;
      }
      await this.sessions.set(user.id, "ENTER_STRADDLE_DISTANCE", {
        ...draft,
        executionMode,
        direction: TradeDirectionDto.BUY,
        pendingExpirySeconds: 30,
      });
      await ctx.reply(
        "Введите расстояние до Stop-ордеров в pips. Для XAUUSD: 1 pip = 0.10 цены. Например: 50",
      );
    });

    bot.callbackQuery(/^reversal_volume:(SPLIT_TOTAL|FULL_EACH)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user?.settings) return;
      const session = await this.sessions.get(user.id);
      if (!session || session.state !== "SELECT_REVERSAL_VOLUME_MODE") return void await ctx.reply("Сессия устарела.");
      const draft = session.data as unknown as TradeDraft;
      const s = user.settings;
      const completeDraft: TradeDraft = {
        ...draft,
        volumeAllocationMode: ctx.match[1] as VolumeAllocationModeDto,
        entryDistancePoints: this.pipsToPoints(draft.symbol!, s.reversalEntryPips),
        stopLossPoints: this.pipsToPoints(draft.symbol!, s.reversalSlPips),
        takeProfitPoints: this.pipsToPoints(draft.symbol!, s.reversalTp1Pips),
        takeProfit2Points: this.pipsToPoints(draft.symbol!, s.reversalTp2Pips),
        takeProfit3Points: this.pipsToPoints(draft.symbol!, s.reversalTp3Pips),
        reversalTp1BufferPoints: this.pipsToPoints(draft.symbol!, s.reversalTp1BufferPips),
        reversalTp2BufferPoints: this.pipsToPoints(draft.symbol!, s.reversalTp2BufferPips),
        pendingExpirySeconds: s.reversalPendingExpirySeconds,
        managementSeconds: s.reversalManagementSeconds,
      };
      await this.sessions.set(user.id, "CONFIRM", completeDraft);
      const lot = completeDraft.fixedLot!;
      const total = completeDraft.volumeAllocationMode === VolumeAllocationModeDto.SPLIT_TOTAL ? lot : lot * 3;
      await ctx.reply([
        "Проверьте NEWS REVERSAL:",
        `Символ: ${completeDraft.symbol}`,
        `Volume mode: ${completeDraft.volumeAllocationMode}`,
        `Выбранный lot: ${lot}; фактический объём направления: ${total.toFixed(2)} lot`,
        "Ордеров: 3 BUY + 3 SELL",
        `Entry/SL: ${s.reversalEntryPips}/${s.reversalSlPips} pips`,
        `TP: ${s.reversalTp1Pips}/${s.reversalTp2Pips}/${s.reversalTp3Pips} pips`,
        `Защита после TP1/TP2: −${s.reversalTp1BufferPips}/−${s.reversalTp2BufferPips} pips`,
        `Pending: T+${s.reversalPendingExpirySeconds} сек.; управление: ${s.reversalManagementSeconds} сек.`,
        "Разрешён максимум один разворот.",
      ].join("\n"), { reply_markup: new InlineKeyboard().text("Подтвердить", "confirm_trade").text("Отмена", "cancel_trade") });
    });

    bot.callbackQuery(/^multi_count:([2-5])$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id)); if (!user) return;
      const session = await this.sessions.get(user.id);
      if (!session || session.state !== "SELECT_MULTI_COUNT") return void await ctx.reply("Сессия устарела.");
      await this.sessions.set(user.id, "ENTER_MULTI_FIRST_ENTRY", { ...(session.data as object), multiTradesPerSide: Number(ctx.match[1]) });
      await ctx.reply("Введите entry distance для первых BUY Stop и SELL Stop в pips:");
    });

    bot.callbackQuery("multi_use_template", async (ctx) => {
      await ctx.answerCallbackQuery(); const user = await this.users.findByTelegramId(BigInt(ctx.from.id)); if (!user?.settings) return;
      const session = await this.sessions.get(user.id); if (!session || session.state !== "SELECT_MULTI_COUNT") return void await ctx.reply("Сессия устарела.");
      const s = user.settings; const draft = session.data as unknown as TradeDraft;
      const completeDraft: TradeDraft = { ...draft, multiTradesPerSide: s.multiTradesPerSide,
        entryDistancePoints: this.pipsToPoints(draft.symbol!, s.multiFirstEntryPips), stopLossPoints: this.pipsToPoints(draft.symbol!, s.multiFirstSlPips),
        takeProfitPoints: this.pipsToPoints(draft.symbol!, s.multiFirstTpPips), multiNextStepPoints: this.pipsToPoints(draft.symbol!, s.multiNextStepPips),
        multiNextSlPoints: this.pipsToPoints(draft.symbol!, s.multiNextSlPips), multiNextTpPoints: this.pipsToPoints(draft.symbol!, s.multiNextTpPips), pendingExpirySeconds: s.multiExpirySeconds };
      await this.sessions.set(user.id, "CONFIRM", completeDraft);
      const total = s.multiTradesPerSide * 2;
      const volumeText = completeDraft.riskMode === RiskModeDto.RISK_PERCENT
        ? `Risk: ${completeDraft.riskPercent}% на корзину`
        : `Lot каждого: ${completeDraft.fixedLot}; общий объём: ${(total * completeDraft.fixedLot!).toFixed(2)} lot`;
      await ctx.reply(["MULTI template выбран:", `${s.multiTradesPerSide} BUY + ${s.multiTradesPerSide} SELL = ${total} ордеров`,
        volumeText,
        `Первый entry/SL/TP: ${s.multiFirstEntryPips}/${s.multiFirstSlPips}/${s.multiFirstTpPips} pips`,
        `Следующие entry step/SL/TP step: ${s.multiNextStepPips}/${s.multiNextSlPips}/${s.multiNextTpPips} pips`].join("\n"),
        { reply_markup: new InlineKeyboard().text("Подтвердить", "confirm_trade").text("Отмена", "cancel_trade") });
    });

    bot.callbackQuery("confirm_trade", async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user) return;
      const session = await this.sessions.get(user.id);
      if (!session || session.state !== "CONFIRM") {
        await ctx.reply("Сессия устарела. Начните заново: /news или /test");
        return;
      }
      const draft = session.data as unknown as Required<TradeDraft>;
      try {
        const job = await this.tradeJobs.createForTelegramUser(ctx.from.id.toString(), {
          accountId: draft.accountId,
          executionVenue: draft.executionVenue,
          economicEventId: draft.eventId,
          symbol: draft.symbol,
          direction: draft.direction,
          executionMode: draft.executionMode,
          riskMode: draft.riskMode,
          fixedLot: draft.riskMode === RiskModeDto.FIXED_LOT ? draft.fixedLot : undefined,
          riskPercent: draft.riskMode === RiskModeDto.RISK_PERCENT ? draft.riskPercent : undefined,
          stopLossPoints: draft.stopLossPoints,
          takeProfitPoints: draft.takeProfitPoints,
          entryDistancePoints:
            [ExecutionModeDto.STRADDLE, ExecutionModeDto.MULTI, ExecutionModeDto.NEWS_REVERSAL].includes(draft.executionMode)
              ? draft.entryDistancePoints
              : undefined,
          pendingExpirySeconds:
            [ExecutionModeDto.STRADDLE, ExecutionModeDto.MULTI, ExecutionModeDto.NEWS_REVERSAL].includes(draft.executionMode)
              ? draft.pendingExpirySeconds
              : undefined,
          multiTradesPerSide: draft.multiTradesPerSide,
          multiNextStepPoints: draft.multiNextStepPoints,
          multiNextSlPoints: draft.multiNextSlPoints,
          multiNextTpPoints: draft.multiNextTpPoints,
          volumeAllocationMode: draft.volumeAllocationMode,
          takeProfit2Points: draft.takeProfit2Points,
          takeProfit3Points: draft.takeProfit3Points,
          reversalTp1BufferPoints: draft.reversalTp1BufferPoints,
          reversalTp2BufferPoints: draft.reversalTp2BufferPoints,
          managementSeconds: draft.managementSeconds,
          executeAt: draft.executeAt,
        });
        await this.sessions.clear(user.id);
        if (job.executionVenue === "CTRADER" && this.cTrader.isMockMode()) {
          await ctx.reply(
            `Mock-задание создано: ${job.id}\nВремя Ашхабад: ${this.formatAshgabatTime(job.executeAt)}\nВыберите симулируемый результат:`,
            {
              reply_markup: new InlineKeyboard()
                .text("BUY fill", `mock:BUY_FILL:${job.id}`)
                .text("SELL fill", `mock:SELL_FILL:${job.id}`)
                .row()
                .text("Timeout", `mock:TIMEOUT:${job.id}`)
                .text("Reject", `mock:REJECT:${job.id}`),
            },
          );
        } else {
        await ctx.reply(`Задание создано: ${job.id}\nВремя Ашхабад: ${this.formatAshgabatTime(job.executeAt)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось создать задание";
        await ctx.reply(`Задание не создано: ${message}`);
      }
    });

    bot.callbackQuery("cancel_trade", async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (user) await this.sessions.clear(user.id);
      await ctx.reply("Создание задания отменено.");
    });

    bot.callbackQuery(/^mock:(BUY_FILL|SELL_FILL|TIMEOUT|REJECT):(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user) return;
      const outcome = ctx.match[1] as "BUY_FILL" | "SELL_FILL" | "TIMEOUT" | "REJECT";
      const result = await this.cTraderMock.setOutcome(user.id, ctx.match[2], outcome);
      await ctx.reply(result.count === 1 ? `Mock-результат: ${outcome}` : "Результат уже нельзя изменить.");
    });

    bot.command("jobs", async (ctx) => this.sendActiveJobs(ctx));
    bot.callbackQuery("jobs", async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendActiveJobs(ctx);
    });
    bot.command("mock_results", async (ctx) => this.sendMockResults(ctx));
    bot.command("strategy_v2", async (ctx) => this.sendStrategyV2(ctx));
    bot.command("strategy_demo", async (ctx) => this.runStrategyDemo(ctx));
    bot.callbackQuery(/^strategy_v2:(on|off):(MT5|CTRADER):(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
      if (!user) return;
      try {
        if (ctx.match[2] === "MT5") {
          await this.probeStrategy.enableForMt5User(user.id, ctx.match[3], ctx.match[1] === "on");
        } else {
          await this.probeStrategy.enableForUser(user.id, ctx.match[3], ctx.match[1] === "on");
        }
        await ctx.reply(`Strategy V2: ${ctx.match[1] === "on" ? "ON" : "OFF"}`);
      } catch (error) {
        await ctx.reply(this.errorMessage(error));
      }
    });

    bot.callbackQuery(/^cancel_job:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        const job = await this.tradeJobs.cancelForTelegramUser(BigInt(ctx.from.id), ctx.match[1]);
        await ctx.reply(job.cancelRequestedAt
          ? `Запрошена отмена pending для ${job.id}. Открытые позиции останутся под SL/TP.`
          : `Задание ${job.id} отменено.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось отменить задание";
        await ctx.reply(`Отмена не выполнена: ${message}`);
      }
    });
    bot.callbackQuery(/^request_close_job:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply("Закрыть позиции этого задания по рынку и отменить pending?", { reply_markup: new InlineKeyboard()
        .text("Да, закрыть", `confirm_close_job:${ctx.match[1]}`).text("Нет", "jobs") });
    });
    bot.callbackQuery(/^confirm_close_job:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      try { const job = await this.tradeJobs.requestCloseForTelegramUser(BigInt(ctx.from.id), ctx.match[1]);
        await ctx.reply(`Запрос на закрытие ${job.id} принят.`); }
      catch (error) { await ctx.reply(`Закрытие не выполнено: ${this.errorMessage(error)}`); }
    });
    bot.command("close_all", async (ctx) => {
      await ctx.reply("Аварийно закрыть все позиции заданий cTrader и отменить все pending?", { reply_markup: new InlineKeyboard()
        .text("Да, закрыть всё", "confirm_close_all").text("Нет", "jobs") });
    });
    bot.callbackQuery("confirm_close_all", async (ctx) => {
      await ctx.answerCallbackQuery();
      try { const result = await this.tradeJobs.requestCloseAllForTelegramUser(BigInt(ctx.from.id));
        await ctx.reply(`Запрос на закрытие отправлен для заданий: ${result.count}.`); }
      catch (error) { await ctx.reply(`Закрытие не выполнено: ${this.errorMessage(error)}`); }
    });

    bot.on("message:text", async (ctx) => this.handleDraftText(ctx));
  }

  private async upsertContextUser(from: {
    id: number;
    username?: string;
    first_name: string;
    language_code?: string;
  }) {
    return this.users.upsertTelegramUser({
      telegramId: BigInt(from.id),
      username: from.username,
      firstName: from.first_name,
      languageCode: from.language_code,
    });
  }

  private async sendPairingCode(ctx: {
    from?: { id: number; username?: string; first_name: string; language_code?: string };
    reply: (text: string) => Promise<unknown>;
  }): Promise<void> {
    if (!ctx.from) return;
    const user = await this.upsertContextUser(ctx.from);
    const result = await this.pairing.create(user.id);
    await ctx.reply(
      `Код подключения: ${result.code}\nДействует до ${result.expiresAt.toISOString()}.\n\nВведите его в параметрах советника MT5.`,
    );
  }

  private async sendCTraderAuthorization(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    if (!this.cTrader.isEnabled()) {
      await ctx.reply("Подключение cTrader пока выключено администратором.");
      return;
    }
    const user = await this.upsertContextUser(ctx.from);
    if (this.cTrader.isMockMode()) {
      const account = await this.cTrader.ensureMockAccount(user.id);
      await ctx.reply(`Mock cTrader demo-счёт подключён: ${account.traderLogin?.toString() ?? account.ctidTraderAccountId.toString()}`);
      return;
    }
    try {
      const url = await this.cTrader.createAuthorizationUrl(user.id);
      await ctx.reply(
        "Откройте официальный сайт cTrader и разрешите доступ к торговым счетам. Пароль от брокера бот не получает.",
        { reply_markup: new InlineKeyboard().url("Подключить cTrader", url) },
      );
    } catch (error) {
      await ctx.reply(`Не удалось начать подключение: ${this.errorMessage(error)}`);
    }
  }

  private async sendStatus(ctx: {
    from?: { id: number };
    reply: (text: string) => Promise<unknown>;
  }): Promise<void> {
    if (!ctx.from) return;
    const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
    if (!user) {
      await ctx.reply("Сначала выполните /start");
      return;
    }

    const agents = user.agents.length
      ? user.agents
          .map((agent) => `${agent.name}: ${agent.status}, last seen ${agent.lastSeenAt?.toISOString() ?? "never"}`)
          .join("\n")
      : "Агенты MT5 ещё не подключены";
    const accounts = user.accounts.length
      ? user.accounts
          .map(
            (account) =>
              `${account.login.toString()} @ ${account.server}: ${account.environment}, trade=${account.expertTradeAllowed ? "on" : "off"}`,
          )
          .join("\n")
      : "Счета ещё не обнаружены";

    const cTraderAccounts = await this.cTrader.listUserAccounts(user.id);
    const cTraderStatus = cTraderAccounts.length
      ? cTraderAccounts.map((account) =>
          `${account.traderLogin?.toString() ?? account.ctidTraderAccountId.toString()} @ ${account.brokerTitle ?? "cTrader"}: ${account.environment}`,
        ).join("\n")
      : "cTrader-счета ещё не подключены";
    const safety = await this.safety.status();

    await ctx.reply(`Торговля: ${safety.halted ? `STOPPED (${safety.reason ?? "kill switch"})` : "ACTIVE"}\n\nАгенты MT5:\n${agents}\n\nСчета MT5:\n${accounts}\n\nСчета cTrader:\n${cTraderStatus}`);
  }

  private async sendSettings(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
    if (!user?.settings) {
      await ctx.reply("Сначала выполните /start");
      return;
    }
    const settings = user.settings;
    await ctx.reply(
      [
        `Real trading: ${settings.realTradingEnabled ? "ON" : "OFF"}`,
        `Default lot: ${settings.defaultFixedLot.toString()}`,
        `Default risk: ${settings.defaultRiskPercent.toString()}%`,
        `Расчётный risk limit: ${settings.riskLimitEnabled ? "ON" : "OFF"}`,
        `Подготовка: ${settings.defaultArmSeconds} сек.`,
        `Макс. опоздание: ${settings.defaultMaxLatenessMs} мс.`,
        `Дневной лимит: ${settings.maxDailyLossPercent.toString()}%`,
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text("Fixed lot", "risk_mode:FIXED_LOT")
          .text("Risk %", "risk_mode:RISK_PERCENT")
          .row()
          .text("Изменить lot", "edit_setting:lot")
          .text("Изменить risk", "edit_setting:risk")
          .row()
          .text("Изменить подготовку", "edit_setting:arm")
          .row()
          .text(
            settings.riskLimitEnabled ? "Выключить risk limit" : "Включить risk limit",
            settings.riskLimitEnabled ? "risk_limit:off" : "risk_limit:on",
          )
          .row()
          .text(
            settings.realTradingEnabled ? "Выключить Real trading" : "Включить Real trading",
            settings.realTradingEnabled ? "real_trading:off" : "real_trading:request_on",
          ),
      },
    );
  }

  private async sendMultiSettings(ctx: Context): Promise<void> {
    if (!ctx.from) return; const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
    if (!user?.settings) return void await ctx.reply("Сначала выполните /start"); const s = user.settings;
    await ctx.reply(["MULTI template · XAUUSD", `Trades на сторону: ${s.multiTradesPerSide}`,
      `Первый entry/SL/TP: ${s.multiFirstEntryPips}/${s.multiFirstSlPips}/${s.multiFirstTpPips} pips`,
      `Следующие entry step/SL/TP step: ${s.multiNextStepPips}/${s.multiNextSlPips}/${s.multiNextTpPips} pips`,
      `Удаление pending: T+${s.multiExpirySeconds} сек.`].join("\n"), { reply_markup: new InlineKeyboard().text("Изменить шаблон", "edit_multi_template") });
  }

  private async sendReversalSettings(ctx: Context): Promise<void> {
    if (!ctx.from) return; const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
    if (!user?.settings) return void await ctx.reply("Сначала выполните /start"); const s = user.settings;
    await ctx.reply(["NEWS REVERSAL template · XAUUSD",
      `Volume mode: ${s.reversalVolumeMode}`,
      `Entry/SL: ${s.reversalEntryPips}/${s.reversalSlPips} pips`,
      `TP: ${s.reversalTp1Pips}/${s.reversalTp2Pips}/${s.reversalTp3Pips} pips`,
      `Buffers TP1/TP2: ${s.reversalTp1BufferPips}/${s.reversalTp2BufferPips} pips`,
      `Pending: T+${s.reversalPendingExpirySeconds} сек.`,
      `Управление: ${s.reversalManagementSeconds} сек.`].join("\n"),
    { reply_markup: new InlineKeyboard().text("Изменить шаблон", "edit_reversal_template") });
  }

  private async sendNews(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const user = await this.upsertContextUser(ctx.from);
    await this.sessions.clear(user.id);
    const events = await this.events.list({ importance: "HIGH" });
    if (events.length === 0) {
      await ctx.reply(
        "Высоковажных событий пока нет в базе. Можно задать время вручную:",
        { reply_markup: new InlineKeyboard().text("Задать своё время", "custom_trade") },
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const event of events.slice(0, 10)) {
      const title = event.title.length > 32 ? `${event.title.slice(0, 29)}...` : event.title;
      keyboard
        .text(`${event.currency} · ${this.formatAshgabatTime(event.scheduledAt)} · ${title}`, `event:${event.id}`)
        .row();
    }
    keyboard.text("Задать своё время", "custom_trade").row();
    await ctx.reply("Выберите новость. Время Ашхабада (UTC+5):", { reply_markup: keyboard });
  }

  private async startCustomTrade(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const user = await this.upsertContextUser(ctx.from);
    await this.sessions.set(user.id, "ENTER_CUSTOM_TIME", {});
    await ctx.reply(
      "Введите время исполнения по Ашхабаду.\n\nСегодня: 19:00 или 19:00:30\nДругая дата: 29.08.2026 19:00\n\nПодготовка начнётся за время из /settings (default: 10 сек.).",
    );
  }

  private async startTestTrade(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const user = await this.upsertContextUser(ctx.from);
    const fullUser = await this.users.findByTelegramId(BigInt(ctx.from.id));
    const mt5Accounts = fullUser?.accounts ?? [];
    const cTraderAccounts = fullUser ? await this.cTrader.listUserAccounts(fullUser.id) : [];
    if (mt5Accounts.length + cTraderAccounts.length === 0) {
      await ctx.reply("Сначала подключите MT5 или cTrader.");
      return;
    }

    const executeAt = new Date(Date.now() + 60_000).toISOString();
    await this.sessions.set(user.id, "SELECT_ACCOUNT", {
      eventTitle: "Тест через 1 минуту",
      executeAt,
    });

    const keyboard = new InlineKeyboard();
    for (const account of mt5Accounts) {
      keyboard
        .text(this.mt5AccountLabel(account), `account:MT5:${account.id}`)
        .row();
    }
    for (const account of cTraderAccounts) {
      keyboard
        .text(`cTrader · ${account.traderLogin?.toString() ?? account.ctidTraderAccountId.toString()} ${account.environment}`, `account:CTRADER:${account.id}`)
        .row();
    }
    await ctx.reply(`Тестовое задание\nВремя Ашхабад: ${this.formatAshgabatTime(new Date(executeAt))}\nВыберите торговый счёт:`, {
      reply_markup: keyboard,
    });
  }

  private async sendActiveJobs(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const jobs = await this.tradeJobs.listActiveForTelegramUser(BigInt(ctx.from.id));
    if (jobs.length === 0) {
      const recent = await this.tradeJobs.listRecentFinalForTelegramUser(BigInt(ctx.from.id));
      if (recent.length === 0) {
        await ctx.reply("Активных заданий нет.");
        return;
      }
      await ctx.reply(["Активных заданий нет.", "", "Последние завершённые задания:", ...recent.map((job) => {
        const report = job.executionReports[0];
        return `${job.symbol} ${job.executionMode} · ${job.status}\nПричина: ${report?.message ?? "нет отчёта"}`;
      })].join("\n\n"));
      return;
    }

    for (const job of jobs) {
      const keyboard = new InlineKeyboard();
      if (["SCHEDULED", "SYNCED"].includes(job.status)) {
        keyboard.text("Отменить", `cancel_job:${job.id}`);
      } else if (job.executionVenue === "CTRADER") {
        keyboard.text("Отменить pending", `cancel_job:${job.id}`).row()
          .text("Закрыть позиции", `request_close_job:${job.id}`);
      }
      await ctx.reply(
        [
          `${job.symbol} ${job.executionMode === "STRADDLE" ? "STRADDLE OCO" : job.direction}`,
          `Новость: ${job.economicEvent?.title ?? "manual"}`,
          `Время Ашхабад: ${this.formatAshgabatTime(job.executeAt)}`,
          `Статус: ${job.status}`,
          `Счёт: ${job.executionVenue === "CTRADER"
            ? `${job.cTraderAccount?.traderLogin?.toString() ?? "cTrader"} @ ${job.cTraderAccount?.brokerTitle ?? "cTrader"}`
            : `${job.account?.login.toString()} @ ${job.account?.server}`}`,
        ].join("\n"),
        keyboard.inline_keyboard.length > 0 ? { reply_markup: keyboard } : undefined,
      );
    }
  }

  private async sendMockResults(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const jobs = await this.tradeJobs.listRecentCTraderForTelegramUser(BigInt(ctx.from.id));
    if (jobs.length === 0) {
      await ctx.reply("cTrader mock-заданий пока нет.");
      return;
    }
    for (const job of jobs) {
      const reports = job.executionReports.length
        ? job.executionReports.map((report) =>
            `${report.occurredAt.toISOString()} · ${report.phase} · ${report.message ?? ""}`,
          ).join("\n")
        : "Отчётов пока нет";
      await ctx.reply([
        `${job.symbol} · ${job.executionMode} · ${job.status}`,
        `Mock outcome: ${job.mockOutcome ?? "BUY_FILL"}`,
        `Счёт: ${job.cTraderAccount?.traderLogin?.toString() ?? "mock"}`,
        reports,
      ].join("\n"));
    }
  }

  private async sendStrategyV2(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
    if (!user) {
      await ctx.reply("Сначала выполните /start");
      return;
    }
    const cTraderAccounts = await this.cTrader.listUserAccounts(user.id);
    const mt5Accounts = user.accounts.filter((account) => account.environment === "DEMO");
    if (cTraderAccounts.length + mt5Accounts.length === 0) {
      await ctx.reply("Сначала подключите MT5 demo или создайте cTrader mock-счёт.");
      return;
    }
    const configs = await this.probeStrategy.statusForUser(user.id);
    const keyboard = new InlineKeyboard();
    for (const account of mt5Accounts) {
      const config = configs.find((item) => item.accountId === account.id);
      keyboard
        .text(
          `${config?.enabled ? "Выключить" : "Включить"} · MT5 ${account.login.toString()}`,
          `strategy_v2:${config?.enabled ? "off" : "on"}:MT5:${account.id}`,
        )
        .row();
    }
    for (const account of cTraderAccounts) {
      const config = configs.find((item) => item.cTraderAccountId === account.id);
      keyboard
        .text(
          `${config?.enabled ? "Выключить" : "Включить"} · ${account.traderLogin?.toString() ?? "cTrader"}`,
          `strategy_v2:${config?.enabled ? "off" : "on"}:CTRADER:${account.id}`,
        )
        .row();
    }
    const active = configs.flatMap((config) => config.positions).find((position) => ["PROBE_OPEN", "MAIN_ADDED"].includes(position.state));
    await ctx.reply([
      "Strategy V2 · XAUUSD",
      "H1 EMA 50/200 · M15 breakout 20 · ATR 14",
      "Probe risk 0.10% · Main risk 0.30% · TP 3R",
      `Активная позиция: ${active ? `${active.direction} ${active.state}` : "нет"}`,
      "MT5 исполняет только на DEMO фиксированными 0.01 + 0.01 lot.",
    ].join("\n"), { reply_markup: keyboard });
  }

  private async runStrategyDemo(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
    if (!user) return;
    try {
      await ctx.reply("Генерирую H1/M15 mock-свечи и выполняю Probe Entry сценарий...");
      await this.probeStrategy.runMockDemo(user.id);
      const configs = await this.probeStrategy.statusForUser(user.id);
      const position = configs.flatMap((config) => config.positions)[0];
      if (!position) {
        await ctx.reply("Сигнал не сформирован. Проверьте, что Strategy V2 включена.");
        return;
      }
      await ctx.reply([
        `${position.symbol} ${position.direction} · ${position.state}`,
        `Probe: ${position.probeEntryPrice.toString()}`,
        `Main: ${position.mainEntryPrice?.toString() ?? "не добавлен"}`,
        `SL: ${position.stopLossPrice.toString()} · TP: ${position.takeProfitPrice.toString()}`,
        `Result: ${position.realizedR?.toString() ?? "open"}R`,
        ...position.events.map((event) => `${event.type}: ${event.message}`),
      ].join("\n"));
    } catch (error) {
      await ctx.reply(`Strategy demo: ${this.errorMessage(error)}`);
    }
  }

  private async handleDraftText(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.message?.text || ctx.message.text.startsWith("/")) return;
    const user = await this.users.findByTelegramId(BigInt(ctx.from.id));
    if (!user?.settings) return;
    const session = await this.sessions.get(user.id);
    if (!session) return;

    if (session.state === "ENTER_CUSTOM_TIME") {
      const executeAt = this.parseAshgabatDateTime(ctx.message.text);
      if (!executeAt) {
        await ctx.reply("Не удалось распознать время. Примеры: 19:00 или 29.08.2026 19:00");
        return;
      }
      if (executeAt.getTime() < Date.now() + 20_000) {
        await ctx.reply("Время должно быть минимум на 20 секунд позже текущего времени.");
        return;
      }
      const cTraderAccounts = await this.cTrader.listUserAccounts(user.id);
      if (user.accounts.length + cTraderAccounts.length === 0) {
        await ctx.reply("Сначала подключите MT5 или cTrader.");
        return;
      }
      await this.sessions.set(user.id, "SELECT_ACCOUNT", {
        eventTitle: "Custom time",
        executeAt: executeAt.toISOString(),
      });
      const keyboard = new InlineKeyboard();
      for (const account of user.accounts) {
        keyboard.text(this.mt5AccountLabel(account), `account:MT5:${account.id}`).row();
      }
      for (const account of cTraderAccounts) {
        keyboard.text(`cTrader · ${account.traderLogin?.toString() ?? account.ctidTraderAccountId.toString()} ${account.environment}`, `account:CTRADER:${account.id}`).row();
      }
      await ctx.reply(`Custom-задание\nВремя Ашхабад: ${this.formatAshgabatTime(executeAt)}\nВыберите торговый счёт:`, { reply_markup: keyboard });
      return;
    }

    if (session.state.startsWith("SETTING_")) {
      if (session.state === "SETTING_MULTI_TEMPLATE") {
        const values = ctx.message.text.trim().split(/\s+/).map(Number);
        if (values.length !== 8 || values.some((value) => !Number.isInteger(value))) return void await ctx.reply("Нужно ровно 8 целых чисел.");
        try { await this.users.updateMultiTemplate(BigInt(ctx.from.id), { tradesPerSide: values[0], firstEntryPips: values[1], firstSlPips: values[2], firstTpPips: values[3], nextStepPips: values[4], nextSlPips: values[5], nextTpPips: values[6], expirySeconds: values[7] });
          await this.sessions.clear(user.id); await ctx.reply("MULTI template сохранён."); } catch (error) { await ctx.reply(this.errorMessage(error)); }
        return;
      }
      if (session.state === "SETTING_REVERSAL_TEMPLATE") {
        const parts = ctx.message.text.trim().split(/\s+/);
        const mode = parts.shift(); const values = parts.map(Number);
        if (!mode || !["SPLIT_TOTAL", "FULL_EACH"].includes(mode) || values.length !== 9 || values.some((value) => !Number.isInteger(value)))
          return void await ctx.reply("Формат: SPLIT_TOTAL|FULL_EACH и ровно 9 целых чисел.");
        try {
          await this.users.updateNewsReversalTemplate(BigInt(ctx.from.id), {
            volumeMode: mode as "SPLIT_TOTAL" | "FULL_EACH", entryPips: values[0], slPips: values[1],
            tp1Pips: values[2], tp2Pips: values[3], tp3Pips: values[4], tp1BufferPips: values[5],
            tp2BufferPips: values[6], pendingExpirySeconds: values[7], managementSeconds: values[8],
          });
          await this.sessions.clear(user.id); await ctx.reply("NEWS REVERSAL template сохранён.");
        } catch (error) { await ctx.reply(this.errorMessage(error)); }
        return;
      }
      const raw = ctx.message.text.trim().replace(",", ".");
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        await ctx.reply("Введите корректное число.");
        return;
      }
      try {
        if (session.state === "SETTING_LOT") {
          await this.users.updateTradingDefault(BigInt(ctx.from.id), {
            field: "defaultFixedLot",
            value,
          });
        } else if (session.state === "SETTING_RISK") {
          await this.users.updateTradingDefault(BigInt(ctx.from.id), {
            field: "defaultRiskPercent",
            value,
          });
        } else if (session.state === "SETTING_ARM") {
          await this.users.updateTradingDefault(BigInt(ctx.from.id), {
            field: "defaultArmSeconds",
            value,
          });
        }
        await this.sessions.clear(user.id);
        await ctx.reply("Настройка сохранена.");
      } catch (error) {
        await ctx.reply(this.errorMessage(error));
      }
      return;
    }

    const draft = session.data as unknown as TradeDraft;

    if (session.state === "SELECT_SYMBOL") {
      const symbol = ctx.message.text.trim();
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(symbol)) {
        await ctx.reply("Некорректный символ. Пример: EURUSD или EURUSD.a");
        return;
      }
      await this.sessions.set(user.id, "SELECT_EXECUTION_MODE", { ...draft, symbol });
      await ctx.reply("Выберите режим исполнения:", {
        reply_markup: new InlineKeyboard()
          .text("Рыночный BUY/SELL", "execution_mode:MARKET")
          .row()
          .text("Две стороны · OCO", "execution_mode:STRADDLE")
          .row()
          .text("Две стороны · MULTI", "execution_mode:MULTI")
          .row()
          .text("News Reversal · 3 TP", "execution_mode:NEWS_REVERSAL")
          .row()
          .text("Отмена", "cancel_trade"),
      });
      return;
    }

    if (session.state === "ENTER_STRADDLE_DISTANCE") {
      const entryPips = Number(ctx.message.text.trim());
      if (!Number.isInteger(entryPips) || entryPips < 1 || entryPips > 100_000) {
        await ctx.reply("Введите целое расстояние от 1 до 100 000 pips.");
        return;
      }
      const entryDistancePoints = this.pipsToPoints(draft.symbol!, entryPips);
      await this.sessions.set(user.id, "ENTER_STOPS", { ...draft, entryDistancePoints });
      await ctx.reply("Введите Stop Loss и Take Profit в pips через пробел. Например: 10 200");
      return;
    }

    if (session.state === "ENTER_MULTI_FIRST_ENTRY") {
      const pips = this.parsePositiveInteger(ctx.message.text);
      if (!pips) return void await ctx.reply("Введите целое положительное число pips.");
      await this.sessions.set(user.id, "ENTER_MULTI_FIRST_STOPS", { ...draft, entryDistancePoints: this.pipsToPoints(draft.symbol!, pips) });
      await ctx.reply("Введите SL и TP первых trades в pips. Например: 10 200"); return;
    }
    if (session.state === "ENTER_MULTI_FIRST_STOPS") {
      const pair = this.parsePipPair(ctx.message.text);
      if (!pair) return void await ctx.reply("Введите два целых числа: SL TP");
      await this.sessions.set(user.id, "ENTER_MULTI_NEXT_STEP", { ...draft,
        stopLossPoints: this.pipsToPoints(draft.symbol!, pair[0]), takeProfitPoints: this.pipsToPoints(draft.symbol!, pair[1]) });
      await ctx.reply("Введите шаг между следующими уровнями в pips. Например: 10"); return;
    }
    if (session.state === "ENTER_MULTI_NEXT_STEP") {
      const pips = this.parsePositiveInteger(ctx.message.text);
      if (!pips) return void await ctx.reply("Введите целое положительное число pips.");
      await this.sessions.set(user.id, "ENTER_MULTI_NEXT_STOPS", { ...draft, multiNextStepPoints: this.pipsToPoints(draft.symbol!, pips) });
      await ctx.reply("Введите SL следующих trades и шаг увеличения TP в pips. Например: 10 100"); return;
    }
    if (session.state === "ENTER_MULTI_NEXT_STOPS") {
      const pair = this.parsePipPair(ctx.message.text);
      if (!pair) return void await ctx.reply("Введите два целых числа: SL TP");
      const completeDraft = { ...draft, multiNextSlPoints: this.pipsToPoints(draft.symbol!, pair[0]), multiNextTpPoints: this.pipsToPoints(draft.symbol!, pair[1]) };
      await this.sessions.set(user.id, "CONFIRM", completeDraft);
      const n = completeDraft.multiTradesPerSide!;
      const volumeText = completeDraft.riskMode === RiskModeDto.RISK_PERCENT
        ? `Risk: ${completeDraft.riskPercent}% на корзину`
        : `Lot каждого: ${completeDraft.fixedLot}; общий объём: ${(n * 2 * completeDraft.fixedLot!).toFixed(2)} lot`;
      await ctx.reply(["Проверьте MULTI-задание:", `Символ: ${completeDraft.symbol}`, volumeText,
        `Ордеров: ${n} BUY + ${n} SELL = ${n * 2}`,
        `Первый entry/SL/TP: ${this.pointsToPips(completeDraft.symbol!, completeDraft.entryDistancePoints!)}/${this.pointsToPips(completeDraft.symbol!, completeDraft.stopLossPoints!)}/${this.pointsToPips(completeDraft.symbol!, completeDraft.takeProfitPoints!)} pips`,
        `Следующие entry step/SL/TP step: ${this.pointsToPips(completeDraft.symbol!, completeDraft.multiNextStepPoints!)}/${pair[0]}/${pair[1]} pips`,
        `TP по уровням: ${Array.from({ length: n }, (_, index) => this.pointsToPips(completeDraft.symbol!, completeDraft.takeProfitPoints!) + index * pair[1]).join(" / ")} pips`,
        "BUY и SELL независимы: противоположные ордера не отменяются."].join("\n"), { reply_markup: new InlineKeyboard().text("Подтвердить", "confirm_trade").text("Отмена", "cancel_trade") });
      return;
    }

    if (session.state === "ENTER_STOPS") {
      const match = ctx.message.text.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) {
        await ctx.reply("Введите два целых числа через пробел. Например: 200 300");
        return;
      }
      const stopLossPoints = this.pipsToPoints(draft.symbol!, Number(match[1]));
      const takeProfitPoints = this.pipsToPoints(draft.symbol!, Number(match[2]));
      if (
        stopLossPoints < 1 ||
        stopLossPoints > 1_000_000 ||
        takeProfitPoints < 1 ||
        takeProfitPoints > 1_000_000
      ) {
        await ctx.reply("SL/TP должны быть от 1 до 1 000 000 points.");
        return;
      }

      const riskMode = draft.riskMode ?? RiskModeDto.FIXED_LOT;
      const completeDraft: TradeDraft = {
        ...draft,
        stopLossPoints,
        takeProfitPoints,
        riskMode,
        fixedLot: draft.fixedLot ?? Number(user.settings.defaultFixedLot),
        riskPercent: Number(user.settings.defaultRiskPercent),
      };
      await this.sessions.set(user.id, "CONFIRM", completeDraft);
      const riskText =
        riskMode === RiskModeDto.FIXED_LOT
          ? `${completeDraft.fixedLot} lot`
          : `${completeDraft.riskPercent}% equity`;
      await ctx.reply(
        [
          "Проверьте задание:",
          `Новость: ${completeDraft.eventTitle ?? "Тестовое задание"}`,
          `Время Ашхабад: ${this.formatAshgabatTime(new Date(completeDraft.executeAt!))}`,
          `Символ: ${completeDraft.symbol}`,
          `Режим: ${completeDraft.executionMode === ExecutionModeDto.STRADDLE ? "STRADDLE OCO" : `MARKET ${completeDraft.direction}`}`,
          ...(completeDraft.executionMode === ExecutionModeDto.STRADDLE
            ? [`Расстояние входа: ${completeDraft.entryDistancePoints} points`, `Удаление pending: T+${completeDraft.pendingExpirySeconds} сек.`]
            : []),
          `Риск: ${riskText}`,
          `SL/TP: ${match[1]}/${match[2]} pips`,
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard()
            .text("Подтвердить", "confirm_trade")
            .text("Отмена", "cancel_trade"),
        },
      );
    }
  }

  private mainMenu(): InlineKeyboard {
    return new InlineKeyboard()
      .text("Подключить MT5", "connect")
      .text("Подключить cTrader", "connect_ctrader")
      .row()
      .text("Новости", "news")
      .text("Тест +1 мин", "test_trade")
      .row()
      .text("Задания", "jobs")
      .text("Статус", "status")
      .text("Настройки", "settings");
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Операция не выполнена";
  }

  private formatAshgabatTime(value: Date): string {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Asia/Ashgabat",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(value);
  }

  private pipsToPoints(symbol: string, pips: number): number {
    return Math.round(pips * (symbol.toUpperCase().includes("XAU") ? 10 : 10));
  }

  private pointsToPips(symbol: string, points: number): number {
    return points / (symbol.toUpperCase().includes("XAU") ? 10 : 10);
  }

  private parsePositiveInteger(value: string): number | null {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100_000 ? parsed : null;
  }

  private parsePipPair(value: string): [number, number] | null {
    const match = value.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) return null;
    const first = this.parsePositiveInteger(match[1]); const second = this.parsePositiveInteger(match[2]);
    return first && second ? [first, second] : null;
  }

  private parseAshgabatDateTime(value: string): Date | null {
    const raw = value.trim();
    const full = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    const timeOnly = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    let year: number; let month: number; let day: number; let hour: number; let minute: number; let second: number;
    if (full) {
      day = Number(full[1]); month = Number(full[2]); year = Number(full[3]);
      hour = Number(full[4]); minute = Number(full[5]); second = Number(full[6] ?? 0);
    } else if (timeOnly) {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ashgabat", year: "numeric", month: "numeric", day: "numeric" })
        .formatToParts(new Date()).reduce<Record<string, number>>((result, part) => {
          if (["year", "month", "day"].includes(part.type)) result[part.type] = Number(part.value);
          return result;
        }, {});
      year = parts.year; month = parts.month; day = parts.day;
      hour = Number(timeOnly[1]); minute = Number(timeOnly[2]); second = Number(timeOnly[3] ?? 0);
    } else return null;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    const result = new Date(Date.UTC(year, month - 1, day, hour - 5, minute, second));
    const verify = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ashgabat", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(result);
    const expected = `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
    return verify === expected ? result : null;
  }

  private mt5AccountLabel(account: { login: bigint; server: string; environment: string; lastSeenAt: Date | null }): string {
    const active = account.lastSeenAt && Date.now() - account.lastSeenAt.getTime() < 60_000;
    return `${active ? "🟢" : "⚪"} MT5 · ${account.login.toString()} · ${account.server} · ${account.environment}`;
  }
}
