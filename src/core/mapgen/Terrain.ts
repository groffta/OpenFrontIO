import path from "path";

const min_island_size = 30;

export interface Coord {
  x: number;
  y: number;
}

export enum TerrainType {
  Land,
  Water,
}

export class Terrain {
  public shoreline: boolean = false;
  public magnitude: number = 0;
  public ocean: boolean = false;
  constructor(public type: TerrainType) {}
}

export async function createMiniMap(tm: Terrain[][]): Promise<Terrain[][]> {
  // Create 2D array properly with correct dimensions
  const miniMap: Terrain[][] = Array(Math.floor(tm.length / 2))
    .fill(null)
    .map(() => Array(Math.floor(tm[0].length / 2)).fill(null));

  for (let x = 0; x < tm.length; x++) {
    for (let y = 0; y < tm[0].length; y++) {
      const miniX = Math.floor(x / 2);
      const miniY = Math.floor(y / 2);

      if (
        miniMap[miniX][miniY] == null ||
        miniMap[miniX][miniY].type != TerrainType.Water
      ) {
        // We shrink 4 tiles into 1 tile. If any of the 4 large tiles
        // has water, then the mini tile is considered water.
        miniMap[miniX][miniY] = tm[x][y];
      }
    }
  }
  return miniMap;
}

export function processShore(map: Terrain[][]): Coord[] {
  const shorelineWaters: Coord[] = [];
  for (let x = 0; x < map.length; x++) {
    for (let y = 0; y < map[0].length; y++) {
      const terrain = map[x][y];
      const ns = neighbors(x, y, map);
      if (terrain.type == TerrainType.Land) {
        if (ns.filter((t) => t.type == TerrainType.Water).length > 0) {
          terrain.shoreline = true;
        }
      } else {
        if (ns.filter((t) => t.type == TerrainType.Land).length > 0) {
          terrain.shoreline = true;
          shorelineWaters.push({ x, y });
        }
      }
    }
  }
  return shorelineWaters;
}

export function processDistToLand(shorelineWaters: Coord[], map: Terrain[][]) {
  const queue: [Coord, number][] = shorelineWaters.map((coord) => [coord, 0]);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const [coord, distance] = queue.shift()!;
    const key = `${coord.x},${coord.y}`;

    if (visited.has(key)) continue;
    visited.add(key);

    const terrain = map[coord.x][coord.y];
    if (terrain.type === TerrainType.Water) {
      terrain.magnitude = distance;

      const nCoords: Coord[] = getNeighborCoords(coord.x, coord.y, map);
      nCoords.forEach((nCoord) => {
        queue.push([{ x: nCoord.x, y: nCoord.y }, distance + 1]);
      });
    }
  }
}

function neighbors(x: number, y: number, map: Terrain[][]): Terrain[] {
  const nCoords: Coord[] = getNeighborCoords(x, y, map);
  const ns: Terrain[] = [];
  nCoords.forEach((nCoord) => {
    ns.push(map[nCoord.x][nCoord.y]);
  });
  return ns;
}

// Improved processOcean function that identifies the largest body of water
export function processOcean(map: Terrain[][]) {
  const visited = new Set<string>();
  const waterBodies: { coords: Coord[]; size: number }[] = [];

  // Find all distinct water bodies
  for (let x = 0; x < map.length; x++) {
    for (let y = 0; y < map[0].length; y++) {
      if (map[x][y].type === TerrainType.Water) {
        const key = `${x},${y}`;
        if (visited.has(key)) continue;

        const waterBody: Coord[] = getArea(x, y, map, visited);
        waterBodies.push({
          coords: waterBody,
          size: waterBody.length,
        });
      }
    }
  }

  // Sort water bodies by size (largest first)
  waterBodies.sort((a, b) => b.size - a.size);

  // Mark the largest water body as ocean
  if (waterBodies.length > 0) {
    const largestWaterBody = waterBodies[0];

    // Mark all tiles in the largest water body as ocean
    for (const coord of largestWaterBody.coords) {
      map[coord.x][coord.y].ocean = true;
    }

    console.log(`Identified ocean with ${largestWaterBody.size} water tiles`);
  } else {
    console.log("No water bodies found in the map");
  }
}

export function packTerrain(map: Terrain[][]): Uint8Array {
  const width = map.length;
  const height = map[0].length;
  const packedData = new Uint8Array(4 + width * height);

  // Add width and height to the first 4 bytes as a pair of LE Uint16
  packedData[0] = width & 0xff;
  packedData[1] = (width >> 8) & 0xff;
  packedData[2] = height & 0xff;
  packedData[3] = (height >> 8) & 0xff;

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const terrain = map[x][y];
      let packedByte = 0;
      if (terrain == null) {
        throw new Error(`terrain null at ${x}:${y}`);
      }

      if (terrain.type === TerrainType.Land) {
        packedByte |= 0b10000000;
      }
      if (terrain.shoreline) {
        packedByte |= 0b01000000;
      }
      if (terrain.ocean) {
        packedByte |= 0b00100000;
      }

      packedByte |= terrain.magnitude & 0b00011111;

      packedData[4 + y * width + x] = packedByte;
    }
  }
  return packedData;
}

export function getArea(
  x: number,
  y: number,
  map: Terrain[][],
  visited: Set<string>,
): Coord[] {
  const targetType: TerrainType = map[x][y].type;
  const area: Coord[] = [];
  const queue: Coord[] = [{ x, y }];

  while (queue.length > 0) {
    const coord = queue.shift()!;
    const key = `${coord.x},${coord.y}`;

    if (visited.has(key)) continue;
    visited.add(key);

    if (map[coord.x][coord.y].type === targetType) {
      area.push({ x: coord.x, y: coord.y });

      const nCoords: Coord[] = getNeighborCoords(coord.x, coord.y, map);
      nCoords.forEach((nCoord) => {
        queue.push({ x: nCoord.x, y: nCoord.y });
      });
    }
  }
  return area;
}

export function removeSmallIslands(map: Terrain[][]) {
  const visited = new Set<string>();

  for (let x = 0; x < map.length; x++) {
    for (let y = 0; y < map[0].length; y++) {
      if (map[x][y].type === TerrainType.Land) {
        const key = `${x},${y}`;
        if (visited.has(key)) continue;

        const island = getArea(x, y, map, visited);
        if (island.length < min_island_size) {
          island.forEach((coord) => {
            map[coord.x][coord.y].type = TerrainType.Water;
          });
        }
      }
    }
  }
}

export function removeSmallLakes(map: Terrain[][]) {
  const visited = new Set<string>();
  const min_lake_size = 200;

  console.log(`Removing small lakes ${map.length}, ${map[0].length}`);

  for (let x = 0; x < map.length; x++) {
    for (let y = 0; y < map[0].length; y++) {
      if (map[x][y].type === TerrainType.Water) {
        const key = `${x},${y}`;
        if (visited.has(key)) continue;

        const lake = getArea(x, y, map, visited);
        if (lake.length < min_lake_size) {
          lake.forEach((coord) => {
            map[coord.x][coord.y].type = TerrainType.Land;
            map[coord.x][coord.y].magnitude = 0;
          });
        }
      }
    }
  }
}

function logBinaryAsBits(
  mapName: string,
  data: Uint8Array,
  length: number = 8,
) {
  const bits = Array.from(data.slice(0, length))
    .map((b) => b.toString(2).padStart(8, "0"))
    .join(" ");
  console.log(`${mapName}: Binary data (bits):`, bits);
}

function getNeighborCoords(x: number, y: number, map: Terrain[][]): Coord[] {
  const coords: Coord[] = [];
  if (x > 0) {
    coords.push({ x: x - 1, y: y });
  }
  if (x < map.length - 1) {
    coords.push({ x: x + 1, y });
  }
  if (y > 0) {
    coords.push({ x: x, y: y - 1 });
  }
  if (y < map[0].length - 1) {
    coords.push({ x: x, y: y + 1 });
  }
  return coords;
}
