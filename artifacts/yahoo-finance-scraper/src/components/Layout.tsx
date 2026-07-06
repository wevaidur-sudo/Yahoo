import { Link } from "wouter";
import SearchBar from "./SearchBar";
import { LineChart } from "lucide-react";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col w-full bg-background text-foreground selection:bg-primary/20">
      <header className="sticky top-0 z-40 w-full border-b border-border/40 bg-background/80 backdrop-blur-md">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <div className="bg-primary/10 p-1.5 rounded-md">
              <LineChart className="w-5 h-5 text-primary" />
            </div>
            <span className="font-display font-bold text-xl hidden sm:inline-block tracking-tight">FinanceScope</span>
          </Link>
          
          <div className="flex-1 max-w-xl mx-auto">
            <SearchBar />
          </div>
        </div>
      </header>
      
      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
      
      <footer className="border-t border-border/40 py-8 mt-auto text-center text-muted-foreground text-sm font-medium">
        <p>FinanceScope &copy; {new Date().getFullYear()}. Data sourced from Yahoo Finance.</p>
      </footer>
    </div>
  );
}
