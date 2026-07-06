import { useState, useEffect, useRef } from "react";
import { Search, X } from "lucide-react";
import { useLocation } from "wouter";
import { useSearchSymbols, getSearchSymbolsQueryKey } from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";

export default function SearchBar() {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const debouncedQuery = useDebounce(query, 300);
  const [, setLocation] = useLocation();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { data: results, isLoading } = useSearchSymbols(
    { q: debouncedQuery },
    { 
      query: { 
        enabled: debouncedQuery.length > 0,
        queryKey: getSearchSymbolsQueryKey({ q: debouncedQuery })
      } 
    }
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (symbol: string) => {
    setQuery("");
    setIsOpen(false);
    setLocation(`/stock/${symbol}`);
  };

  return (
    <div ref={wrapperRef} className="relative w-full">
      <div className={cn(
        "relative flex items-center w-full rounded-md border border-border/80 bg-card overflow-hidden transition-all shadow-sm",
        isOpen ? "ring-2 ring-primary/20 border-primary/50" : "hover:border-border"
      )}>
        <div className="pl-3 text-muted-foreground">
          <Search className="w-4 h-4" />
        </div>
        <input
          type="text"
          className="w-full bg-transparent border-none py-2.5 px-3 text-sm outline-none placeholder:text-muted-foreground/70"
          placeholder="Search tickers or companies..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
        />
        {query && (
          <button 
            onClick={() => setQuery("")}
            className="pr-3 text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {isOpen && query.length > 0 && (
        <div className="absolute top-full mt-2 w-full bg-card border border-border rounded-md shadow-xl overflow-hidden z-50">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">Searching...</div>
          ) : results && results.length > 0 ? (
            <div className="max-h-80 overflow-y-auto py-2">
              {results.map((result) => (
                <button
                  key={result.symbol}
                  onClick={() => handleSelect(result.symbol)}
                  className="w-full text-left px-4 py-2.5 hover:bg-muted/50 flex items-center justify-between group transition-colors"
                >
                  <div className="flex flex-col">
                    <span className="font-mono font-medium text-foreground group-hover:text-primary transition-colors">
                      {result.symbol}
                    </span>
                    <span className="text-xs text-muted-foreground truncate max-w-[200px] sm:max-w-[300px]">
                      {result.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="bg-background px-2 py-0.5 rounded border border-border">
                      {result.exchange}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 text-center text-sm text-muted-foreground">No results found for "{query}"</div>
          )}
        </div>
      )}
    </div>
  );
}
