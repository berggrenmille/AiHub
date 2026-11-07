// Levels from experience. `agent.experience` counts delivered results and resolved items, so a level
// only ever reflects real work (DESIGN.md › The office experience).
//
// The formula: going from level L to level L + 1 takes 5 × L experience. Level 1 starts at 0, so
// level L starts at 5 × L × (L − 1) / 2:
//
//   level      1   2   3   4   5   6    7    8
//   starts at  0   5  15  30  50  75  105  140
//
// Early levels come quickly, and each later one takes a little more work than the last.

export const XP_STEP = 5;

export interface Level {
  level: number;
  /** Experience earned since this level started. */
  into: number;
  /** Experience this level takes in all, from its start to the next level. */
  span: number;
  /** Experience still needed for the next level. */
  toNext: number;
  /** 0 to 1: how far through this level. */
  progress: number;
  /** A word for the level, for the profile card. */
  rank: string;
}

/** The total experience at which a level starts. */
export function levelStart(level: number): number {
  return (XP_STEP * level * (level - 1)) / 2;
}

const RANKS = ["New hire", "Regular", "Trusted", "Seasoned", "Veteran", "Expert", "Mainstay", "Legend"] as const;

export function levelOf(experience: number): Level {
  const xp = Number.isFinite(experience) ? Math.max(0, Math.floor(experience)) : 0;
  let level = 1;
  while (levelStart(level + 1) <= xp) level++;
  const into = xp - levelStart(level);
  const span = levelStart(level + 1) - levelStart(level);
  return {
    level,
    into,
    span,
    toNext: span - into,
    progress: into / span,
    rank: RANKS[Math.min(level, RANKS.length) - 1]!,
  };
}
