import { useMemo } from "react";

export const TILE = 24;

// Office grid in tiles
export const COLS = 28;
export const ROWS = 19;

export const ROOM_WIDTH = COLS * TILE;
export const ROOM_HEIGHT = ROWS * TILE;

// Room rectangles in tile coordinates [x, y, w, h] (inclusive interior)
const MAIN_ROOM = { x: 1, y: 1, w: 17, h: 17 } as const; // wood-floor work area
const MEETING_ROOM = { x: 19, y: 1, w: 8, h: 7 } as const; // beige conference area
const LOUNGE_ROOM = { x: 19, y: 9, w: 8, h: 9 } as const; // blue lounge

interface Furniture {
  type: string;
  file: string;
  x: number; // tile col (top-left)
  y: number; // tile row (top-left)
  tilesW: number;
  tilesH: number;
}

// Build a deterministic furniture layout
function buildFurniture(): Furniture[] {
  const items: Furniture[] = [];

  // 3 rows × 3 desk groups in main work area
  // Each desk group: DESK_FRONT (3 tiles wide × 2 tall) + 1 PC on top of left tile
  const deskRowYs = [3, 8, 13];
  const deskColXs = [3, 9];
  for (const y of deskRowYs) {
    for (const x of deskColXs) {
      items.push({
        type: "DESK_FRONT",
        file: "/pixel-office/furniture/DESK/DESK_FRONT.png",
        x,
        y,
        tilesW: 3,
        tilesH: 2,
      });
      // PC sits on top of desk (1 tile wide × 2 tall, anchored above desk)
      items.push({
        type: "PC_FRONT_OFF",
        file: "/pixel-office/furniture/PC/PC_FRONT_OFF.png",
        x: x + 1,
        y: y - 1,
        tilesW: 1,
        tilesH: 2,
      });
    }
  }

  // Plants in main room corners
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 1, y: 1, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 16, y: 1, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 1, y: 16, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 16, y: 16, tilesW: 1, tilesH: 2 });

  // Cactus in mid main area
  items.push({ type: "CACTUS", file: "/pixel-office/furniture/CACTUS/CACTUS.png", x: 7, y: 11, tilesW: 1, tilesH: 1 });

  // Meeting room: 2 small chairs + 1 plant
  items.push({ type: "CUSHIONED_CHAIR_FRONT", file: "/pixel-office/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png", x: 22, y: 4, tilesW: 1, tilesH: 1 });
  items.push({ type: "CUSHIONED_CHAIR_FRONT", file: "/pixel-office/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png", x: 24, y: 4, tilesW: 1, tilesH: 1 });
  items.push({ type: "PLANT", file: "/pixel-office/furniture/PLANT/PLANT.png", x: 19, y: 1, tilesW: 1, tilesH: 2 });
  items.push({ type: "PLANT", file: "/pixel-office/furniture/PLANT/PLANT.png", x: 26, y: 1, tilesW: 1, tilesH: 2 });

  // Lounge: SOFA + plants + clock
  items.push({ type: "SOFA_FRONT", file: "/pixel-office/furniture/SOFA/SOFA_FRONT.png", x: 21, y: 13, tilesW: 3, tilesH: 1 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 19, y: 9, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 26, y: 9, tilesW: 1, tilesH: 2 });
  items.push({ type: "BIN", file: "/pixel-office/furniture/BIN/BIN.png", x: 19, y: 17, tilesW: 1, tilesH: 1 });

  return items;
}

// CSS filters that fake HSB colorize on a greyscale tile.
// Pixel-agents uses HSB color with hue, saturation, brightness, contrast.
// We approximate with CSS sepia → hue-rotate → saturate → brightness → contrast,
// which lands close enough for a pixel-art office look.
const ROOM_FLOOR_FILTERS = {
  wood: "sepia(1) saturate(2.2) hue-rotate(-15deg) brightness(0.62) contrast(1.05)",
  beige: "sepia(0.55) saturate(0.9) hue-rotate(-5deg) brightness(1.05) contrast(0.95)",
  blue: "sepia(1) saturate(2) hue-rotate(170deg) brightness(0.85) contrast(1)",
  outer: "brightness(0.25) saturate(0)",
} as const;

const ROOM_WALL_COLOR = {
  wood: "#1a0e08",
  beige: "#3a3528",
  blue: "#0f1a2e",
  outer: "#000000",
} as const;

type RoomKey = keyof typeof ROOM_FLOOR_FILTERS;

function roomAtTile(col: number, row: number): RoomKey | null {
  if (col >= MAIN_ROOM.x && col < MAIN_ROOM.x + MAIN_ROOM.w && row >= MAIN_ROOM.y && row < MAIN_ROOM.y + MAIN_ROOM.h) return "wood";
  if (col >= MEETING_ROOM.x && col < MEETING_ROOM.x + MEETING_ROOM.w && row >= MEETING_ROOM.y && row < MEETING_ROOM.y + MEETING_ROOM.h) return "beige";
  if (col >= LOUNGE_ROOM.x && col < LOUNGE_ROOM.x + LOUNGE_ROOM.w && row >= LOUNGE_ROOM.y && row < LOUNGE_ROOM.y + LOUNGE_ROOM.h) return "blue";
  return null;
}

interface RoomBox {
  key: RoomKey;
  pattern: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ROOMS: RoomBox[] = [
  // wood plank pattern for main room
  { key: "wood", pattern: "/pixel-office/floors/floor_5.png", ...MAIN_ROOM },
  // tile pattern for meeting
  { key: "beige", pattern: "/pixel-office/floors/floor_4.png", ...MEETING_ROOM },
  // smooth carpet for lounge
  { key: "blue", pattern: "/pixel-office/floors/floor_0.png", ...LOUNGE_ROOM },
];

export interface PixelOfficeRendererProps {
  /** Children rendered as the agents layer (positioned absolutely inside the room). */
  children?: React.ReactNode;
}

export function PixelOfficeRenderer({ children }: PixelOfficeRendererProps) {
  const furniture = useMemo(buildFurniture, []);

  // Walkable bounds (in pixels) for agent wandering — main room interior padded
  // by 2 tiles on edges to keep them away from walls/desks.
  void roomAtTile;

  return (
    <div
      data-testid="pixel-office-floor"
      className="relative mx-auto border-4 border-neutral-800 shadow-[6px_6px_0_rgb(0_0_0_/_0.5)] overflow-hidden"
      style={{
        width: ROOM_WIDTH,
        height: ROOM_HEIGHT,
        maxWidth: "100%",
        background: "#1a1410",
        imageRendering: "pixelated",
      }}
    >
      {/* Outer dark area is just the bg color above. Each room paints its tinted floor on top. */}

      {/* Room floors */}
      {ROOMS.map((room) => (
        <div
          key={`${room.key}-${room.x}-${room.y}`}
          className="absolute"
          style={{
            left: room.x * TILE,
            top: room.y * TILE,
            width: room.w * TILE,
            height: room.h * TILE,
            backgroundImage: `url(${room.pattern})`,
            backgroundSize: `${TILE}px ${TILE}px`,
            backgroundRepeat: "repeat",
            imageRendering: "pixelated",
            filter: ROOM_FLOOR_FILTERS[room.key],
          }}
        />
      ))}

      {/* Wall outlines around each room */}
      {ROOMS.map((room) => (
        <div
          key={`wall-${room.key}-${room.x}-${room.y}`}
          className="absolute pointer-events-none"
          style={{
            left: room.x * TILE - 2,
            top: room.y * TILE - 2,
            width: room.w * TILE + 4,
            height: room.h * TILE + 4,
            border: `2px solid ${ROOM_WALL_COLOR[room.key]}`,
            boxShadow: `inset 0 0 0 1px rgba(0,0,0,0.3)`,
          }}
        />
      ))}

      {/* Furniture layer */}
      {furniture.map((f, i) => (
        <img
          key={`${f.type}-${i}`}
          src={f.file}
          alt=""
          className="absolute pointer-events-none select-none"
          style={{
            left: f.x * TILE,
            top: f.y * TILE,
            width: f.tilesW * TILE,
            height: f.tilesH * TILE,
            imageRendering: "pixelated",
          }}
          draggable={false}
        />
      ))}

      {/* Agents layer (children render absolutely on this stage) */}
      <div className="absolute inset-0">{children}</div>

      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0.0) 0px, rgba(0,0,0,0.0) 2px, rgba(0,0,0,0.07) 3px, rgba(0,0,0,0.0) 4px)",
        }}
      />

      {/* Vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </div>
  );
}

/**
 * Walkable area for agents — confined to the main wood-floor room interior.
 * Returns pixel rect agents can target.
 */
export function getWalkableBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
  // Keep 2-tile inset from main room edges so agents don't overlap desks/plants
  const insetX = 2;
  const insetY = 2;
  return {
    minX: (MAIN_ROOM.x + insetX) * TILE,
    minY: (MAIN_ROOM.y + insetY) * TILE,
    maxX: (MAIN_ROOM.x + MAIN_ROOM.w - insetX) * TILE,
    maxY: (MAIN_ROOM.y + MAIN_ROOM.h - insetY) * TILE,
  };
}

/** Walkable bounds for agents that should hang out in lounge/meeting (small variation) */
export function getOptionalRoomBounds(): { minX: number; minY: number; maxX: number; maxY: number }[] {
  return [
    {
      minX: (MEETING_ROOM.x + 1) * TILE,
      minY: (MEETING_ROOM.y + 1) * TILE,
      maxX: (MEETING_ROOM.x + MEETING_ROOM.w - 1) * TILE,
      maxY: (MEETING_ROOM.y + MEETING_ROOM.h - 1) * TILE,
    },
    {
      minX: (LOUNGE_ROOM.x + 1) * TILE,
      minY: (LOUNGE_ROOM.y + 1) * TILE,
      maxX: (LOUNGE_ROOM.x + LOUNGE_ROOM.w - 1) * TILE,
      maxY: (LOUNGE_ROOM.y + LOUNGE_ROOM.h - 1) * TILE,
    },
  ];
}
