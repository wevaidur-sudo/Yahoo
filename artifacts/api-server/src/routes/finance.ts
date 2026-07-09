import { Router, type IRouter } from "express";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import YahooFinance from "yahoo-finance2";

// yahoo-finance2 v3 requires instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinance as any)({
  suppressNotices: ["yahooSurvey"],
});
import {
  SearchSymbolsResponse,
  SearchSymbolsQueryParams,
  GetQuoteParams,
  GetQuoteResponse,
  GetPriceHistoryParams,
  GetPriceHistoryResponse,
  GetNewsParams,
  GetNewsResponse,
  GetCompanySummaryParams,
  GetCompanySummaryResponse,
  GetTrendingResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /finance/search?q=...
router.get("/finance/search", async (req, res): Promise<void> => {
  const parsed = SearchSymbolsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { q } = parsed.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any = await (yahooFinance as any).search(q, {
      newsCount: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const quotes: any[] = results.quotes || [];

    const data = quotes
      .filter((item: any) => item.symbol)
      .map((item: any) => ({
        symbol: item.symbol,
        name: item.shortname || item.longname || item.symbol,
        exchange: item.exchange || "N/A",
        type: item.quoteType || "EQUITY",
        score: item.score ?? null,
      }));

    res.json(SearchSymbolsResponse.parse(data));
  } catch (err) {
    req.log.error({ err }, "Search error");
    res.status(500).json({ error: "Failed to search symbols" });
  }
});

// GET /finance/quote/:symbol
router.get("/finance/quote/:symbol", async (req, res): Promise<void> => {
  const params = GetQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { symbol } = params.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = await (yahooFinance as any).quote(symbol);

    if (!q) {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    const data = {
      symbol: q.symbol,
      name: q.displayName || q.shortName || q.longName || symbol,
      price: q.regularMarketPrice ?? null,
      open: q.regularMarketOpen ?? null,
      high: q.regularMarketDayHigh ?? null,
      low: q.regularMarketDayLow ?? null,
      previousClose: q.regularMarketPreviousClose ?? null,
      change: q.regularMarketChange ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      volume: q.regularMarketVolume ?? null,
      avgVolume: q.averageDailyVolume10Day ?? null,
      marketCap: q.marketCap ?? null,
      peRatio: q.trailingPE ?? null,
      eps: q.epsTrailingTwelveMonths ?? null,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
      currency: q.currency ?? null,
      exchange: q.fullExchangeName ?? q.exchange ?? null,
      marketState: q.marketState ?? null,
      postMarketPrice: q.postMarketPrice ?? null,
      postMarketChange: q.postMarketChange ?? null,
      postMarketChangePercent: q.postMarketChangePercent ?? null,
      postMarketTime: q.postMarketTime instanceof Date ? q.postMarketTime.toISOString() : null,
      preMarketPrice: q.preMarketPrice ?? null,
      preMarketChange: q.preMarketChange ?? null,
      preMarketChangePercent: q.preMarketChangePercent ?? null,
      preMarketTime: q.preMarketTime instanceof Date ? q.preMarketTime.toISOString() : null,
    };

    res.json(GetQuoteResponse.parse(data));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, symbol }, "Quote error");
    if (msg.includes("No fundamentals data")) {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
    } else {
      res.status(500).json({ error: "Failed to fetch quote" });
    }
  }
});

// GET /finance/history/:symbol/:period
router.get(
  "/finance/history/:symbol/:period",
  async (req, res): Promise<void> => {
    const params = GetPriceHistoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const { symbol, period } = params.data;

    const intervalMap: Record<string, "1d" | "1wk" | "1mo"> = {
      "1d": "1d",
      "5d": "1d",
      "1mo": "1d",
      "3mo": "1d",
      "6mo": "1d",
      "1y": "1d",
      "2y": "1wk",
      "5y": "1wk",
      "10y": "1mo",
      ytd: "1d",
      max: "1mo",
    };

    const interval: "1d" | "1wk" | "1mo" = intervalMap[period] ?? "1d";

    const now = new Date();
    const startMap: Record<string, Date> = {
      "1d": new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      "5d": new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
      "1mo": new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      "3mo": new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
      "6mo": new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000),
      "1y": new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
      "2y": new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000),
      "5y": new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000),
      "10y": new Date(now.getTime() - 10 * 365 * 24 * 60 * 60 * 1000),
      ytd: new Date(now.getFullYear(), 0, 1),
      max: new Date("1970-01-01"),
    };

    const startDate = startMap[period] ?? startMap["1mo"];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await (yahooFinance as any).chart(symbol, {
        period1: startDate,
        period2: now,
        interval,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quotes: any[] = result?.quotes || [];

      const data = quotes
        .filter((item: any) => item.date != null)
        .map((item: any) => ({
          date:
            item.date instanceof Date
              ? item.date.toISOString()
              : String(item.date),
          open: item.open ?? null,
          high: item.high ?? null,
          low: item.low ?? null,
          close: item.close ?? null,
          volume: item.volume ?? null,
          adjClose: item.adjclose ?? null,
        }));

      res.json(GetPriceHistoryResponse.parse(data));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err, symbol, period }, "History error");
      if (msg.includes("No fundamentals data")) {
        res.status(404).json({ error: `Symbol not found: ${symbol}` });
      } else {
        res.status(500).json({ error: "Failed to fetch price history" });
      }
    }
  },
);

// GET /finance/news/:symbol
router.get("/finance/news/:symbol", async (req, res): Promise<void> => {
  const params = GetNewsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { symbol } = params.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await (yahooFinance as any).search(symbol, {
      newsCount: 20,
      quotesCount: 0,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const news: any[] = result?.news || [];

    const data = news.map((article: any) => ({
      title: article.title || "Untitled",
      publisher: article.publisher ?? null,
      link: article.link || "#",
      publishedAt: article.providerPublishTime
        ? new Date(article.providerPublishTime).toISOString()
        : null,
      thumbnail: article.thumbnail?.resolutions?.[0]?.url ?? null,
      summary: null,
    }));

    res.json(GetNewsResponse.parse(data));
  } catch (err) {
    req.log.error({ err, symbol }, "News error");
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

// GET /finance/summary/:symbol
router.get("/finance/summary/:symbol", async (req, res): Promise<void> => {
  const params = GetCompanySummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { symbol } = params.data;

  try {
    const [quoteSummary, q] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).quoteSummary(symbol, {
        modules: [
          "assetProfile",
          "defaultKeyStatistics",
          "financialData",
          "summaryDetail",
        ],
      }) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).quote(symbol) as Promise<any>,
    ]);

    const profile = quoteSummary?.assetProfile;
    const stats = quoteSummary?.defaultKeyStatistics;
    const financial = quoteSummary?.financialData;
    const summaryDetail = quoteSummary?.summaryDetail;

    const data = {
      symbol,
      name: q?.displayName || q?.shortName || q?.longName || symbol,
      description: profile?.longBusinessSummary ?? null,
      sector: profile?.sector ?? null,
      industry: profile?.industry ?? null,
      website: profile?.website ?? null,
      employees: profile?.fullTimeEmployees ?? null,
      country: profile?.country ?? null,
      city: profile?.city ?? null,
      marketCap: q?.marketCap ?? null,
      enterpriseValue: stats?.enterpriseValue ?? null,
      trailingPE: summaryDetail?.trailingPE ?? null,
      forwardPE: summaryDetail?.forwardPE ?? null,
      priceToBook: stats?.priceToBook ?? null,
      profitMargins: financial?.profitMargins ?? null,
      returnOnEquity: financial?.returnOnEquity ?? null,
      revenueGrowth: financial?.revenueGrowth ?? null,
      totalRevenue: financial?.totalRevenue ?? null,
      grossProfit: financial?.grossProfits ?? null,
      totalDebt: financial?.totalDebt ?? null,
      totalCash: financial?.totalCash ?? null,
      dividendYield: summaryDetail?.dividendYield ?? null,
      beta: summaryDetail?.beta ?? null,
    };

    res.json(GetCompanySummaryResponse.parse(data));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, symbol }, "Summary error");
    if (msg.includes("No fundamentals data")) {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
    } else {
      res.status(500).json({ error: "Failed to fetch company summary" });
    }
  }
});

// GET /finance/trending
router.get("/finance/trending", async (_req, res): Promise<void> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trending: any = await (yahooFinance as any).trendingSymbols("US", {
      count: 20,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const symbols: string[] = (trending?.quotes || [])
      .map((item: any) => item.symbol)
      .filter(Boolean)
      .slice(0, 12);

    if (symbols.length === 0) {
      res.json(GetTrendingResponse.parse([]));
      return;
    }

    const quoteResults = await Promise.allSettled(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      symbols.map((sym) => (yahooFinance as any).quote(sym) as Promise<any>),
    );

    const data = quoteResults
      .filter(
        (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled",
      )
      .map((r: PromiseFulfilledResult<any>) => {
        const item = r.value;
        return {
          symbol: item.symbol,
          name: item.displayName || item.shortName || item.longName || item.symbol,
          price: item.regularMarketPrice ?? null,
          change: item.regularMarketChange ?? null,
          changePercent: item.regularMarketChangePercent ?? null,
          volume: item.regularMarketVolume ?? null,
          marketCap: item.marketCap ?? null,
        };
      });

    res.json(GetTrendingResponse.parse(data));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch trending symbols" });
  }
});

export default router;
