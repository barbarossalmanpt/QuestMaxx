import { QUESTS } from './quests.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, getDocs, updateDoc, collection, onSnapshot, arrayUnion, arrayRemove, query, where, deleteDoc, addDoc, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// --- Global State ---
let isMuted = false;
let currentView = 'view-home';
let wizardStep = 0;
let userAnswers = {};
let selectedQuest = null; // Track selected quest for accepting

// --- Character / Progression State ---
let characterState = {
  nickname: 'ADVENTURER',
  avatarType: 'preset', // 'preset' or 'custom'
  avatarClass: 'warrior', // warrior, mage, rogue, ranger, paladin, bard
  avatarData: '', // base64 URL for custom upload
  xp: 0,
  level: 1,
  guildId: ''
};
let activeQuests = []; // max 3 active quests
let completedQuests = []; // history of { questId, title, completedAt, xpEarned }

// --- Friends State ---
let friendCode = '';
let friendsList = []; // array of { code: 'QM-XXXX', name: 'Adventurer', avatarType: 'preset', avatarClass: 'warrior', avatarData: '' }
let notificationsList = [];

// Preset class avatars mapping
const AVATAR_PRESETS = {
  warrior: '⚔️',
  mage: '🔮',
  rogue: '🗡️',
  ranger: '🏹',
  paladin: '🛡️',
  bard: '🎸'
};

// --- Firebase Config & Setup ---
const firebaseConfig = {
  apiKey: ["AIzaSy", "C4mR2", "GQVb7xP", "apezXFeoJZ", "KcO87qpc2lU"].join(""),
  authDomain: "questmax-c4972.firebaseapp.com",
  projectId: "questmax-c4972",
  storageBucket: "questmax-c4972.firebasestorage.app",
  messagingSenderId: "707138224890",
  appId: "1:707138224890:web:3463273a6b9d0c676fbf43"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let currentUser = null;
let unsubscribeUser = null;
let unsubscribeNotifications = null;
let unsubscribeLobby = null;
let pendingRegistrationData = null;
let friendSubscriptions = {};
let friendDataCache = {};
let friendProfileSourceView = 'friends';
let toastedNotificationIds = new Set();

// --- Guilds State ---
let activeGuild = null;
let unsubscribeGuild = null;
let unsubscribeGuildChat = null;
let unsubscribeGuildLeaderboard = null;

// --- Initialize user document structure in Firestore ---
async function initializeUserDocument(user, customData = {}) {
  const docRef = doc(db, 'users', user.uid);
  try {
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data();
    }
  } catch (e) {
    console.warn("Could not check if user doc exists, proceeding with creation", e);
  }

  const generatedCode = 'QM-' + Math.random().toString(36).substring(2, 6).toUpperCase();
  await setDoc(doc(db, 'friendCodes', generatedCode), { uid: user.uid });
  
  const defaults = {
    nickname: user.displayName ? user.displayName.toUpperCase().slice(0, 15) : 'ADVENTURER',
    avatarType: 'preset',
    avatarClass: 'warrior',
    avatarData: '',
    xp: 0,
    level: 1,
    friendCode: generatedCode,
    friendsList: [],
    activeQuests: [],
    completedQuests: [],
    guildId: ''
  };

  const finalData = { ...defaults, ...customData };
  await setDoc(docRef, finalData);
  return finalData;
}

// Secondary self-healing: query the users collection to find the UID matching a friendCode
async function fallbackResolveUID(fCode) {
  try {
    const q = query(collection(db, 'users'), where('friendCode', '==', fCode));
    const querySnapshot = await getDocs(q);
    if (!querySnapshot.empty) {
      return querySnapshot.docs[0].id;
    }
  } catch (err) {
    console.error("Error running fallbackResolveUID query for code " + fCode + ":", err);
  }
  return null;
}

// --- LocalStorage & Firebase Persistence ---
function saveToLocalStorage() {
  localStorage.setItem('questmax_character', JSON.stringify(characterState));
  localStorage.setItem('questmax_active', JSON.stringify(activeQuests));
  localStorage.setItem('questmax_completed', JSON.stringify(completedQuests));
  localStorage.setItem('questmax_friendCode', friendCode);
  localStorage.setItem('questmax_friendsList', JSON.stringify(friendsList));
  localStorage.setItem('questmax_notificationsList', JSON.stringify(notificationsList));
  
  if (currentUser) {
    saveToFirestore();
  }
}

async function saveToFirestore() {
  if (!currentUser) return;
  try {
    await setDoc(doc(db, 'users', currentUser.uid), {
      nickname: characterState.nickname,
      avatarType: characterState.avatarType,
      avatarClass: characterState.avatarClass,
      avatarData: characterState.avatarData,
      xp: characterState.xp,
      level: characterState.level,
      friendCode: friendCode,
      friendsList: friendsList,
      activeQuests: activeQuests,
      completedQuests: completedQuests,
      guildId: characterState.guildId || ''
    });
  } catch (err) {
    console.error("Error saving to Firestore:", err);
  }
}

function loadFromLocalStorage() {
  const charData = localStorage.getItem('questmax_character');
  const activeData = localStorage.getItem('questmax_active');
  const completedData = localStorage.getItem('questmax_completed');
  const fcData = localStorage.getItem('questmax_friendCode');
  const flData = localStorage.getItem('questmax_friendsList');
  const notificationsData = localStorage.getItem('questmax_notificationsList');

  if (charData) characterState = JSON.parse(charData);
  if (activeData) activeQuests = JSON.parse(activeData);
  if (completedData) completedQuests = JSON.parse(completedData);
  
  if (fcData) friendCode = fcData;
  if (flData) friendsList = JSON.parse(flData);
  if (notificationsData) notificationsList = JSON.parse(notificationsData);
}

// --- Audio Context Setup ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
  if (isMuted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  
  osc.type = 'square'; // 8-bit style
  
  const now = audioCtx.currentTime;
  
  switch(type) {
    case 'click':
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
      gainNode.gain.setValueAtTime(0.1, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
      break;
    case 'toggleOn':
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.setValueAtTime(600, now + 0.05);
      gainNode.gain.setValueAtTime(0.1, now);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
      break;
    case 'toggleOff':
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.setValueAtTime(200, now + 0.05);
      gainNode.gain.setValueAtTime(0.1, now);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
      break;
    case 'chestRumble':
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(50, now);
      osc.frequency.linearRampToValueAtTime(80, now + 0.8);
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.2, now + 0.3);
      gainNode.gain.linearRampToValueAtTime(0.25, now + 0.6);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.8);
      osc.start(now);
      osc.stop(now + 0.8);
      break;
    case 'chestBurst':
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(1000, now + 0.15);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.3);
      gainNode.gain.setValueAtTime(0.25, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
      break;
    case 'cardDing':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      gainNode.gain.setValueAtTime(0.1, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
      break;
    case 'success':
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.setValueAtTime(500, now + 0.1);
      osc.frequency.setValueAtTime(600, now + 0.2);
      osc.frequency.setValueAtTime(800, now + 0.3);
      gainNode.gain.setValueAtTime(0.1, now);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
      break;
    case 'levelUp':
      osc.type = 'sawtooth';
      // Retro triumphant level up arpeggio
      osc.frequency.setValueAtTime(220, now); // A3
      osc.frequency.setValueAtTime(277, now + 0.1); // C#4
      osc.frequency.setValueAtTime(330, now + 0.2); // E4
      osc.frequency.setValueAtTime(440, now + 0.3); // A4
      osc.frequency.setValueAtTime(554, now + 0.4); // C#5
      osc.frequency.setValueAtTime(660, now + 0.5); // E5
      osc.frequency.setValueAtTime(880, now + 0.6); // A5
      gainNode.gain.setValueAtTime(0.15, now);
      gainNode.gain.linearRampToValueAtTime(0.15, now + 0.6);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
      osc.start(now);
      osc.stop(now + 0.9);
      break;
    case 'notification':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.setValueAtTime(800, now + 0.1);
      gainNode.gain.setValueAtTime(0.2, now);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
      break;
    case 'modalOpen':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(500, now);
      osc.frequency.setValueAtTime(700, now + 0.08);
      gainNode.gain.setValueAtTime(0.08, now);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
      break;
    case 'xboxConnect':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.35);
      gainNode.gain.setValueAtTime(0.15, now);
      gainNode.gain.linearRampToValueAtTime(0, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
      break;
    case 'xboxFullLobby':
      const frequencies = [659.25, 830.61, 987.77, 1318.51];
      frequencies.forEach((freq, idx) => {
        const subOsc = audioCtx.createOscillator();
        const subGain = audioCtx.createGain();
        subOsc.type = 'triangle';
        subOsc.frequency.setValueAtTime(freq, now + idx * 0.05);
        subGain.gain.setValueAtTime(0.1, now + idx * 0.05);
        subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5 + idx * 0.05);
        subOsc.connect(subGain);
        subGain.connect(audioCtx.destination);
        subOsc.start(now + idx * 0.05);
        subOsc.stop(now + 0.7 + idx * 0.05);
      });
      break;
  }
}

// --- Background Particles ---
function createParticles() {
  const container = document.getElementById('particles-container');
  const particleCount = 25;
  for (let i = 0; i < particleCount; i++) {
    let p = document.createElement('div');
    p.classList.add('particle');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.animationDuration = (Math.random() * 6 + 6) + 's';
    p.style.animationDelay = Math.random() * 6 + 's';
    container.appendChild(p);
  }
}

// --- Choice Modal ---
function openChoiceModal() {
  playSound('modalOpen');
  document.getElementById('choice-overlay').classList.add('visible');
}

function closeChoiceModal() {
  playSound('click');
  document.getElementById('choice-overlay').classList.remove('visible');
}

// --- Navigation & Views ---
function switchView(targetViewId) {
  playSound('click');
  const current = document.getElementById(currentView);
  const target = document.getElementById(targetViewId);
  
  if (current) current.classList.replace('active-view', 'hidden-view');
  if (target) target.classList.replace('hidden-view', 'active-view');
  
  currentView = targetViewId;
}

// --- Wizard Data ---
const WIZARD_STEPS = [
  {
    id: 'difficulty',
    title: 'CHOOSE DIFFICULTY',
    options: [
      { value: 'chill', label: 'Chill', icon: '🌿' },
      { value: 'challenging', label: 'Challenging', icon: '⚔️' },
      { value: 'epic', label: 'Epic', icon: '🔥' }
    ]
  },
  {
    id: 'party',
    title: 'PARTY SIZE',
    options: [
      { value: 'solo', label: 'Solo', icon: '🐺' },
      { value: 'duo', label: 'Duo', icon: '🤝' },
      { value: 'squad', label: 'Squad', icon: '🛡️' }
    ]
  },
  {
    id: 'budget',
    title: 'BUDGET',
    options: [
      { value: 'free', label: 'Free', icon: '🆓' },
      { value: 'cheap', label: 'Cheap', icon: '💵' },
      { value: 'splurge', label: 'Splurge', icon: '💎' }
    ]
  },
  {
    id: 'environment',
    title: 'ENVIRONMENT',
    options: [
      { value: 'indoor', label: 'Indoor', icon: '🏠' },
      { value: 'outdoor', label: 'Outdoor', icon: '🌲' },
      { value: 'urban', label: 'Urban', icon: '🏙️' }
    ]
  },
  {
    id: 'vibe',
    title: 'YOUR VIBE',
    options: [
      { value: 'creative', label: 'Creative', icon: '🎨' },
      { value: 'active', label: 'Active', icon: '🏃' },
      { value: 'chill', label: 'Chill', icon: '🏕️' },
      { value: 'adventure', label: 'Adventure', icon: '🗺️' },
      { value: 'social', label: 'Social', icon: '🍻' }
    ]
  },
  {
    id: 'time',
    title: 'TIME COMMITMENT',
    options: [
      { value: 'quick', label: 'Quick', icon: '⚡' },
      { value: 'half-day', label: 'Half-Day', icon: '🌤️' },
      { value: 'full-day', label: 'Full Day', icon: '🌅' },
      { value: 'multi-day', label: 'Multi-Day', icon: '🏕️' }
    ]
  }
];

// --- Wizard Logic ---
function initWizard() {
  wizardStep = 0;
  userAnswers = {};
  renderWizardStep();
}

function renderWizardStep() {
  const stepData = WIZARD_STEPS[wizardStep];
  document.getElementById('wizard-question-title').textContent = stepData.title;
  document.getElementById('wizard-step-text').textContent = `${wizardStep + 1}/${WIZARD_STEPS.length}`;
  
  const progressPct = ((wizardStep) / WIZARD_STEPS.length) * 100;
  document.getElementById('wizard-progress-fill').style.width = `${progressPct}%`;

  const container = document.getElementById('wizard-options-container');
  container.innerHTML = '';
  
  if (!userAnswers[stepData.id]) {
    userAnswers[stepData.id] = [];
  }

  stepData.options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'inventory-slot';
    if (userAnswers[stepData.id].includes(opt.value)) {
      btn.classList.add('selected');
    }
    
    btn.innerHTML = `
      <span class="slot-icon">${opt.icon}</span>
      <span class="slot-label">${opt.label}</span>
    `;
    
    btn.addEventListener('click', () => {
      const isSelected = btn.classList.toggle('selected');
      if (isSelected) {
        playSound('toggleOn');
        userAnswers[stepData.id].push(opt.value);
      } else {
        playSound('toggleOff');
        userAnswers[stepData.id] = userAnswers[stepData.id].filter(v => v !== opt.value);
      }
    });
    
    container.appendChild(btn);
  });
}

function nextWizardStep() {
  playSound('click');
  const stepData = WIZARD_STEPS[wizardStep];
  
  if (userAnswers[stepData.id].length === 0) {
    alert("Select at least one option!");
    return;
  }

  wizardStep++;
  if (wizardStep < WIZARD_STEPS.length) {
    renderWizardStep();
  } else {
    document.getElementById('wizard-progress-fill').style.width = '100%';
    generateQuests();
  }
}

// --- Quest Generation & Chest Animation ---
function generateQuests() {
  switchView('view-reveal');
  
  const chestContainer = document.querySelector('.chest-container');
  const chest = document.getElementById('treasure-chest');
  const glow = document.getElementById('chest-glow');
  
  // Reset chest state
  chestContainer.classList.remove('chest-shake');
  chest.classList.remove('chest-opened');
  glow.classList.remove('glow-burst');
  
  // Phase 1: Shake
  playSound('chestRumble');
  chestContainer.classList.add('chest-shake');
  
  setTimeout(() => {
    // Phase 2: Burst open
    chestContainer.classList.remove('chest-shake');
    chest.classList.add('chest-opened');
    playSound('chestBurst');
    glow.classList.add('glow-burst');
    
    // Calculate results while animating
    const results = filterQuests(userAnswers);
    renderResults(results.slice(0, 5));
    
    setTimeout(() => {
      // Phase 3: Transition to results
      glow.classList.remove('glow-burst');
      chest.classList.remove('chest-opened');
      switchView('view-results');
      
      // Play card ding sounds
      const cards = document.querySelectorAll('#results-list .quest-card');
      cards.forEach((card, index) => {
        setTimeout(() => {
          playSound('cardDing');
        }, index * 400);
      });

    }, 1800);
    
  }, 1200);
}

function filterQuests(answers) {
  let scoredQuests = QUESTS.map(q => {
    let score = 0;
    Object.keys(answers).forEach(key => {
      const userSelections = answers[key];
      const questTags = Array.isArray(q.tags[key]) ? q.tags[key] : [q.tags[key]];
      
      const hasMatch = userSelections.some(sel => questTags.includes(sel));
      if (hasMatch) score++;
    });
    return { ...q, score };
  });
  
  scoredQuests.sort((a, b) => b.score - a.score);
  return scoredQuests;
}

// --- Progression Arithmetic ---
function getXPForLevel(level) {
  return level * 100;
}

function getQuestXPReward(quest) {
  // Reward XP based on difficulty property (1, 2, 3, 4)
  switch(quest.difficulty) {
    case 1: return 25;
    case 2: return 50;
    case 3: return 100;
    case 4: return 200;
    default: return 50;
  }
}
// --- Rendering Quests ---
function getDifficultySkulls(level) {
  return '⚔️'.repeat(level);
}

function createQuestCard(quest) {
  const div = document.createElement('div');
  div.className = 'quest-card';
  div.setAttribute('data-rarity', quest.rarity);
  
  div.innerHTML = `
    <div class="quest-icon">${quest.icon}</div>
    <div class="quest-details">
      <h3 class="quest-title">${quest.title}</h3>
      <p class="quest-desc">${quest.description}</p>
      <div class="quest-meta">
        <span class="difficulty-skulls">${getDifficultySkulls(quest.difficulty)}</span>
        <span>+${getQuestXPReward(quest)} XP</span>
      </div>
    </div>
  `;
  
  div.addEventListener('click', () => {
    playSound('click');
    openQuestCodex(quest, currentView);
  });

  return div;
}

function renderResults(quests) {
  const container = document.getElementById('results-list');
  container.innerHTML = '';
  document.getElementById('btn-accept-quest').classList.add('hidden');
  selectedQuest = null;
  
  quests.forEach((q, index) => {
    const card = createQuestCard(q);
    card.style.animationDelay = `${index * 0.4}s`;
    container.appendChild(card);
  });
}

function renderQuestBoard(filter = 'all') {
  const container = document.getElementById('board-list');
  container.innerHTML = '';
  document.getElementById('btn-accept-quest').classList.add('hidden');
  document.getElementById('btn-accept-board-quest').classList.add('hidden');
  selectedQuest = null;
  
  let filtered = QUESTS;
  if (filter !== 'all') {
    filtered = QUESTS.filter(q => q.rarity === filter);
  }
  
  filtered.forEach((q, index) => {
    const card = createQuestCard(q);
    card.style.animationDelay = `${index * 0.1}s`;
    container.appendChild(card);
  });
}

// --- Profile Customization & Journal UI rendering ---
function updateProfileUI() {
  // Update Nickname
  const nameInput = document.getElementById('input-nickname');
  if (nameInput) nameInput.value = characterState.nickname;

  // Update Avatar Image/Placeholder
  const avatarImg = document.getElementById('profile-avatar');
  const avatarPlaceholder = document.getElementById('profile-avatar-placeholder');
  
  if (characterState.avatarType === 'custom' && characterState.avatarData) {
    avatarImg.src = characterState.avatarData;
    avatarImg.classList.remove('hidden');
    avatarPlaceholder.classList.add('hidden');
  } else {
    avatarImg.classList.add('hidden');
    avatarPlaceholder.textContent = AVATAR_PRESETS[characterState.avatarClass] || '⚔️';
    avatarPlaceholder.classList.remove('hidden');
  }

  // Update Stats & XP Bar
  const levelText = document.getElementById('stat-level');
  const xpText = document.getElementById('stat-xp-text');
  const xpFill = document.getElementById('profile-xp-fill');
  
  if (levelText && xpText && xpFill) {
    levelText.textContent = characterState.level;
    const threshold = getXPForLevel(characterState.level);
    xpText.textContent = `${characterState.xp} / ${threshold} XP`;
    const progressPct = Math.min((characterState.xp / threshold) * 100, 100);
    xpFill.style.width = `${progressPct}%`;
  }

  // Update Quest Journal (History)
  const ledgerList = document.getElementById('completed-quest-list');
  if (ledgerList) {
    if (completedQuests.length === 0) {
      ledgerList.innerHTML = '<p class="empty-journal-msg">No completed quests yet.</p>';
    } else {
      ledgerList.innerHTML = '';
      // Show in reverse chronological order
      [...completedQuests].reverse().forEach(q => {
        const entry = document.createElement('div');
        entry.className = 'ledger-entry';
        entry.innerHTML = `
          <span class="ledger-entry-title">${q.title}</span>
          <span class="ledger-entry-xp">+${q.xpEarned} XP</span>
        `;
        ledgerList.appendChild(entry);
      });
    }
  }
}

// --- Active/Pending Quests UI rendering ---
function updateActiveQuestsUI() {
  const container = document.getElementById('active-quests-list');
  if (!container) return;

  if (activeQuests.length === 0) {
    container.innerHTML = '<p class="empty-active-msg">No active quests. Choose a path above to accept one!</p>';
    return;
  }

  container.innerHTML = '';
  activeQuests.forEach(q => {
    const card = document.createElement('div');
    card.className = 'active-quest-card clickable';
    card.style.cursor = 'pointer';
    
    let coOpAvatarsHtml = '';
    const readyFriends = (q.coopFriends || []).filter(f => f.status === 'ready');
    if (readyFriends.length > 0) {
      coOpAvatarsHtml = `<div class="active-coop-avatars" style="display:flex; gap: 4px; margin-top: 4px;">`;
      readyFriends.forEach(f => {
        let icon = f.avatarType === 'custom' && f.avatarData ? `<img src="${f.avatarData}" style="width:16px;height:16px;border-radius:2px;object-fit:cover;">` : (AVATAR_PRESETS[f.avatarClass] || '⚔️');
        coOpAvatarsHtml += `<span class="coop-mini-avatar" title="${f.name}" style="font-size:10px; background:#000; padding:2px; border:1px solid var(--gold-primary); border-radius:3px; display:flex; align-items:center; justify-content:center; width:18px; height:18px;">${icon}</span>`;
      });
      coOpAvatarsHtml += `</div>`;
    }

    const baseReward = getQuestXPReward(q);
    const hasCoop = readyFriends.length > 0;
    const finalReward = hasCoop ? Math.round(baseReward * 1.25) : baseReward;
    const bonusText = hasCoop ? ' <span style="font-size:0.8rem;color:var(--emerald);">(+25% CO-OP)</span>' : '';

    card.innerHTML = `
      <div class="active-quest-info">
        <span class="active-quest-icon">${q.icon}</span>
        <div class="active-quest-text">
          <span class="active-quest-title-text">${q.title}</span>
          <span class="active-quest-reward-text">+${finalReward} XP${bonusText}</span>
          ${coOpAvatarsHtml}
        </div>
      </div>
      <div class="active-quest-actions">
        <button class="active-action-btn btn-complete-active" data-id="${q.id}" title="Complete Quest">✓</button>
        <button class="active-action-btn btn-abandon-active" data-id="${q.id}" title="Abandon Quest">✕</button>
      </div>
    `;
    
    // Clicking active quest opens Codex
    card.addEventListener('click', () => {
      openQuestCodex(q, 'view-home');
    });

    // Wire complete action
    card.querySelector('.btn-complete-active').addEventListener('click', (e) => {
      e.stopPropagation();
      completeQuest(q.id);
    });

    // Wire abandon action
    card.querySelector('.btn-abandon-active').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to abandon the quest "${q.title}"?`)) {
        abandonQuest(q.id);
      }
    });

    container.appendChild(card);
  });
}

// --- Complete Quest Action ---
function completeQuest(questId) {
  const questIndex = activeQuests.findIndex(q => q.id === questId);
  if (questIndex === -1) return;

  const quest = activeQuests[questIndex];
  const baseReward = getQuestXPReward(quest);
  const readyFriends = (quest.coopFriends || []).filter(f => f.status === 'ready');
  const multiplier = readyFriends.length > 0 ? 1.25 : 1.0;
  const xpReward = Math.round(baseReward * multiplier);
  
  // Update state
  completedQuests.push({
    questId: quest.id,
    title: quest.title,
    xpEarned: xpReward,
    completedAt: new Date().toISOString()
  });

  activeQuests.splice(questIndex, 1);

  // Apply XP & check for level-up
  characterState.xp += xpReward;
  let didLevelUp = false;
  while (characterState.xp >= getXPForLevel(characterState.level)) {
    characterState.xp -= getXPForLevel(characterState.level);
    characterState.level++;
    didLevelUp = true;
  }

  // Post system message to guild chat if in a guild
  if (currentUser && characterState.guildId) {
    try {
      addDoc(collection(db, 'guilds', characterState.guildId, 'chat'), {
        text: `🛡️ ${characterState.nickname} completed the quest "${quest.title}" (+${xpReward} XP)!`,
        type: 'system',
        timestamp: Date.now()
      });
    } catch(e) {
      console.warn("Failed to post quest completion to guild chat", e);
    }
  }

  if (didLevelUp) {
    playSound('levelUp');
    alert(`🎉 LEVEL UP! You reached Level ${characterState.level}!`);
    
    if (currentUser && characterState.guildId) {
      try {
        addDoc(collection(db, 'guilds', characterState.guildId, 'chat'), {
          text: `🎉 ${characterState.nickname} leveled up to Level ${characterState.level}!`,
          type: 'system',
          timestamp: Date.now()
        });
      } catch(e) {
        console.warn("Failed to post level up to guild chat", e);
      }
    }
  } else {
    playSound('success');
  }

  // Show fellowship bonus toast notification if applicable
  if (readyFriends.length > 0) {
    const friendNames = readyFriends.map(f => f.name).join(', ');
    alert(`Fellowship Buff Applied! You and ${friendNames} completed the quest together. +25% Co-op XP bonus applied!`);
  }

  saveToLocalStorage();
  updateProfileUI();
  updateActiveQuestsUI();
}

// --- Abandon Quest Action ---
function abandonQuest(questId) {
  activeQuests = activeQuests.filter(q => q.id !== questId);
  playSound('toggleOff');
  saveToLocalStorage();
  updateActiveQuestsUI();
}

// --- Friends UI rendering ---
function updateFriendsUI() {
  document.getElementById('my-friend-code').textContent = friendCode;

  const listContainer = document.getElementById('friends-list');
  listContainer.innerHTML = '';
  if (friendsList.length === 0) {
    listContainer.innerHTML = '<p class="empty-msg" style="text-align: center; color: var(--text-dim); margin-top: 20px;">No friends yet. Add some using their code!</p>';
  } else {
    friendsList.forEach(f => {
      const item = document.createElement('div');
      item.className = 'friend-item clickable';
      item.setAttribute('data-friend-code', f.code);
      
      // Resolve details from cache or fallback to f
      const cached = f.uid ? friendDataCache[f.uid] : null;
      const name = cached ? (cached.nickname || f.name) : f.name;
      const avatarType = cached ? (cached.avatarType || f.avatarType) : f.avatarType;
      const avatarClass = cached ? (cached.avatarClass || f.avatarClass) : f.avatarClass;
      const avatarData = cached ? (cached.avatarData || f.avatarData) : f.avatarData;

      let avatarHtml = '';
      if (avatarType === 'custom' && avatarData) {
        avatarHtml = `<img src="${avatarData}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover; border-radius: 2px;">`;
      } else {
        avatarHtml = AVATAR_PRESETS[avatarClass] || '⚔️';
      }

      item.innerHTML = `
        <div class="friend-avatar">${avatarHtml}</div>
        <div class="friend-info">
          <span class="friend-name">${name}</span>
          <span class="friend-code-text">${f.code}</span>
        </div>
      `;

      item.addEventListener('click', () => {
        friendProfileSourceView = 'friends';
        showFriendProfile(f);
      });

      listContainer.appendChild(item);

      // Real-time live update subscription in background
      if (currentUser) {
        const setupSnapshot = (uid) => {
          if (!friendSubscriptions[uid]) {
            friendSubscriptions[uid] = onSnapshot(doc(db, 'users', uid), (friendDoc) => {
              if (friendDoc.exists()) {
                const fData = friendDoc.data();
                
                // Store in cache
                friendDataCache[uid] = fData;
                
                // Resolve from current global friendsList dynamically to avoid closure memory capture of orphaned objects
                const currentFriend = friendsList.find(fr => fr.uid === uid || fr.code === f.code);
                if (currentFriend) {
                  const nameChanged = fData.nickname && fData.nickname !== currentFriend.name;
                  const classChanged = fData.avatarClass && fData.avatarClass !== currentFriend.avatarClass;
                  const typeChanged = fData.avatarType && fData.avatarType !== currentFriend.avatarType;
                  const dataChanged = fData.avatarData && fData.avatarData !== currentFriend.avatarData;
                  const levelChanged = fData.level && fData.level !== currentFriend.level;
                  
                  if (nameChanged || classChanged || typeChanged || dataChanged || levelChanged) {
                    currentFriend.name = fData.nickname || currentFriend.name;
                    currentFriend.avatarType = fData.avatarType || 'preset';
                    currentFriend.avatarClass = fData.avatarClass || 'warrior';
                    currentFriend.avatarData = fData.avatarData || '';
                    currentFriend.level = fData.level || currentFriend.level || 1;
                    currentFriend.xp = fData.xp || currentFriend.xp || 0;
                    
                    // LocalStorage cache update
                    localStorage.setItem('questmax_friendsList', JSON.stringify(friendsList));
                    saveToLocalStorage();
                    
                    // Dynamic DOM update
                    const friendItem = listContainer.querySelector(`[data-friend-code="${currentFriend.code}"]`);
                    if (friendItem) {
                      const nameEl = friendItem.querySelector('.friend-name');
                      const avatarEl = friendItem.querySelector('.friend-avatar');
                      if (nameEl) nameEl.textContent = currentFriend.name;
                      if (avatarEl) {
                        if (currentFriend.avatarType === 'custom' && currentFriend.avatarData) {
                          avatarEl.innerHTML = `<img src="${currentFriend.avatarData}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover; border-radius: 2px;">`;
                        } else {
                          avatarEl.innerHTML = AVATAR_PRESETS[currentFriend.avatarClass] || '⚔️';
                        }
                      }
                    }
                  }
                }
              }
            }, (e) => {
              console.warn("Could not live update friend profile:", e);
            });
          }
        };

        if (f.uid) {
          setupSnapshot(f.uid);
        } else {
          // Self-heal: Fetch UID from the code
          getDoc(doc(db, 'friendCodes', f.code)).then(codeDoc => {
            if (codeDoc.exists()) {
              const retrievedUid = codeDoc.data().uid;
              if (retrievedUid) {
                const currentFriend = friendsList.find(fr => fr.code === f.code);
                if (currentFriend) {
                  currentFriend.uid = retrievedUid;
                  localStorage.setItem('questmax_friendsList', JSON.stringify(friendsList));
                  saveToLocalStorage(); // Sync back to Firestore
                  setupSnapshot(retrievedUid);
                }
              }
            } else {
              // Try secondary self-heal: query users collection by friendCode
              fallbackResolveUID(f.code).then(retrievedUid => {
                if (retrievedUid) {
                  const currentFriend = friendsList.find(fr => fr.code === f.code);
                  if (currentFriend) {
                    currentFriend.uid = retrievedUid;
                    localStorage.setItem('questmax_friendsList', JSON.stringify(friendsList));
                    saveToLocalStorage();
                    setupSnapshot(retrievedUid);
                  }
                }
              });
            }
          }).catch(e => {
            console.warn("Could not self-heal resolve friend UID from code, trying fallback query:", e);
            fallbackResolveUID(f.code).then(retrievedUid => {
              if (retrievedUid) {
                const currentFriend = friendsList.find(fr => fr.code === f.code);
                if (currentFriend) {
                  currentFriend.uid = retrievedUid;
                  localStorage.setItem('questmax_friendsList', JSON.stringify(friendsList));
                  saveToLocalStorage();
                  setupSnapshot(retrievedUid);
                }
              }
            });
          });
        }
      }
    });
  }
}

// --- Friend profile display helper ---
function ensureFriendStats(friend) {
  if (friend.level === undefined) friend.level = Math.floor(Math.random() * 8) + 2;
  if (friend.xp === undefined) friend.xp = Math.floor(Math.random() * 150);
  if (!friend.deeds) {
    const classes = ['Warrior', 'Mage', 'Rogue', 'Ranger', 'Paladin', 'Bard'];
    const selectedClass = friend.avatarClass ? friend.avatarClass.toUpperCase() : classes[Math.floor(Math.random() * classes.length)];
    friend.deeds = [
      { title: `Completed ${selectedClass} Training`, xpEarned: 50 },
      { title: `Slayed a local Dungeon Bug`, xpEarned: 75 }
    ];
  }
}

function showFriendProfile(friend) {
  playSound('modalOpen');
  
  // Resolve details from cache or fallback to friend parameter
  const cachedData = friend.uid ? friendDataCache[friend.uid] : null;
  const resolvedFriend = {
    ...friend,
    name: cachedData ? (cachedData.nickname || friend.name) : friend.name,
    avatarType: cachedData ? (cachedData.avatarType || friend.avatarType) : friend.avatarType,
    avatarClass: cachedData ? (cachedData.avatarClass || friend.avatarClass) : friend.avatarClass,
    avatarData: cachedData ? (cachedData.avatarData || friend.avatarData) : friend.avatarData,
    level: cachedData ? (cachedData.level || friend.level) : friend.level,
    xp: cachedData ? (cachedData.xp || friend.xp) : friend.xp,
    deeds: (cachedData && cachedData.completedQuests && cachedData.completedQuests.length > 0) ? 
      cachedData.completedQuests.map(q => ({ title: q.title, xpEarned: q.xpEarned })) : 
      friend.deeds
  };
  
  ensureFriendStats(resolvedFriend);
  
  document.getElementById('friend-profile-name').textContent = resolvedFriend.name;
  document.getElementById('friend-profile-code').textContent = resolvedFriend.code;
  
  const avatarImg = document.getElementById('friend-profile-avatar');
  const avatarPlaceholder = document.getElementById('friend-profile-avatar-placeholder');
  if (resolvedFriend.avatarType === 'custom' && resolvedFriend.avatarData) {
    avatarImg.src = resolvedFriend.avatarData;
    avatarImg.classList.remove('hidden');
    avatarPlaceholder.classList.add('hidden');
  } else {
    avatarImg.classList.add('hidden');
    avatarPlaceholder.textContent = AVATAR_PRESETS[resolvedFriend.avatarClass] || '⚔️';
    avatarPlaceholder.classList.remove('hidden');
  }
  
  const classTitles = {
    warrior: 'WARRIOR', mage: 'MAGE', rogue: 'ROGUE', ranger: 'RANGER', paladin: 'PALADIN', bard: 'BARD'
  };
  const title = classTitles[resolvedFriend.avatarClass] || 'HERO';
  document.getElementById('friend-profile-class').textContent = `LEVEL ${resolvedFriend.level} ${title}`;
  
  // Populate details on the action button (Add vs Remove vs Hide if self)
  const removeBtn = document.getElementById('btn-remove-friend');
  if (removeBtn) {
    if (resolvedFriend.uid === currentUser.uid) {
      removeBtn.classList.add('hidden');
    } else {
      removeBtn.classList.remove('hidden');
      const isAlreadyFriend = friendsList.some(f => f.uid === resolvedFriend.uid || f.code === resolvedFriend.code);
      if (isAlreadyFriend) {
        removeBtn.textContent = 'REMOVE FRIEND';
        removeBtn.style.borderColor = '#e74c3c';
        removeBtn.style.color = '#e74c3c';
        removeBtn.setAttribute('data-action', 'remove');
      } else {
        removeBtn.textContent = 'ADD FRIEND';
        removeBtn.style.borderColor = '#2ecc71';
        removeBtn.style.color = '#2ecc71';
        removeBtn.setAttribute('data-action', 'add');
      }
      removeBtn.setAttribute('data-uid', resolvedFriend.uid || '');
      removeBtn.setAttribute('data-code', resolvedFriend.code || '');
    }
  }

  // Populate dynamic quest status (AVAILABLE vs IN QUEST) and CURRENT PURSUITS
  const activeQuestsArr = cachedData ? (cachedData.activeQuests || []) : (friend.activeQuests || []);
  const statusEl = document.getElementById('friend-profile-status');
  if (statusEl) {
    if (activeQuestsArr.length > 0) {
      statusEl.textContent = 'IN QUEST';
      statusEl.style.color = '#9b59b6'; // Purple for questing
    } else {
      statusEl.textContent = 'AVAILABLE';
      statusEl.style.color = '#2ecc71'; // Green for available
    }
  }

  const activeQuestsList = document.getElementById('friend-active-quests-list');
  if (activeQuestsList) {
    activeQuestsList.innerHTML = '';
    if (activeQuestsArr.length === 0) {
      activeQuestsList.innerHTML = '<p class="empty-journal-msg" style="font-size:0.8rem; padding: 10px 0;">No active quests currently.</p>';
    } else {
      activeQuestsArr.forEach(q => {
        const entry = document.createElement('div');
        entry.className = 'ledger-entry';
        entry.innerHTML = `
          <span class="ledger-entry-title">${q.icon || '⚔️'} ${q.title}</span>
          <span class="ledger-entry-xp" style="color: #9b59b6;">TRACKING</span>
        `;
        activeQuestsList.appendChild(entry);
      });
    }
  }

  const deedsList = document.getElementById('friend-deeds-list');
  deedsList.innerHTML = '';
  resolvedFriend.deeds.forEach(d => {
    const entry = document.createElement('div');
    entry.className = 'ledger-entry';
    entry.innerHTML = `
      <span class="ledger-entry-title">${d.title}</span>
      <span class="ledger-entry-xp">+${d.xpEarned} XP</span>
    `;
    deedsList.appendChild(entry);
  });
  
  document.getElementById('friends-modal').classList.remove('visible');
  document.getElementById('friend-profile-modal').classList.add('visible');
}

// --- Guild / Clans Logic ---

async function createGuild(name, desc, crest) {
  if (!name.trim()) {
    alert("Guild Name cannot be empty!");
    return;
  }
  
  try {
    playSound('success');
    const tempCode = 'GD-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    
    // 1. Create Guild Document
    const guildRef = await addDoc(collection(db, 'guilds'), {
      name: name.trim().toUpperCase(),
      description: desc.trim(),
      crest: crest,
      ownerUid: currentUser.uid,
      members: [currentUser.uid],
      code: tempCode,
      createdAt: Date.now()
    });
    
    const guildId = guildRef.id;
    
    // 2. Post a system message in the subcollection chat
    await addDoc(collection(db, 'guilds', guildId, 'chat'), {
      text: `🏰 Guild "${name.trim().toUpperCase()}" has been created by ${characterState.nickname}!`,
      type: 'system',
      timestamp: Date.now()
    });
    
    // 3. Update User document with guildId
    characterState.guildId = guildId;
    saveToLocalStorage(); // Sync back to Firestore
    
    alert(`Guild "${name.trim().toUpperCase()}" created successfully! Code: ${tempCode}`);
  } catch (err) {
    console.error("Error creating guild:", err);
    alert("Failed to create guild: " + err.message);
  }
}

async function joinGuild(code) {
  const cleanCode = code.trim().toUpperCase();
  if (!cleanCode) return;
  
  try {
    const q = query(collection(db, 'guilds'), where('code', '==', cleanCode));
    const querySnap = await getDocs(q);
    
    if (querySnap.empty) {
      alert("Guild Code not found!");
      return;
    }
    
    const guildDoc = querySnap.docs[0];
    const gData = guildDoc.data();
    
    if (gData.members.length >= 30) {
      alert("This guild is full (max 30 members)!");
      return;
    }
    
    if (gData.members.includes(currentUser.uid)) {
      alert("You are already in this guild!");
      return;
    }
    
    playSound('success');
    
    // 1. Add to members list
    await updateDoc(doc(db, 'guilds', guildDoc.id), {
      members: arrayUnion(currentUser.uid)
    });
    
    // 2. Post system message
    await addDoc(collection(db, 'guilds', guildDoc.id, 'chat'), {
      text: `🚪 ${characterState.nickname} joined the guild!`,
      type: 'system',
      timestamp: Date.now()
    });
    
    // 3. Update User doc
    characterState.guildId = guildDoc.id;
    saveToLocalStorage();
    
    alert(`Joined "${gData.name}" successfully!`);
  } catch (err) {
    console.error("Error joining guild:", err);
    alert("Failed to join guild: " + err.message);
  }
}

async function leaveGuild() {
  if (!activeGuild) return;
  
  if (confirm(`Are you sure you want to leave "${activeGuild.name}"?`)) {
    try {
      playSound('toggleOff');
      const gId = activeGuild.id;
      
      // If owner, check if we must delete or transfer ownership
      if (activeGuild.ownerUid === currentUser.uid) {
        const nextOwner = activeGuild.members.find(m => m !== currentUser.uid);
        if (nextOwner) {
          await updateDoc(doc(db, 'guilds', gId), {
            ownerUid: nextOwner,
            members: arrayRemove(currentUser.uid)
          });
          
          await addDoc(collection(db, 'guilds', gId, 'chat'), {
            text: `🚪 Leader ${characterState.nickname} left the guild. ${friendDataCache[nextOwner]?.nickname || 'A member'} is the new Leader!`,
            type: 'system',
            timestamp: Date.now()
          });
        } else {
          // Delete completely if no one left
          await deleteDoc(doc(db, 'guilds', gId));
        }
      } else {
        // Not owner, just remove from members
        await updateDoc(doc(db, 'guilds', gId), {
          members: arrayRemove(currentUser.uid)
        });
        
        await addDoc(collection(db, 'guilds', gId, 'chat'), {
          text: `🚪 ${characterState.nickname} left the guild.`,
          type: 'system',
          timestamp: Date.now()
        });
      }
      
      // Clean up subscriptions
      if (unsubscribeGuild) { unsubscribeGuild(); unsubscribeGuild = null; }
      if (unsubscribeGuildChat) { unsubscribeGuildChat(); unsubscribeGuildChat = null; }
      if (unsubscribeGuildLeaderboard) { unsubscribeGuildLeaderboard(); unsubscribeGuildLeaderboard = null; }
      activeGuild = null;
      
      // Update User doc
      characterState.guildId = '';
      saveToLocalStorage();
      
      // Reset UI
      document.getElementById('view-guild-hub').classList.add('hidden-view');
      document.getElementById('view-guild-hub').classList.remove('active-view');
      document.getElementById('view-guild-none').classList.add('active-view');
      document.getElementById('view-guild-none').classList.remove('hidden-view');
      
      renderPublicGuildsList();
      alert("Left the guild.");
    } catch (err) {
      console.error("Error leaving guild:", err);
      alert("Failed to leave guild: " + err.message);
    }
  }
}

async function kickGuildMember(memberUid, memberName) {
  if (!activeGuild || activeGuild.ownerUid !== currentUser.uid) return;
  
  if (confirm(`🛡️ Leader Action: Are you sure you want to kick ${memberName} from the guild?`)) {
    try {
      playSound('toggleOff');
      
      // 1. Remove from guild document members array
      await updateDoc(doc(db, 'guilds', activeGuild.id), {
        members: arrayRemove(memberUid)
      });
      
      // 2. Post system chat message
      await addDoc(collection(db, 'guilds', activeGuild.id, 'chat'), {
        text: `🛡️ ${memberName} was kicked from the guild by Leader ${characterState.nickname}.`,
        type: 'system',
        timestamp: Date.now()
      });
      
      alert(`${memberName} has been kicked.`);
    } catch (e) {
      console.error("Error kicking member:", e);
      alert("Failed to kick member: " + e.message);
    }
  }
}

async function saveGuildEdit(newDesc, newCrest) {
  if (!activeGuild || activeGuild.ownerUid !== currentUser.uid) return;
  
  try {
    playSound('success');
    await updateDoc(doc(db, 'guilds', activeGuild.id), {
      description: newDesc.trim(),
      crest: newCrest
    });
    
    await addDoc(collection(db, 'guilds', activeGuild.id, 'chat'), {
      text: `🛡️ Guild details updated by Leader ${characterState.nickname}.`,
      type: 'system',
      timestamp: Date.now()
    });
  } catch (err) {
    console.error("Error editing guild details:", err);
    alert("Failed to save guild changes: " + err.message);
  }
}

async function sendChatMessage(text, type = 'chat', meta = null) {
  if (!activeGuild || !text.trim()) return;
  
  try {
    await addDoc(collection(db, 'guilds', activeGuild.id, 'chat'), {
      senderUid: currentUser.uid,
      senderName: characterState.nickname,
      senderAvatarClass: characterState.avatarClass,
      senderAvatarType: characterState.avatarType,
      senderAvatarData: characterState.avatarData,
      text: text.trim(),
      type: type,
      meta: meta,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error("Error sending chat message:", err);
  }
}

async function joinQuestLobby(lobbyId, questId, hostName) {
  if (activeQuests.some(q => q.id === questId)) {
    alert("⚔️ You are already tracking this quest!");
    return;
  }
  
  if (activeQuests.length >= 3) {
    alert("⚠️ Your active quest log is full! Abandon or complete a quest before starting another.");
    return;
  }
  
  const quest = QUESTS.find(q => q.id === questId);
  if (!quest) return;
  
  try {
    const lobbyRef = doc(db, 'lobbies', lobbyId);
    const lobbySnap = await getDoc(lobbyRef);
    if (!lobbySnap.exists()) {
      alert("Lobby no longer exists!");
      return;
    }
    
    const lobbyData = lobbySnap.data();
    if (lobbyData.members.length >= lobbyData.maxPartySize) {
      alert("This co-op lobby is full!");
      return;
    }
    
    if (lobbyData.members.some(m => m.uid === currentUser.uid)) {
      alert("You are already in this lobby!");
      return;
    }
    
    const myMemberObj = {
      uid: currentUser.uid,
      name: characterState.nickname,
      avatarType: characterState.avatarType,
      avatarClass: characterState.avatarClass,
      avatarData: characterState.avatarData,
      status: 'ready'
    };
    
    await updateDoc(lobbyRef, {
      members: arrayUnion(myMemberObj)
    });
    
    const newActive = { 
      ...quest, 
      lobbyId: lobbyId,
      coopFriends: lobbyData.members.filter(m => m.uid !== currentUser.uid).map(m => ({
        uid: m.uid,
        name: m.name,
        avatarType: m.avatarType,
        avatarClass: m.avatarClass,
        avatarData: m.avatarData,
        status: m.status
      }))
    };
    activeQuests.push(newActive);
    saveToLocalStorage();
    updateActiveQuestsUI();
    
    playSound('success');
    playSound('xboxConnect');
    
    if (characterState.guildId) {
      await addDoc(collection(db, 'guilds', characterState.guildId, 'chat'), {
        text: `🎮 ${characterState.nickname} joined ${hostName}'s lobby for "${quest.title}"!`,
        type: 'system',
        timestamp: Date.now()
      });
    }
    
    alert(`Joined ${hostName}'s lobby!`);
    
    switchView('view-home');
    setTimeout(() => {
      openQuestCodex(newActive, 'view-home');
    }, 300);
  } catch (err) {
    console.error("Error joining lobby:", err);
    alert("Failed to join lobby: " + err.message);
  }
}

function joinQuestFromChat(questId, hostUid, hostName) {
  if (activeQuests.some(q => q.id === questId)) {
    alert("⚔️ You are already tracking this quest!");
    return;
  }
  
  if (activeQuests.length >= 3) {
    alert("⚠️ Your active quest log is full! Abandon or complete a quest before starting another.");
    return;
  }
  
  const quest = QUESTS.find(q => q.id === questId);
  if (!quest) return;
  
  let hostDetails = {
    uid: hostUid,
    code: '',
    name: hostName,
    avatarType: 'preset',
    avatarClass: 'warrior',
    avatarData: '',
    status: 'ready'
  };
  
  const cachedHost = friendDataCache[hostUid];
  if (cachedHost) {
    hostDetails.avatarType = cachedHost.avatarType || 'preset';
    hostDetails.avatarClass = cachedHost.avatarClass || 'warrior';
    hostDetails.avatarData = cachedHost.avatarData || '';
  }
  
  const newActive = { ...quest, coopFriends: [ hostDetails ] };
  activeQuests.push(newActive);
  playSound('success');
  playSound('xboxConnect');
  saveToLocalStorage();
  updateActiveQuestsUI();
  
  alert(`Joined ${hostName}'s Co-op Quest: "${quest.title}"!`);
}

function handleGuildSubscription(newGuildId) {
  if (!newGuildId) {
    // Unsubscribe from any active guild
    if (unsubscribeGuild) { unsubscribeGuild(); unsubscribeGuild = null; }
    if (unsubscribeGuildChat) { unsubscribeGuildChat(); unsubscribeGuildChat = null; }
    if (unsubscribeGuildLeaderboard) { unsubscribeGuildLeaderboard(); unsubscribeGuildLeaderboard = null; }
    activeGuild = null;
    
    // Toggle UI views
    document.getElementById('view-guild-none').classList.add('active-view');
    document.getElementById('view-guild-none').classList.remove('hidden-view');
    document.getElementById('view-guild-hub').classList.add('hidden-view');
    document.getElementById('view-guild-hub').classList.remove('active-view');
    
    // Fetch public guilds list
    renderPublicGuildsList();
    return;
  }
  
  // If we are already subscribed to this guild, do nothing
  if (activeGuild && activeGuild.id === newGuildId) {
    return;
  }
  
  // Otherwise, subscribe to the new guild!
  if (unsubscribeGuild) { unsubscribeGuild(); }
  if (unsubscribeGuildChat) { unsubscribeGuildChat(); }
  if (unsubscribeGuildLeaderboard) { unsubscribeGuildLeaderboard(); }
  
  // Show Guild Hub view
  document.getElementById('view-guild-none').classList.add('hidden-view');
  document.getElementById('view-guild-none').classList.remove('active-view');
  document.getElementById('view-guild-hub').classList.add('active-view');
  document.getElementById('view-guild-hub').classList.remove('hidden-view');
  
  // 1. Subscribe to Guild Doc
  unsubscribeGuild = onSnapshot(doc(db, 'guilds', newGuildId), async (guildSnap) => {
    if (!guildSnap.exists()) {
      // Guild was deleted, clean up our user reference
      characterState.guildId = '';
      saveToLocalStorage();
      return;
    }
    
    const gData = guildSnap.data();
    activeGuild = { id: guildSnap.id, ...gData };
    
    // Check if we were kicked (not in members array anymore)
    if (!gData.members.includes(currentUser.uid)) {
      // Clean up our user reference
      characterState.guildId = '';
      saveToLocalStorage();
      alert("🛡️ Leader Action: You have been kicked from the guild.");
      return;
    }
    
    // Render Guild Info in Hub Header
    document.getElementById('guild-hub-crest').textContent = gData.crest || '🛡️';
    document.getElementById('guild-hub-name').textContent = gData.name || 'GUILD';
    document.getElementById('guild-hub-desc').textContent = gData.description || '';
    document.getElementById('guild-hub-code').textContent = gData.code || '';
    document.getElementById('guild-hub-count').textContent = `${gData.members.length}/30`;
    
    // Toggle leader actions
    const isLeader = gData.ownerUid === currentUser.uid;
    const actionsEl = document.getElementById('guild-leader-actions');
    if (actionsEl) {
      if (isLeader) actionsEl.classList.remove('hidden');
      else actionsEl.classList.add('hidden');
    }
    
    // Subscribe to Leaderboard members updates
    subscribeToLeaderboard(gData.members);
  }, (err) => {
    console.error("Guild snapshot error:", err);
  });
  
  // 2. Subscribe to Guild Chat (last 50 messages)
  const chatQuery = query(
    collection(db, 'guilds', newGuildId, 'chat'),
    orderBy('timestamp', 'asc'),
    limit(50)
  );
  
  unsubscribeGuildChat = onSnapshot(chatQuery, (chatSnap) => {
    const chatFeed = document.getElementById('guild-chat-feed');
    if (!chatFeed) return;
    
    // Check if we should notify user of new messages (if not currently looking at the chat tab)
    const isChatTabActive = document.getElementById('tab-guild-chat').classList.contains('active');
    
    // Save scroll position to auto-scroll if at bottom
    const wasAtBottom = chatFeed.scrollHeight - chatFeed.scrollTop <= chatFeed.clientHeight + 40;
    
    chatFeed.innerHTML = '';
    chatSnap.docs.forEach(docSnap => {
      const msg = docSnap.data();
      const item = document.createElement('div');
      
      if (msg.type === 'system') {
        item.className = 'chat-msg system';
        item.textContent = msg.text;
      } else if (msg.type === 'coop_invite') {
        item.className = 'chat-msg';
        if (msg.senderUid === currentUser.uid) item.classList.add('self');
        
        const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const meta = msg.meta || {};
        
        item.innerHTML = `
          <div class="chat-msg-header">
            <span class="chat-msg-sender">${msg.senderName}</span>
            <span class="chat-msg-time">${timeStr}</span>
          </div>
          <div class="chat-msg-text">Shared a Co-op Quest!</div>
          <div class="chat-quest-card">
            <div class="chat-quest-header">
              <span class="chat-quest-icon">${meta.questIcon || '⚔️'}</span>
              <span class="chat-quest-title" title="${msg.text}">${msg.text}</span>
            </div>
            <div class="chat-quest-meta">
              <span>${'⚔️'.repeat(meta.difficulty || 1)}</span>
              <span>Co-op Invite</span>
            </div>
            <button class="stone-button success-btn chat-quest-join-btn" data-id="${meta.questId}" data-sender-uid="${msg.senderUid}" data-sender-code="${meta.senderCode || ''}">JOIN LOBBY</button>
          </div>
        `;
        
        // Wire join event
        const joinBtn = item.querySelector('.chat-quest-join-btn');
        if (joinBtn) {
          joinBtn.addEventListener('click', () => {
            playSound('click');
            if (meta.lobbyId) {
              joinQuestLobby(meta.lobbyId, meta.questId, msg.senderName);
            } else {
              joinQuestFromChat(meta.questId, msg.senderUid, msg.senderName);
            }
          });
        }
      } else {
        item.className = 'chat-msg';
        if (msg.senderUid === currentUser.uid) item.classList.add('self');
        
        const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        item.innerHTML = `
          <div class="chat-msg-header">
            <span class="chat-msg-sender">${msg.senderName}</span>
            <span class="chat-msg-time">${timeStr}</span>
          </div>
          <div class="chat-msg-text">${msg.text}</div>
        `;
      }
      chatFeed.appendChild(item);
    });
    
    // Auto-scroll to bottom
    if (wasAtBottom || isChatTabActive) {
      chatFeed.scrollTop = chatFeed.scrollHeight;
    }
  });
}

function subscribeToLeaderboard(memberUids) {
  if (unsubscribeGuildLeaderboard) {
    unsubscribeGuildLeaderboard();
  }
  
  if (!memberUids || memberUids.length === 0) return;
  
  const q = query(
    collection(db, 'users'),
    where('__name__', 'in', memberUids.slice(0, 30))
  );
  
  unsubscribeGuildLeaderboard = onSnapshot(q, (snapshot) => {
    const leaderboardList = document.getElementById('guild-leaderboard-list');
    if (!leaderboardList) return;
    
    const membersData = [];
    snapshot.forEach(docSnap => {
      const d = docSnap.data();
      friendDataCache[docSnap.id] = d; // Cache details for tapping member profile
      membersData.push({
        uid: docSnap.id,
        name: d.nickname || 'HERO',
        avatarType: d.avatarType || 'preset',
        avatarClass: d.avatarClass || 'warrior',
        avatarData: d.avatarData || '',
        level: d.level || 1,
        xp: d.xp || 0
      });
    });
    
    membersData.sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return b.xp - a.xp;
    });
    
    leaderboardList.innerHTML = '';
    membersData.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      if (m.uid === currentUser.uid) row.classList.add('current-user');
      
      const rank = idx + 1;
      let rankBadge = rank;
      if (rank === 1) rankBadge = '🥇';
      else if (rank === 2) rankBadge = '🥈';
      else if (rank === 3) rankBadge = '🥉';
      
      let avatarHtml = '';
      if (m.avatarType === 'custom' && m.avatarData) {
        avatarHtml = `<img src="${m.avatarData}" style="width:20px; height:20px; object-fit:cover; border-radius:2px;">`;
      } else {
        avatarHtml = AVATAR_PRESETS[m.avatarClass] || '⚔️';
      }
      
      let kickHtml = '';
      if (activeGuild && activeGuild.ownerUid === currentUser.uid && m.uid !== currentUser.uid) {
        kickHtml = `<button class="member-kick-btn" data-uid="${m.uid}" data-name="${m.name}">KICK</button>`;
      }
      
      row.innerHTML = `
        <div class="leaderboard-member-info">
          <span class="leaderboard-rank" style="font-size: 1.1rem; min-width: 20px; text-align: center;">${rankBadge}</span>
          <span class="leaderboard-avatar" style="font-size: 1.1rem; display: flex; align-items: center;">${avatarHtml}</span>
          <span class="leaderboard-name">${m.name}</span>
          ${kickHtml}
        </div>
        <div class="leaderboard-xp">
          <span>LVL ${m.level}</span>
          <span class="leaderboard-xp-val">(${m.xp} XP)</span>
        </div>
      `;
      
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        friendProfileSourceView = 'guild';
        const friendObj = {
          uid: m.uid,
          code: friendDataCache[m.uid]?.friendCode || 'QM-XXXX',
          name: m.name,
          avatarType: m.avatarType,
          avatarClass: m.avatarClass,
          avatarData: m.avatarData,
          level: m.level,
          xp: m.xp,
          deeds: []
        };
        showFriendProfile(friendObj);
      });
      
      const kickBtn = row.querySelector('.member-kick-btn');
      if (kickBtn) {
        kickBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          kickGuildMember(m.uid, m.name);
        });
      }
      
      leaderboardList.appendChild(row);
    });
  });
}

async function renderPublicGuildsList() {
  const container = document.getElementById('public-guilds-list');
  if (!container) return;
  
  try {
    const q = query(collection(db, 'guilds'), limit(15));
    const snap = await getDocs(q);
    
    container.innerHTML = '';
    if (snap.empty) {
      container.innerHTML = '<p class="empty-journal-msg" style="text-align: center; padding: 15px;">No active guilds. Be the first to create one!</p>';
      return;
    }
    
    snap.docs.forEach(docSnap => {
      const g = docSnap.data();
      const item = document.createElement('div');
      item.className = 'guild-list-item';
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.5rem;">${g.crest || '🛡️'}</span>
          <div style="display: flex; flex-direction: column;">
            <strong style="color: var(--gold-primary); font-size: 0.9rem;">${g.name}</strong>
            <span style="font-size: 0.75rem; color: var(--text-dim); max-width: 180px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${g.description}</span>
          </div>
        </div>
        <div style="text-align: right; font-size: 0.8rem;">
          <span style="color: var(--emerald); font-weight: bold;">${g.code}</span>
          <div style="color: var(--text-dim); font-size: 0.7rem; margin-top: 2px;">${g.members.length}/30</div>
        </div>
      `;
      
      item.addEventListener('click', () => {
        const codeInput = document.getElementById('guild-join-code');
        if (codeInput) {
          codeInput.value = g.code;
          codeInput.focus();
        }
      });
      
      container.appendChild(item);
    });
  } catch (e) {
    console.error("Error loading public guilds:", e);
  }
}

// --- Quest Codex Modal Logic ---
let codexQuest = null;

function getQuestMaxPartySize(quest) {
  if (!quest.tags || !quest.tags.party) return 1;
  const p = quest.tags.party;
  if (p.includes('squad')) return 4;
  if (p.includes('duo')) return 2;
  return 1;
}

function drawFellowshipRing(activeInstance) {
  const ring = document.querySelector('.xbox-ring');
  if (!ring) return;
  ring.classList.remove('lobby-full');
  
  const quadrants = ring.querySelectorAll('.quadrant');
  quadrants.forEach(q => {
    q.classList.remove('active');
    q.style.opacity = '0';
  });
  
  const partyList = document.getElementById('xbox-party-list');
  if (!partyList) return;
  partyList.innerHTML = '';
  
  let myAvatarHtml = characterState.avatarType === 'custom' && characterState.avatarData ? 
    `<img src="${characterState.avatarData}" style="width:100%; height:100%; object-fit:cover; border-radius: 50%;">` : 
    (AVATAR_PRESETS[characterState.avatarClass] || '⚔️');
    
  // Slot 1 (You) is active
  ring.querySelector('.q-tl').classList.add('active');
  ring.querySelector('.q-tl').style.opacity = '1';
  
  partyList.innerHTML = `
    <div class="party-member">
      <div class="party-avatar">${myAvatarHtml}</div>
      <span class="party-name">${characterState.nickname} (YOU)</span>
      <span class="party-status">READY</span>
    </div>
  `;
  
  const maxParty = getQuestMaxPartySize(activeInstance);
  const friends = activeInstance.coopFriends || [];
  const quadClasses = ['.q-tr', '.q-br', '.q-bl'];
  
  friends.forEach((friend, idx) => {
    if (idx < quadClasses.length) {
      const path = ring.querySelector(quadClasses[idx]);
      path.classList.add('active');
      if (friend.status !== 'ready') {
        path.style.opacity = '0.5';
      } else {
        path.style.opacity = '1';
      }
    }
    
    let friendAvatar = friend.avatarType === 'custom' && friend.avatarData ?
      `<img src="${friend.avatarData}" style="width:100%; height:100%; object-fit:cover; border-radius: 50%;">` :
      (AVATAR_PRESETS[friend.avatarClass] || '⚔️');
      
    const statusText = friend.status === 'ready' ? 'READY' : 'PENDING...';
    const statusClass = friend.status === 'ready' ? 'party-status' : 'party-status pending';
    
    partyList.innerHTML += `
      <div class="party-member">
        <div class="party-avatar">${friendAvatar}</div>
        <span class="party-name">${friend.name}</span>
        <span class="${statusClass}">${statusText}</span>
      </div>
    `;
  });
  
  const currentPartySize = 1 + friends.length;
  document.getElementById('ring-party-size').textContent = `${currentPartySize}/${maxParty}`;
  
  if (currentPartySize >= maxParty && friends.every(f => f.status === 'ready')) {
    ring.classList.add('lobby-full');
  }
  
  const bonusRow = document.getElementById('codex-bonus-row');
  const baseXP = getQuestXPReward(activeInstance);
  const readyFriends = friends.filter(f => f.status === 'ready');
  if (readyFriends.length > 0 && bonusRow) {
    bonusRow.classList.remove('hidden');
    document.getElementById('codex-bonus-xp').textContent = `+${Math.round(baseXP * 0.25)} XP`;
  } else if (bonusRow) {
    bonusRow.classList.add('hidden');
  }
  
  const inviteBtn = document.getElementById('btn-codex-invite');
  if (inviteBtn) {
    if (currentPartySize < maxParty && friendsList.length > 0) {
      inviteBtn.classList.remove('hidden');
    } else {
      inviteBtn.classList.add('hidden');
    }
  }
  
  const guildInviteBtn = document.getElementById('btn-codex-guild-invite');
  if (guildInviteBtn) {
    if (currentPartySize < maxParty && characterState.guildId && !activeInstance.lobbyId) {
      guildInviteBtn.classList.remove('hidden');
    } else {
      guildInviteBtn.classList.add('hidden');
    }
  }
}

function closeQuestCodex() {
  document.getElementById('quest-codex-modal').classList.remove('visible');
  if (unsubscribeLobby) {
    unsubscribeLobby();
    unsubscribeLobby = null;
  }
}

function openQuestCodex(quest, sourceView, hostFriend = null) {
  codexQuest = quest;
  playSound('modalOpen');
  
  const activeInstance = activeQuests.find(q => q.id === quest.id);
  
  const rarityBanner = document.getElementById('codex-rarity-banner');
  rarityBanner.setAttribute('data-rarity', quest.rarity);
  document.getElementById('codex-quest-icon').textContent = quest.icon;
  document.getElementById('codex-quest-title').textContent = quest.title;
  document.getElementById('codex-quest-desc').textContent = quest.description;
  document.getElementById('codex-difficulty-skulls').textContent = getDifficultySkulls(quest.difficulty);
  
  const baseXP = getQuestXPReward(quest);
  document.getElementById('codex-base-xp').textContent = `${baseXP} XP`;
  
  const maxParty = getQuestMaxPartySize(quest);
  
  const ring = document.querySelector('.xbox-ring');
  ring.classList.remove('lobby-full');
  
  const quadrants = ring.querySelectorAll('.quadrant');
  quadrants.forEach(q => {
    q.classList.remove('active');
    q.style.opacity = '0';
  });
  
  const partyList = document.getElementById('xbox-party-list');
  partyList.innerHTML = '';
  
  const bonusRow = document.getElementById('codex-bonus-row');
  const actionBtn = document.getElementById('btn-codex-action');
  const inviteBtn = document.getElementById('btn-codex-invite');
  const guildInviteBtn = document.getElementById('btn-codex-guild-invite');
  
  let myAvatarHtml = characterState.avatarType === 'custom' && characterState.avatarData ? 
    `<img src="${characterState.avatarData}" style="width:100%; height:100%; object-fit:cover; border-radius: 50%;">` : 
    (AVATAR_PRESETS[characterState.avatarClass] || '⚔️');

  if (hostFriend) {
    // Show hostFriend as Slot 1 (q-tl, active)
    ring.querySelector('.q-tl').classList.add('active');
    ring.querySelector('.q-tl').style.opacity = '1';
    
    // Show You as Slot 2 (q-tr, active but half-opacity for invited/pending join)
    const qTr = ring.querySelector('.q-tr');
    qTr.classList.add('active');
    qTr.style.opacity = '0.5';
    
    let hostAvatarHtml = hostFriend.avatarType === 'custom' && hostFriend.avatarData ?
      `<img src="${hostFriend.avatarData}" style="width:100%; height:100%; object-fit:cover; border-radius: 50%;">` :
      (AVATAR_PRESETS[hostFriend.avatarClass] || '⚔️');
      
    partyList.innerHTML = `
      <div class="party-member">
        <div class="party-avatar">${hostAvatarHtml}</div>
        <span class="party-name">${hostFriend.name} (HOST)</span>
        <span class="party-status">READY</span>
      </div>
      <div class="party-member">
        <div class="party-avatar">${myAvatarHtml}</div>
        <span class="party-name">${characterState.nickname} (YOU)</span>
        <span class="party-status pending">INVITED</span>
      </div>
    `;
    
    document.getElementById('ring-party-size').textContent = `1/${maxParty}`;
    bonusRow.classList.add('hidden');
    inviteBtn.classList.add('hidden');
    if (guildInviteBtn) guildInviteBtn.classList.add('hidden');
    
    actionBtn.textContent = 'JOIN QUEST ✓';
    actionBtn.className = 'stone-button success-btn';
    actionBtn.onclick = () => {
      if (activeQuests.length >= 3) {
        alert("⚠️ Your active quest log is full! Abandon or complete a quest before starting another.");
        return;
      }
      
      if (activeQuests.some(q => q.id === quest.id)) {
        alert("⚔️ You are already tracking this quest!");
        return;
      }
      
      const newActive = { ...quest, coopFriends: [ { ...hostFriend, status: 'ready' } ] };
      activeQuests.push(newActive);
      playSound('success');
      saveToLocalStorage();
      updateActiveQuestsUI();
      
      playSound('xboxConnect');
      
      closeQuestCodex();
      if (currentView !== 'view-home') switchView('view-home');
      
      setTimeout(() => {
        openQuestCodex(newActive, 'view-home');
      }, 300);
    };
  } else if (activeInstance) {
    if (activeInstance.lobbyId) {
      if (unsubscribeLobby) unsubscribeLobby();
      
      let prevMemberCount = 0;
      unsubscribeLobby = onSnapshot(doc(db, 'lobbies', activeInstance.lobbyId), (lobbySnap) => {
        if (!lobbySnap.exists()) return;
        const lobbyData = lobbySnap.data();
        const members = lobbyData.members || [];
        
        activeInstance.coopFriends = members.filter(m => m.uid !== currentUser.uid).map(m => ({
          uid: m.uid,
          name: m.name,
          avatarType: m.avatarType,
          avatarClass: m.avatarClass,
          avatarData: m.avatarData,
          status: m.status
        }));
        saveToLocalStorage();
        
        if (members.length > prevMemberCount && prevMemberCount > 0) {
          playSound('xboxConnect');
        }
        prevMemberCount = members.length;
        
        drawFellowshipRing(activeInstance);
      });
    } else {
      drawFellowshipRing(activeInstance);
    }
    
    actionBtn.textContent = 'COMPLETE QUEST ✓';
    actionBtn.className = 'stone-button success-btn';
    actionBtn.onclick = () => {
      completeQuest(activeInstance.id);
      closeQuestCodex();
    };
    
    if (inviteBtn) {
      inviteBtn.onclick = () => {
        openFriendPicker(activeInstance);
      };
    }
    
    if (guildInviteBtn) {
      guildInviteBtn.onclick = async () => {
        playSound('success');
        
        let lobbyId = activeInstance.lobbyId;
        if (!lobbyId) {
          lobbyId = 'LB-' + Math.random().toString(36).substring(2, 8).toUpperCase();
          activeInstance.lobbyId = lobbyId;
          saveToLocalStorage();
          
          try {
            await setDoc(doc(db, 'lobbies', lobbyId), {
              lobbyId: lobbyId,
              hostUid: currentUser.uid,
              hostName: characterState.nickname,
              questId: activeInstance.id,
              maxPartySize: maxParty,
              members: [
                {
                  uid: currentUser.uid,
                  name: characterState.nickname,
                  avatarType: characterState.avatarType,
                  avatarClass: characterState.avatarClass,
                  avatarData: characterState.avatarData,
                  status: 'ready'
                }
              ],
              createdAt: Date.now()
            });
          } catch (err) {
            console.error("Failed to create lobby document:", err);
          }
        }
        
        sendChatMessage(activeInstance.title, 'coop_invite', {
          questId: activeInstance.id,
          questIcon: activeInstance.icon,
          difficulty: activeInstance.difficulty,
          senderCode: friendCode,
          lobbyId: lobbyId
        });
        
        alert("Quest invite shared in Guild Chat!");
        guildInviteBtn.classList.add('hidden');
        
        openQuestCodex(activeInstance, 'view-home');
      };
    }
  } else {
    // Slot 1 (You) is active
    ring.querySelector('.q-tl').classList.add('active');
    ring.querySelector('.q-tl').style.opacity = '1';
    
    partyList.innerHTML = `
      <div class="party-member">
        <div class="party-avatar">${myAvatarHtml}</div>
        <span class="party-name">${characterState.nickname} (YOU)</span>
        <span class="party-status">READY</span>
      </div>
    `;
    
    document.getElementById('ring-party-size').textContent = `1/${maxParty}`;
    bonusRow.classList.add('hidden');
    inviteBtn.classList.add('hidden');
    if (guildInviteBtn) guildInviteBtn.classList.add('hidden');
    
    actionBtn.textContent = 'ACCEPT QUEST';
    actionBtn.className = 'stone-button success-btn';
    actionBtn.onclick = () => {
      if (activeQuests.length >= 3) {
        alert("⚠️ Your active quest log is full! Abandon or complete a quest before starting another.");
        return;
      }
      
      if (activeQuests.some(q => q.id === quest.id)) {
        alert("⚔️ You are already tracking this quest!");
        return;
      }
      
      const newActive = { ...quest, coopFriends: [] };
      activeQuests.push(newActive);
      playSound('success');
      saveToLocalStorage();
      updateActiveQuestsUI();
      closeQuestCodex();
      
      setTimeout(() => {
        openQuestCodex(newActive, 'view-home');
      }, 300);
    };
  }
  
  document.getElementById('quest-codex-modal').classList.add('visible');
}

function openFriendPicker(activeQuestInstance) {
  const pickerList = document.getElementById('picker-friends-list');
  pickerList.innerHTML = '';
  
  const availableFriends = friendsList.filter(f => {
    return !activeQuestInstance.coopFriends.some(cf => cf.code === f.code);
  });
  
  if (availableFriends.length === 0) {
    pickerList.innerHTML = '<p class="empty-msg" style="text-align: center; color: var(--text-dim); padding: 20px;">All friends are already in party.</p>';
  } else {
    availableFriends.forEach(f => {
      ensureFriendStats(f);
      const item = document.createElement('div');
      item.className = 'friend-item clickable';
      
      let avatarHtml = f.avatarType === 'custom' && f.avatarData ?
        `<img src="${f.avatarData}" style="width:100%; height:100%; object-fit:cover; border-radius:2px;">` :
        (AVATAR_PRESETS[f.avatarClass] || '⚔️');
        
      item.innerHTML = `
        <div class="friend-avatar">${avatarHtml}</div>
        <div class="friend-info">
          <span class="friend-name">${f.name}</span>
          <span class="friend-code-text">LEVEL ${f.level} ${f.avatarClass.toUpperCase()}</span>
        </div>
      `;
      
      item.addEventListener('click', async () => {
        playSound('click');
        document.getElementById('friend-picker-modal').classList.remove('visible');
        
        let lobbyId = activeQuestInstance.lobbyId;
        const maxParty = getQuestMaxPartySize(activeQuestInstance);
        
        if (!lobbyId) {
          lobbyId = 'LB-' + Math.random().toString(36).substring(2, 8).toUpperCase();
          activeQuestInstance.lobbyId = lobbyId;
          saveToLocalStorage();
          
          try {
            await setDoc(doc(db, 'lobbies', lobbyId), {
              lobbyId: lobbyId,
              hostUid: currentUser.uid,
              hostName: characterState.nickname,
              questId: activeQuestInstance.id,
              maxPartySize: maxParty,
              members: [
                {
                  uid: currentUser.uid,
                  name: characterState.nickname,
                  avatarType: characterState.avatarType,
                  avatarClass: characterState.avatarClass,
                  avatarData: characterState.avatarData,
                  status: 'ready'
                }
              ],
              createdAt: Date.now()
            });
          } catch (err) {
            console.error("Failed to create lobby document:", err);
          }
        }
        
        if (f.uid) {
          try {
            await addDoc(collection(db, 'users', f.uid, 'notifications'), {
              type: 'coop_invite',
              senderCode: friendCode,
              senderUid: currentUser.uid,
              questId: activeQuestInstance.id,
              questTitle: activeQuestInstance.title,
              lobbyId: lobbyId,
              timestamp: Date.now(),
              read: false
            });
            alert("Co-op invite sent to " + f.name + "!");
          } catch (err) {
            console.error("Failed to send co-op invite to Firestore:", err);
          }
        }
        
        const friendCopy = { ...f, status: 'pending' };
        activeQuestInstance.coopFriends.push(friendCopy);
        saveToLocalStorage();
        openQuestCodex(activeQuestInstance, 'view-home');
        
        // Background timeout simulation in case the friend isn't active
        setTimeout(() => {
          if (friendCopy.status !== 'ready') {
            friendCopy.status = 'ready';
            playSound('xboxConnect');
            
            if (activeQuestInstance.coopFriends.length + 1 >= maxParty) {
              playSound('xboxFullLobby');
              setTimeout(() => {
                const ring = document.querySelector('.xbox-ring');
                if (ring) ring.classList.add('lobby-full');
              }, 50);
            }
            
            saveToLocalStorage();
            updateActiveQuestsUI();
            
            if (document.getElementById('quest-codex-modal').classList.contains('visible') && codexQuest && codexQuest.id === activeQuestInstance.id) {
              openQuestCodex(activeQuestInstance, 'view-home');
            }
          }
        }, 10000); // 10 second fallback if they don't accept in real-time
      });
      pickerList.appendChild(item);
    });
  }
  
  document.getElementById('friend-picker-modal').classList.add('visible');
}

// --- Notifications UI rendering ---
function updateNotificationsUI() {
  const badge = document.getElementById('noti-badge');
  const unreadCount = notificationsList.filter(n => !n.read).length;
  if (unreadCount > 0) {
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const notiList = document.getElementById('notifications-list');
  if (!notiList) return;
  
  notiList.innerHTML = '';
  if (notificationsList.length === 0) {
    notiList.innerHTML = '<p class="empty-msg" style="text-align: center; color: var(--text-dim); margin-top: 20px;">No new notifications.</p>';
  } else {
    const sorted = [...notificationsList].sort((a, b) => b.timestamp - a.timestamp);
    sorted.forEach(n => {
      const item = document.createElement('div');
      item.className = 'friend-item';
      item.style.flexDirection = 'column';
      item.style.alignItems = 'flex-start';

      if (n.type === 'friend_request') {
        item.innerHTML = `
          <div style="display: flex; justify-content: space-between; width: 100%;">
            <span class="friend-name" style="font-size: 0.9rem;">⚔️ Request from ${n.senderCode}</span>
            <span style="font-size: 0.7rem; color: var(--text-dim);">Just now</span>
          </div>
          <div style="display: flex; gap: 10px; margin-top: 10px; width: 100%;">
            <button class="stone-button small-btn accept-btn" style="padding: 5px 10px; font-size: 0.7rem; flex: 1;" data-action="accept" data-id="${n.id}">ACCEPT</button>
            <button class="stone-button small-btn decline-btn" style="padding: 5px 10px; font-size: 0.7rem; flex: 1;" data-action="decline" data-id="${n.id}">DECLINE</button>
          </div>
        `;
      } else if (n.type === 'coop_invite') {
        item.innerHTML = `
          <div style="display: flex; justify-content: space-between; width: 100%;">
            <span class="friend-name" style="font-size: 0.9rem;">⚔️ Co-op Invite from ${n.senderCode}</span>
            <span style="font-size: 0.7rem; color: var(--text-dim);">Just now</span>
          </div>
          <p style="font-size:0.95rem; margin-top: 5px; color:var(--text-main);">Tackle: <strong>${n.questTitle}</strong></p>
          <div style="display: flex; gap: 10px; margin-top: 10px; width: 100%;">
            <button class="stone-button small-btn accept-btn" style="padding: 5px 10px; font-size: 0.7rem; flex: 1;" data-action="accept-coop" data-id="${n.id}">ACCEPT</button>
            <button class="stone-button small-btn decline-btn" style="padding: 5px 10px; font-size: 0.7rem; flex: 1;" data-action="decline-coop" data-id="${n.id}">DECLINE</button>
          </div>
        `;
      }
      notiList.appendChild(item);
    });
  }
}

function resizeImage(file, maxW, maxH, callback) {
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    let width = img.width;
    let height = img.height;

    if (width > height) {
      if (width > maxW) {
        height *= maxW / width;
        width = maxW;
      }
    } else {
      if (height > maxH) {
        width *= maxH / height;
        height = maxH;
      }
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    callback(canvas.toDataURL('image/jpeg', 0.7));
  };
  img.src = URL.createObjectURL(file);
}

// --- Initialization & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
  // Load State from LocalStorage
  loadFromLocalStorage();
  
  // Initialize Particles Background
  createParticles();
  
  // Render current states
  updateProfileUI();
  updateActiveQuestsUI();
  updateFriendsUI();
  updateNotificationsUI();

  // Scroll snap indicators logic
  const swipeContainer = document.querySelector('.swipe-container');
  const dots = document.querySelectorAll('.swipe-indicators .dot');
  
  swipeContainer.addEventListener('scroll', () => {
    const scrollPos = swipeContainer.scrollLeft;
    const width = swipeContainer.clientWidth;
    const index = Math.round(scrollPos / width);
    dots.forEach((dot, i) => {
      dot.classList.toggle('active', i === index);
    });
  });

  // Snap to center panel on load
  setTimeout(() => {
    const centerPanel = document.getElementById('main-panel');
    if (centerPanel) centerPanel.scrollIntoView();
  }, 100);

  // Mute toggle listener
  document.getElementById('mute-toggle').addEventListener('click', (e) => {
    isMuted = !isMuted;
    e.currentTarget.classList.toggle('muted', isMuted);
    e.currentTarget.innerHTML = isMuted ? '<span class="icon">🔇</span>' : '<span class="icon">🔊</span>';
  });

  // Nickname auto-save
  const nicknameInput = document.getElementById('input-nickname');
  if (nicknameInput) {
    nicknameInput.addEventListener('change', (e) => {
      const val = e.target.value.trim().toUpperCase() || 'ADVENTURER';
      characterState.nickname = val;
      e.target.value = val;
      saveToLocalStorage();
      playSound('click');
    });
    
    // Accept Enter key as submit
    nicknameInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        nicknameInput.blur();
      }
    });
  }

  // Avatar selector modal triggers
  const changeAvatarBtn = document.getElementById('btn-change-avatar');
  const avatarModal = document.getElementById('avatar-modal');
  const avatarModalClose = document.getElementById('avatar-modal-close');

  if (changeAvatarBtn && avatarModal) {
    changeAvatarBtn.addEventListener('click', () => {
      playSound('modalOpen');
      avatarModal.classList.add('visible');
      
      // Highlight currently selected preset class
      document.querySelectorAll('.avatar-preset-btn').forEach(btn => {
        const isSelected = (characterState.avatarType === 'preset' && btn.getAttribute('data-class') === characterState.avatarClass);
        btn.classList.toggle('selected', isSelected);
      });
    });
  }

  if (avatarModalClose && avatarModal) {
    avatarModalClose.addEventListener('click', () => {
      playSound('click');
      avatarModal.classList.remove('visible');
    });
  }

  // Avatar presets click handler
  document.querySelectorAll('.avatar-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const cls = e.currentTarget.getAttribute('data-class');
      characterState.avatarType = 'preset';
      characterState.avatarClass = cls;
      characterState.avatarData = '';
      
      playSound('click');
      saveToLocalStorage();
      updateProfileUI();
      avatarModal.classList.remove('visible');
    });
  });

  // Custom avatar upload handler
  const avatarUploadInput = document.getElementById('avatar-file-upload');
  if (avatarUploadInput) {
    avatarUploadInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;

      resizeImage(file, 120, 120, (resizedBase64) => {
        characterState.avatarType = 'custom';
        characterState.avatarClass = '';
        characterState.avatarData = resizedBase64;
        
        playSound('success');
        saveToLocalStorage();
        updateProfileUI();
        avatarModal.classList.remove('visible');
      });
    });
  }

  // START QUEST → open choice modal
  document.getElementById('btn-start-quest').addEventListener('click', () => {
    openChoiceModal();
  });

  // Choice modal options
  document.getElementById('choice-board').addEventListener('click', () => {
    closeChoiceModal();
    setTimeout(() => {
      switchView('view-board');
      renderQuestBoard();
    }, 150);
  });

  document.getElementById('choice-wizard').addEventListener('click', () => {
    closeChoiceModal();
    setTimeout(() => {
      switchView('view-wizard');
      initWizard();
    }, 150);
  });

  document.getElementById('choice-close').addEventListener('click', () => {
    closeChoiceModal();
  });

  // Wizard Next trigger
  document.getElementById('btn-wizard-next').addEventListener('click', nextWizardStep);

  // General Back buttons
  document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      switchView(e.target.getAttribute('data-target'));
    });
  });

  // Accept selected quest handler (shared function)
  function acceptSelectedQuest() {
    if (!selectedQuest) return;

    // Check if slot limit of 3 is reached
    if (activeQuests.length >= 3) {
      alert("⚠️ Your active quest log is full! Abandon or complete a quest before starting another.");
      return;
    }

    // Check if already active
    if (activeQuests.some(q => q.id === selectedQuest.id)) {
      alert("⚔️ You are already tracking this quest!");
      return;
    }

    // Add to active quests
    activeQuests.push(selectedQuest);
    playSound('success');
    
    saveToLocalStorage();
    updateActiveQuestsUI();

    alert(`Quest Accepted! "${selectedQuest.title}" has been added to your Active Quests log.`);
    switchView('view-home');
  }

  document.getElementById('btn-accept-quest').addEventListener('click', acceptSelectedQuest);
  document.getElementById('btn-accept-board-quest').addEventListener('click', acceptSelectedQuest);

  // Board filter tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSound('click');
      document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      renderQuestBoard(e.target.getAttribute('data-filter'));
    });
  });

  // --- Friends System Event Listeners ---
  const friendsModal = document.getElementById('friends-modal');
  const notificationsModal = document.getElementById('notifications-modal');
  let bannerTimeout = null;
  
  document.getElementById('btn-friends-list').addEventListener('click', () => {
    playSound('modalOpen');
    friendsModal.classList.add('visible');
  });

  document.getElementById('friends-modal-close').addEventListener('click', () => {
    playSound('click');
    friendsModal.classList.remove('visible');
  });

  document.getElementById('btn-notification').addEventListener('click', () => {
    playSound('modalOpen');
    notificationsModal.classList.add('visible');
  });

  document.getElementById('notifications-modal-close').addEventListener('click', async () => {
    playSound('click');
    notificationsModal.classList.remove('visible');
    
    // Mark all as read in Firestore
    if (currentUser) {
      notificationsList.forEach(async (n) => {
        if (!n.read) {
          try {
            await updateDoc(doc(db, 'users', currentUser.uid, 'notifications', n.id), { read: true });
          } catch (e) {
            console.error(e);
          }
        }
      });
    }
  });

  document.getElementById('btn-add-friend').addEventListener('click', async () => {
    const codeInput = document.getElementById('input-add-friend');
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return;
    
    if (code === friendCode) {
      alert("You can't add yourself!");
      return;
    }
    if (friendsList.some(f => f.code === code)) {
      alert("This person is already your friend!");
      return;
    }
    
    try {
      const friendCodeSnap = await getDoc(doc(db, 'friendCodes', code));
      if (!friendCodeSnap.exists()) {
        alert("Adventurer Code not found!");
        return;
      }
      
      const friendUid = friendCodeSnap.data().uid;
      
      // Write friend request notification to friend's notifications
      await addDoc(collection(db, 'users', friendUid, 'notifications'), {
        type: 'friend_request',
        senderCode: friendCode,
        senderUid: currentUser.uid,
        timestamp: Date.now(),
        read: false
      });
      
      playSound('success');
      alert("Friend request sent to " + code + "!");
      codeInput.value = '';
    } catch (err) {
      console.error(err);
      alert("Failed to add friend: " + err.message);
    }
  });

  function triggerToastBanner(senderCode, type = 'friend_request', questTitle = '') {
    const banner = document.getElementById('friend-request-banner');
    if (!banner) return;
    
    const textEl = banner.querySelector('.banner-text');
    if (type === 'friend_request') {
      textEl.innerHTML = `⚔️ New request from <span id="banner-sender-code">${senderCode}</span>!`;
    } else if (type === 'coop_invite') {
      textEl.innerHTML = `🛡️ Co-op Invite from <span id="banner-sender-code">${senderCode}</span>!<br><span style="font-size:0.9rem; color:var(--gold-bright);">${questTitle}</span>`;
    }
    
    banner.classList.remove('hidden', 'slide-up');
    
    const progressFill = document.getElementById('banner-progress-fill');
    if (progressFill) {
      progressFill.style.animation = 'none';
      progressFill.offsetHeight;
      progressFill.style.animation = 'countdown 5s linear forwards';
    }
    
    if (bannerTimeout) clearTimeout(bannerTimeout);
    
    bannerTimeout = setTimeout(() => {
      banner.classList.add('slide-up');
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('slide-up');
      }, 300);
    }, 5000);
  }

  document.getElementById('btn-simulate-request').addEventListener('click', async () => {
    playSound('click');
    friendsModal.classList.remove('visible');
    
    if (!currentUser) return;
    
    const randCode = 'QM-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    
    try {
      await addDoc(collection(db, 'users', currentUser.uid, 'notifications'), {
        type: 'friend_request',
        senderCode: randCode,
        timestamp: Date.now(),
        read: false
      });
      playSound('notification');
      triggerToastBanner(randCode);
    } catch (err) {
      console.warn("Firestore write failed for simulation, falling back to local simulation:", err);
      const mockId = 'mock_' + Math.random().toString(36).substring(2, 6);
      notificationsList.push({
        id: mockId,
        type: 'friend_request',
        senderCode: randCode,
        timestamp: Date.now(),
        read: false
      });
      playSound('notification');
      triggerToastBanner(randCode);
      updateNotificationsUI();
    }
  });

  // Delegate accept/decline for notifications
  document.getElementById('notifications-list').addEventListener('click', async (e) => {
    if (e.target.tagName !== 'BUTTON') return;
    const action = e.target.getAttribute('data-action');
    const notiId = e.target.getAttribute('data-id');
    const notiIndex = notificationsList.findIndex(n => n.id === notiId);
    
    if (notiIndex === -1) return;
    const noti = notificationsList[notiIndex];

    try {
      if (action === 'accept') {
        // Prepare initial friend details
        let friendDetails = {
          uid: noti.senderUid || '',
          code: noti.senderCode,
          name: 'HERO_' + (noti.senderCode.split('-')[1] || 'HERO'),
          avatarType: 'preset',
          avatarClass: Object.keys(AVATAR_PRESETS)[Math.floor(Math.random() * 6)],
          avatarData: '',
          level: 1,
          xp: 0,
          deeds: [
            { title: 'Rescued a cat from tavern', xpEarned: 25 },
            { title: 'Conquered epic workout', xpEarned: 100 }
          ]
        };

        // Try to fetch actual details from Firestore
        try {
          if (noti.senderUid && noti.senderUid !== 'mock_uid') {
            const friendDoc = await getDoc(doc(db, 'users', noti.senderUid));
            if (friendDoc.exists()) {
              const fData = friendDoc.data();
              friendDetails.name = fData.nickname || friendDetails.name;
              friendDetails.avatarType = fData.avatarType || friendDetails.avatarType;
              friendDetails.avatarClass = fData.avatarClass || friendDetails.avatarClass;
              friendDetails.avatarData = fData.avatarData || friendDetails.avatarData;
              friendDetails.level = fData.level || friendDetails.level;
              friendDetails.xp = fData.xp || friendDetails.xp;
              if (fData.completedQuests && fData.completedQuests.length > 0) {
                friendDetails.deeds = fData.completedQuests.map(q => ({ title: q.title, xpEarned: q.xpEarned }));
              }
              // Store in cache
              friendDataCache[noti.senderUid] = fData;
            }
          }
        } catch (e) {
          console.warn("Could not fetch friend profile on accept, using placeholders:", e);
        }

        friendsList.push(friendDetails);
        playSound('success');
        saveToLocalStorage();
        updateFriendsUI();

        // Notify the sender that the request was accepted
        if (noti.senderUid && noti.senderUid !== 'mock_uid' && notiId && !notiId.startsWith('mock_')) {
          try {
            await addDoc(collection(db, 'users', noti.senderUid, 'notifications'), {
              type: 'friend_accepted',
              senderCode: friendCode,
              senderUid: currentUser.uid,
              timestamp: Date.now(),
              read: false
            });
          } catch (err) {
            console.error("Failed to send friend_accepted notification:", err);
          }
        }
      } else if (action === 'decline') {
        playSound('toggleOff');
      } else if (action === 'accept-coop') {
        if (noti.lobbyId) {
          notificationsModal.classList.remove('visible');
          await joinQuestLobby(noti.lobbyId, noti.questId, noti.senderCode);
        } else {
          const originalQuest = QUESTS.find(q => q.id === noti.questId);
          if (originalQuest) {
            if (activeQuests.length >= 3) {
              alert("⚠️ Your active quest log is full! Abandon or complete a quest before starting another.");
              return;
            }
            if (activeQuests.some(q => q.id === originalQuest.id)) {
              alert("⚔️ You are already tracking this quest!");
              return;
            }
            
            const senderFriend = friendsList.find(f => f.code === noti.senderCode) || {
              code: noti.senderCode,
              name: 'HERO_' + (noti.senderCode.split('-')[1] || 'HERO'),
              avatarType: 'preset',
              avatarClass: Object.keys(AVATAR_PRESETS)[Math.floor(Math.random() * 6)],
              avatarData: ''
            };
            ensureFriendStats(senderFriend);
            const friendCopy = { ...senderFriend, status: 'ready' };
            
            const newActive = { ...originalQuest, coopFriends: [friendCopy] };
            activeQuests.push(newActive);
            playSound('success');
            saveToLocalStorage();
            updateActiveQuestsUI();
            
            notificationsModal.classList.remove('visible');
            if (currentView !== 'view-home') switchView('view-home');
            
            setTimeout(() => {
              openQuestCodex(newActive, 'view-home');
            }, 300);
          }
        }
      } else if (action === 'decline-coop') {
        playSound('toggleOff');
      }
      
      if (notiId && !notiId.startsWith('mock_')) {
        // Delete notification from Firestore
        await deleteDoc(doc(db, 'users', currentUser.uid, 'notifications', notiId));
      } else {
        // Local removal
        notificationsList = notificationsList.filter(n => n.id !== notiId);
        updateNotificationsUI();
      }
    } catch (err) {
      console.error(err);
      // Fallback local removal on error
      notificationsList = notificationsList.filter(n => n.id !== notiId);
      updateNotificationsUI();
    }
  });

  // Modal Closers
  document.getElementById('quest-codex-close').addEventListener('click', () => {
    playSound('click');
    document.getElementById('quest-codex-modal').classList.remove('visible');
  });
  document.getElementById('friend-profile-close').addEventListener('click', () => {
    playSound('click');
    document.getElementById('friend-profile-modal').classList.remove('visible');
    if (friendProfileSourceView === 'friends') {
      document.getElementById('friends-modal').classList.add('visible');
    }
  });

  const removeFriendBtn = document.getElementById('btn-remove-friend');
  if (removeFriendBtn) {
    removeFriendBtn.addEventListener('click', async () => {
      const uid = removeFriendBtn.getAttribute('data-uid');
      const code = removeFriendBtn.getAttribute('data-code');
      const action = removeFriendBtn.getAttribute('data-action') || 'remove';
      if (!code) return;

      if (action === 'add') {
        try {
          playSound('success');
          await addDoc(collection(db, 'users', uid, 'notifications'), {
            type: 'friend_request',
            senderCode: friendCode,
            senderUid: currentUser.uid,
            timestamp: Date.now(),
            read: false
          });
          alert("Friend request sent to " + code + "!");
          document.getElementById('friend-profile-modal').classList.remove('visible');
        } catch (err) {
          console.error(err);
          alert("Failed to send friend request: " + err.message);
        }
      } else {
        if (confirm(`Are you sure you want to remove this friend (${code})?`)) {
          playSound('toggleOff');

          if (uid && friendSubscriptions[uid]) {
            try {
              friendSubscriptions[uid]();
            } catch (e) {
              console.error(e);
            }
            delete friendSubscriptions[uid];
          }

          friendsList = friendsList.filter(fr => fr.code !== code);
          saveToLocalStorage();
          updateFriendsUI();

          document.getElementById('friend-profile-modal').classList.remove('visible');
          if (friendProfileSourceView === 'friends') {
            document.getElementById('friends-modal').classList.add('visible');
          }
          
          alert("Friend removed successfully.");
        }
      }
    });
  }

  document.getElementById('friend-picker-close').addEventListener('click', () => {
    playSound('click');
    document.getElementById('friend-picker-modal').classList.remove('visible');
  });

  // --- Firebase Auth Panel Handlers ---
  document.getElementById('btn-auth-signin').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    if (!email || !password) {
      alert("Please fill in email and password.");
      return;
    }
    
    const errMsgEl = document.getElementById('auth-error-msg');
    try {
      errMsgEl.classList.add('hidden');
      playSound('click');
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      errMsgEl.textContent = err.message;
      errMsgEl.classList.remove('hidden');
    }
  });

  document.getElementById('btn-auth-signup').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    if (!email || !password) {
      alert("Please fill in email and password.");
      return;
    }
    
    const errMsgEl = document.getElementById('auth-error-msg');
    try {
      errMsgEl.classList.add('hidden');
      playSound('success');
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
      console.error("Signup failed:", err);
      errMsgEl.textContent = err.message;
      errMsgEl.classList.remove('hidden');
    }
  });

  document.getElementById('btn-auth-google').addEventListener('click', async () => {
    playSound('success');
    const provider = new GoogleAuthProvider();
    const errMsgEl = document.getElementById('auth-error-msg');
    try {
      errMsgEl.classList.add('hidden');
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Google sign in failed:", err);
      errMsgEl.textContent = err.message;
      errMsgEl.classList.remove('hidden');
    }
  });

  document.getElementById('btn-auth-guest').addEventListener('click', async () => {
    playSound('success');
    const tempEmail = `guest_${Math.floor(Math.random() * 1000000)}@questmax.com`;
    const tempPassword = "password123";
    const errMsgEl = document.getElementById('auth-error-msg');
    errMsgEl.textContent = "Creating simulated guest account...";
    errMsgEl.classList.remove('hidden');
    
    // Pre-populate with randomized class, level, and quests for simulation
    const classes = ['warrior', 'mage', 'rogue', 'ranger', 'paladin', 'bard'];
    const randomClass = classes[Math.floor(Math.random() * classes.length)];
    const randomLevel = Math.floor(Math.random() * 8) + 2;
    const randomXP = Math.floor(Math.random() * 80);
    const adjs = ['EPIC', 'SWIFT', 'BRAVE', 'MIGHTY', 'SHADOW', 'GOLDEN', 'LEGENDARY'];
    const nouns = ['KNIGHT', 'WIZARD', 'THIEF', 'HUNTER', 'CLERIC', 'ROVER', 'CHAMPION'];
    const randomName = adjs[Math.floor(Math.random() * adjs.length)] + '_' + nouns[Math.floor(Math.random() * nouns.length)];

    pendingRegistrationData = {
      nickname: randomName,
      avatarClass: randomClass,
      level: randomLevel,
      xp: randomXP,
      completedQuests: [
        { questId: 'q1', title: 'Tutorial Dungeon', xpEarned: 25, completedAt: new Date().toISOString() },
        { questId: 'q2', title: 'Defeat the Local Slime', xpEarned: 50, completedAt: new Date().toISOString() }
      ]
    };
    
    try {
      await createUserWithEmailAndPassword(auth, tempEmail, tempPassword);
    } catch (err) {
      console.error("Guest registration failed:", err);
      errMsgEl.textContent = err.message;
      errMsgEl.classList.remove('hidden');
      pendingRegistrationData = null;
    }
  });

  document.getElementById('btn-show-email-screen').addEventListener('click', () => {
    playSound('click');
    document.getElementById('auth-options-screen').classList.add('hidden');
    document.getElementById('auth-email-screen').classList.remove('hidden');
    document.getElementById('auth-title').textContent = "SIGN IN WITH EMAIL";
  });

  document.getElementById('btn-back-to-options').addEventListener('click', () => {
    playSound('click');
    document.getElementById('auth-email-screen').classList.add('hidden');
    document.getElementById('auth-options-screen').classList.remove('hidden');
    document.getElementById('auth-title').textContent = "HERO LOGIN / REGISTER";
    document.getElementById('auth-error-msg').classList.add('hidden');
  });

  document.getElementById('btn-auth-logout').addEventListener('click', () => {
    if (!confirm("Are you sure you want to log out?")) return;
    
    playSound('toggleOff');
    if (unsubscribeUser) unsubscribeUser();
    if (unsubscribeNotifications) unsubscribeNotifications();
    Object.values(friendSubscriptions).forEach(unsub => {
      try { unsub(); } catch(e) {}
    });
    friendSubscriptions = {};
    signOut(auth);
  });

  // --- Listen for Auth Changes ---
  onAuthStateChanged(auth, (user) => {
    // Unsubscribe from previous listeners if any to prevent cross-contamination
    if (unsubscribeUser) {
      unsubscribeUser();
      unsubscribeUser = null;
    }
    if (unsubscribeNotifications) {
      unsubscribeNotifications();
      unsubscribeNotifications = null;
    }
    Object.values(friendSubscriptions).forEach(unsub => {
      try { unsub(); } catch(e) {}
    });
    friendSubscriptions = {};

    // Reset local state to default values immediately to prevent cross-contamination
    characterState = {
      nickname: 'ADVENTURER',
      avatarType: 'preset',
      avatarClass: 'warrior',
      avatarData: '',
      xp: 0,
      level: 1
    };
    activeQuests = [];
    completedQuests = [];
    friendCode = '';
    friendsList = [];
    notificationsList = [];
    toastedNotificationIds.clear();

    // Redraw UI to reflect cleared state
    updateProfileUI();
    updateActiveQuestsUI();
    updateFriendsUI();
    updateNotificationsUI();

    if (user) {
      currentUser = user;
      document.getElementById('view-auth').classList.remove('visible');
      
      // Fast client-side fallback for friendCode in case Firestore is unreachable
      if (!friendCode) {
        friendCode = localStorage.getItem('questmax_friendCode') || 'QM-' + Math.random().toString(36).substring(2, 6).toUpperCase();
        updateFriendsUI();
      }
      
      // Subscribe to real-time user database
      unsubscribeUser = onSnapshot(doc(db, 'users', user.uid), async (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          characterState.nickname = data.nickname || 'ADVENTURER';
          characterState.avatarType = data.avatarType || 'preset';
          characterState.avatarClass = data.avatarClass || 'warrior';
          characterState.avatarData = data.avatarData || '';
          characterState.xp = data.xp || 0;
          characterState.level = data.level || 1;
          friendCode = data.friendCode || '';
          friendsList = data.friendsList || [];
          activeQuests = data.activeQuests || [];
          completedQuests = data.completedQuests || [];
          
          // Fallback: If logged in user doesn't have a friendCode, create one
          if (!friendCode) {
            friendCode = 'QM-' + Math.random().toString(36).substring(2, 6).toUpperCase();
            await updateDoc(doc(db, 'users', user.uid), { friendCode: friendCode });
            await setDoc(doc(db, 'friendCodes', friendCode), { uid: user.uid });
          }
          
          const newGuildId = data.guildId || '';
          characterState.guildId = newGuildId;
          handleGuildSubscription(newGuildId);

          updateProfileUI();
          updateActiveQuestsUI();
          updateFriendsUI();
        } else {
          // Document does not exist, initialize it!
          try {
            const isGuest = user.email && user.email.startsWith('guest_');
            let customData = {};
            if (pendingRegistrationData) {
              customData = pendingRegistrationData;
              pendingRegistrationData = null;
            } else if (isGuest) {
              const numStr = user.email.split('@')[0].split('_')[1] || 'GUEST';
              customData.nickname = 'GUEST_' + numStr;
            }
            await initializeUserDocument(user, customData);
          } catch (e) {
            console.error("Error self-healing user document: ", e);
          }
        }
      }, (error) => {
        console.error("User snapshot listener error:", error);
      });
      
      // Subscribe to notifications
      unsubscribeNotifications = onSnapshot(collection(db, 'users', user.uid, 'notifications'), async (snapshot) => {
        notificationsList = [];
        let needsSave = false;
        
        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (data.type === 'friend_accepted') {
            // Automatically add the friend to our list if not already present
            const friendExists = friendsList.some(f => f.code === data.senderCode);
            if (!friendExists) {
              let friendDetails = {
                uid: data.senderUid || '',
                code: data.senderCode,
                name: 'HERO_' + (data.senderCode.split('-')[1] || 'HERO'),
                avatarType: 'preset',
                avatarClass: 'warrior',
                avatarData: '',
                level: 1,
                xp: 0,
                deeds: [
                  { title: 'Rescued a cat from tavern', xpEarned: 25 },
                  { title: 'Conquered epic workout', xpEarned: 100 }
                ]
              };
              
              try {
                const friendDoc = await getDoc(doc(db, 'users', data.senderUid));
                if (friendDoc.exists()) {
                  const fData = friendDoc.data();
                  friendDetails.name = fData.nickname || friendDetails.name;
                  friendDetails.avatarType = fData.avatarType || 'preset';
                  friendDetails.avatarClass = fData.avatarClass || 'warrior';
                  friendDetails.avatarData = fData.avatarData || '';
                  friendDetails.level = fData.level || 1;
                  friendDetails.xp = fData.xp || 0;
                }
              } catch (e) {
                console.warn("Could not fetch friend details for acceptance", e);
              }
              
              friendsList.push(friendDetails);
              needsSave = true;
            }
            
            // Delete processed friend_accepted notification
            try {
              await deleteDoc(doc(db, 'users', user.uid, 'notifications', docSnap.id));
            } catch (e) {
              console.error("Error deleting friend_accepted notification:", e);
            }
          } else {
            notificationsList.push({ id: docSnap.id, ...data });
            
            if (!data.read && !toastedNotificationIds.has(docSnap.id)) {
              toastedNotificationIds.add(docSnap.id);
              const age = Date.now() - (data.timestamp || 0);
              if (age < 60000) {
                playSound('notification');
                if (data.type === 'friend_request') {
                  triggerToastBanner(data.senderCode, 'friend_request');
                } else if (data.type === 'coop_invite') {
                  triggerToastBanner(data.senderCode, 'coop_invite', data.questTitle);
                }
              }
            }
          }
        }
        
        if (needsSave) {
          saveToLocalStorage();
          updateFriendsUI();
        }
        
        updateNotificationsUI();
      }, (error) => {
        console.error("Notifications snapshot listener error:", error);
      });
    } else {
      currentUser = null;
      document.getElementById('view-auth').classList.add('visible');
      
      // Clean up active guild subscriptions on logout
      if (unsubscribeGuild) { unsubscribeGuild(); unsubscribeGuild = null; }
      if (unsubscribeGuildChat) { unsubscribeGuildChat(); unsubscribeGuildChat = null; }
      if (unsubscribeGuildLeaderboard) { unsubscribeGuildLeaderboard(); unsubscribeGuildLeaderboard = null; }
      activeGuild = null;

      // Reset Auth Screens
      document.getElementById('auth-email-screen').classList.add('hidden');
      document.getElementById('auth-options-screen').classList.remove('hidden');
      document.getElementById('auth-title').textContent = "HERO LOGIN / REGISTER";
      
      // Reset inputs
      document.getElementById('auth-email').value = '';
      document.getElementById('auth-password').value = '';
      document.getElementById('auth-error-msg').classList.add('hidden');
    }
  });

  // --- Guild DOM Event Listeners ---
  const createCrestPresets = document.querySelectorAll('#guild-crest-presets .avatar-preset-btn');
  createCrestPresets.forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSound('click');
      createCrestPresets.forEach(b => b.classList.remove('selected'));
      e.currentTarget.classList.add('selected');
    });
  });

  const editCrestPresets = document.querySelectorAll('#guild-edit-crest-presets .avatar-preset-btn');
  editCrestPresets.forEach(btn => {
    btn.addEventListener('click', (e) => {
      playSound('click');
      editCrestPresets.forEach(b => b.classList.remove('selected'));
      e.currentTarget.classList.add('selected');
    });
  });

  const btnGuildCreate = document.getElementById('btn-guild-create');
  if (btnGuildCreate) {
    btnGuildCreate.addEventListener('click', async () => {
      const name = document.getElementById('guild-create-name').value;
      const desc = document.getElementById('guild-create-desc').value;
      const selectedBtn = document.querySelector('#guild-crest-presets .avatar-preset-btn.selected');
      const crest = selectedBtn ? selectedBtn.getAttribute('data-crest') : '⚔️';
      
      await createGuild(name, desc, crest);
      document.getElementById('guild-create-name').value = '';
      document.getElementById('guild-create-desc').value = '';
    });
  }

  const btnGuildJoin = document.getElementById('btn-guild-join');
  if (btnGuildJoin) {
    btnGuildJoin.addEventListener('click', async () => {
      const code = document.getElementById('guild-join-code').value;
      await joinGuild(code);
      document.getElementById('guild-join-code').value = '';
    });
  }

  const btnGuildLeave = document.getElementById('btn-guild-leave');
  if (btnGuildLeave) {
    btnGuildLeave.addEventListener('click', async () => {
      await leaveGuild();
    });
  }

  const btnGuildEdit = document.getElementById('btn-guild-edit');
  if (btnGuildEdit) {
    btnGuildEdit.addEventListener('click', () => {
      if (!activeGuild) return;
      playSound('modalOpen');
      document.getElementById('guild-edit-desc-input').value = activeGuild.description || '';
      
      const editPresets = document.querySelectorAll('#guild-edit-crest-presets .avatar-preset-btn');
      editPresets.forEach(btn => {
        const isSelected = btn.getAttribute('data-crest') === activeGuild.crest;
        btn.classList.toggle('selected', isSelected);
      });
      
      document.getElementById('guild-edit-modal').classList.add('visible');
    });
  }

  const btnGuildSaveEdit = document.getElementById('btn-guild-save-edit');
  if (btnGuildSaveEdit) {
    btnGuildSaveEdit.addEventListener('click', async () => {
      const desc = document.getElementById('guild-edit-desc-input').value;
      const selectedBtn = document.querySelector('#guild-edit-crest-presets .avatar-preset-btn.selected');
      const crest = selectedBtn ? selectedBtn.getAttribute('data-crest') : '🛡️';
      
      await saveGuildEdit(desc, crest);
      document.getElementById('guild-edit-modal').classList.remove('visible');
    });
  }

  const btnGuildEditClose = document.getElementById('guild-edit-modal-close');
  if (btnGuildEditClose) {
    btnGuildEditClose.addEventListener('click', () => {
      playSound('click');
      document.getElementById('guild-edit-modal').classList.remove('visible');
    });
  }

  const tabHome = document.getElementById('tab-guild-home');
  const tabChat = document.getElementById('tab-guild-chat');
  const homeContent = document.getElementById('guild-hub-home-content');
  const chatContent = document.getElementById('guild-hub-chat-content');

  if (tabHome && tabChat) {
    tabHome.addEventListener('click', () => {
      playSound('click');
      tabHome.classList.add('active');
      tabChat.classList.remove('active');
      homeContent.classList.remove('hidden');
      chatContent.classList.add('hidden');
    });

    tabChat.addEventListener('click', () => {
      playSound('click');
      tabChat.classList.add('active');
      tabHome.classList.remove('active');
      chatContent.classList.remove('hidden');
      homeContent.classList.add('hidden');
      
      const chatFeed = document.getElementById('guild-chat-feed');
      if (chatFeed) {
        chatFeed.scrollTop = chatFeed.scrollHeight;
      }
      
      const chatBadge = document.getElementById('guild-chat-badge');
      if (chatBadge) chatBadge.classList.add('hidden');
    });
  }

  const btnChatSend = document.getElementById('btn-guild-chat-send');
  const chatInput = document.getElementById('guild-chat-input');

  if (btnChatSend && chatInput) {
    const handleSend = async () => {
      const text = chatInput.value;
      if (!text.trim()) return;
      
      playSound('click');
      await sendChatMessage(text);
      chatInput.value = '';
      chatInput.focus();
    };

    btnChatSend.addEventListener('click', handleSend);
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        handleSend();
      }
    });
  }
});
