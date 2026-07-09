/**
 * Minimal gradient-boosted decision tree classifier (binary log-loss),
 * implemented from scratch so the API server has zero native/binary
 * dependencies. This is a real trained model — not a hand-tuned formula:
 * trees are grown greedily by variance reduction on gradients/hessians of
 * the logistic loss, exactly as XGBoost/LightGBM do internally, just
 * without their engineering optimizations (histogram binning, GPU, etc).
 *
 * Kept intentionally small and dependency-free so model artifacts can be
 * serialized to JSON and stored directly in Postgres.
 */

export interface TreeNode {
  isLeaf: boolean;
  value?: number; // leaf output (raw score contribution)
  featureIndex?: number;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
}

export interface GBMConfig {
  nTrees: number;
  maxDepth: number;
  learningRate: number;
  minSamplesLeaf: number;
  /** L2 regularization on leaf weights (like XGBoost's lambda). */
  l2: number;
  /** Fraction of features considered at each split (feature subsampling). */
  featureSubsample: number;
  /** Fraction of rows sampled (with replacement) per tree (row subsampling). */
  rowSubsample: number;
  seed: number;
}

export const DEFAULT_GBM_CONFIG: GBMConfig = {
  nTrees: 120,
  maxDepth: 3,
  learningRate: 0.08,
  minSamplesLeaf: 20,
  l2: 1.0,
  featureSubsample: 0.8,
  rowSubsample: 0.8,
  seed: 42,
};

export interface SerializedGBM {
  trees: TreeNode[];
  basePrediction: number;
  config: GBMConfig;
}

// ─── Deterministic PRNG (mulberry32) so training is reproducible ──────────────
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/** Builds one regression tree on gradients/hessians (Newton-boosting, XGBoost-style leaf weights). */
function buildTree(
  X: number[][],
  grad: number[],
  hess: number[],
  rowIdx: number[],
  featureIdx: number[],
  depth: number,
  config: GBMConfig,
): TreeNode {
  const leafValue = (idx: number[]) => {
    let g = 0, h = 0;
    for (const i of idx) { g += grad[i]; h += hess[i]; }
    return -g / (h + config.l2);
  };

  if (depth >= config.maxDepth || rowIdx.length < config.minSamplesLeaf * 2) {
    return { isLeaf: true, value: leafValue(rowIdx) };
  }

  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;
  let bestLeft: number[] = [];
  let bestRight: number[] = [];

  let gSum = 0, hSum = 0;
  for (const i of rowIdx) { gSum += grad[i]; hSum += hess[i]; }
  const parentScore = (gSum * gSum) / (hSum + config.l2);

  for (const f of featureIdx) {
    // Sort row indices by this feature's value to sweep candidate thresholds.
    const sorted = [...rowIdx].sort((a, b) => X[a][f] - X[b][f]);
    let gLeft = 0, hLeft = 0;
    for (let pos = 0; pos < sorted.length - 1; pos++) {
      const i = sorted[pos];
      gLeft += grad[i];
      hLeft += hess[i];
      const nLeft = pos + 1;
      const nRight = sorted.length - nLeft;
      if (nLeft < config.minSamplesLeaf || nRight < config.minSamplesLeaf) continue;

      const v1 = X[sorted[pos]][f];
      const v2 = X[sorted[pos + 1]][f];
      if (v1 === v2) continue; // only split between distinct values

      const gRight = gSum - gLeft;
      const hRight = hSum - hLeft;
      const gain =
        (gLeft * gLeft) / (hLeft + config.l2) +
        (gRight * gRight) / (hRight + config.l2) -
        parentScore;

      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = (v1 + v2) / 2;
        bestLeft = sorted.slice(0, nLeft);
        bestRight = sorted.slice(nLeft);
      }
    }
  }

  if (bestFeature === -1 || bestGain <= 1e-9) {
    return { isLeaf: true, value: leafValue(rowIdx) };
  }

  return {
    isLeaf: false,
    featureIndex: bestFeature,
    threshold: bestThreshold,
    left: buildTree(X, grad, hess, bestLeft, featureIdx, depth + 1, config),
    right: buildTree(X, grad, hess, bestRight, featureIdx, depth + 1, config),
  };
}

function predictTree(tree: TreeNode, x: number[]): number {
  let node = tree;
  while (!node.isLeaf) {
    const v = x[node.featureIndex!];
    node = v <= node.threshold! ? node.left! : node.right!;
  }
  return node.value!;
}

export class GradientBoostedTrees {
  trees: TreeNode[] = [];
  basePrediction = 0;
  config: GBMConfig;

  constructor(config: Partial<GBMConfig> = {}) {
    this.config = { ...DEFAULT_GBM_CONFIG, ...config };
  }

  /**
   * Trains on features X (rows x cols) against binary labels y (0/1).
   * Async so the event loop can handle HTTP requests between tree builds —
   * each tree yields via setImmediate before the next one starts, preventing
   * the ~120-iteration CPU loop from blocking all incoming requests.
   */
  async fit(X: number[][], y: number[]): Promise<void> {
    const n = X.length;
    const nFeatures = X[0]?.length ?? 0;
    const rand = mulberry32(this.config.seed);

    const posRate = y.reduce((a, b) => a + b, 0) / n;
    const clampedRate = Math.min(Math.max(posRate, 1e-4), 1 - 1e-4);
    this.basePrediction = Math.log(clampedRate / (1 - clampedRate)); // log-odds

    let rawPred = new Array(n).fill(this.basePrediction);
    this.trees = [];

    const nFeatSample = Math.max(1, Math.round(nFeatures * this.config.featureSubsample));
    const nRowSample = Math.max(
      this.config.minSamplesLeaf * 2,
      Math.round(n * this.config.rowSubsample),
    );

    // Yield helper: hands control back to the event loop so pending I/O and
    // HTTP requests are processed before the next tree is built.
    const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

    for (let t = 0; t < this.config.nTrees; t++) {
      // Yield every tree so HTTP requests aren't starved during training.
      await yieldToEventLoop();

      const p = rawPred.map(sigmoid);
      const grad = p.map((pi, i) => pi - y[i]); // dLoss/dRaw for log loss
      const hess = p.map((pi) => Math.max(pi * (1 - pi), 1e-6));

      // Row subsample (bagging) for this tree.
      const rowIdx: number[] = [];
      for (let i = 0; i < nRowSample; i++) {
        rowIdx.push(Math.floor(rand() * n));
      }
      // Feature subsample for this tree.
      const allFeats = Array.from({ length: nFeatures }, (_, i) => i);
      for (let i = allFeats.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [allFeats[i], allFeats[j]] = [allFeats[j], allFeats[i]];
      }
      const featIdx = allFeats.slice(0, nFeatSample);

      const tree = buildTree(X, grad, hess, rowIdx, featIdx, 0, this.config);
      this.trees.push(tree);

      for (let i = 0; i < n; i++) {
        rawPred[i] += this.config.learningRate * predictTree(tree, X[i]);
      }
    }
  }

  /** Returns probability of the positive class for each row. */
  predictProba(X: number[][]): number[] {
    return X.map((x) => {
      let raw = this.basePrediction;
      for (const tree of this.trees) raw += this.config.learningRate * predictTree(tree, x);
      return sigmoid(raw);
    });
  }

  predictProbaOne(x: number[]): number {
    let raw = this.basePrediction;
    for (const tree of this.trees) raw += this.config.learningRate * predictTree(tree, x);
    return sigmoid(raw);
  }

  toJSON(): SerializedGBM {
    return { trees: this.trees, basePrediction: this.basePrediction, config: this.config };
  }

  static fromJSON(data: SerializedGBM): GradientBoostedTrees {
    const model = new GradientBoostedTrees(data.config);
    model.trees = data.trees;
    model.basePrediction = data.basePrediction;
    return model;
  }
}
