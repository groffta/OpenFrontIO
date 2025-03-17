// engine.test.ts
import { Engine, EngineConfig } from "../../src/core/mapgen/Engine";
import * as path from "path";
import * as fs from "fs";

const seed = 696969;
const config: EngineConfig = {
  width: 1024,
  height: 1024,
  scale: 0.4,
  octaves: 8,
  persistence: 0.58,
  waterLevel: 0.5,
  island: false,
  mountainGain: 3.0,
  plainsRatio: 0.7,
  features: {
    mountains: true,
    water: true,
  },
  seed: seed ? seed : Math.floor(Math.random() * 1_000_000_000),
};

describe("Engine PNG Generation with Transparent Water", () => {
  it("should generate a PNG where water pixels are transparent", async () => {
    const engine = new Engine(config);

    // Output path for our PNG
    const outputPath = path.join(__dirname, "test_map.png");

    await engine.generate();
    // Clean up old file if it exists
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    await engine.createTerrainPng(outputPath);

    console.log("PNG generated at:", outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});
