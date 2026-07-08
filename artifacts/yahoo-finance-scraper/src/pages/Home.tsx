import { useGetTrending, getGetTrendingQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { TrendingUp, TrendingDown, Activity } from "lucide-react";
import { formatCurrency, formatPercent, cn } from "@/lib/utils";

export default function Home() {
  const { data: trending, isLoading, isError } = useGetTrending({
    query: { queryKey: getGetTrendingQueryKey(), refetchInterval: 1_000 }
  });

  return (
    <div className="flex flex-col gap-14 max-w-5xl mx-auto py-8">
      <section className="text-center space-y-6 py-12">
        <h1 className="text-4xl md:text-6xl font-display font-bold tracking-tighter">
          Market Intelligence, <span className="text-primary">Refined.</span>
        </h1>
        <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto leading-relaxed">
          Institutional-grade data and analytics for the modern investor. 
          Search for a symbol above to get started.
        </p>
      </section>

      <section className="space-y-6">
        <div className="flex items-center justify-between border-b border-border/50 pb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-display font-semibold">Trending Tickers</h2>
          </div>
          {!isLoading && !isError && (
            <span className="flex items-center gap-1.5 text-xs text-[#00C853] font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00C853] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#00C853]" />
              </span>
              Live
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-36 bg-card rounded-xl border border-border animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <div className="text-center p-8 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive font-medium">
            Failed to load trending tickers. Please try again later.
          </div>
        ) : trending && trending.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {trending.map((ticker) => {
              const isUp = (ticker.changePercent || 0) >= 0;
              return (
                <Link
                  key={ticker.symbol}
                  href={`/stock/${ticker.symbol}`}
                  className="group block p-5 bg-card rounded-xl border border-card-border hover:border-primary/40 transition-all duration-300 hover:shadow-xl hover:shadow-primary/5 hover:-translate-y-0.5"
                >
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      <h3 className="font-mono text-lg font-bold group-hover:text-primary transition-colors">
                        {ticker.symbol}
                      </h3>
                      <p className="text-sm text-muted-foreground truncate max-w-[120px]">
                        {ticker.name}
                      </p>
                    </div>
                    <div className={cn(
                      "flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md",
                      isUp ? "bg-[#00C853]/10 text-[#00C853]" : "bg-[#FF333A]/10 text-[#FF333A]"
                    )}>
                      {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {formatPercent(ticker.changePercent)}
                    </div>
                  </div>
                  
                  <div className="flex justify-between items-end">
                    <div className="font-mono text-xl font-medium tracking-tight">
                      {formatCurrency(ticker.price)}
                    </div>
                    <div className={cn(
                      "text-sm font-mono font-medium",
                      isUp ? "text-[#00C853]" : "text-[#FF333A]"
                    )}>
                      {ticker.change && ticker.change > 0 ? "+" : ""}{ticker.change?.toFixed(2)}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="text-center p-12 text-muted-foreground border border-border border-dashed rounded-xl">
            No trending tickers available.
          </div>
        )}
      </section>
    </div>
  );
}
