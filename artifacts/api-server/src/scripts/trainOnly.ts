import { trainAllModels } from "../lib/ml/train";

const onlyKinds = process.argv.slice(2) as ("overall" | "momentum" | "value" | "lowRisk")[];

async function main() {
  await trainAllModels(console.log, onlyKinds.length ? onlyKinds : undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error("[train-only] FAILED:", err);
  process.exit(1);
});
