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
  GetDelistedLookupParams,
  GetDelistedLookupResponse,
} from "@workspace/api-zod";
import { tiingo } from "../lib/tiingo";

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

    const data: unknown[] = quotes
      .filter((item: any) => item.symbol)
      .map((item: any) => ({
        symbol: item.symbol,
        name: item.shortname || item.longname || item.symbol,
        exchange: item.exchange || "N/A",
        type: item.quoteType || "EQUITY",
        score: item.score ?? null,
        source: "yahoo",
      }));

    // Yahoo drops delisted tickers entirely. If nothing came back and the
    // query looks like a bare ticker symbol, try resolving it via Tiingo so
    // users can still find historically delisted stocks.
    if (data.length === 0 && tiingo.isConfigured() && /^[A-Za-z.\-]{1,10}$/.test(q)) {
      try {
        const meta = await tiingo.getMeta(q);
        if (meta) {
          data.push({
            symbol: meta.ticker,
            name: meta.name || meta.ticker,
            exchange: meta.exchangeCode || "N/A",
            type: "EQUITY",
            score: null,
            source: "tiingo",
            delisted: tiingo.isDelisted(meta),
          });
        }
      } catch (err) {
        req.log.error({ err, q }, "Tiingo search fallback error");
      }
    }

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
    const now = new Date();
    // Fetch quote (metadata) and chart (real-time candles) in parallel.
    // chart() uses Yahoo's v8 endpoint which is not served from the same
    // CDN cache as v7/quote — this is how we get live extended-hours prices.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [q, chartResult]: [any, any] = await Promise.all([
      (yahooFinance as any).quote(symbol),
      (yahooFinance as any).chart(symbol, {
        period1: new Date(now.getTime() - 12 * 60 * 60 * 1000), // last 12 h covers any session
        period2: now,
        interval: "1m",
        // includePrePost is true by default in yahoo-finance2
      }, {
        fetchOptions: {
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        },
      }),
    ]);

    if (!q) {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    // ── Derive real-time extended-hours price from chart candles ────────────
    // The chart quotes array contains 1-minute candles for pre + regular + post
    // market.  We walk backwards to find the latest non-null close, then check
    // whether it falls inside today's pre- or post-market session window.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chartQuotes: any[] = chartResult?.quotes ?? [];
    const meta = chartResult?.meta ?? {};

    // Today's pre-market session window (Date objects from yahoo-finance2)
    const preStart: Date | null = meta?.currentTradingPeriod?.pre?.start ?? null;
    const preEnd: Date | null   = meta?.currentTradingPeriod?.pre?.end   ?? null;

    // Timestamp of the last regular-market trade — anything AFTER this is extended hours.
    // This works across session boundaries: yesterday's post-market candles are after
    // yesterday's regularMarketTime; today's pre-market candles are also after it.
    const regularMarketTime: Date | null = meta?.regularMarketTime instanceof Date
      ? meta.regularMarketTime
      : (meta?.regularMarketTime ? new Date(meta.regularMarketTime) : null);

    // Last candle with a valid close
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastCandle: any = null;
    for (let i = chartQuotes.length - 1; i >= 0; i--) {
      if (chartQuotes[i]?.close != null) { lastCandle = chartQuotes[i]; break; }
    }

    // Helper: is a Date within [start, end)?
    const inWindow = (d: Date, s: Date | null, e: Date | null) =>
      !!(s && e && d >= s && d < e);

    let preMarketPrice: number | null = null;
    let preMarketChange: number | null = null;
    let preMarketChangePercent: number | null = null;
    let preMarketTime: string | null = null;
    let postMarketPrice: number | null = null;
    let postMarketChange: number | null = null;
    let postMarketChangePercent: number | null = null;
    let postMarketTime: string | null = null;

    // Use the chart's regularMarketPrice as the base for change calculations
    // (it equals the most recent regular-session close price)
    const regularClose: number = meta?.regularMarketPrice ?? q.regularMarketPrice ?? 0;

    if (lastCandle) {
      const candleDate: Date = lastCandle.date instanceof Date
        ? lastCandle.date
        : new Date(lastCandle.date);
      const close: number = Math.round(lastCandle.close * 10000) / 10000;
      const change = Math.round((close - regularClose) * 10000) / 10000;
      const changePct = regularClose !== 0
        ? Math.round(((change / regularClose) * 100) * 10000) / 10000
        : 0;
      const iso = candleDate.toISOString();

      // Is this candle from an extended-hours session?
      // It qualifies if it's after the last regular-market close.
      const isExtended = regularMarketTime ? candleDate > regularMarketTime : false;

      if (isExtended) {
        if (inWindow(candleDate, preStart, preEnd)) {
          // Candle falls in today's pre-market window
          preMarketPrice = close;
          preMarketChange = change;
          preMarketChangePercent = changePct;
          preMarketTime = iso;
        } else {
          // After regular close but not in pre-market → post-market
          // (covers both yesterday's post-market and today's post-market)
          postMarketPrice = close;
          postMarketChange = change;
          postMarketChangePercent = changePct;
          postMarketTime = iso;
        }
      }
    }

    // Fall back to quote() extended values only if chart gave us nothing
    // (e.g. weekend, holiday, or very new symbol with no intraday data)
    if (preMarketPrice == null && q.preMarketPrice != null) {
      preMarketPrice = q.preMarketPrice;
      preMarketChange = q.preMarketChange ?? null;
      preMarketChangePercent = q.preMarketChangePercent ?? null;
      preMarketTime = q.preMarketTime instanceof Date ? q.preMarketTime.toISOString() : null;
    }
    if (postMarketPrice == null && q.postMarketPrice != null) {
      postMarketPrice = q.postMarketPrice;
      postMarketChange = q.postMarketChange ?? null;
      postMarketChangePercent = q.postMarketChangePercent ?? null;
      postMarketTime = q.postMarketTime instanceof Date ? q.postMarketTime.toISOString() : null;
    }
    // ────────────────────────────────────────────────────────────────────────

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
      postMarketPrice,
      postMarketChange,
      postMarketChangePercent,
      postMarketTime,
      preMarketPrice,
      preMarketChange,
      preMarketChangePercent,
      preMarketTime,
      source: "yahoo",
    };

    res.json(GetQuoteResponse.parse(data));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const notFound = msg.includes("No fundamentals data") || msg.includes("symbol may be delisted");

    if (notFound && tiingo.isConfigured()) {
      try {
        const tiingoQuote = await tryTiingoQuote(symbol);
        if (tiingoQuote) {
          res.json(GetQuoteResponse.parse(tiingoQuote));
          return;
        }
      } catch (tiingoErr) {
        req.log.error({ err: tiingoErr, symbol }, "Tiingo quote fallback error");
      }
    }

    req.log.error({ err, symbol }, "Quote error");
    if (notFound) {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
    } else {
      res.status(500).json({ error: "Failed to fetch quote" });
    }
  }
});

// Builds a minimal StockQuote from Tiingo metadata + latest EOD price, for
// symbols Yahoo no longer serves (delisted tickers).
async function tryTiingoQuote(symbol: string) {
  const meta = await tiingo.getMeta(symbol);
  if (!meta) return null;

  const prices = await tiingo.getPrices(symbol);
  const last = prices[prices.length - 1] ?? null;
  const prev = prices[prices.length - 2] ?? null;

  const price = last?.close ?? null;
  const previousClose = prev?.close ?? null;
  const change = price != null && previousClose != null ? Math.round((price - previousClose) * 10000) / 10000 : null;
  const changePercent =
    change != null && previousClose ? Math.round(((change / previousClose) * 100) * 10000) / 10000 : null;

  return {
    symbol: meta.ticker,
    name: meta.name || meta.ticker,
    price,
    open: last?.open ?? null,
    high: last?.high ?? null,
    low: last?.low ?? null,
    previousClose,
    change,
    changePercent,
    volume: last?.volume ?? null,
    avgVolume: null,
    marketCap: null,
    peRatio: null,
    eps: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    currency: "USD",
    exchange: meta.exchangeCode ?? null,
    marketState: "CLOSED",
    postMarketPrice: null,
    postMarketChange: null,
    postMarketChangePercent: null,
    postMarketTime: null,
    preMarketPrice: null,
    preMarketChange: null,
    preMarketChangePercent: null,
    preMarketTime: null,
    source: "tiingo",
    delisted: tiingo.isDelisted(meta),
  };
}

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
      const notFound = msg.includes("No fundamentals data") || msg.includes("symbol may be delisted");

      if (notFound && tiingo.isConfigured()) {
        try {
          const rows = await tiingo.getPrices(symbol, { startDate });
          if (rows.length > 0) {
            const data = rows.map((row) => ({
              date: new Date(row.date).toISOString(),
              open: row.open,
              high: row.high,
              low: row.low,
              close: row.close,
              volume: row.volume,
              adjClose: row.adjClose,
            }));
            res.json(GetPriceHistoryResponse.parse(data));
            return;
          }
        } catch (tiingoErr) {
          req.log.error({ err: tiingoErr, symbol, period }, "Tiingo history fallback error");
        }
      }

      req.log.error({ err, symbol, period }, "History error");
      if (notFound) {
        res.status(404).json({ error: `Symbol not found: ${symbol}` });
      } else {
        res.status(500).json({ error: "Failed to fetch price history" });
      }
    }
  },
);

// GET /finance/delisted/:symbol — Tiingo-backed lookup for symbols no longer
// served by Yahoo Finance.
router.get("/finance/delisted/:symbol", async (req, res): Promise<void> => {
  const params = GetDelistedLookupParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { symbol } = params.data;

  if (!tiingo.isConfigured()) {
    res.status(404).json({ error: "Delisted-stock lookup is not configured" });
    return;
  }

  try {
    const meta = await tiingo.getMeta(symbol);
    if (!meta) {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    const data = {
      symbol: meta.ticker,
      name: meta.name || meta.ticker,
      exchange: meta.exchangeCode ?? null,
      startDate: meta.startDate ?? null,
      endDate: meta.endDate ?? null,
      delisted: tiingo.isDelisted(meta),
    };

    res.json(GetDelistedLookupResponse.parse(data));
  } catch (err) {
    req.log.error({ err, symbol }, "Delisted lookup error");
    res.status(500).json({ error: "Failed to look up symbol" });
  }
});

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
