import {
  Terrain,
  TerrainType,
  createMiniMap,
  processShore,
  processOcean,
  processDistToLand,
  packTerrain,
  removeSmallIslands,
  removeSmallLakes,
} from "./Terrain";

export interface EngineConfig {
  width: number;
  height: number;

  // Fractal noise params
  scale: number;
  octaves: number;
  persistence: number;

  // Water level clamp in [0..255]
  waterLevel: number;

  // Ratio of plains to mountains [0.0..1.0]
  plainsRatio: number;

  // If true, apply a radial mask to push edges down (single island)
  island?: boolean;
  mountainGain?: number;

  // Feature toggles & parameters
  features?: {
    mountains?: boolean;
    water?: boolean;
  };

  seed: number;
}

export class Engine {
  public config: EngineConfig;
  private permutation: number[];
  private rand: () => number;
  private normalmap: number[][];

  constructor(config: EngineConfig) {
    this.config = config;
    const seed = config.seed ?? Math.floor(Math.random() * 1_000_000);
    this.permutation = this.createPermutationTable(seed);
    this.normalmap = Array(config.width)
      .fill(null)
      .map(() => Array(config.height).fill(null));
  }

  public updateConfig(newConfig: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...newConfig };
    if (newConfig.seed !== undefined) {
      this.permutation = this.createPermutationTable(newConfig.seed);
    }
  }

  /**
   * Main method: generate a 2D array of bytes (0..255).
   * Incorporates:
   *  - multi-octave fractal noise (base)
   *  - optional "mountains" exponent
   *  - optional "island" mask
   *  - optional "carveValleys" using Worley noise
   */
  public async generate(): Promise<void> {
    return new Promise<void>((resolve) => {
      let {
        width,
        height,
        scale,
        octaves,
        persistence,
        waterLevel,
        island: islandMask,
        features,
        plainsRatio,
        mountainGain,
      } = this.config;

      const heightOffset = 0.15;
      const mountainOffset = -0.4;
      waterLevel = this.lerp(waterLevel, 0.25, 0.75) + heightOffset;
      this.config.waterLevel = waterLevel;

      const mountainThreshold = this.lerp(plainsRatio, waterLevel, 0.8);

      const gain = 1.0;
      const baseFrequency = this.lerp(scale, 1, 8);
      const mountainFrequency = baseFrequency * 5;
      const lacunarity = 2.0;

      // Random XY offsets for land and mountain fractals
      const randmax = 0x80000000;
      const rx1 = this.rand() / randmax - 0.5;
      const ry1 = this.rand() / randmax - 0.5;
      const rx2 = this.rand() / randmax - 0.5;
      const ry2 = this.rand() / randmax - 0.5;

      for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
          // Normalized coords in [-0.5..0.5]
          let nx = x / Math.min(width, height) - 0.5 + rx1;
          let ny = y / Math.min(width, height) - 0.5 + ry1;

          // --- 1) BASE FRACTAL NOISE ---
          let baseVal = this.fractalNoise(
            nx,
            ny,
            baseFrequency,
            octaves,
            lacunarity,
            persistence,
          );
          // Range ~[-1..1], convert to [0..1] for easier threshold checks
          let normalized = (baseVal + 1) / 2;
          // Apply height offset and clamp to [0..1]
          normalized += heightOffset;
          normalized = Math.max(Math.min(1, normalized), 0);

          // Use mountains fractal
          if (features?.mountains) {
            let ridgedVal = this.ridgedNoise(
              nx + rx2,
              ny + ry2,
              mountainFrequency,
              6,
              3.0,
              mountainGain,
            );

            // Scale mountain fractal to waterLevel..1.0
            ridgedVal = this.lerp(ridgedVal, waterLevel, 1.0);

            // Blend mountains and lowlands with linear interpolation
            const blendOffset = 0.05;
            let blendMin = mountainThreshold - blendOffset;
            let blendMax = mountainThreshold + blendOffset;
            const t = this.smoothstep(blendMin, blendMax, normalized);
            if (t > 0 && t < 1) {
              normalized = this.lerp(t, normalized, ridgedVal);
            }
            if (t >= 1) {
              normalized = ridgedVal;
            }
          }

          // set heights below water level to 0
          if (features?.water && normalized <= waterLevel) {
            normalized = 0;
          }

          this.normalmap[x][y] = normalized * gain;
        }
      }
      resolve();
    });
  }

  /**
   * Generate a greyscale PNG file from the current configuration.
   * Water pixels => transparent alpha.
   */

  public async getTerrain(): Promise<Terrain[][]> {
    return new Promise<Terrain[][]>((resolve, reject) => {
      let { width, height } = this.config;
      const terrain: Terrain[][] = Array(width)
        .fill(null)
        .map(() => Array(height).fill(null));

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let normal = this.normalmap[x][y];
          // scale normals > this.config.waterLevel to 0..255
          let value = (terrain[x][y] = new Terrain(
            normal > 0 ? TerrainType.Land : TerrainType.Water,
          ));
          const shifted = normal - this.config.waterLevel; // shift waterline to 0
          const scaled = shifted / (1 - this.config.waterLevel); // scale shifted value 0..1
          terrain[x][y].magnitude = Math.floor(this.lerp(scaled, 0, 31));
        }
      }
      removeSmallIslands(terrain);
      removeSmallLakes(terrain);
      const shorelineWaters = processShore(terrain);
      processDistToLand(shorelineWaters, terrain);
      processOcean(terrain);
      resolve(terrain);
    });
  }

  // ------------------------------------------------------
  // FRACTAL NOISE (multi-octave Perlin)
  // ------------------------------------------------------
  private fractalNoise(
    x: number,
    y: number,
    baseFrequency: number,
    octaves: number,
    lacunarity: number,
    persistence: number,
  ): number {
    let total = 0;
    let frequency = baseFrequency;
    let amplitude = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      const val = this.perlinNoise(x * frequency, y * frequency);
      total += val * amplitude;

      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    // scale to [-1..1]
    return total / maxValue;
  }

  // ------------------------------------------------------
  // PERLIN NOISE
  // ------------------------------------------------------
  private perlinNoise(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = this.fade(xf);
    const v = this.fade(yf);

    const aa = this.permutation[this.permutation[X] + Y];
    const ab = this.permutation[this.permutation[X] + Y + 1];
    const ba = this.permutation[this.permutation[X + 1] + Y];
    const bb = this.permutation[this.permutation[X + 1] + Y + 1];

    const x1 = this.lerp(u, this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf));
    const x2 = this.lerp(
      u,
      this.grad(ab, xf, yf - 1),
      this.grad(bb, xf - 1, yf - 1),
    );
    return this.lerp(v, x1, x2);
  }

  // ------------------------------------------------------
  // RIDGED FRACTAL NOISE (For mountain generation)
  // ------------------------------------------------------
  private ridgedNoise(
    x: number,
    y: number,
    frequency: number,
    octaves: number,
    lacunarity: number,
    gain: number,
  ): number {
    let sum = 0;
    let amplitude = 0.5;
    let offset = 1.0;
    let weight = 1.0;

    x *= frequency;
    y *= frequency;

    for (let i = 0; i < octaves; i++) {
      // Take absolute value of noise, invert it
      let n = Math.abs(this.perlinNoise(x, y));
      n = offset - n;
      n *= n;

      // Weight the contribution
      n *= weight;
      weight = Math.max(Math.min(n * gain, 1.0), 0.0);

      sum += n * amplitude;

      x *= lacunarity;
      y *= lacunarity;
      amplitude *= 0.5;
    }

    return sum;
  }

  private fade(t: number): number {
    // Ken Perlin's fade
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private lerp(t: number, a: number, b: number): number {
    return a + t * (b - a);
  }

  private grad(hash: number, x: number, y: number): number {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  }

  private smoothstep(edge0: number, edge1: number, x: number): number {
    // Scale and clamp x into 0..1 range
    let t = (x - edge0) / (edge1 - edge0);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    // Evaluate smoothstep: 3t^2 - 2t^3
    return 3 * (t * t) - 2 * (t * t * t);
  }

  // ------------------------------------------------------
  // PERMUTATION TABLE & SEED
  // ------------------------------------------------------
  private createPermutationTable(seed: number): number[] {
    // Fill array [0..255]
    const p: number[] = [];
    for (let i = 0; i < 256; i++) {
      p[i] = i;
    }
    // Shuffle with seeded RNG
    this.rand = this.seededRandom(seed);
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    // Duplicate so we don't overflow
    return p.concat(p);
  }

  private seededRandom(seed: number): () => number {
    let m = 0x80000000; // 2^31
    let a = 1103515245;
    let c = 8276342398;
    let state = seed;
    return () => {
      state = (a * state + c) % m;
      return state / m;
    };
  }
}
