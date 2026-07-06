import { Link } from "wouter";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-[70vh] w-full flex items-center justify-center">
      <div className="max-w-md w-full bg-card border border-border p-8 rounded-2xl text-center space-y-6 shadow-xl">
        <div className="mx-auto w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mb-4 border border-destructive/20">
          <AlertCircle className="w-8 h-8 text-destructive" />
        </div>
        <h1 className="text-4xl font-display font-bold">404</h1>
        <p className="text-muted-foreground text-lg">
          The page you're looking for doesn't exist.
        </p>
        <div className="pt-4">
          <Link 
            href="/" 
            className="inline-block bg-primary text-primary-foreground px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity"
          >
            Return Home
          </Link>
        </div>
      </div>
    </div>
  );
}
