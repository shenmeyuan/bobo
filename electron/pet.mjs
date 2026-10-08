export const DAY = 86_400_000;
export const STAGES = [
  {
    id: "seed",
    name: "种子期",
    from: 0,
    until: 1,
    description: "小小的期待，埋在柔软的土里。",
  },
  {
    id: "sprout",
    name: "发芽期",
    from: 1,
    until: 7,
    description: "两片新叶，正在认识这个世界。",
  },
  {
    id: "young",
    name: "幼年期",
    from: 7,
    until: 21,
    description: "第一次探出花盆，什么都很好奇。",
  },
  {
    id: "adult",
    name: "成年期",
    from: 21,
    until: 120,
    description: "圆圆的胡萝卜，和你一起过日子。",
  },
  {
    id: "elder",
    name: "老年期",
    from: 120,
    until: 180,
    description: "慢一点也很好，我们有很多故事。",
  },
  {
    id: "memory",
    name: "回忆期",
    from: 180,
    until: Infinity,
    description: "这段陪伴，已经住进了回忆里。",
  },
];
export const localDay = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export function stageOf(pet) {
  const age = pet.companionMs / DAY;
  return STAGES.find((stage) => age < stage.until) ?? STAGES[STAGES.length - 1];
}
export function newPet(generation = 1, now = Date.now()) {
  return {
    id: `bobo-${generation}-${now}`,
    name: "Bobo",
    generation,
    bornAt: now,
    lastSeenAt: now,
    companionMs: 0,
    hydration: 64,
    energy: 76,
    bond: 8,
    sleeping: false,
    careDay: localDay(now),
    careCounts: { water: 0, touch: 0, sun: 0 },
    moments: 0,
  };
}
export function advancePet(pet, now = Date.now()) {
  if (!Number.isFinite(now) || now <= pet.lastSeenAt) return pet;
  // Calendar growth pauses after two days away. Backward clocks never rewind a pet.
  const elapsed = Math.min(now - pet.lastSeenAt, DAY * 2);
  const age = Math.min(pet.companionMs + elapsed, DAY * 180);
  return {
    ...pet,
    companionMs: age,
    lastSeenAt: now,
    hydration: Math.max(20, pet.hydration - (elapsed / DAY) * 8),
    energy: Math.max(
      30,
      Math.min(100, pet.energy + (elapsed / DAY) * (pet.sleeping ? 15 : -3)),
    ),
    careDay: localDay(now),
    careCounts:
      pet.careDay === localDay(now)
        ? pet.careCounts
        : { water: 0, touch: 0, sun: 0 },
  };
}
export function careFor(pet, action, now = Date.now()) {
  pet = advancePet(pet, now);
  if (!["water", "touch", "sun", "sleep"].includes(action))
    throw new Error("不认识这个照料动作。");
  if (stageOf(pet).id === "memory")
    return {
      pet,
      text: "我们的回忆留在花盆里。准备好时，可以种下下一颗种子。",
      changed: false,
    };
  if (action === "sleep")
    return {
      pet: { ...pet, sleeping: !pet.sleeping },
      text: pet.sleeping
        ? "睡饱啦，今天也一起待着吧。"
        : "我回花盆里打个盹，有任务结束还是会告诉你。",
      changed: true,
    };
  const limits = { water: 3, touch: 5, sun: 2 };
  if (pet.careCounts[action] >= limits[action])
    return {
      pet,
      text:
        action === "water"
          ? "今天的水已经够啦，陪我待一会儿就好。"
          : "今天已经很满足啦，明天再一起玩吧。",
      changed: false,
    };
  const next = {
    ...pet,
    sleeping: false,
    careCounts: { ...pet.careCounts, [action]: pet.careCounts[action] + 1 },
  };
  if (action === "water") {
    next.hydration = Math.min(100, pet.hydration + 14);
    next.bond = Math.min(100, pet.bond + 2);
  }
  if (action === "touch") next.bond = Math.min(100, pet.bond + 3);
  if (action === "sun") {
    next.energy = Math.min(100, pet.energy + 12);
    next.bond = Math.min(100, pet.bond + 1);
  }
  return {
    pet: next,
    changed: true,
    text: {
      water: "咕噜咕噜，喝饱了。谢谢你照顾我。",
      touch: "嘿嘿，感觉离你又近了一点。",
      sun: "暖暖的，叶子也伸了个懒腰。",
    }[action],
  };
}
