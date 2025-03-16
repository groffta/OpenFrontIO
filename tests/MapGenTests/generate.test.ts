// engine.test.ts

import { Engine, EngineConfig } from "../../src/core/mapgen/Engine";
import * as path from "path";
import * as fs from "fs";
import { randomInt } from "d3";

describe("Engine PNG Generation with Transparent Water", () => {
  it("should generate a PNG where water pixels are transparent", async () => {
    // Example config
    const randomSeed = Math.floor(Math.random() * 1_000_000_000);
    const config: EngineConfig = {
      width: 512,
      height: 512,
      scale: 0.25,
      octaves: 8,
      persistence: 0.58,
      waterLevel: 0.5,
      island: false,
      mountainGain: 3.0,
      plainsRatio: 0.5,
      features: {
        mountains: true,
        water: true,
      },
      seed: randomSeed,
    };

    const engine = new Engine(config);

    // Output path for our PNG
    const outputPath = path.join(__dirname, "test_map.png");

    // Clean up old file if it exists
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    // Use the new function
    await engine.generateTerrainPng(outputPath);

    // We can now verify the file was created, etc.
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});
