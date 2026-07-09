import { fetchAndStoreHistory } from "../lib/ml/pipeline";

const symbols = process.argv.slice(2);

async function main() {
  console.log(`[fetch-chunk] Fetching ${symbols.length} symbols: ${symbols.join(",")}`);
  await fetchAndStoreHistory(symbols);
  console.log("[fetch-chunk] Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[fetch-chunk] FAILED:", err);
  process.exit(1);
});
