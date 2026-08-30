import { Controller, Get, Query, Res } from "@nestjs/common";
import { CTraderService } from "./ctrader.service";

interface HtmlResponse {
  status(code: number): HtmlResponse;
  type(contentType: string): HtmlResponse;
  send(body: string): void;
}

@Controller("v1/ctrader")
export class CTraderController {
  constructor(private readonly cTrader: CTraderService) {}

  @Get("oauth/callback")
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() response: HtmlResponse,
  ): Promise<void> {
    try {
      const accounts = await this.cTrader.completeAuthorization(code, state);
      response.type("html").send(this.page("cTrader подключён", `Найдено счетов: ${accounts}. Вернитесь в Telegram.`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось подключить cTrader";
      response.status(400).type("html").send(this.page("Ошибка подключения", message));
    }
  }

  private page(title: string, message: string): string {
    const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;",
    })[character] ?? character);
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><body style="font-family:system-ui;max-width:600px;margin:15vh auto;padding:24px"><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
  }
}
