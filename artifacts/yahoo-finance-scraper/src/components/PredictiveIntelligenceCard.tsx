import { cn } from "@/lib/utils";
import {
  TrendingUp, TrendingDown, Minus, Zap, Brain,
  Activity, Globe, BarChart2, ChevronDown, ChevronUp,
} from "lucide-react";
import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PredictiveLayer {
  direction: "bullish" | "bearish" | "neutral";
  score: number;
  note: string;
}

interface PreMarketLayer extends PredictiveLayer {
  velocityPctPerHour: number;
  volumeSurge: number;
  blockTradeDetected: boolean;
  earningsInDays: number | null;
}

interface OptionsFlowLayer extends PredictiveLayer {
  unusualCallStrikes: number[];
  unusualPutStrikes: number[];
  ivSkewPct: number;
  fullChainPCR: number | null;
}

interface NewsCatalystLayer extends PredictiveLayer {
  rawScore: number;
  isEarningsDriven: boolean;
  catalystSummary: string;
}

interface MarketRegimeLayer extends PredictiveLayer {
  spyAbove20SMA: boolean | null;
  vixLevel: number | null;
  vixRegime: "fear" | "elevated" | "normal" | "complacent" | null;
}

interface MLPredictionLayer extends PredictiveLayer {
  probability: number;
  hasSufficientData: boolean;
  trainingSampleCount: number;
}

export interface PredictiveIntelligence {
  preMarketMomentum: PreMarketLayer | null;
  optionsFlow: OptionsFlowLayer | null;
  newsCatalyst: NewsCatalystLayer | null;
  marketRegime: MarketRegimeLayer | null;
  mlPrediction: MLPredictionLayer | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DIR = {
  bullish: { color: "text-[#00C853]", bg: "bg-[#00C853]/10 border-[#00C853]/20", Icon: TrendingUp, label: "Bullish" },
  bearish: { color: "text-[#FF333A]", bg: "bg-[#FF333A]/10 border-[#FF333A]/20", Icon: TrendingDown, label: "Bearish" },
  neutral: { color: "text-yellow-400", bg: "bg-yellow-400/10 border-yellow-400/20", Icon: Minus, label: "Neutral" },
};

function ScoreBar({ score, maxWeight }: { score: number; maxWeight: number }) {
  const pct   = Math.min(100, Math.round((Math.abs(score) / maxWeight) * 100));
  const color = score > 0 ? "#00C853" : score < 0 ? "#FF333A" : "#f59e0b";
  const isPos = score >= 0;
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="relative h-1.5 flex-1 rounded-full bg-muted flex overflow-hidden">
        <div className="flex-1 flex justify-end pr-px">
          {!isPos && <div className="h-full rounded-l-full" style={{ width: `${pct}%`, backgroundColor: "#FF333A" }} />}
        </div>
        <div className="w-px bg-border/60 flex-shrink-0" />
        <div className="flex-1 flex justify-start pl-px">
          {isPos && <div className="h-full rounded-r-full" style={{ width: `${pct}%`, backgroundColor: "#00C853" }} />}
        </div>
      </div>
      <span className="text-[11px] font-mono font-bold w-10 text-right" style={{ color }}>
        {score > 0 ? "+" : ""}{score}
      </span>
    </div>
  );
}

function LayerRow({
  icon: Icon,
  label,
  direction,
  score,
  maxWeight,
  value,
  note,
  extra,
}: {
  icon: React.ElementType;
  label: string;
  direction: "bullish" | "bearish" | "neutral";
  score: number;
  maxWeight: number;
  value?: string;
  note: string;
  extra?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const d = DIR[direction];
  return (
    <div className={cn("rounded-xl border p-3 transition-colors", d.bg)}>
      <button
        className="w-full flex items-center gap-3 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className={cn("p-1.5 rounded-lg border", d.bg)}>
          <Icon className={cn("w-3.5 h-3.5", d.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">{label}</span>
            <span className={cn("text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border", d.bg, d.color)}>
              {d.label}
            </span>
          </div>
          {value && <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">{value}</p>}
        </div>
        <ScoreBar score={score} maxWeight={maxWeight} />
        {open ? <ChevronUp className="w-3 h-3 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-border/40 space-y-2">
          <p className="text-xs text-muted-foreground leading-relaxed">{note}</p>
          {extra}
        </div>
      )}
    </div>
  );
}

// ─── Main card ────────────────────────────────────────────────────────────────

export function PredictiveIntelligenceCard({ data }: { data: PredictiveIntelligence }) {
  const layers = [
    data.preMarketMomentum,
    data.optionsFlow,
    data.newsCatalyst,
    data.marketRegime,
    data.mlPrediction,
  ].filter(Boolean);

  if (!layers.length) return null;

  // Composite direction: weighted by |score|
  const totalScore = layers.reduce((s, l) => s + (l?.score ?? 0), 0);
  const compositeDir: "bullish" | "bearish" | "neutral" =
    totalScore > 5 ? "bullish" : totalScore < -5 ? "bearish" : "neutral";
  const cd = DIR[compositeDir];
  const CompositeIcon = cd.Icon;

  return (
    <div className="bg-card border border-border rounded-2xl p-6 space-y-5 shadow-sm">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-xl bg-primary/10 border border-primary/20">
          <Brain className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-display font-semibold">Predictive Intelligence</h2>
            <span className="text-[10px] font-bold uppercase tracking-wider text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full">
              Pre-Move Signals
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Leading indicators that fire <strong className="text-foreground">before</strong> price confirms the move — institutional positioning, PM momentum, news catalysts, and ML pattern recognition.
          </p>
        </div>
      </div>

      {/* Composite verdict */}
      <div className={cn("flex items-center gap-3 p-4 rounded-xl border", cd.bg)}>
        <CompositeIcon className={cn("w-5 h-5", cd.color)} />
        <div className="flex-1">
          <p className="text-sm font-semibold">
            Composite pre-move signal: <span className={cd.color}>{cd.label}</span>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Net score across all leading indicators: {totalScore > 0 ? "+" : ""}{totalScore}
          </p>
        </div>
      </div>

      {/* Individual layers */}
      <div className="space-y-2">
        {/* 1. Pre-Market Momentum */}
        {data.preMarketMomentum && (
          <LayerRow
            icon={Activity}
            label="Pre-Market Momentum"
            direction={data.preMarketMomentum.direction}
            score={data.preMarketMomentum.score}
            maxWeight={30}
            value={`${data.preMarketMomentum.velocityPctPerHour >= 0 ? "+" : ""}${data.preMarketMomentum.velocityPctPerHour.toFixed(2)}%/hr${data.preMarketMomentum.blockTradeDetected ? " · ⚡ Block trade detected" : ""}${data.preMarketMomentum.volumeSurge >= 2 ? ` · ${data.preMarketMomentum.volumeSurge.toFixed(1)}× volume surge` : ""}`}
            note={data.preMarketMomentum.note}
            extra={
              data.preMarketMomentum.earningsInDays != null && data.preMarketMomentum.earningsInDays <= 7
                ? (
                  <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
                    <Zap className="w-3 h-3" />
                    Earnings in {data.preMarketMomentum.earningsInDays} day{data.preMarketMomentum.earningsInDays !== 1 ? "s" : ""} — expect elevated volatility
                  </div>
                )
                : null
            }
          />
        )}

        {/* 2. Options Flow */}
        {data.optionsFlow && (
          <LayerRow
            icon={BarChart2}
            label="Options Flow (Smart Money)"
            direction={data.optionsFlow.direction}
            score={data.optionsFlow.score}
            maxWeight={15}
            value={[
              data.optionsFlow.fullChainPCR != null ? `PCR ${data.optionsFlow.fullChainPCR}` : null,
              Math.abs(data.optionsFlow.ivSkewPct) > 1 ? `IV skew ${data.optionsFlow.ivSkewPct > 0 ? "+" : ""}${data.optionsFlow.ivSkewPct.toFixed(1)}%` : null,
              data.optionsFlow.unusualCallStrikes.length ? `Unusual calls @ $${data.optionsFlow.unusualCallStrikes.slice(0,2).join(", $")}` : null,
              data.optionsFlow.unusualPutStrikes.length  ? `Unusual puts @ $${data.optionsFlow.unusualPutStrikes.slice(0,2).join(", $")}` : null,
            ].filter(Boolean).join(" · ")}
            note={data.optionsFlow.note}
          />
        )}

        {/* 3. News Catalyst */}
        {data.newsCatalyst && (
          <LayerRow
            icon={Zap}
            label="News Catalyst"
            direction={data.newsCatalyst.direction}
            score={data.newsCatalyst.score}
            maxWeight={15}
            value={`Sentiment ${data.newsCatalyst.rawScore >= 0 ? "+" : ""}${data.newsCatalyst.rawScore}/100${data.newsCatalyst.isEarningsDriven ? " · Earnings-driven" : ""}`}
            note={data.newsCatalyst.note}
            extra={
              data.newsCatalyst.catalystSummary && data.newsCatalyst.catalystSummary !== "No significant catalyst identified" ? (
                <p className="text-xs italic text-muted-foreground border-l-2 border-primary/30 pl-3">
                  "{data.newsCatalyst.catalystSummary}"
                </p>
              ) : null
            }
          />
        )}

        {/* 4. Market Regime */}
        {data.marketRegime && (
          <LayerRow
            icon={Globe}
            label="Market Regime (SPY + VIX)"
            direction={data.marketRegime.direction}
            score={data.marketRegime.score}
            maxWeight={10}
            value={[
              data.marketRegime.vixLevel != null ? `VIX ${data.marketRegime.vixLevel} (${data.marketRegime.vixRegime ?? "?"})` : null,
              data.marketRegime.spyAbove20SMA === true  ? "SPY ▲ above 20-SMA" :
              data.marketRegime.spyAbove20SMA === false ? "SPY ▼ below 20-SMA" : null,
            ].filter(Boolean).join(" · ")}
            note={data.marketRegime.note}
          />
        )}

        {/* 5. ML Model */}
        {data.mlPrediction && (
          <LayerRow
            icon={Brain}
            label="ML Model Edge"
            direction={data.mlPrediction.direction}
            score={data.mlPrediction.score}
            maxWeight={15}
            value={
              data.mlPrediction.hasSufficientData
                ? `${(data.mlPrediction.probability * 100).toFixed(0)}% probability correct · ${data.mlPrediction.trainingSampleCount} training samples`
                : `Cold start — ${data.mlPrediction.trainingSampleCount} samples recorded (need 30)`
            }
            note={data.mlPrediction.note}
          />
        )}
      </div>

      {/* Footer disclaimer */}
      <p className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-3">
        Predictive signals augment — but do not replace — the deterministic intraday score. The combined conviction score reflects all layers. Always confirm with your broker before trading.
      </p>
    </div>
  );
}
