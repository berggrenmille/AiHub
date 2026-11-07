import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCESSORIES, CLOTHING_COLORS, HAIR_COLORS, HAIR_STYLES, OUTFITS, SKIN_TONES, hashSeed, lookFor, lookKey, seededRandom, shade } from "./avatar.ts";

describe("avatar looks", () => {
  it("gives the same seed the same look every time", () => {
    for (const seed of ["chief-of-staff", "work-schedule", "Rut", ""]) {
      assert.deepEqual(lookFor(seed), lookFor(seed));
    }
    assert.equal(hashSeed("portfolio"), hashSeed("portfolio"));
  });

  it("gives the seeded staff distinct looks", () => {
    const seeds = ["chief-of-staff", "work-schedule", "work-inbox", "personal-inbox", "portfolio"];
    const keys = new Set(seeds.map((seed) => lookKey(lookFor(seed))));
    assert.equal(keys.size, seeds.length);
  });

  it("spreads looks across many seeds", () => {
    const keys = new Set(Array.from({ length: 200 }, (_, index) => lookKey(lookFor(`agent-${index}`))));
    assert.ok(keys.size >= 195, `only ${keys.size} distinct looks of 200`);
    const styles = new Set(Array.from({ length: 200 }, (_, index) => lookFor(`agent-${index}`).hairStyle));
    assert.equal(styles.size, HAIR_STYLES.length, "every hair style comes up");
  });

  it("only picks from its palettes, and never puts a hat on a bun", () => {
    for (let index = 0; index < 300; index++) {
      const look = lookFor(`seed-${index}`);
      assert.ok((SKIN_TONES as readonly string[]).includes(look.skin));
      assert.ok((HAIR_COLORS as readonly string[]).includes(look.hair));
      assert.ok((CLOTHING_COLORS as readonly string[]).includes(look.clothing));
      assert.ok(OUTFITS.includes(look.outfit));
      assert.ok(ACCESSORIES.includes(look.accessory));
      assert.match(look.skinShade, /^#[0-9a-f]{6}$/);
      if (look.hairStyle === "bun" || look.hairStyle === "afro") assert.notEqual(look.accessory, "beanie");
      if (look.hairStyle === "bald" || look.hairStyle === "buzz") assert.notEqual(look.accessory, "hairclip");
    }
  });

  it("hashes similar seeds far apart and generates numbers in [0, 1)", () => {
    assert.notEqual(hashSeed("agent-1"), hashSeed("agent-2"));
    const random = seededRandom(42);
    const again = seededRandom(42);
    for (let index = 0; index < 50; index++) {
      const value = random();
      assert.equal(value, again());
      assert.ok(value >= 0 && value < 1);
    }
  });

  it("darkens a color by a fraction", () => {
    assert.equal(shade("#ffffff", 0.5), "#808080");
    assert.equal(shade("#4f7cff", 0), "#4f7cff");
    assert.equal(shade("#123456", 1), "#000000");
  });
});
