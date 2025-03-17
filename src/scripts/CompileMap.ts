import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { fileURLToPath } from "url";
import { Engine } from "../core/mapgen/Engine";
import { loadTerrainMap } from "../core/mapgen/Terrain";

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

await loadTerrainMaps();
