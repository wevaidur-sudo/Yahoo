import { useState, useMemo } from "react";
import { useParams } from "wouter";
import AIAnalysisTab from "@/components/AIAnalysisTab";
import { 
  useGetQuote, getGetQuoteQueryKey,
  useGetPriceHistory, getGetPriceHistoryQueryKey,
  useGetCompanySummary, getGetCompanySummaryQueryKey,
  useGetNews, getGetNewsQueryKey,
  HistoryPeriod 
} from "@workspace/api-client-react";
import { formatCurrency, formatCompactNumber, formatPercent, cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Clock, Globe, MapPin, Users, Briefcase, Newspaper } from "lucide-react";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer 
} from "recharts";
import { format, formatDistanceToNow, differenceInHours } from "date-fns";

const PERIODS: { label: string; value: HistoryPeriod }[] = [
  { label: '1D', value: '1d' },
  { label: '5D', value: '5d' },
  { label: '1M', value: '1mo' },
  { label: '3M', value: '3mo' },
  { label: '6M', value: '6mo' },
  { label: '1Y', value: '1y' },
  { label: '5Y', value: '5y' },
];

export default function StockDetail() {
  const params = useParams<{ symbol: string }>();
  const symbol = params.symbol?.toUpperCase() || "";
  
  const [period, setPeriod] = useState<HistoryPeriod>('1mo');
  const [activeTab, setActiveTab] = useState<'overview' | 'ai'>('overview');

  const { data: quote, isLoading: isQuoteLoading } = useGetQuote(symbol, { 
    query: { enabled: !!symbol, queryKey: getGetQuoteQueryKey(symbol), refetchInterval: 1_000 } 
  });
  
  const { data: history, isLoading: isHistoryLoading } = useGetPriceHistory(symbol, period, { 
    query: { enabled: !!symbol, queryKey: getGetPriceHistoryQueryKey(symbol, period) } 
  });
  
  const { data: summary, isLoading: isSummaryLoading } = useGetCompanySummary(symbol, { 
    query: { enabled: !!symbol, queryKey: getGetCompanySummaryQueryKey(symbol) } 
  });
  
  const { data: news, isLoading: isNewsLoading } = useGetNews(symbol, { 
    query: { enabled: !!symbol, queryKey: getGetNewsQueryKey(symbol) } 
  });

  const isUp = quote ? (quote.changePercent || 0) >= 0 : true;
  const quoteColorClass = isUp ? "text-[#00C853]" : "text-[#FF333A]";

  const marketStateLabel = (state: string | null | undefined) => {
    switch (state) {
      case "PRE":
      case "PREPRE":
        return "Pre-Market";
      case "POST":
      case "POSTPOST":
        return "After Hours";
      case "REGULAR":
        return "Market Open";
      case "CLOSED":
        return "Market Closed";
      default:
        return state ?? "Unknown";
    }
  };

  const extendedPrice = (() => {
    if (!quote) return null;
    const { marketState, preMarketPrice, preMarketChange, preMarketChangePercent, postMarketPrice, postMarketChange, postMarketChangePercent } = quote;
    if (marketState === "PRE" || marketState === "PREPRE") {
      return { price: preMarketPrice, change: preMarketChange, pct: preMarketChangePercent, label: "Pre-Market" };
    }
    if (marketState === "POST" || marketState === "POSTPOST") {
      return { price: postMarketPrice, change: postMarketChange, pct: postMarketChangePercent, label: "After Hours" };
    }
    // Market is CLOSED but extended-hours data is still available from Yahoo Finance
    if (marketState === "CLOSED") {
      if (postMarketPrice != null) {
        return { price: postMarketPrice, change: postMarketChange, pct: postMarketChangePercent, label: "After Hours" };
      }
      if (preMarketPrice != null) {
        return { price: preMarketPrice, change: preMarketChange, pct: preMarketChangePercent, label: "Pre-Market" };
      }
    }
    return null;
  })();

  // Chart data processing
  const chartData = useMemo(() => {
    if (!history) return [];
    return history.map(point => ({
      ...point,
      formattedDate: ['1d', '5d'].includes(period) 
        ? format(new Date(point.date), "HH:mm") 
        : format(new Date(point.date), "MMM d, yyyy"),
      numericDate: new Date(point.date).getTime()
    }));
  }, [history, period]);

  const chartColor = useMemo(() => {
    if (!chartData || chartData.length < 2) return "#4d94ff"; // primary var fallback
    const first = chartData[0].close || 0;
    const last = chartData[chartData.length - 1].close || 0;
    return last >= first ? "#00C853" : "#FF333A";
  }, [chartData]);


  if (!symbol) return null;

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      {/* Header / Quote Section */}

      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6 pb-2">
        {isQuoteLoading ? (
          <div className="h-32 w-72 bg-card animate-pulse rounded-lg border border-border" />
        ) : quote ? (
          <div>
            <div className="flex items-center gap-3 mb-1.5">
              <h1 className="text-4xl md:text-5xl font-display font-bold tracking-tight">{quote.symbol}</h1>
              <span className="text-xl md:text-2xl text-muted-foreground font-medium">{quote.name}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground mb-5 font-medium">
              <span className="bg-muted px-2 py-0.5 rounded border border-border">{quote.exchange}</span>
              <span>•</span>
              <span>Currency in {quote.currency}</span>
              <span>•</span>
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                {marketStateLabel(quote.marketState)}
              </span>
              <span>•</span>
              <span className="flex items-center gap-1.5 text-[#00C853]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00C853] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00C853]" />
                </span>
                Live
              </span>
            </div>
            <div className="flex items-end gap-5">
              <span className="text-5xl md:text-6xl font-mono font-medium tracking-tighter">
                {formatCurrency(quote.price, quote.currency || "USD")}
              </span>
              <div className={cn("flex items-center gap-2 mb-2 font-mono text-xl font-medium", quoteColorClass)}>
                {isUp ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
                <span>{quote.change && quote.change > 0 ? "+" : ""}{quote.change?.toFixed(2)}</span>
                <span>({formatPercent(quote.changePercent)})</span>
              </div>
            </div>
            {extendedPrice && extendedPrice.price != null && (
              <div className="flex items-center gap-3 mt-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground bg-muted px-2 py-0.5 rounded border border-border">
                  {extendedPrice.label}
                </span>
                <span className="font-mono text-lg font-medium text-foreground">
                  {formatCurrency(extendedPrice.price, quote.currency || "USD")}
                </span>
                {extendedPrice.change != null && (
                  <span className={cn(
                    "font-mono text-sm font-medium",
                    (extendedPrice.change ?? 0) >= 0 ? "text-[#00C853]" : "text-[#FF333A]"
                  )}>
                    {extendedPrice.change > 0 ? "+" : ""}{extendedPrice.change.toFixed(2)}
                    {extendedPrice.pct != null && (
                      <span className="ml-1">({formatPercent(extendedPrice.pct)})</span>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 bg-destructive/10 text-destructive border border-destructive/20 rounded-lg">
            Failed to load quote data. Please try again.
          </div>
        )}
      </section>

      {/* Tab Bar */}
      <div className="flex items-center gap-1 bg-card border border-card-border rounded-xl p-1 w-fit">
        {([
          { id: 'overview', label: 'Overview' },
          { id: 'ai', label: '✦ AI Analysis' },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "px-5 py-2 text-sm font-semibold rounded-lg transition-all duration-200",
              activeTab === tab.id
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* AI Analysis Tab */}
      {activeTab === 'ai' && <AIAnalysisTab symbol={symbol} />}

      {/* Overview Tab */}
      {activeTab === 'overview' && <>

      {/* Chart Section */}
      <section className="bg-card border border-card-border rounded-2xl p-5 md:p-7 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <h2 className="text-lg font-display font-semibold">Price History</h2>
          <div className="flex flex-wrap items-center bg-background rounded-md p-1 border border-border gap-0.5">
            {PERIODS.map(p => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold rounded-sm transition-colors",
                  period === p.value 
                    ? "bg-primary text-primary-foreground shadow-sm" 
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="h-[400px] w-full">
          {isHistoryLoading ? (
            <div className="w-full h-full flex items-center justify-center">
              <div className="animate-pulse w-full h-full bg-muted/20 border border-border/50 rounded-xl" />
            </div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.6} />
                <XAxis 
                  dataKey="formattedDate" 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                  minTickGap={40}
                  dy={10}
                />
                <YAxis 
                  domain={['auto', 'auto']} 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))', fontFamily: 'var(--app-font-mono)', fontWeight: 500 }}
                  tickFormatter={(val) => `$${val}`}
                  dx={-10}
                />
                <RechartsTooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    borderColor: 'hsl(var(--border))',
                    borderRadius: '8px',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                    color: 'hsl(var(--foreground))'
                  }}
                  itemStyle={{ fontFamily: 'var(--app-font-mono)', fontWeight: 600 }}
                  labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '6px', fontSize: '13px' }}
                />
                <Area 
                  type="monotone" 
                  dataKey="close" 
                  stroke={chartColor} 
                  strokeWidth={2.5}
                  fillOpacity={1} 
                  fill="url(#colorPrice)" 
                  animationDuration={800}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground border border-dashed border-border rounded-xl">
              No price history available for this period.
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Stats & Summary */}
        <div className="lg:col-span-2 space-y-8">
          {/* Key Statistics */}
          <section className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
            <h2 className="text-xl font-display font-semibold mb-6 pb-4 border-b border-border/50">Key Statistics</h2>
            {isQuoteLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-y-8 gap-x-6">
                {[...Array(9)].map((_, i) => (
                  <div key={i} className="h-12 bg-muted/30 animate-pulse rounded-md" />
                ))}
              </div>
            ) : quote ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-y-8 gap-x-6">
                <StatItem label="Market Cap" value={formatCompactNumber(quote.marketCap)} />
                <StatItem label="Volume" value={formatCompactNumber(quote.volume)} />
                <StatItem label="Avg Volume (3M)" value={formatCompactNumber(quote.avgVolume)} />
                <StatItem label="P/E Ratio" value={quote.peRatio?.toFixed(2) || "-"} />
                <StatItem label="EPS" value={quote.eps?.toFixed(2) || "-"} />
                <StatItem label="52W Range" value={`${quote.fiftyTwoWeekLow?.toFixed(2) || "-"} - ${quote.fiftyTwoWeekHigh?.toFixed(2) || "-"}`} />
                <StatItem label="Open" value={formatCurrency(quote.open, quote.currency || "USD")} />
                <StatItem label="High" value={formatCurrency(quote.high, quote.currency || "USD")} />
                <StatItem label="Low" value={formatCurrency(quote.low, quote.currency || "USD")} />
              </div>
            ) : null}
          </section>

          {/* Company Profile */}
          <section className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm">
            <h2 className="text-xl font-display font-semibold mb-6 pb-4 border-b border-border/50">Company Profile</h2>
            {isSummaryLoading ? (
              <div className="space-y-4">
                <div className="h-4 bg-muted/30 animate-pulse rounded w-full" />
                <div className="h-4 bg-muted/30 animate-pulse rounded w-11/12" />
                <div className="h-4 bg-muted/30 animate-pulse rounded w-4/5" />
                <div className="h-16 bg-muted/30 animate-pulse rounded w-full mt-6" />
              </div>
            ) : summary ? (
              <div className="space-y-8">
                <p className="text-muted-foreground leading-relaxed text-sm md:text-base">
                  {summary.description || "No description available."}
                </p>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-6 border-t border-border/50">
                  <ProfileItem icon={<Briefcase className="w-4 h-4" />} label="Sector" value={summary.sector} />
                  <ProfileItem icon={<Globe className="w-4 h-4" />} label="Industry" value={summary.industry} />
                  <ProfileItem icon={<Users className="w-4 h-4" />} label="Employees" value={summary.employees?.toLocaleString()} />
                  <ProfileItem icon={<MapPin className="w-4 h-4" />} label="Location" value={[summary.city, summary.country].filter(Boolean).join(", ")} />
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground border border-dashed border-border p-6 rounded-xl text-center">
                Profile information not available.
              </div>
            )}
          </section>
        </div>

        {/* Right Column: News */}
        <div className="space-y-6">
          <h2 className="text-xl font-display font-semibold flex items-center gap-2 px-1">
            <Newspaper className="w-5 h-5 text-primary" />
            Latest News
          </h2>
          
          {isNewsLoading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-28 bg-card border border-border animate-pulse rounded-xl" />
              ))}
            </div>
          ) : news && news.length > 0 ? (
            <div className="space-y-4">
              {news.map((item, idx) => (
                <a 
                  key={idx} 
                  href={item.link} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="block bg-card hover:bg-muted/40 border border-card-border rounded-xl p-5 transition-all duration-200 group hover:-translate-y-0.5 hover:shadow-md"
                >
                  <div className="flex justify-between items-start gap-4 mb-3">
                    <h3 className="font-semibold text-sm md:text-base group-hover:text-primary transition-colors line-clamp-3 leading-snug">
                      {item.title}
                    </h3>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground font-medium">
                    <span className="bg-background px-2 py-1 rounded border border-border">{item.publisher || "News"}</span>
                    <span>{item.publishedAt ? (() => {
                      const d = new Date(item.publishedAt);
                      return differenceInHours(new Date(), d) < 24
                        ? formatDistanceToNow(d, { addSuffix: true })
                        : format(d, "MMM d, h:mm a");
                    })() : ""}</span>
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <div className="p-8 bg-card border border-dashed border-border rounded-xl text-center text-muted-foreground text-sm">
              No recent news found for this symbol.
            </div>
          )}
        </div>
      </div>

      </>}
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">{label}</span>
      <span className="font-mono text-foreground font-medium text-lg">{value}</span>
    </div>
  );
}

function ProfileItem({ icon, label, value }: { icon: React.ReactNode; label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="text-muted-foreground bg-muted p-2.5 rounded-lg border border-border/50">
        {icon}
      </div>
      <div className="flex flex-col">
        <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">{label}</span>
        <span className="font-medium text-foreground">{value}</span>
      </div>
    </div>
  );
}
