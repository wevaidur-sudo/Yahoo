import { useState, useEffect } from "react";
import {
  useGetStockAnalysis,
  getGetStockAnalysisQueryKey,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Brain,
  Target,
  Activity,
  Zap,
  AlertTriangle,
  DollarSign,
  Loader2,
  ShieldAlert,
  Calculator,
  Clock,
  RefreshCw,
  XCircle,
  ArrowUpRight,
  ArrowDownRight,
  BarChart2,
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

// ─── Utility components ────────────────────────────────────────────────────────

function StatPill({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number | null;
  highlight?: "up" | "down" | "neutral";
}) {
  const colorClass =
    highlight === "up"
      ? "text-[#00C853]"
      : highlight === "down"
        ? "text-[#FF333A]"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-1 bg-background rounded-lg border border-border p-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={cn("font-mono text-sm font-semibold", colorClass)}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function DataQualityBanner({ dataQuality }: { dataQuality: any }) {
  if (!dataQuality) return null;
  const hasIssues =
    dataQuality.quoteStale || (dataQuality.liquidityWarnings?.length ?? 0) > 0;
  if (!hasIssues) return null;
  return (
    <div className="flex items-start gap-3 p-4 rounded-xl bg-yellow-400/5 border border-yellow-400/20">
      <ShieldAlert className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
      <div className="space-y-1 text-sm">
        {dataQuality.quoteStale && (
          <p className="text-yellow-400 font-medium">
            Quote data is{" "}
            {Math.round((dataQuality.quoteAgeSeconds ?? 0) / 60)} min old —
            treat prices as delayed.
          </p>
        )}
        {dataQuality.liquidityWarnings?.map((w: string, i: number) => (
          <p key={i} className="text-muted-foreground">
            {w}
          </p>
        ))}
      </div>
    </div>
  );
}

function GreeksRow({
  iv,
  delta,
  theo,
}: {
  iv?: number | null;
  delta?: number | null;
  theo?: number | null;
}) {
  if (iv == null && delta == null && theo == null) return null;
  return (
    <div className="flex flex-wrap gap-3 text-xs font-mono text-muted-foreground pt-1">
      {iv != null && (
        <span>
          IV <b className="text-foreground">{iv}%</b>
        </span>
      )}
      {delta != null && (
        <span>
          Δ <b className="text-foreground">{delta}</b>
        </span>
      )}
      {theo != null && (
        <span>
          Theo. Value <b className="text-foreground">${theo}</b>
        </span>
      )}
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

/** Bidirectional bar: centre = 0, left = bearish, right = bullish. */
function SignalBar({ score }: { score: number }) {
  const clamped = Math.max(-100, Math.min(100, score));
  const color =
    clamped >= 20 ? "#00C853" : clamped <= -20 ? "#FF333A" : "#f59e0b";
  const pct = Math.abs(clamped);
  const isPositive = clamped >= 0;
  return (
    <div className="space-y-1.5">
      <div className="relative h-2.5 rounded-full overflow-hidden bg-muted flex">
        <div className="flex-1 flex justify-end pr-px">
          {!isPositive && (
            <div
              className="h-full rounded-l-full"
              style={{ width: `${pct}%`, backgroundColor: "#FF333A" }}
            />
          )}
        </div>
        <div className="w-px bg-border/80 flex-shrink-0" />
        <div className="flex-1 flex justify-start pl-px">
          {isPositive && (
            <div
              className="h-full rounded-r-full"
              style={{ width: `${pct}%`, backgroundColor: "#00C853" }}
            />
          )}
        </div>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
        <span>−100 Bearish</span>
        <span className="font-bold text-xs" style={{ color }}>
          {clamped > 0 ? "+" : ""}
          {clamped}
        </span>
        <span>Bullish +100</span>
      </div>
    </div>
  );
}

function ProminentDisclaimer() {
  return (
    <div className="flex items-start gap-4 p-5 rounded-2xl border border-amber-500/30 bg-amber-500/5">
      <ShieldAlert className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-amber-400 tracking-tight">
          For Informational Purposes Only — Not Financial Advice
        </p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          The{" "}
          <strong className="text-foreground">Intraday Signal Score</strong> is
          computed deterministically from standard financial formulas (VWAP,
          ORB, RSI, MACD). The{" "}
          <strong className="text-foreground">AI Commentary</strong> is
          qualitative narrative from a large language model — not a forecast.{" "}
          <strong className="text-foreground">
            Neither constitutes investment advice or a trading recommendation.
          </strong>{" "}
          Past indicator readings do not guarantee future price movements.
          Options trading involves substantial risk of loss and is not suitable
          for all investors. Consult a licensed financial advisor before making
          any investment decision.
        </p>
      </div>
    </div>
  );
}

// ─── Market session helpers ────────────────────────────────────────────────────

function getETMarketPhase(): {
  phase: string;
  label: string;
  color: string;
  isRegularHours: boolean;
  isExtendedHours: boolean;
  sessionMinutes: number | null;
} {
  const now = new Date();
  // DST-aware ET offset
  const m = now.getUTCMonth() + 1;
  let offset = 5; // EST default
  if (m > 3 && m < 11) {
    offset = 4; // clearly EDT
  } else if (m === 3) {
    const year = now.getUTCFullYear();
    const dow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSun = (dow === 0 ? 1 : 8 - dow) + 7;
    if (now.getUTCDate() >= secondSun) offset = 4;
  } else if (m === 11) {
    const year = now.getUTCFullYear();
    const dow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const firstSun = dow === 0 ? 1 : 8 - dow;
    if (now.getUTCDate() < firstSun) offset = 4;
  }

  const etDecimal =
    ((now.getUTCHours() - offset + 24) % 24) + now.getUTCMinutes() / 60;

  const sessionMinutes =
    etDecimal >= 9.5 && etDecimal < 16
      ? Math.round((etDecimal - 9.5) * 60)
      : null;

  if (etDecimal >= 4 && etDecimal < 9.5)
    return {
      phase: "pre-market",
      label: "Pre-Market",
      color: "text-blue-400",
      isRegularHours: false,
      isExtendedHours: true,
      sessionMinutes: null,
    };
  if (etDecimal >= 9.5 && etDecimal < 9.75)
    return {
      phase: "orb",
      label: "Opening Range Window",
      color: "text-yellow-400",
      isRegularHours: true,
      isExtendedHours: false,
      sessionMinutes,
    };
  if (etDecimal >= 9.75 && etDecimal < 10.5)
    return {
      phase: "morning",
      label: "Morning Session",
      color: "text-[#00C853]",
      isRegularHours: true,
      isExtendedHours: false,
      sessionMinutes,
    };
  if (etDecimal >= 10.5 && etDecimal < 13.5)
    return {
      phase: "midday",
      label: "Midday Session",
      color: "text-muted-foreground",
      isRegularHours: true,
      isExtendedHours: false,
      sessionMinutes,
    };
  if (etDecimal >= 13.5 && etDecimal < 15.0)
    return {
      phase: "afternoon",
      label: "Afternoon Session",
      color: "text-[#00C853]",
      isRegularHours: true,
      isExtendedHours: false,
      sessionMinutes,
    };
  if (etDecimal >= 15.0 && etDecimal < 16.0)
    return {
      phase: "power-hour",
      label: "Power Hour",
      color: "text-primary",
      isRegularHours: true,
      isExtendedHours: false,
      sessionMinutes,
    };
  if (etDecimal >= 16.0 && etDecimal < 20.0)
    return {
      phase: "after-hours",
      label: "After Hours",
      color: "text-blue-400",
      isRegularHours: false,
      isExtendedHours: true,
      sessionMinutes: null,
    };
  return {
    phase: "closed",
    label: "Market Closed",
    color: "text-muted-foreground",
    isRegularHours: false,
    isExtendedHours: false,
    sessionMinutes: null,
  };
}

// ─── Session Banner ────────────────────────────────────────────────────────────

function SessionBanner({
  isMarketHours,
  generatedAt,
}: {
  isMarketHours: boolean;
  generatedAt: string;
}) {
  const [phase, setPhase] = useState(getETMarketPhase());

  useEffect(() => {
    const id = setInterval(() => setPhase(getETMarketPhase()), 30_000);
    return () => clearInterval(id);
  }, []);

  const genTime = new Date(generatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-card border border-card-border rounded-xl text-sm">
      {/* Live indicator + phase */}
      <div className="flex items-center gap-2">
        <div className="relative flex h-2 w-2">
          <span
            className={cn(
              "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
              phase.isRegularHours
                ? "bg-[#00C853]"
                : phase.isExtendedHours
                  ? "bg-blue-400"
                  : "bg-muted-foreground/50",
            )}
          />
          <span
            className={cn(
              "relative inline-flex rounded-full h-2 w-2",
              phase.isRegularHours
                ? "bg-[#00C853]"
                : phase.isExtendedHours
                  ? "bg-blue-400"
                  : "bg-muted-foreground/50",
            )}
          />
        </div>
        <span className={cn("font-semibold", phase.color)}>{phase.label}</span>
      </div>

      {/* Time into session */}
      {phase.sessionMinutes != null && (
        <span className="text-xs text-muted-foreground">
          {Math.floor(phase.sessionMinutes / 60)}h{" "}
          {phase.sessionMinutes % 60}m into session
        </span>
      )}

      {/* Separator pills for key phases */}
      {phase.phase === "orb" && (
        <span className="text-xs font-semibold text-yellow-400 bg-yellow-400/10 border border-yellow-400/20 px-2 py-0.5 rounded-full">
          ⚡ ORB window open — wait for 9:45 ET breakout
        </span>
      )}
      {phase.phase === "midday" && (
        <span className="text-xs text-muted-foreground bg-muted border border-border px-2 py-0.5 rounded-full">
          Midday — reduced momentum, avoid new positions
        </span>
      )}
      {phase.phase === "power-hour" && (
        <span className="text-xs font-semibold text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full">
          ⚡ Power Hour — strong trend resumption plays
        </span>
      )}

      {/* Right: update info */}
      <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
        <span>Updated {genTime}</span>
        {isMarketHours && (
          <span className="flex items-center gap-1 text-[#00C853]">
            <RefreshCw className="w-3 h-3" /> Auto-refresh 60s
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Trade Setup Card ──────────────────────────────────────────────────────────

function TradeSetupCard({ setup }: { setup: any }) {
  if (!setup) return null;

  // No-trade / PASS state
  if (setup.bias === "no-trade") {
    return (
      <div className="bg-card border border-yellow-500/30 rounded-2xl p-6 md:p-8 shadow-sm bg-yellow-500/5">
        <div className="flex items-center gap-3 mb-5">
          <XCircle className="w-5 h-5 text-yellow-400" />
          <h2 className="text-xl font-display font-semibold">Trade Setup</h2>
          <span className="ml-auto text-xs font-bold uppercase tracking-wider text-yellow-400 bg-yellow-400/10 border border-yellow-400/30 px-3 py-1 rounded-full">
            PASS — NO TRADE
          </span>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-xl bg-yellow-500/10 border border-yellow-500/20 mb-4">
          <AlertTriangle className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-yellow-300 mb-1">
              No actionable setup — protect your capital
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {setup.noTradeReason ??
                "Insufficient directional conviction for a high-probability setup."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="w-3.5 h-3.5 flex-shrink-0" />
          {setup.bestWindow}
        </div>
      </div>
    );
  }

  const isLong = setup.bias === "long";
  const BiasIcon = isLong ? ArrowUpRight : ArrowDownRight;
  const biasColor = isLong ? "#00C853" : "#FF333A";
  const borderClass = isLong
    ? "border-[#00C853]/30 shadow-[0_0_30px_rgba(0,200,83,0.08)]"
    : "border-[#FF333A]/30 shadow-[0_0_30px_rgba(255,51,58,0.08)]";

  const convictionColor =
    setup.confidence >= 70
      ? "#00C853"
      : setup.confidence >= 50
        ? "#f59e0b"
        : "#FF333A";

  return (
    <div className={cn("bg-card border rounded-2xl p-6 md:p-8 shadow-sm", borderClass)}>
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Target className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-display font-semibold">Trade Setup</h2>
        <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full">
          Mechanical
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span
            className="flex items-center gap-1 font-bold text-sm"
            style={{ color: biasColor }}
          >
            <BiasIcon className="w-4 h-4" />
            {isLong ? "LONG" : "SHORT"}
          </span>
          <span className="text-xs font-semibold text-muted-foreground bg-muted border border-border px-2 py-0.5 rounded">
            {setup.setupType}
          </span>
        </div>
      </div>

      {/* Entry / Stop / T1 / T2 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {/* Entry zone — spans 2 cols on mobile */}
        <div className="col-span-2 md:col-span-2 bg-background rounded-xl border border-border p-4">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-2">
            Entry Zone
          </span>
          <span className="font-mono text-xl font-bold">
            {setup.entryLow != null && setup.entryHigh != null
              ? `$${setup.entryLow.toFixed(2)} – $${setup.entryHigh.toFixed(2)}`
              : "—"}
          </span>
          {setup.riskPerShare != null && (
            <p className="text-xs text-muted-foreground mt-1.5">
              Risk: <span className="font-mono font-semibold text-foreground">${setup.riskPerShare.toFixed(2)}</span>/share
            </p>
          )}
        </div>

        {/* Stop Loss */}
        <div className="bg-[#FF333A]/5 rounded-xl border border-[#FF333A]/25 p-4">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#FF333A] block mb-2">
            Stop Loss
          </span>
          <span className="font-mono text-xl font-bold text-[#FF333A]">
            {setup.stopLoss != null ? `$${setup.stopLoss.toFixed(2)}` : "—"}
          </span>
        </div>

        {/* Target 1 */}
        <div className="bg-[#00C853]/5 rounded-xl border border-[#00C853]/25 p-4">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#00C853] block mb-1">
            Target 1
          </span>
          <span className="font-mono text-xl font-bold text-[#00C853]">
            {setup.target1 != null ? `$${setup.target1.toFixed(2)}` : "—"}
          </span>
          {setup.rrRatio1 != null && (
            <span className="text-xs font-mono font-bold text-[#00C853]/80">
              {setup.rrRatio1.toFixed(1)}R
            </span>
          )}
        </div>
      </div>

      {/* Target 2 + conviction + window */}
      <div className="flex flex-wrap items-center gap-3">
        {setup.target2 != null && (
          <div className="flex items-center gap-2 bg-background rounded-lg border border-border px-3 py-2">
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

        <div className="flex items-center gap-2 bg-background rounded-lg border border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">Conviction</span>
          <span
            className="font-mono text-sm font-bold"
            style={{ color: convictionColor }}
          >
            {setup.confidence}%
          </span>
        </div>

        <div className="flex items-center gap-1.5 bg-background rounded-lg border border-border px-3 py-2 flex-1 min-w-[200px]">
          <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-xs text-muted-foreground">{setup.bestWindow}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Intraday Key Levels Card ──────────────────────────────────────────────────

function IntradayLevelsCard({ levels }: { levels: any }) {
  if (!levels) return null;

  const fmt = (v: number | null | undefined) =>
    v != null ? `$${v.toFixed(2)}` : "—";
  const fmtPct = (v: number | null | undefined) =>
    v != null ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%` : "—";

  const orbStatusLabel =
    levels.orbBroken === "up"
      ? "↑ Broken Up"
      : levels.orbBroken === "down"
        ? "↓ Broken Down"
        : levels.orbBroken === "none"
          ? "Intact"
          : levels.orbBroken === null
            ? "Forming…"
            : "—";

  const orbStatusColor =
    levels.orbBroken === "up"
      ? "text-[#00C853]"
      : levels.orbBroken === "down"
        ? "text-[#FF333A]"
        : levels.orbBroken === "none"
          ? "text-muted-foreground"
          : "text-yellow-400";

  const gapStatusLabel =
    levels.gapFilled == null
      ? "—"
      : levels.gapFilled
        ? "Filled"
        : `Unfilled ${levels.gapDirection ?? ""}`;

  const gapStatusColor =
    levels.gapFilled
      ? "text-muted-foreground"
      : levels.gapDirection === "up"
        ? "text-[#00C853]"
        : levels.gapDirection === "down"
          ? "text-[#FF333A]"
          : "text-muted-foreground";

  const rvolHighlight: "up" | "down" | "neutral" | undefined =
    levels.rvol == null
      ? undefined
      : levels.rvol >= 1.5
        ? "up"
        : levels.rvol < 0.6
          ? "down"
          : "neutral";

  return (
    <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
      <div className="flex items-center gap-3 mb-6">
        <BarChart2 className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-display font-semibold">Intraday Key Levels</h2>
        <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full">
          Live Data
        </span>
      </div>

      <div className="space-y-5">
        {/* VWAP row */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            VWAP & Bands
          </h4>
          <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
            <div className="bg-primary/5 border border-primary/20 rounded-lg p-3 col-span-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-primary block mb-1">
                VWAP
              </span>
              <span className="font-mono text-sm font-bold">{fmt(levels.vwap)}</span>
            </div>
            <StatPill label="VWAP +1σ" value={fmt(levels.vwapUpper1)} highlight="down" />
            <StatPill label="VWAP −1σ" value={fmt(levels.vwapLower1)} highlight="up" />
            <StatPill label="VWAP +2σ" value={fmt(levels.vwapUpper2)} />
            <StatPill label="VWAP −2σ" value={fmt(levels.vwapLower2)} />
          </div>
        </div>

        {/* Opening Range */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Opening Range (9:30–9:45 ET)
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatPill label="ORB High" value={fmt(levels.orbHigh)} highlight="down" />
            <StatPill label="ORB Low" value={fmt(levels.orbLow)} highlight="up" />
            <StatPill
              label="ORB Range"
              value={levels.orbRange != null ? `$${levels.orbRange.toFixed(2)}` : "—"}
            />
            <div className="bg-background rounded-lg border border-border p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">
                ORB Status
              </span>
              <span className={cn("text-sm font-bold", orbStatusColor)}>
                {orbStatusLabel}
              </span>
            </div>
          </div>
        </div>

        {/* Gap + RVOL */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <StatPill
            label="Gap"
            value={fmtPct(levels.gap)}
            highlight={
              levels.gapDirection === "up"
                ? "up"
                : levels.gapDirection === "down"
                  ? "down"
                  : "neutral"
            }
          />
          <div className="bg-background rounded-lg border border-border p-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">
              Gap Status
            </span>
            <span className={cn("text-sm font-semibold", gapStatusColor)}>
              {gapStatusLabel}
            </span>
          </div>
          <StatPill
            label="RVOL"
            value={levels.rvol != null ? `${levels.rvol.toFixed(2)}x` : "—"}
            highlight={rvolHighlight}
          />
          <StatPill label="Session Open" value={fmt(levels.sessionOpen)} />
        </div>

        {/* Pre-market + PDH/PDL/PDC + ATR */}
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Pre-Market & Previous Day Levels
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <StatPill label="Pre-Market High" value={fmt(levels.preMarketHigh)} highlight="down" />
            <StatPill label="Pre-Market Low" value={fmt(levels.preMarketLow)} highlight="up" />
            <StatPill
              label="Intraday ATR"
              value={levels.intradayAtr != null ? `$${levels.intradayAtr.toFixed(2)}` : "—"}
            />
            <StatPill label="Prev Day High (PDH)" value={fmt(levels.pdHigh)} highlight="down" />
            <StatPill label="Prev Day Low (PDL)" value={fmt(levels.pdLow)} highlight="up" />
            <StatPill label="Prev Day Close (PDC)" value={fmt(levels.pdClose)} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Options Strategy Panel ────────────────────────────────────────────────────

function OptionsStrategyPanel({ symbol }: { symbol: string }) {
  const [amount, setAmount]       = useState("");
  const [accountSize, setAccountSize] = useState("");
  const [strategy, setStrategy]   = useState<any>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  async function generate() {
    const num = parseFloat(amount);
    if (!num || num <= 0) return;
    setLoading(true);
    setError(null);
    setStrategy(null);
    try {
      const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const acct = parseFloat(accountSize);
      const resp = await fetch(`${base}/api/finance/options-strategy/${symbol}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          investmentAmount: num,
          ...(acct > 0 ? { accountSize: acct } : {}),
        }),
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

  const ps = strategy?.positionSizing;

  return (
    <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10 border border-primary/20">
          <DollarSign className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="font-display font-semibold text-lg">
            Options Strategy Generator
          </h3>
          <p className="text-xs text-muted-foreground">
            AI designs a strategy — commissions, slippage &amp; risk sizing included
          </p>
        </div>
      </div>

      {/* Inputs row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground font-medium">Trade capital</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">$</span>
            <input
              type="number" min="1" placeholder="e.g. 500"
              value={amount} onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && generate()}
              className="w-full bg-background border border-border rounded-lg pl-7 pr-4 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-all"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground font-medium">Account size <span className="text-muted-foreground/60">(optional — enables 2% rule)</span></label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-sm">$</span>
            <input
              type="number" min="1" placeholder="e.g. 25000"
              value={accountSize} onChange={(e) => setAccountSize(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && generate()}
              className="w-full bg-background border border-border rounded-lg pl-7 pr-4 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-all"
            />
          </div>
        </div>
      </div>

      <button
        onClick={generate}
        disabled={loading || !amount}
        className="w-full px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
        {loading ? "Analyzing…" : "Generate Strategy"}
      </button>

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
                <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-md border",
                  DIRECTION_CONFIG[strategy.strategyType as keyof typeof DIRECTION_CONFIG]?.bg,
                  DIRECTION_CONFIG[strategy.strategyType as keyof typeof DIRECTION_CONFIG]?.color)}>
                  {strategy.strategyType?.toUpperCase()}
                </span>
                <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-md border",
                  RISK_CONFIG[strategy.riskLevel as keyof typeof RISK_CONFIG]?.bg,
                  RISK_CONFIG[strategy.riskLevel as keyof typeof RISK_CONFIG]?.color)}>
                  {strategy.riskLevel?.toUpperCase()} RISK
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground mb-1">Profit Probability</div>
              <div className="font-mono text-2xl font-bold text-[#00C853]">{strategy.probability}%</div>
            </div>
          </div>

          <DataQualityBanner dataQuality={strategy.dataQuality} />

          {/* Theoretical P&L */}
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Theoretical P&amp;L <span className="normal-case font-normal">(mid-price fills)</span>
            </h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatPill label="Total Cost" value={strategy.totalCost != null ? `${strategy.totalCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "N/A"} />
              <StatPill label="Max Profit" value={strategy.maxProfit} highlight="up" />
              <StatPill label="Max Loss"   value={strategy.maxLoss}   highlight="down" />
              <StatPill label="Breakeven"  value={strategy.breakeven} />
            </div>
          </div>

          {/* Realistic P&L after costs */}
          {strategy.friction != null && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                <h5 className="text-xs font-semibold uppercase tracking-wider text-amber-500">
                  Realistic P&amp;L after costs
                </h5>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <StatPill label="Effective Cost"       value={`${strategy.effectiveCost?.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
                <StatPill label="After-Cost Max Profit" value={strategy.effectiveMaxProfit} highlight="up" />
                <StatPill label="After-Cost Max Loss"   value={strategy.effectiveMaxLoss}   highlight="down" />
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>
                  Commission: <span className="font-mono text-foreground">${strategy.commission?.toFixed(2)}</span>
                  <span className="text-muted-foreground/60 ml-1">($0.65/contract, one-way open)</span>
                </span>
                <span>
                  Slippage: <span className="font-mono text-foreground">${strategy.slippage?.toFixed(2)}</span>
                  <span className="text-muted-foreground/60 ml-1">(½ bid-ask spread)</span>
                </span>
                <span className="font-medium text-amber-500/80">
                  Total drag: <span className="font-mono">${strategy.friction?.toFixed(2)}</span>
                </span>
              </div>
            </div>
          )}

          {/* Position sizing — 2% rule */}
          {ps && (
            <div className={cn(
              "rounded-xl border p-4 space-y-2",
              ps.exceedsRule
                ? "border-destructive/30 bg-destructive/5"
                : "border-[#00C853]/20 bg-[#00C853]/5"
            )}>
              <div className="flex items-center justify-between">
                <h5 className={cn("text-xs font-semibold uppercase tracking-wider",
                  ps.exceedsRule ? "text-destructive" : "text-[#00C853]")}>
                  Position Risk
                </h5>
                <span className={cn("font-mono font-bold text-sm",
                  ps.exceedsRule ? "text-destructive" : "text-[#00C853]")}>
                  {ps.riskPercent}% of account
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-border/50 overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all",
                    ps.exceedsRule ? "bg-destructive" : "bg-[#00C853]")}
                  style={{ width: `${Math.min(ps.riskPercent / 5 * 100, 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{ps.recommendation}</p>
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>Account: <span className="font-mono text-foreground">${ps.accountSize.toLocaleString()}</span></span>
                <span>At risk: <span className="font-mono text-foreground">${ps.riskDollars.toLocaleString()}</span></span>
                <span>2% limit: <span className="font-mono text-foreground">${ps.maxAllowedFor2Pct.toLocaleString()}</span></span>
              </div>
            </div>
          )}

          {/* Strategy Legs */}
          {strategy.legs?.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Strategy Legs</h5>
              <div className="space-y-2">
                {strategy.legs.map((leg: any, i: number) => (
                  <div key={i} className="flex flex-col gap-1 bg-background border border-border rounded-lg px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <span className={cn("text-xs font-bold px-2 py-0.5 rounded",
                        leg.action === "buy" ? "bg-[#00C853]/10 text-[#00C853]" : "bg-[#FF333A]/10 text-[#FF333A]")}>
                        {leg.action?.toUpperCase()}
                      </span>
                      <span className="font-mono text-sm font-semibold">
                        {leg.contracts}x {leg.type?.toUpperCase()}{leg.strike ? ` ${leg.strike}` : ""}
                      </span>
                      {leg.expiry && <span className="text-xs text-muted-foreground ml-auto">exp {leg.expiry}</span>}
                      {leg.premium != null && <span className="font-mono text-sm text-muted-foreground">@${leg.premium.toFixed(2)}</span>}
                    </div>
                    <GreeksRow iv={leg.impliedVolatility} delta={leg.delta} theo={leg.theoreticalPrice} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Probability methodology */}
          {strategy.probabilityMethod && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground bg-background border border-border rounded-lg px-4 py-2.5">
              <Calculator className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                <b className="text-foreground">{strategy.probability}% probability of profit</b>{" "}
                — computed via {strategy.probabilityMethod}, not an AI estimate.
              </span>
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

// ─── Main component ────────────────────────────────────────────────────────────

export default function AIAnalysisTab({ symbol }: Props) {
  const {
    data: analysis,
    isLoading,
    isError,
    refetch,
  } = useGetStockAnalysis(symbol, {
    query: {
      enabled: !!symbol,
      queryKey: getGetStockAnalysisQueryKey(symbol),
      // Evaluate at each interval tick so polling starts/stops correctly
      // across session boundaries without requiring a page reload.
      refetchInterval: () =>
        getETMarketPhase().isRegularHours ? 60_000 : false,
      staleTime: 30_000,
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-card border border-card-border rounded-2xl p-8 animate-pulse"
          >
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
          <p className="text-sm text-muted-foreground mt-1">
            Could not generate AI analysis for {symbol}
          </p>
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
  const opts = analysis.optionsSnapshot;
  const sig = analysis.signalScore;
  const levels = analysis.intradayLevels;
  const setup = analysis.tradeSetup;

  // Derive a signed score for the bidirectional SignalBar
  // conviction is 0-100; direction gives sign
  const signedScore =
    sig.direction === "bullish"
      ? sig.conviction
      : sig.direction === "bearish"
        ? -sig.conviction
        : 0;

  const signalCfg =
    DIRECTION_CONFIG[sig.direction as keyof typeof DIRECTION_CONFIG] ??
    DIRECTION_CONFIG.neutral;
  const SignalIcon = signalCfg.icon;

  const trendCfg =
    DIRECTION_CONFIG[trend.direction as keyof typeof DIRECTION_CONFIG] ??
    DIRECTION_CONFIG.neutral;
  const TrendIcon = trendCfg.icon;

  const intradayCfg =
    DIRECTION_CONFIG[intraday.bias as keyof typeof DIRECTION_CONFIG] ??
    DIRECTION_CONFIG.neutral;
  const IntradayIcon = intradayCfg.icon;

  // Computed fresh at render time for the SessionBanner indicator.
  // The refetchInterval function above also calls getETMarketPhase() independently
  // so polling transitions are always evaluated at the moment of each tick.
  const isMarketHours = getETMarketPhase().isRegularHours;

  return (
    <div className="space-y-6">
      {/* ── Session Clock ─────────────────────────────────────────── */}
      <SessionBanner
        isMarketHours={isMarketHours}
        generatedAt={analysis.generatedAt}
      />

      {/* ── Compliance disclaimer ─────────────────────────────────── */}
      <ProminentDisclaimer />

      <DataQualityBanner dataQuality={analysis.dataQuality} />

      {/* ── Trade Setup (THE premium output) ─────────────────────── */}
      <TradeSetupCard setup={setup} />

      {/* ── Technical Signal Score (formula-based) ───────────────── */}
      <div
        className={cn(
          "bg-card border rounded-2xl p-6 md:p-8 shadow-sm",
          signalCfg.glow,
          signalCfg.bg.split(" ")[1],
        )}
      >
        <div className="flex items-center gap-2 mb-6">
          <Target className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-display font-semibold">
            Intraday Signal Score
          </h2>
          <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full">
            Formula-Based
          </span>
        </div>

        <div className="flex flex-col md:flex-row gap-8">
          <div
            className={cn(
              "flex flex-col items-center justify-center rounded-2xl border p-6 md:p-8 min-w-[160px]",
              signalCfg.bg,
            )}
          >
            <SignalIcon className={cn("w-10 h-10 mb-3", signalCfg.color)} />
            <span
              className={cn(
                "text-2xl font-display font-bold",
                signalCfg.color,
              )}
            >
              {signalCfg.label}
            </span>
            <span className="text-xs text-muted-foreground mt-1">
              Signal Direction
            </span>
            <span
              className="font-mono text-lg font-bold mt-2"
              style={{
                color:
                  sig.conviction >= 70
                    ? "#00C853"
                    : sig.conviction >= 50
                      ? "#f59e0b"
                      : "#FF333A",
              }}
            >
              {sig.conviction}/100
            </span>
            <span className="text-[10px] text-muted-foreground">
              Conviction
            </span>
          </div>

          <div className="flex-1 space-y-5">
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-2">
                <span className="font-semibold uppercase tracking-wider">
                  Directional Score
                </span>
                <span>
                  {sig.bullishCount} bullish · {sig.bearishCount} bearish ·{" "}
                  {sig.neutralCount} neutral
                </span>
              </div>
              <SignalBar score={signedScore} />
            </div>

            {sig.noTradeReason && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-400/5 border border-yellow-400/20 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 mt-0.5 flex-shrink-0" />
                <span className="text-yellow-300">{sig.noTradeReason}</span>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Signal Breakdown
              </h4>
              <div className="space-y-1.5">
                {sig.signals.map((s, i) => {
                  const sc =
                    DIRECTION_CONFIG[
                      s.signal as keyof typeof DIRECTION_CONFIG
                    ] ?? DIRECTION_CONFIG.neutral;
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs"
                    >
                      <span
                        className={cn(
                          "font-bold px-1.5 py-0.5 rounded border flex-shrink-0 text-[10px]",
                          sc.bg,
                          sc.color,
                        )}
                      >
                        {s.signal === "bullish"
                          ? "↑ BUL"
                          : s.signal === "bearish"
                            ? "↓ BEA"
                            : "– NEU"}
                      </span>
                      <span className="font-semibold text-foreground flex-shrink-0 w-36">
                        {s.name}
                      </span>
                      <span className="font-mono text-muted-foreground flex-shrink-0">
                        {s.value}
                      </span>
                      <span className="text-muted-foreground ml-auto text-right hidden md:block leading-snug max-w-[40%]">
                        {s.note}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── AI Qualitative Commentary (LLM) ──────────────────────── */}
      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
        <div className="flex items-center gap-2 mb-6">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-display font-semibold">
            AI Session Commentary
          </h2>
          <span className="ml-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted border border-border px-2 py-0.5 rounded-full">
            AI-Generated
          </span>
        </div>

        <div className="flex flex-col md:flex-row gap-8">
          <div
            className={cn(
              "flex flex-col items-center justify-center rounded-2xl border p-5 min-w-[140px] opacity-80",
              trendCfg.bg,
            )}
          >
            <TrendIcon className={cn("w-8 h-8 mb-2", trendCfg.color)} />
            <span
              className={cn(
                "text-lg font-display font-bold",
                trendCfg.color,
              )}
            >
              {trendCfg.label}
            </span>
            <span className="text-[10px] text-muted-foreground mt-1 text-center leading-tight">
              AI Assessment
              <br />
              (not a signal)
            </span>
          </div>

          <div className="flex-1 space-y-4">
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
                <span className="font-semibold uppercase tracking-wider">
                  AI Conviction
                </span>
                <span className="italic">
                  LLM self-assessment — not a probability
                </span>
              </div>
              <ConfidenceBar value={trend.confidence} />
            </div>
            <p className="text-base font-semibold leading-snug">
              {trend.summary}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {trend.reasoning}
            </p>
            {trend.priceTargets && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-2">
                <StatPill
                  label="Support"
                  value={
                    trend.priceTargets.support
                      ? `$${trend.priceTargets.support.toFixed(2)}`
                      : null
                  }
                  highlight="up"
                />
                <StatPill
                  label="Resistance"
                  value={
                    trend.priceTargets.resistance
                      ? `$${trend.priceTargets.resistance.toFixed(2)}`
                      : null
                  }
                  highlight="down"
                />
                <StatPill
                  label="Session Target"
                  value={
                    (trend.priceTargets as any).sessionTarget
                      ? `$${((trend.priceTargets as any).sessionTarget as number).toFixed(2)}`
                      : null
                  }
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── AI Intraday Analysis ──────────────────────────────────── */}
      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <Activity className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-display font-semibold">
            AI Intraday Analysis
          </h2>
          {intraday.topPick && (
            <span className="ml-auto flex items-center gap-1.5 bg-primary/10 border border-primary/30 text-primary text-xs font-bold px-3 py-1 rounded-full">
              <Zap className="w-3 h-3" /> TODAY'S TOP PICK
            </span>
          )}
        </div>

        <div className="flex flex-col md:flex-row gap-6">
          <div
            className={cn(
              "flex flex-col items-center justify-center rounded-xl border p-5 min-w-[130px]",
              intradayCfg.bg,
            )}
          >
            <IntradayIcon
              className={cn("w-7 h-7 mb-2", intradayCfg.color)}
            />
            <span
              className={cn(
                "text-lg font-bold font-display",
                intradayCfg.color,
              )}
            >
              {intradayCfg.label}
            </span>
            <span className="text-xs text-muted-foreground mt-0.5">
              Session Bias
            </span>
          </div>

          <div className="flex-1 space-y-4">
            {intraday.topPickReason && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <Zap className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                <p className="text-sm font-medium text-primary">
                  {intraday.topPickReason}
                </p>
              </div>
            )}
            <p className="text-sm text-muted-foreground leading-relaxed">
              {intraday.setup}
            </p>

            {intraday.keyLevels?.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Key Levels (AI)
                </h4>
                {intraday.keyLevels.map((level: any, i: number) => {
                  const levelColor =
                    level.type === "support"
                      ? "text-[#00C853] bg-[#00C853]/5 border-[#00C853]/20"
                      : level.type === "resistance"
                        ? "text-[#FF333A] bg-[#FF333A]/5 border-[#FF333A]/20"
                        : "text-yellow-400 bg-yellow-400/5 border-yellow-400/20";
                  return (
                    <div
                      key={i}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-4 py-2.5",
                        levelColor,
                      )}
                    >
                      <span className="font-mono font-bold text-sm">
                        ${level.price.toFixed(2)}
                      </span>
                      <span className="text-xs font-semibold uppercase">
                        {level.type}
                      </span>
                      <span className="text-xs opacity-80 ml-auto text-right max-w-[60%]">
                        {level.significance}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Intraday Key Levels ───────────────────────────────────── */}
      <IntradayLevelsCard levels={levels} />

      {/* ── Options Snapshot ──────────────────────────────────────── */}
      {opts && (
        <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <TrendingUp className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-display font-semibold">
              Options Snapshot
            </h2>
            <span
              className={cn(
                "ml-auto text-xs font-semibold px-2 py-0.5 rounded-md border",
                DIRECTION_CONFIG[
                  opts.sentiment as keyof typeof DIRECTION_CONFIG
                ]?.bg,
                DIRECTION_CONFIG[
                  opts.sentiment as keyof typeof DIRECTION_CONFIG
                ]?.color,
              )}
            >
              {opts.sentiment?.toUpperCase()} FLOW
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
            <StatPill
              label="Put/Call Ratio"
              value={opts.putCallRatio ?? null}
              highlight={
                opts.putCallRatio != null
                  ? opts.putCallRatio > 1
                    ? "down"
                    : "up"
                  : undefined
              }
            />
            <div className="bg-background rounded-lg border border-border p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">
                Unusual Activity
              </span>
              <p className="text-sm text-muted-foreground">
                {opts.unusualActivity}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {opts.topCallPick && (
              <div className="bg-[#00C853]/5 border border-[#00C853]/20 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-[#00C853]" />
                  <span className="text-xs font-bold text-[#00C853] uppercase tracking-wider">
                    Top Call Pick
                  </span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold">
                    ${opts.topCallPick.strike}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    exp {opts.topCallPick.expiry}
                  </span>
                  {opts.topCallPick.premium && (
                    <span className="font-mono text-sm text-muted-foreground ml-auto">
                      @${opts.topCallPick.premium.toFixed(2)}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {opts.topCallPick.rationale}
                </p>
                <GreeksRow
                  iv={opts.topCallPick.impliedVolatility}
                  delta={opts.topCallPick.delta}
                  theo={opts.topCallPick.theoreticalPrice}
                />
                {opts.topCallPick.probabilityITM != null && (
                  <p className="text-xs text-muted-foreground font-mono">
                    Prob. ITM at expiry:{" "}
                    <b className="text-foreground">
                      {opts.topCallPick.probabilityITM}%
                    </b>
                  </p>
                )}
              </div>
            )}
            {opts.topPutPick && (
              <div className="bg-[#FF333A]/5 border border-[#FF333A]/20 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <TrendingDown className="w-4 h-4 text-[#FF333A]" />
                  <span className="text-xs font-bold text-[#FF333A] uppercase tracking-wider">
                    Top Put Pick
                  </span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold">
                    ${opts.topPutPick.strike}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    exp {opts.topPutPick.expiry}
                  </span>
                  {opts.topPutPick.premium && (
                    <span className="font-mono text-sm text-muted-foreground ml-auto">
                      @${opts.topPutPick.premium.toFixed(2)}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {opts.topPutPick.rationale}
                </p>
                <GreeksRow
                  iv={opts.topPutPick.impliedVolatility}
                  delta={opts.topPutPick.delta}
                  theo={opts.topPutPick.theoreticalPrice}
                />
                {opts.topPutPick.probabilityITM != null && (
                  <p className="text-xs text-muted-foreground font-mono">
                    Prob. ITM at expiry:{" "}
                    <b className="text-foreground">
                      {opts.topPutPick.probabilityITM}%
                    </b>
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Options Strategy Generator ───────────────────────────── */}
      <OptionsStrategyPanel symbol={symbol} />

      <p className="text-xs text-muted-foreground text-center pb-4 opacity-60">
        All analysis is for informational purposes only. See the disclosure
        above.
      </p>
    </div>
  );
}
