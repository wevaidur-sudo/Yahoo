import { useState } from "react";
import {
  useGetStockAnalysis,
  getGetStockAnalysisQueryKey,
} from "@workspace/api-client-react";
import { formatCurrency, cn } from "@/lib/utils";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Brain,
  Target,
  Activity,
  ChevronDown,
  ChevronUp,
  Zap,
  AlertTriangle,
  DollarSign,
  Loader2,
} from "lucide-react";

interface Props {
  symbol: string;
}

const DIRECTION_CONFIG = {
  bullish: {
    label: "Bullish",
    color: "text-[#00C853]",
    bg: "bg-[#00C853]/10 border-[#00C853]/30",
    icon: TrendingUp,
    glow: "shadow-[0_0_30px_rgba(0,200,83,0.15)]",
  },
  bearish: {
    label: "Bearish",
    color: "text-[#FF333A]",
    bg: "bg-[#FF333A]/10 border-[#FF333A]/30",
    icon: TrendingDown,
    glow: "shadow-[0_0_30px_rgba(255,51,58,0.15)]",
  },
  neutral: {
    label: "Neutral",
    color: "text-yellow-400",
    bg: "bg-yellow-400/10 border-yellow-400/30",
    icon: Minus,
    glow: "shadow-[0_0_30px_rgba(250,204,21,0.1)]",
  },
};

const RISK_CONFIG = {
  low: { color: "text-[#00C853]", bg: "bg-[#00C853]/10 border-[#00C853]/20" },
  medium: { color: "text-yellow-400", bg: "bg-yellow-400/10 border-yellow-400/20" },
  high: { color: "text-[#FF333A]", bg: "bg-[#FF333A]/10 border-[#FF333A]/20" },
};

function StatPill({ label, value, highlight }: { label: string; value: string | number | null; highlight?: "up" | "down" | "neutral" }) {
  const colorClass =
    highlight === "up"
      ? "text-[#00C853]"
      : highlight === "down"
        ? "text-[#FF333A]"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-1 bg-background rounded-lg border border-border p-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", colorClass)}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 70 ? "#00C853" : value >= 50 ? "#f59e0b" : "#FF333A";
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-1000"
          style={{ width: `${value}%`, backgroundColor: color }}
        />
      </div>
      <span className="font-mono text-sm font-bold" style={{ color }}>
        {value}%
      </span>
    </div>
  );
}

function OptionsStrategyPanel({ symbol }: { symbol: string }) {
  const [amount, setAmount] = useState("");
  const [strategy, setStrategy] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    const num = parseFloat(amount);
    if (!num || num <= 0) return;
    setLoading(true);
    setError(null);
    setStrategy(null);
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const resp = await fetch(`${base}/api/finance/options-strategy/${symbol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ investmentAmount: num }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Failed to generate strategy");
      }
      setStrategy(await resp.json());
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
          <DollarSign className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="font-display font-semibold text-lg">Options Strategy Generator</h3>
          <p className="text-xs text-muted-foreground">Enter your capital — AI designs the highest-probability strategy</p>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">$</span>
          <input
            type="number"
            min="1"
            placeholder="e.g. 5000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generate()}
            className="w-full bg-background border border-border rounded-lg pl-7 pr-4 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-all"
          />
        </div>
        <button
          onClick={generate}
          disabled={loading || !amount}
          className="px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {loading ? "Analyzing…" : "Generate"}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {strategy && (
        <div className="space-y-5 pt-2 border-t border-border/50">
          {/* Strategy Header */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-xl font-display font-bold">{strategy.strategyName}</h4>
              <div className="flex items-center gap-2 mt-1.5">
                <span className={cn(
                  "text-xs font-semibold px-2 py-0.5 rounded-md border",
                  DIRECTION_CONFIG[strategy.strategyType as keyof typeof DIRECTION_CONFIG]?.bg,
                  DIRECTION_CONFIG[strategy.strategyType as keyof typeof DIRECTION_CONFIG]?.color,
                )}>
                  {strategy.strategyType?.toUpperCase()}
                </span>
                <span className={cn(
                  "text-xs font-semibold px-2 py-0.5 rounded-md border",
                  RISK_CONFIG[strategy.riskLevel as keyof typeof RISK_CONFIG]?.bg,
                  RISK_CONFIG[strategy.riskLevel as keyof typeof RISK_CONFIG]?.color,
                )}>
                  {strategy.riskLevel?.toUpperCase()} RISK
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground mb-1">Profit Probability</div>
              <div className="font-mono text-2xl font-bold text-[#00C853]">{strategy.probability}%</div>
            </div>
          </div>

          {/* P&L Summary */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatPill label="Total Cost" value={strategy.totalCost ? `$${strategy.totalCost.toLocaleString()}` : "N/A"} />
            <StatPill label="Max Profit" value={strategy.maxProfit} highlight="up" />
            <StatPill label="Max Loss" value={strategy.maxLoss} highlight="down" />
            <StatPill label="Breakeven" value={strategy.breakeven} />
          </div>

          {/* Legs */}
          {strategy.legs?.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Strategy Legs</h5>
              <div className="space-y-2">
                {strategy.legs.map((leg: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 bg-background border border-border rounded-lg px-4 py-2.5">
                    <span className={cn(
                      "text-xs font-bold px-2 py-0.5 rounded",
                      leg.action === "buy" ? "bg-[#00C853]/10 text-[#00C853]" : "bg-[#FF333A]/10 text-[#FF333A]"
                    )}>
                      {leg.action?.toUpperCase()}
                    </span>
                    <span className="font-mono text-sm font-semibold">
                      {leg.contracts}x {leg.type?.toUpperCase()}
                      {leg.strike ? ` $${leg.strike}` : ""}
                    </span>
                    {leg.expiry && (
                      <span className="text-xs text-muted-foreground ml-auto">exp {leg.expiry}</span>
                    )}
                    {leg.premium != null && (
                      <span className="font-mono text-sm text-muted-foreground">@${leg.premium.toFixed(2)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reasoning */}
          <div className="space-y-3">
            <div className="bg-background border border-border rounded-lg p-4">
              <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">AI Reasoning</h5>
              <p className="text-sm leading-relaxed text-muted-foreground">{strategy.reasoning}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-background border border-border rounded-lg p-4">
                <h5 className="text-xs font-semibold uppercase tracking-wider text-[#00C853] mb-2">Entry Timing</h5>
                <p className="text-sm leading-relaxed text-muted-foreground">{strategy.entryTiming}</p>
              </div>
              <div className="bg-background border border-border rounded-lg p-4">
                <h5 className="text-xs font-semibold uppercase tracking-wider text-[#FF333A] mb-2">Exit Strategy</h5>
                <p className="text-sm leading-relaxed text-muted-foreground">{strategy.exitStrategy}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AIAnalysisTab({ symbol }: Props) {
  const { data: analysis, isLoading, isError, refetch } = useGetStockAnalysis(symbol, {
    query: {
      enabled: !!symbol,
      queryKey: getGetStockAnalysisQueryKey(symbol),
      staleTime: 5 * 60 * 1000, // 5 min — AI calls are expensive
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-card border border-card-border rounded-2xl p-8 animate-pulse">
            <div className="h-6 w-48 bg-muted/40 rounded mb-4" />
            <div className="h-4 w-full bg-muted/30 rounded mb-2" />
            <div className="h-4 w-3/4 bg-muted/30 rounded" />
          </div>
        ))}
        <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm pt-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Analyzing {symbol} with AI — this takes ~10 seconds…
        </div>
      </div>
    );
  }

  if (isError || !analysis) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <AlertTriangle className="w-10 h-10 text-destructive/70" />
        <div>
          <p className="font-semibold">Analysis failed</p>
          <p className="text-sm text-muted-foreground mt-1">Could not generate AI analysis for {symbol}</p>
        </div>
        <button
          onClick={() => refetch()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-all"
        >
          Retry
        </button>
      </div>
    );
  }

  const trend = analysis.trend;
  const intraday = analysis.intraday;
  const tech = analysis.technicalIndicators;
  const opts = analysis.optionsSnapshot;

  const trendCfg = DIRECTION_CONFIG[trend.direction as keyof typeof DIRECTION_CONFIG] ?? DIRECTION_CONFIG.neutral;
  const TrendIcon = trendCfg.icon;

  const intradayCfg = DIRECTION_CONFIG[intraday.bias as keyof typeof DIRECTION_CONFIG] ?? DIRECTION_CONFIG.neutral;
  const IntradayIcon = intradayCfg.icon;

  const rsiColor =
    tech.rsi !== null && tech.rsi !== undefined
      ? tech.rsi > 70
        ? "text-[#FF333A]"
        : tech.rsi < 30
          ? "text-[#00C853]"
          : "text-foreground"
      : "text-foreground";

  return (
    <div className="space-y-6">
      {/* ── Trend Prediction ────────────────────────────────────── */}
      <div className={cn("bg-card border rounded-2xl p-6 md:p-8 shadow-sm", trendCfg.glow, trendCfg.bg.split(" ")[1])}>
        <div className="flex items-center gap-2 mb-6">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-display font-semibold">Trend Prediction</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            {new Date(analysis.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        <div className="flex flex-col md:flex-row gap-8">
          {/* Direction badge */}
          <div className={cn("flex flex-col items-center justify-center rounded-2xl border p-6 md:p-8 min-w-[160px]", trendCfg.bg)}>
            <TrendIcon className={cn("w-10 h-10 mb-3", trendCfg.color)} />
            <span className={cn("text-2xl font-display font-bold", trendCfg.color)}>
              {trendCfg.label}
            </span>
            <span className="text-xs text-muted-foreground mt-1">Overall Trend</span>
          </div>

          <div className="flex-1 space-y-4">
            {/* Confidence */}
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                <span className="font-semibold uppercase tracking-wider">AI Confidence</span>
              </div>
              <ConfidenceBar value={trend.confidence} />
            </div>

            {/* Summary */}
            <p className="text-base font-semibold leading-snug">{trend.summary}</p>
            <p className="text-sm text-muted-foreground leading-relaxed">{trend.reasoning}</p>

            {/* Price Targets */}
            {trend.priceTargets && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
                <StatPill label="Support" value={trend.priceTargets.support ? `$${trend.priceTargets.support.toFixed(2)}` : null} highlight="up" />
                <StatPill label="Resistance" value={trend.priceTargets.resistance ? `$${trend.priceTargets.resistance.toFixed(2)}` : null} highlight="down" />
                <StatPill label="1W Target" value={trend.priceTargets.oneWeek ? `$${trend.priceTargets.oneWeek.toFixed(2)}` : null} />
                <StatPill label="1M Target" value={trend.priceTargets.oneMonth ? `$${trend.priceTargets.oneMonth.toFixed(2)}` : null} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Intraday Analysis ────────────────────────────────────── */}
      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-display font-semibold">Intraday Analysis</h2>
          {intraday.topPick && (
            <span className="ml-auto flex items-center gap-1.5 bg-primary/10 border border-primary/30 text-primary text-xs font-bold px-3 py-1 rounded-full">
              <Zap className="w-3 h-3" /> TODAY'S TOP PICK
            </span>
          )}
        </div>

        <div className="flex flex-col md:flex-row gap-6">
          <div className={cn("flex flex-col items-center justify-center rounded-xl border p-5 min-w-[130px]", intradayCfg.bg)}>
            <IntradayIcon className={cn("w-7 h-7 mb-2", intradayCfg.color)} />
            <span className={cn("text-lg font-bold font-display", intradayCfg.color)}>
              {intradayCfg.label}
            </span>
            <span className="text-xs text-muted-foreground mt-0.5">Intraday Bias</span>
          </div>

          <div className="flex-1 space-y-4">
            {intraday.topPickReason && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <Zap className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                <p className="text-sm font-medium text-primary">{intraday.topPickReason}</p>
              </div>
            )}
            <p className="text-sm text-muted-foreground leading-relaxed">{intraday.setup}</p>

            {/* Key Levels */}
            {intraday.keyLevels?.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Key Levels</h4>
                {intraday.keyLevels.map((level: any, i: number) => {
                  const levelColor = level.type === "support" ? "text-[#00C853] bg-[#00C853]/5 border-[#00C853]/20" : level.type === "resistance" ? "text-[#FF333A] bg-[#FF333A]/5 border-[#FF333A]/20" : "text-yellow-400 bg-yellow-400/5 border-yellow-400/20";
                  return (
                    <div key={i} className={cn("flex items-center gap-3 rounded-lg border px-4 py-2.5", levelColor)}>
                      <span className="font-mono font-bold text-sm">${level.price.toFixed(2)}</span>
                      <span className="text-xs font-semibold uppercase">{level.type}</span>
                      <span className="text-xs opacity-80 ml-auto text-right max-w-[60%]">{level.significance}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Technical Indicators ─────────────────────────────────── */}
      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <Target className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-display font-semibold">Technical Indicators</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatPill
            label="RSI (14)"
            value={tech.rsi ? `${tech.rsi} ${tech.rsi > 70 ? "⚠ OB" : tech.rsi < 30 ? "⚠ OS" : ""}` : null}
            highlight={tech.rsi !== null && tech.rsi !== undefined ? tech.rsi > 70 ? "down" : tech.rsi < 30 ? "up" : "neutral" : undefined}
          />
          <StatPill label="MACD" value={tech.macd?.toFixed(3) ?? null} highlight={tech.macd !== null && tech.macd !== undefined ? tech.macd > 0 ? "up" : "down" : undefined} />
          <StatPill label="MACD Signal" value={tech.macdSignal?.toFixed(3) ?? null} />
          <StatPill label="MACD Hist." value={tech.macdHistogram?.toFixed(3) ?? null} highlight={tech.macdHistogram !== null && tech.macdHistogram !== undefined ? tech.macdHistogram > 0 ? "up" : "down" : undefined} />
          <StatPill label="BB Upper" value={tech.bollingerUpper ? `$${tech.bollingerUpper}` : null} />
          <StatPill label="BB Middle" value={tech.bollingerMiddle ? `$${tech.bollingerMiddle}` : null} />
          <StatPill label="BB Lower" value={tech.bollingerLower ? `$${tech.bollingerLower}` : null} />
          <StatPill label="SMA 20" value={tech.sma20 ? `$${tech.sma20}` : null} />
          <StatPill label="SMA 50" value={tech.sma50 ? `$${tech.sma50}` : null} />
          <StatPill label="SMA 200" value={tech.sma200 ? `$${tech.sma200}` : null} />
          <StatPill label="ATR (14)" value={tech.atr ?? null} />
          <StatPill label="Volume Ratio" value={tech.volumeRatio ? `${tech.volumeRatio}x` : null} highlight={tech.volumeRatio !== null && tech.volumeRatio !== undefined ? tech.volumeRatio > 1.5 ? "up" : tech.volumeRatio < 0.7 ? "down" : "neutral" : undefined} />
        </div>
      </div>

      {/* ── Options Snapshot ──────────────────────────────────────── */}
      {opts && (
        <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <TrendingUp className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-display font-semibold">Options Snapshot</h2>
            <span className={cn(
              "ml-auto text-xs font-semibold px-2 py-0.5 rounded-md border",
              DIRECTION_CONFIG[opts.sentiment as keyof typeof DIRECTION_CONFIG]?.bg,
              DIRECTION_CONFIG[opts.sentiment as keyof typeof DIRECTION_CONFIG]?.color,
            )}>
              {opts.sentiment?.toUpperCase()} FLOW
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            <StatPill label="Put/Call Ratio" value={opts.putCallRatio ?? null} highlight={opts.putCallRatio !== null && opts.putCallRatio !== undefined ? opts.putCallRatio > 1 ? "down" : "up" : undefined} />
            <div className="bg-background rounded-lg border border-border p-3 col-span-1 md:col-span-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">Unusual Activity</span>
              <p className="text-sm text-muted-foreground">{opts.unusualActivity}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {opts.topCallPick && (
              <div className="bg-[#00C853]/5 border border-[#00C853]/20 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-[#00C853]" />
                  <span className="text-xs font-bold text-[#00C853] uppercase tracking-wider">Top Call Pick</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold">${opts.topCallPick.strike}</span>
                  <span className="text-xs text-muted-foreground">exp {opts.topCallPick.expiry}</span>
                  {opts.topCallPick.premium && (
                    <span className="font-mono text-sm text-muted-foreground ml-auto">@${opts.topCallPick.premium.toFixed(2)}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{opts.topCallPick.rationale}</p>
              </div>
            )}
            {opts.topPutPick && (
              <div className="bg-[#FF333A]/5 border border-[#FF333A]/20 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <TrendingDown className="w-4 h-4 text-[#FF333A]" />
                  <span className="text-xs font-bold text-[#FF333A] uppercase tracking-wider">Top Put Pick</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold">${opts.topPutPick.strike}</span>
                  <span className="text-xs text-muted-foreground">exp {opts.topPutPick.expiry}</span>
                  {opts.topPutPick.premium && (
                    <span className="font-mono text-sm text-muted-foreground ml-auto">@${opts.topPutPick.premium.toFixed(2)}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{opts.topPutPick.rationale}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Options Strategy Generator ───────────────────────────── */}
      <OptionsStrategyPanel symbol={symbol} />

      {/* Disclaimer */}
      <p className="text-xs text-muted-foreground text-center pb-4">
        ⚠ AI-generated analysis for informational purposes only. Not financial advice. Options trading involves significant risk of loss.
      </p>
    </div>
  );
}
