import { useEffect, useMemo, useState } from "react";

export const TILE = 24;

// Sprite frame metadata for character sheets — exported so PixelOffice can position seated agents.
export const FRAME_WIDTH = 16;
export const FRAME_HEIGHT = 32;
export const SPRITE_SCALE = 2;
export const RENDERED_W = FRAME_WIDTH * SPRITE_SCALE;
export const RENDERED_H = FRAME_HEIGHT * SPRITE_SCALE;

// Office grid in tiles
export const COLS = 36;
export const ROWS = 22;

export const ROOM_WIDTH = COLS * TILE;
export const ROOM_HEIGHT = ROWS * TILE;

// Room rectangles in tile coordinates
const MAIN_ROOM = { x: 1, y: 1, w: 22, h: 20 } as const; // wood-floor work area
const MEETING_ROOM = { x: 24, y: 1, w: 11, h: 10 } as const; // beige conference area
const LOUNGE_ROOM = { x: 24, y: 12, w: 11, h: 9 } as const; // blue lounge

export type SeatDirection = "down" | "up" | "right" | "left";

export interface Seat {
  id: string;
  type: "pc" | "sofa" | "chair";
  /** Pixel x for the character sprite's top-left when sitting in this seat. */
  spriteX: number;
  /** Pixel y for the character sprite's top-left when sitting in this seat. */
  spriteY: number;
  direction: SeatDirection;
}

interface DeskGroup {
  deskCol: number;
  deskRow: number;
  pcCol: number;
  pcRow: number;
  seatCol: number;
  seatRow: number;
  pcId: string;
}

const DESK_GROUPS: DeskGroup[] = (() => {
  const groups: DeskGroup[] = [];
  // Desk and PC share the same top row so the PC visibly rests on top of the desk
  // (their sprites overlap in the middle column).
  const deskRows = [2, 7, 12, 17];
  const deskCols = [3, 9, 15];
  let i = 0;
  for (const dy of deskRows) {
    for (const dx of deskCols) {
      groups.push({
        deskCol: dx,
        deskRow: dy,
        pcCol: dx + 1,
        pcRow: dy,
        seatCol: dx + 1,
        seatRow: dy + 2,
        pcId: `pc-${i++}`,
      });
    }
  }
  return groups;
})();

interface SofaInfo {
  col: number;
  row: number;
}

const SOFAS: SofaInfo[] = [
  { col: 26, row: 14 },
  { col: 31, row: 14 },
];

interface ChairInfo {
  col: number;
  row: number;
  /** Where the chair lives — used only for layout; seat direction is always front. */
  area: "meeting" | "lounge";
}

const CHAIRS: ChairInfo[] = [
  // Meeting room — 4 chairs in a row (used for chats/discussions)
  { col: 26, row: 4, area: "meeting" },
  { col: 28, row: 4, area: "meeting" },
  { col: 30, row: 4, area: "meeting" },
  { col: 32, row: 4, area: "meeting" },
  // Lounge — flanking chairs
  { col: 26, row: 18, area: "lounge" },
  { col: 32, row: 18, area: "lounge" },
];

/**
 * For a "front-facing" seat (character sits on/at the tile facing the camera),
 * we anchor the sprite so its bottom rests at the bottom of the tile and it's
 * centered horizontally. The 32px-wide sprite is wider than a 24px tile, so we
 * shift left by 4px.
 */
function frontSeatAnchor(tileCol: number, tileRow: number) {
  return {
    spriteX: tileCol * TILE + (TILE - RENDERED_W) / 2,
    spriteY: (tileRow + 1) * TILE - RENDERED_H,
  };
}

/**
 * For a PC seat, the character sits in front of the desk facing up (toward the PC).
 * We pull the sprite up by 16px so its head overlaps the desk's bottom edge — making
 * the character look like it's sitting *at* the desk rather than parked below it.
 */
function pcSeatAnchor(seatCol: number, seatRow: number) {
  return {
    spriteX: seatCol * TILE + (TILE - RENDERED_W) / 2,
    spriteY: seatRow * TILE - 16,
  };
}

export const PC_SEATS: Seat[] = DESK_GROUPS.map((g) => {
  const a = pcSeatAnchor(g.seatCol, g.seatRow);
  return {
    id: `pc-seat-${g.pcId}`,
    type: "pc",
    spriteX: a.spriteX,
    spriteY: a.spriteY,
    direction: "up",
  };
});

/** PC tile id paired with the seat that fronts it (so we can flip PC sprites when occupied). */
export const PC_SEAT_PC_IDS: Map<string, string> = new Map(
  DESK_GROUPS.map((g) => [`pc-seat-${g.pcId}`, g.pcId]),
);

export const SOFA_SEATS: Seat[] = SOFAS.flatMap((s, i) => [
  {
    id: `sofa-${i}-l`,
    type: "sofa" as const,
    ...frontSeatAnchor(s.col, s.row),
    direction: "down" as const,
  },
  {
    id: `sofa-${i}-r`,
    type: "sofa" as const,
    ...frontSeatAnchor(s.col + 1, s.row),
    direction: "down" as const,
  },
]);

export const CHAIR_SEATS: Seat[] = CHAIRS.map((c, i) => ({
  id: `chair-${i}`,
  type: "chair" as const,
  ...frontSeatAnchor(c.col, c.row),
  direction: "down" as const,
}));

export const REST_SEATS: Seat[] = [...SOFA_SEATS, ...CHAIR_SEATS];

interface Furniture {
  type: string;
  file: string;
  x: number;
  y: number;
  tilesW: number;
  tilesH: number;
}

function buildStaticFurniture(): Furniture[] {
  const items: Furniture[] = [];

  // Desks (PCs are rendered separately so we can swap to ON frames when occupied)
  for (const g of DESK_GROUPS) {
    items.push({
      type: "DESK_FRONT",
      file: "/pixel-office/furniture/DESK/DESK_FRONT.png",
      x: g.deskCol,
      y: g.deskRow,
      tilesW: 3,
      tilesH: 2,
    });
  }

  // Plants in main room corners
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 1, y: 1, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 21, y: 1, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 1, y: 18, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 21, y: 18, tilesW: 1, tilesH: 2 });

  // Cactus accent in main room
  items.push({ type: "CACTUS", file: "/pixel-office/furniture/CACTUS/CACTUS.png", x: 19, y: 11, tilesW: 1, tilesH: 1 });

  // Meeting room: chairs + plants
  for (const c of CHAIRS.filter((x) => x.area === "meeting")) {
    items.push({
      type: "CUSHIONED_CHAIR_FRONT",
      file: "/pixel-office/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png",
      x: c.col,
      y: c.row,
      tilesW: 1,
      tilesH: 1,
    });
  }
  items.push({ type: "PLANT", file: "/pixel-office/furniture/PLANT/PLANT.png", x: 24, y: 1, tilesW: 1, tilesH: 2 });
  items.push({ type: "PLANT", file: "/pixel-office/furniture/PLANT/PLANT.png", x: 33, y: 1, tilesW: 1, tilesH: 2 });
  items.push({ type: "CLOCK", file: "/pixel-office/furniture/CLOCK/CLOCK.png", x: 29, y: 1, tilesW: 1, tilesH: 1 });

  // Lounge: sofas + chairs + plants + bin
  for (const s of SOFAS) {
    items.push({
      type: "SOFA_FRONT",
      file: "/pixel-office/furniture/SOFA/SOFA_FRONT.png",
      x: s.col,
      y: s.row,
      tilesW: 2,
      tilesH: 1,
    });
  }
  for (const c of CHAIRS.filter((x) => x.area === "lounge")) {
    items.push({
      type: "CUSHIONED_CHAIR_FRONT",
      file: "/pixel-office/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png",
      x: c.col,
      y: c.row,
      tilesW: 1,
      tilesH: 1,
    });
  }
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 24, y: 12, tilesW: 1, tilesH: 2 });
  items.push({ type: "LARGE_PLANT", file: "/pixel-office/furniture/LARGE_PLANT/LARGE_PLANT.png", x: 33, y: 12, tilesW: 1, tilesH: 2 });
  items.push({ type: "BIN", file: "/pixel-office/furniture/BIN/BIN.png", x: 24, y: 19, tilesW: 1, tilesH: 1 });

  return items;
}

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

interface RoomBox {
  key: RoomKey;
  pattern: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ROOMS: RoomBox[] = [
  { key: "wood", pattern: "/pixel-office/floors/floor_5.png", ...MAIN_ROOM },
  { key: "beige", pattern: "/pixel-office/floors/floor_4.png", ...MEETING_ROOM },
  { key: "blue", pattern: "/pixel-office/floors/floor_0.png", ...LOUNGE_ROOM },
];

export interface PixelOfficeRendererProps {
  /** Children rendered as the agents layer (positioned absolutely inside the room). */
  children?: React.ReactNode;
  /** Set of PC seat ids that currently have an agent working — flips PC sprites to ON. */
  occupiedPcSeatIds?: Set<string>;
}

const PC_ON_FRAMES = [
  "/pixel-office/furniture/PC/PC_FRONT_ON_1.png",
  "/pixel-office/furniture/PC/PC_FRONT_ON_2.png",
  "/pixel-office/furniture/PC/PC_FRONT_ON_3.png",
];
const PC_OFF_FRAME = "/pixel-office/furniture/PC/PC_FRONT_OFF.png";

export function PixelOfficeRenderer({ children, occupiedPcSeatIds }: PixelOfficeRendererProps) {
  const furniture = useMemo(buildStaticFurniture, []);

  // Animate "ON" PCs by cycling through 3 frames at ~2.5fps.
  const [pcFrame, setPcFrame] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setPcFrame((f) => (f + 1) % PC_ON_FRAMES.length);
    }, 400);
    return () => window.clearInterval(id);
  }, []);

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

      {/* Static furniture layer */}
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

      {/* PCs (animated when occupied) */}
      {DESK_GROUPS.map((g) => {
        const seatId = `pc-seat-${g.pcId}`;
        const on = occupiedPcSeatIds?.has(seatId) ?? false;
        const src = on ? PC_ON_FRAMES[pcFrame] : PC_OFF_FRAME;
        return (
          <img
            key={`pc-${g.pcId}`}
            src={src}
            alt=""
            className="absolute pointer-events-none select-none"
            style={{
              left: g.pcCol * TILE,
              top: g.pcRow * TILE,
              width: 1 * TILE,
              height: 2 * TILE,
              imageRendering: "pixelated",
            }}
            draggable={false}
          />
        );
      })}

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
 * Walkable area for agents wandering — confined to the main wood-floor room interior.
 * Returns pixel rect agents can target.
 */
export function getWalkableBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
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
