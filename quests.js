export const QUESTS = [
  {
    id: 1,
    title: "The Morning Commute",
    description: "Take a 30 minute walk around your neighborhood right after waking up.",
    difficulty: 1,
    rarity: "chill", // chill, challenging, epic, legendary
    icon: "🚶",
    tags: {
      difficulty: "chill",
      party: ["solo", "duo"],
      budget: "free",
      environment: ["outdoor"],
      vibe: ["active", "chill"],
      time: "quick"
    }
  },
  {
    id: 2,
    title: "Urban Explorer",
    description: "Find 3 pieces of street art or murals you've never seen before and take a picture.",
    difficulty: 2,
    rarity: "challenging",
    icon: "🎨",
    tags: {
      difficulty: "challenging",
      party: ["solo", "duo", "squad"],
      budget: "free",
      environment: ["outdoor", "urban"],
      vibe: ["creative", "adventure"],
      time: "half-day"
    }
  },
  {
    id: 3,
    title: "The Great Feast",
    description: "Cook a 3-course meal from scratch for your friends or family.",
    difficulty: 3,
    rarity: "epic",
    icon: "🍲",
    tags: {
      difficulty: "challenging",
      party: ["solo", "duo"], // Solo cook, feeds many
      budget: "cheap",
      environment: ["indoor"],
      vibe: ["creative", "social"],
      time: "half-day"
    }
  },
  {
    id: 4,
    title: "Wilderness Survival",
    description: "Spend a night camping in the wilderness or a remote campsite.",
    difficulty: 3,
    rarity: "epic",
    icon: "🏕️",
    tags: {
      difficulty: "epic",
      party: ["duo", "squad"],
      budget: "cheap",
      environment: ["outdoor"],
      vibe: ["adventure", "chill"],
      time: "multi-day"
    }
  },
  {
    id: 5,
    title: "The Legendary Roadtrip",
    description: "Pack the car and drive at least 200 miles to a destination you've never been to.",
    difficulty: 4,
    rarity: "legendary",
    icon: "🚗",
    tags: {
      difficulty: "epic",
      party: ["duo", "squad"],
      budget: "splurge",
      environment: ["outdoor"],
      vibe: ["adventure", "social"],
      time: "multi-day"
    }
  },
  {
    id: 6,
    title: "Digital Detox",
    description: "Go 24 hours without looking at a single screen (phone, TV, computer).",
    difficulty: 3,
    rarity: "epic",
    icon: "📵",
    tags: {
      difficulty: "epic",
      party: ["solo"],
      budget: "free",
      environment: ["indoor", "outdoor"],
      vibe: ["chill"],
      time: "full-day"
    }
  },
  {
    id: 7,
    title: "Local Tourist",
    description: "Visit a local museum, historical site, or landmark in your town.",
    difficulty: 1,
    rarity: "chill",
    icon: "🏛️",
    tags: {
      difficulty: "chill",
      party: ["solo", "duo", "squad"],
      budget: "cheap",
      environment: ["indoor"],
      vibe: ["chill", "adventure"],
      time: "half-day"
    }
  },
  {
    id: 8,
    title: "Creative Outlet",
    description: "Spend 2 hours painting, drawing, writing, or making music.",
    difficulty: 1,
    rarity: "chill",
    icon: "🎸",
    tags: {
      difficulty: "chill",
      party: ["solo"],
      budget: "free",
      environment: ["indoor"],
      vibe: ["creative", "chill"],
      time: "quick"
    }
  },
  {
    id: 9,
    title: "The Tryout",
    description: "Attend a class for something you've never done (martial arts, pottery, dance).",
    difficulty: 2,
    rarity: "challenging",
    icon: "🥋",
    tags: {
      difficulty: "challenging",
      party: ["solo", "duo"],
      budget: "cheap",
      environment: ["indoor"],
      vibe: ["active", "social"],
      time: "quick"
    }
  },
  {
    id: 10,
    title: "Thrift Flipper",
    description: "Buy an item from a thrift store for under $10 and upcycle/flip it.",
    difficulty: 2,
    rarity: "challenging",
    icon: "👕",
    tags: {
      difficulty: "challenging",
      party: ["solo", "duo"],
      budget: "cheap",
      environment: ["indoor", "urban"],
      vibe: ["creative"],
      time: "half-day"
    }
  }
];
