import test from "node:test";
import assert from "node:assert/strict";
import { DAY, newPet, stageOf, advancePet, careFor } from "../electron/pet.mjs";
const start = new Date("2026-10-03T10:00:00+08:00").getTime();
test("lifecycle has distinct stages through a six-month life", () => {
  const pet = newPet(1, start);
  for (const [days, expected] of [
    [0, "seed"],
    [1, "sprout"],
    [7, "young"],
    [21, "adult"],
    [120, "elder"],
    [180, "memory"],
  ])
    assert.equal(stageOf({ ...pet, companionMs: days * DAY }).id, expected);
});
test("long absences pause growth after two days; a backward clock cannot rewind it", () => {
  const pet = newPet(1, start);
  const after = advancePet(pet, start + DAY * 30);
  assert.equal(after.companionMs, DAY * 2);
  assert.equal(after.lastSeenAt, start + DAY * 30);
  assert.deepEqual(advancePet(after, start), after);
  assert.ok(after.hydration >= 20);
});
test("daily care is capped but does not accelerate biological age", () => {
  let pet = newPet(1, start);
  for (let i = 0; i < 3; i++) pet = careFor(pet, "water", start).pet;
  const capped = careFor(pet, "water", start);
  assert.equal(capped.changed, false);
  assert.equal(capped.pet.bond, pet.bond);
  assert.equal(pet.companionMs, 0);
  const tomorrow = careFor(pet, "water", start + DAY);
  assert.equal(tomorrow.changed, true);
  assert.equal(tomorrow.pet.careCounts.water, 1);
});
test("a completed life cannot be watered or changed into a younger pet", () => {
  const pet = { ...newPet(1, start), companionMs: DAY * 180 };
  assert.equal(careFor(pet, "touch", start).changed, false);
  assert.throws(() => careFor(pet, "bogus", start));
});
