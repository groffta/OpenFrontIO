import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Engine } from "../core/mapgen/Engine";
import { createReadStream } from "fs";
import { decodePNGFromStream } from "pngjs";
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
} from "../core/mapgen/Terrain";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const maps = [
  "Africa",
  "Asia",
  "WorldMap",
  "BlackSea",
  "Europe",
  "Mars",
  "Mena",
  "Oceania",
  "NorthAmerica",
  "SouthAmerica",
];

export async function loadTerrainMaps() {
  await Promise.all(maps.map((map) => loadTerrainMap(map)));
}

export async function loadTerrainMap(mapName: string): Promise<void> {
  const imagePath = path.resolve(
    __dirname,
    "..",
    "..",
    "resources",
    "maps",
    mapName + ".png",
  );

  const readStream = createReadStream(imagePath);
  const img = await decodePNGFromStream(readStream);

  console.log(`${mapName}: Image loaded successfully`);
  console.log(`${mapName}: `, "Image dimensions:", img.width, "x", img.height);

  const terrain: Terrain[][] = Array(img.width)
    .fill(null)
    .map(() => Array(img.height).fill(null));

  for (let x = 0; x < img.width; x++) {
    for (let y = 0; y < img.height; y++) {
      const color = img.getPixelRGBA(x, y);
      const alpha = color & 0xff;
      const blue = (color >> 8) & 0xff;

      if (alpha < 20 || blue == 106) {
        // transparent
        terrain[x][y] = new Terrain(TerrainType.Water);
      } else {
        terrain[x][y] = new Terrain(TerrainType.Land);
        terrain[x][y].magnitude = 0;

        // 140 -> 200 = 60
        const mag = Math.min(200, Math.max(140, blue)) - 140;
        terrain[x][y].magnitude = mag / 2;
      }
    }
  }

  removeSmallIslands(terrain);
  removeSmallLakes(terrain);
  const shorelineWaters = processShore(terrain);
  processDistToLand(shorelineWaters, terrain);
  processOcean(terrain);
  const outputPath = path.join(
    __dirname,
    "..",
    "..",
    "resources",
    "maps",
    mapName + ".bin",
  );
  fs.writeFile(outputPath, packTerrain(terrain), () => {
    console.log(`${mapName}: Map saved to ${outputPath}`);
  });

  const miniTerrain = await createMiniMap(terrain);
  const miniOutputPath = path.join(
    __dirname,
    "..",
    "..",
    "resources",
    "maps",
    mapName + "Mini.bin",
  );
  fs.writeFile(miniOutputPath, packTerrain(miniTerrain), () => {
    console.log(`${mapName}: Mini map saved to ${miniOutputPath}`);
  });
}

await loadTerrainMaps();
