import { PNG } from "pngjs";
import * as fs from "fs";
import { SHA512_256 } from "bun";
import { timingSafeEqual } from "crypto";

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
    valleys?: boolean;
  };

  // Carving parameters
  // - threshold above which we start carving
  // - factor controlling how deep to carve
  // - worleyFrequency controlling "resolution" of the valley pattern
  valleyThreshold?: number;
  valleyCarveFactor?: number;
  worleyFrequency?: number;

  // Optional seed for deterministic noise
  seed?: number;
}

export class Engine {
  private config: EngineConfig;
  private permutation: number[];
  private rand: () => number;

  constructor(config: EngineConfig) {
    this.config = config;
    const seed = config.seed ?? Math.floor(Math.random() * 1_000_000);
    this.permutation = this.createPermutationTable(seed);
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
  public generate(): number[][] {
    let {
      width,
      height,
      scale,
      octaves,
      persistence,
      waterLevel,
      island: islandMask,
      features,
      valleyThreshold,
      valleyCarveFactor,
      worleyFrequency,
      plainsRatio,
      mountainGain,
    } = this.config;

    // Apply plains ratio
    const mountainThreshold = this.lerp(plainsRatio, waterLevel, 0.8);

    const map: number[][] = [];
    const heightOffset = 0.05;
    const baseFrequency = this.lerp(scale, 1, 8);
    const mountainFrequency = baseFrequency * 8;
    const lacunarity = 2.0;
    waterLevel = this.lerp(waterLevel, 0.25, 0.75) + heightOffset;

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
        let nx = x / width - 0.5 + rx1;
        let ny = y / height - 0.5 + ry1;

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

        // --- 4) Carve Valleys with Worley noise? ---
        // If terrain is above a threshold, subtract a "branchy" pattern.
        if (features?.valleys && normalized > valleyThreshold) {
          // fraction of how far above threshold we are (0..1)
          const t = (normalized - valleyThreshold) / (1.0 - valleyThreshold);
          // how strongly to carve at this altitude
          const carve = valleyCarveFactor * t;

          // Sample Worley noise in [0..1], using a chosen frequency
          const wVal = this.worleyNoise(nx, ny, worleyFrequency);

          // Subtract a fraction of wVal to carve out valleys
          // "Bright" areas in Worley => deeper valleys
          normalized = normalized - carve * wVal;

          // clamp to 0 so we don't go negative
          if (normalized < 0) normalized = 0;
        }

        // --- 2) Optionally emphasize mountains globally ---
        if (features?.mountains) {
          const blendOffset = 0.05;
          let blendMin = mountainThreshold - blendOffset;
          let blendMax = mountainThreshold + blendOffset;
          const t = this.smoothstep(blendMin, blendMax, normalized);

          // Ridged fractal for mountainous region
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

          if (t > 0) {
            // Blend mountains and lowlands with linear interpolation
            normalized = this.lerp(t, normalized, ridgedVal);
          }
        }

        // set heights below water level to 0
        if (features?.water && normalized <= waterLevel) {
          normalized = 0;
        }

        // Convert normalized height to byte [0..255] ---
        let byteValue = Math.floor(normalized * 255);

        row.push(byteValue);
      }
      map.push(row);
    }

    return map;
  }

  /**
   * Generate a PNG file from the current configuration.
   * Water-level pixels => transparent alpha.
   */
  public async generatePng(outputPath: string): Promise<void> {
    const { width, height, waterLevel } = this.config;
    const heightmap = this.generate();

    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        const value = heightmap[y][x];

        // Greyscale
        png.data[idx + 0] = value; // R
        png.data[idx + 1] = value; // G
        png.data[idx + 2] = value; // B
        // If at or below water, alpha=0 => transparent
        png.data[idx + 3] = value == 0 ? 0 : 255;
      }
    }

    return new Promise<void>((resolve, reject) => {
      png
        .pack()
        .pipe(fs.createWriteStream(outputPath))
        .on("finish", () => resolve())
        .on("error", (err) => reject(err));
    });
  }

  public async generateTerrainPng(outputPath: string): Promise<void> {
    const { width, height } = this.config;
    const heightmap = this.generate();

    // Create PNG with RGB channels
    const png = new PNG({ width, height });

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        const value = heightmap[y][x];

        let r: number, g: number, b: number;

        // Water
        if (value === 0 || value < 20) {
          r = 70;
          g = 132;
          b = 180;
        }
        // Plains
        else if (value <= 140 && value !== 106) {
          r = 191;
          g = 212;
          b = 141;
        }
        // Low Hills
        else if (value <= 158 && value > 140) {
          b = value % 2 ? value + 1 : value;
          const magnitude = (b - 140) / 2;

          r = 190;
          g = 220 - magnitude * 2;
          b = b;
        }
        // Highlands
        else if (value >= 159 && value <= 178) {
          b = value % 2 ? value + 1 : value;
          const magnitude = (b - 140) / 2;

          r = 200 + magnitude * 2;
          g = 183 + magnitude * 2;
          b = b;
        }
        // Mountains
        else if (value >= 179 && value <= 199) {
          b = value % 2 ? value + 1 : value;
          const magnitude = (b - 140) / 2;

          r = 230 + magnitude / 2;
          g = 230 + magnitude / 2;
          b = 230;
        }
        // Peak Mountains
        else if (value >= 200) {
          r = 245; // 230 + 15
          g = 245; // 230 + 15
          b = 245;
        }
        // Fallback (shouldn't occur)
        else {
          r = value;
          g = value;
          b = value;
        }

        // Set RGB values
        png.data[idx] = r; // R
        png.data[idx + 1] = g; // G
        png.data[idx + 2] = b; // B
        png.data[idx + 3] = 255; // Alpha (fully opaque)
      }
    }

    return new Promise<void>((resolve, reject) => {
      png
        .pack()
        .pipe(fs.createWriteStream(outputPath))
        .on("finish", () => resolve())
        .on("error", (err) => reject(err));
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
  // WORLEY NOISE (Cellular) for "lightning-like" valleys
  // ------------------------------------------------------
  /**
   * Basic Worley noise in [0..1].
   * "frequency" scales x,y before computing distances.
   * Inverted so smaller distances => bigger values (like bright cracks).
   */
  private worleyNoise(x: number, y: number, frequency: number): number {
    x *= frequency;
    y *= frequency;

    const cellX = Math.floor(x);
    const cellY = Math.floor(y);

    let minDist = Infinity;

    // Check neighboring cells in a 3x3 block around (cellX, cellY)
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const fx = cellX + offsetX;
        const fy = cellY + offsetY;

        // Each cell has a random feature point offset in [0..1]
        const featureX = fx + this.worleyRandomOffset(fx, fy, 0);
        const featureY = fy + this.worleyRandomOffset(fx, fy, 1);

        // Distance from (x, y) to this feature point
        const dx = featureX - x;
        const dy = featureY - y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDist) {
          minDist = dist;
        }
      }
    }

    // "minDist" typically in [0..~1.4], we clamp to 1.0 for a [0..1] range
    // Then invert so closer => bigger value
    const clamped = Math.min(minDist, 1.0);
    return 1.0 - clamped; // => 1 when distance=0, 0 when distance>=1
  }

  /**
   * Use the permutation table to produce a pseudo-random offset in [0..1]
   * for a given cell (fx, fy) and index (0 or 1).
   */
  private worleyRandomOffset(fx: number, fy: number, index: number): number {
    // Simple hashing approach: combine coords + index, then mod by 256
    const hashIndex = (fx * 37 + fy * 57 + index * 131) & 255;
    return this.permutation[hashIndex] / 255.0;
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
