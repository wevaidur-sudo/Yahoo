import { fetchAndCacheFundamentals } from "../lib/ml/pipeline";

const symbols = process.argv.slice(2);

async function main() {
  console.log(`[fund-chunk] Fetching ${symbols.length} symbols: ${symbols.join(",")}`);
  await fetchAndCacheFundamentals(symbols);
  console.log("[fund-chunk] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[fund-chunk] FAILED:", err);
  process.exit(1);
});
