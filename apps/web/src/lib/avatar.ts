// A staff member's generated look (DESIGN.md › The office experience: "Every character has a
// generated look of its own"). The look comes from `agent.avatar` alone, so it is the same on every
// screen and after every restart, and two seeds rarely share one.

export type HairStyle =
  | "short"
  | "buzz"
  | "bob"
  | "long"
  | "bun"
  | "curly"
  | "ponytail"
  | "spiky"
  | "afro"
  | "sidepart"
  | "bald";

export type Accessory = "none" | "round_glasses" | "square_glasses" | "headphones" | "beanie" | "earrings" | "tie" | "scarf" | "hairclip";

export type Outfit = "tee" | "collar" | "hoodie" | "blazer" | "sweater";

export interface Look {
  skin: string;
  /** A darker skin tone for the neck, ears, and hands. */
  skinShade: string;
  hairStyle: HairStyle;
  hair: string;
  outfit: Outfit;
  clothing: string;
  /** A darker shade of the clothing for folds and sleeves. */
  clothingShade: string;
  accessory: Accessory;
  /** A color for the accessory, the mug, and the pod's rug. */
  accent: string;
  /** Freckles or a beauty mark: a small detail that makes faces easier to tell apart. */
  mark: "none" | "freckles" | "mole";
}

export const SKIN_TONES = ["#fbe0cf", "#f5cfb1", "#eab48f", "#d89a70", "#b97a50", "#99603c", "#7a4a2c", "#5a3720"] as const;
export const HAIR_COLORS = ["#1d1a1f", "#3b2a20", "#5e3b23", "#8a5a2b", "#b0472a", "#d9b26a", "#e8dcc0", "#8c8f96", "#3f6e8c", "#a8578f"] as const;
/** Natural colors come up twice as often as the dyed ones at the end. */
const HAIR_WEIGHTED = [...HAIR_COLORS.slice(0, 8), ...HAIR_COLORS.slice(0, 8), ...HAIR_COLORS.slice(8)];
export const HAIR_STYLES: readonly HairStyle[] = ["short", "buzz", "bob", "long", "bun", "curly", "ponytail", "spiky", "afro", "sidepart", "bald"];
export const ACCESSORIES: readonly Accessory[] = ["none", "round_glasses", "square_glasses", "headphones", "beanie", "earrings", "tie", "scarf", "hairclip"];
export const OUTFITS: readonly Outfit[] = ["tee", "collar", "hoodie", "blazer", "sweater"];
export const CLOTHING_COLORS = ["#4f7cff", "#2bb3a3", "#f0a33a", "#e2566e", "#8a63d2", "#3c9d4e", "#e07a3f", "#2f4a7a", "#c94f9b", "#5a6b7d", "#d4b13a", "#2e8fc7"] as const;
const ACCENTS = ["#ff8a65", "#ffd166", "#06d6a0", "#4cc9f0", "#b388ff", "#f78fb3", "#9ad16b", "#f4a261"] as const;

/** A 32-bit hash of the seed: FNV-1a, then a finalizer so similar seeds land far apart. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** A small seeded generator (mulberry32): the same seed always gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, options: readonly T[]): T {
  return options[Math.floor(random() * options.length)]!;
}

/** Darkens a #rrggbb color by a fraction. */
export function shade(color: string, amount: number): string {
  const value = Number.parseInt(color.slice(1), 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 0xff) * (1 - amount));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

export function lookFor(seed: string): Look {
  const random = seededRandom(hashSeed(seed));
  const skin = pick(random, SKIN_TONES);
  const hairStyle = pick(random, HAIR_STYLES);
  const hair = pick(random, HAIR_WEIGHTED);
  const outfit = pick(random, OUTFITS);
  const clothing = pick(random, CLOTHING_COLORS);
  let accessory = pick(random, ACCESSORIES);
  // A hat would hide a bun or an afro, and a clip needs hair to sit in.
  if (accessory === "beanie" && (hairStyle === "bun" || hairStyle === "afro")) accessory = "round_glasses";
  if (accessory === "hairclip" && (hairStyle === "bald" || hairStyle === "buzz")) accessory = "earrings";
  const accent = pick(random, ACCENTS);
  const markRoll = random();
  return {
    skin,
    skinShade: shade(skin, 0.12),
    hairStyle,
    hair,
    outfit,
    clothing,
    clothingShade: shade(clothing, 0.22),
    accessory,
    accent,
    mark: markRoll < 0.2 ? "freckles" : markRoll < 0.32 ? "mole" : "none",
  };
}

/** The parts of a look the eye uses to tell people apart, as one string. */
export function lookKey(look: Look): string {
  return [look.skin, look.hairStyle, look.hair, look.outfit, look.clothing, look.accessory].join("|");
}
