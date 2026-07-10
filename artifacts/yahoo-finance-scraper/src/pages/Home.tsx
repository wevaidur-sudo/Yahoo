import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import {
  TrendingUp, TrendingDown, Target, RefreshCw, AlertTriangle,
  ArrowUpRight, ArrowDownRight, Clock, DollarSign, Zap,
  BarChart2, Trophy, ChevronRight,
} from "lucide-react";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TradeSetup {
  bias: "long" | "short" | "no-trade";
  setupType: string;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  rrRatio1: number | null;
  rrRatio2: number | null;
  riskPerShare: number | null;
  bestWindow: string;
  confidence: number;
}

interface OptionsLeg {
  type: "call" | "put";
  action: "buy" | "sell";
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  impliedVolatility: number | null;
}

interface OptionsStrategy {
  strategyName: string;
  strategyType: string;
  riskLevel: string;
  reasoning: string;
  exitStrategy: string;
  affordable: boolean;
  totalCost: number;
  maxProfit: string;
  maxLoss: string;
  probability: number;
  breakeven: string;
  legs: OptionsLeg[];
}

interface Pick {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  score: number;
  tradeSetup: TradeSetup;
  signalScore: { direction: string; conviction: number };
}

interface RunnerUp {
  symbol: string;
  bias: string;
  setupType: string;
  conviction: number;
  rrRatio1: number | null;
  score: number;
}

interface TopPickResponse {
  generatedAt: string;
  pick: Pick | null;
  optionsStrategy: OptionsStrategy | null;
  allPicks: RunnerUp[];
  reason?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function convictionColor(c: number) {
  return c >= 70 ? "#00C853" : c >= 50 ? "#f59e0b" : "#FF333A";
}

function timeAgo(iso: string) {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse bg-muted rounded-lg", className)} />;
}

function TradeSetupBlock({ setup }: { setup: TradeSetup }) {
  const isLong = setup.bias === "long";
  const color  = isLong ? "#00C853" : "#FF333A";
  const Icon   = isLong ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="space-y-4">
      {/* Bias + setup type */}
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className="flex items-center gap-1.5 font-bold text-base px-3 py-1.5 rounded-lg border"
          style={{ color, borderColor: `${color}40`, background: `${color}10` }}
        >
          <Icon className="w-4 h-4" />
          {isLong ? "LONG" : "SHORT"}
        </span>
        <span className="text-xs font-semibold text-muted-foreground bg-muted border border-border px-2.5 py-1 rounded-lg">
          {setup.setupType}
        </span>
        <span
          className="ml-auto text-sm font-bold font-mono"
          style={{ color: convictionColor(setup.confidence) }}
        >
          {setup.confidence}% conviction
        </span>
      </div>

      {/* Levels grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <div className="col-span-2 bg-background rounded-xl border border-border p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Entry Zone
          </p>
          <p className="font-mono text-base font-bold">
            {setup.entryLow != null && setup.entryHigh != null
              ? `$${setup.entryLow.toFixed(2)} – $${setup.entryHigh.toFixed(2)}`
              : "—"}
          </p>
          {setup.riskPerShare != null && (
            <p className="text-xs text-muted-foreground mt-1">
              Risk{" "}
              <span className="font-mono font-semibold text-foreground">
                ${setup.riskPerShare.toFixed(2)}
              </span>
              /share
            </p>
          )}
        </div>

        <div className="bg-[#FF333A]/5 rounded-xl border border-[#FF333A]/25 p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#FF333A] mb-1.5">
            Stop Loss
          </p>
          <p className="font-mono text-base font-bold text-[#FF333A]">
            {setup.stopLoss != null ? `$${setup.stopLoss.toFixed(2)}` : "—"}
          </p>
        </div>

        <div className="bg-[#00C853]/5 rounded-xl border border-[#00C853]/25 p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#00C853] mb-1">
            Target 1
          </p>
          <p className="font-mono text-base font-bold text-[#00C853]">
            {setup.target1 != null ? `$${setup.target1.toFixed(2)}` : "—"}
          </p>
          {setup.rrRatio1 != null && (
            <p className="text-xs font-mono font-bold text-[#00C853]/80">
              {setup.rrRatio1.toFixed(1)}R
            </p>
          )}
        </div>
      </div>

      {/* T2 + window */}
      <div className="flex flex-wrap gap-2">
        {setup.target2 != null && (
          <div className="flex items-center gap-2 bg-background rounded-lg border border-border px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Target 2</span>
            <span className="font-mono text-sm font-bold text-[#00C853]">
              ${setup.target2.toFixed(2)}
            </span>
            {setup.rrRatio2 != null && (
              <span className="text-xs font-mono font-bold text-[#00C853]/70">
                {setup.rrRatio2.toFixed(1)}R
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1.5 bg-background rounded-lg border border-border px-3 py-1.5 flex-1 min-w-[180px]">
          <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{setup.bestWindow}</span>
        </div>
      </div>
    </div>
  );
}

function OptionsStrategyBlock({ strategy }: { strategy: OptionsStrategy }) {
  const probColor =
    strategy.probability >= 60 ? "#00C853" :
    strategy.probability >= 45 ? "#f59e0b" : "#FF333A";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold text-base">{strategy.strategyName}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{strategy.reasoning}</p>
        </div>
        <span className={cn(
          "text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border shrink-0",
          strategy.riskLevel === "low"
            ? "text-[#00C853] bg-[#00C853]/10 border-[#00C853]/30"
            : strategy.riskLevel === "high"
              ? "text-[#FF333A] bg-[#FF333A]/10 border-[#FF333A]/30"
              : "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30",
        )}>
          {strategy.riskLevel} risk
        </span>
      </div>

      {/* Legs */}
      <div className="flex flex-wrap gap-2">
        {strategy.legs.map((leg, i) => (
          <div key={i} className="flex items-center gap-1.5 bg-background border border-border rounded-lg px-3 py-1.5 text-xs font-mono">
            <span className={leg.action === "buy" ? "text-[#00C853]" : "text-[#FF333A]"}>
              {leg.action.toUpperCase()}
            </span>
            <span className="font-bold">{leg.type.toUpperCase()}</span>
            {leg.strike != null && <span>${leg.strike}</span>}
            {leg.expiry && <span className="text-muted-foreground">exp {leg.expiry}</span>}
            {leg.premium != null && (
              <span className="text-muted-foreground">@ ${leg.premium.toFixed(2)}</span>
            )}
          </div>
        ))}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <div className="bg-background rounded-xl border border-border p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Total Cost
          </p>
          <p className={cn(
            "font-mono text-lg font-bold",
            strategy.affordable ? "text-foreground" : "text-[#FF333A]",
          )}>
            ${strategy.totalCost.toFixed(2)}
          </p>
          {!strategy.affordable && (
            <p className="text-[10px] text-[#FF333A]">Exceeds $100</p>
          )}
        </div>

        <div className="bg-[#00C853]/5 rounded-xl border border-[#00C853]/25 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#00C853] mb-1">
            Max Profit
          </p>
          <p className="font-mono text-lg font-bold text-[#00C853]">
            {strategy.maxProfit}
          </p>
        </div>

        <div className="bg-[#FF333A]/5 rounded-xl border border-[#FF333A]/25 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#FF333A] mb-1">
            Max Loss
          </p>
          <p className="font-mono text-lg font-bold text-[#FF333A]">
            {strategy.maxLoss}
          </p>
        </div>

        <div className="bg-background rounded-xl border border-border p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Prob. of Profit
          </p>
          <p className="font-mono text-lg font-bold" style={{ color: probColor }}>
            {strategy.probability.toFixed(1)}%
          </p>
        </div>
      </div>

      {/* Breakeven + exit */}
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>Breakeven: <span className="font-mono text-foreground">{strategy.breakeven}</span></span>
        <span className="text-border">|</span>
        <span className="text-muted-foreground italic">{strategy.exitStrategy}</span>
      </div>
    </div>
  );
}

// ─── Main Home component ──────────────────────────────────────────────────────

export default function Home() {
  const [data, setData]       = useState<TopPickResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const resp = await fetch(`${base}/api/finance/top-pick`);
      if (!resp.ok) throw new Error(`Server error ${resp.status}`);
      setData(await resp.json());
    } catch (e: any) {
      setError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  const pick  = data?.pick ?? null;
  const opts  = data?.optionsStrategy ?? null;
  const isUp  = (pick?.changePercent ?? 0) >= 0;

  return (
    <div className="flex flex-col gap-10 max-w-5xl mx-auto py-8">

      {/* ── Hero ── */}
      <section className="text-center space-y-5 py-10">
        <h1 className="text-4xl md:text-6xl font-display font-bold tracking-tighter">
          Market Intelligence, <span className="text-primary">Refined.</span>
        </h1>
        <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
          Institutional-grade data and analytics for the modern investor.
          Search for a symbol above to get started.
        </p>
      </section>

      {/* ── Top Pick ── */}
      <section className="space-y-5">
        {/* Section header */}
        <div className="flex items-center justify-between border-b border-border/50 pb-4">
          <div className="flex items-center gap-2">
            <Trophy className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-display font-semibold">Today's Top Intraday Pick</h2>
            <span className="text-xs font-semibold bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded-full">
              AI Scored
            </span>
          </div>
          <div className="flex items-center gap-3">
            {data?.generatedAt && (
              <span className="text-xs text-muted-foreground hidden sm:block">
                Updated {timeAgo(data.generatedAt)}
              </span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
              Refresh
            </button>
          </div>
        </div>

        {/* Loading skeleton */}
        {loading && !data && (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <Skeleton className="h-32" />
              <Skeleton className="h-48" />
            </div>
            <Skeleton className="h-80" />
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="flex items-center gap-3 p-5 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {/* No pick */}
        {!loading && !error && data && !pick && (
          <div className="text-center p-12 border border-dashed border-border rounded-2xl text-muted-foreground space-y-2">
            <BarChart2 className="w-8 h-8 mx-auto opacity-40" />
            <p className="font-medium">No actionable setups right now</p>
            <p className="text-sm">{data.reason ?? "Markets may be closed or signals are mixed. Check back during trading hours."}</p>
          </div>
        )}

        {/* Main pick card */}
        {pick && (
          <div className="grid md:grid-cols-2 gap-5">

            {/* Left: stock info + trade setup */}
            <div className="space-y-4">
              {/* Stock header */}
              <Link href={`/stock/${pick.symbol}`}>
                <div className={cn(
                  "group p-5 bg-card rounded-2xl border transition-all hover:-translate-y-0.5 hover:shadow-xl cursor-pointer",
                  pick.tradeSetup.bias === "long"
                    ? "border-[#00C853]/30 hover:shadow-[#00C853]/10"
                    : "border-[#FF333A]/30 hover:shadow-[#FF333A]/10",
                )}>
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-mono text-2xl font-bold group-hover:text-primary transition-colors">
                          {pick.symbol}
                        </h3>
                        <Zap className="w-4 h-4 text-primary" />
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5 max-w-[200px] truncate">
                        {pick.name}
                      </p>
                    </div>
                    <div className={cn(
                      "flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md",
                      isUp ? "bg-[#00C853]/10 text-[#00C853]" : "bg-[#FF333A]/10 text-[#FF333A]",
                    )}>
                      {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {formatPercent(pick.changePercent)}
                    </div>
                  </div>

                  <div className="flex items-end justify-between">
                    <span className="font-mono text-3xl font-bold">
                      {formatCurrency(pick.price)}
                    </span>
                    <div className="text-right">
                      <span className={cn(
                        "text-sm font-mono font-medium block",
                        isUp ? "text-[#00C853]" : "text-[#FF333A]",
                      )}>
                        {pick.change > 0 ? "+" : ""}{pick.change.toFixed(2)}
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center justify-end gap-1 mt-0.5">
                        Score <span className="font-mono font-bold text-foreground">{pick.score}</span>
                        <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
                      </span>
                    </div>
                  </div>
                </div>
              </Link>

              {/* Trade setup */}
              <div className={cn(
                "p-5 bg-card rounded-2xl border",
                pick.tradeSetup.bias === "long"
                  ? "border-[#00C853]/20"
                  : "border-[#FF333A]/20",
              )}>
                <div className="flex items-center gap-2 mb-4">
                  <Target className="w-4 h-4 text-primary" />
                  <h3 className="font-semibold text-sm">Trade Setup</h3>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full ml-auto">
                    Mechanical
                  </span>
                </div>
                <TradeSetupBlock setup={pick.tradeSetup} />
              </div>
            </div>

            {/* Right: options strategy */}
            <div>
              {opts ? (
                <div className="h-full p-5 bg-card rounded-2xl border border-card-border space-y-1">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="p-1.5 rounded-lg bg-primary/10 border border-primary/20">
                      <DollarSign className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">Options Strategy</h3>
                      <p className="text-[11px] text-muted-foreground">≤ $100 budget · AI designed</p>
                    </div>
                    {opts.affordable && (
                      <span className="ml-auto text-[10px] font-bold uppercase tracking-wider text-[#00C853] bg-[#00C853]/10 border border-[#00C853]/30 px-2 py-0.5 rounded-full">
                        Within Budget
                      </span>
                    )}
                  </div>
                  <OptionsStrategyBlock strategy={opts} />
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center p-8 bg-card rounded-2xl border border-dashed border-border text-muted-foreground space-y-2 min-h-[300px]">
                  <DollarSign className="w-8 h-8 opacity-30" />
                  <p className="text-sm font-medium">Options strategy unavailable</p>
                  <p className="text-xs text-center">No contracts under $100 found for {pick.symbol}. Try opening the stock page for a custom budget.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Runner-ups */}
        {data?.allPicks && data.allPicks.length > 1 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
              Other setups found
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {data.allPicks.slice(1).map((s) => (
                <Link key={s.symbol} href={`/stock/${s.symbol}`}>
                  <div className="group flex items-center justify-between p-3 bg-card rounded-xl border border-card-border hover:border-primary/30 transition-all cursor-pointer">
                    <div>
                      <p className="font-mono text-sm font-bold group-hover:text-primary transition-colors">
                        {s.symbol}
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate max-w-[80px]">
                        {s.setupType.replace("Previous Day", "PD").replace("Pre-Market", "PM").replace(" Breakdown", " ↓").replace(" Breakout", " ↑")}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className="text-xs font-mono font-bold"
                        style={{ color: convictionColor(s.conviction) }}
                      >
                        {s.conviction}%
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {s.rrRatio1 != null ? `${s.rrRatio1.toFixed(1)}R` : "—"}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
