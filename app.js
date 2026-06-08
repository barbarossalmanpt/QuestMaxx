import { QUESTS } from './quests.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, onSnapshot, arrayUnion, arrayRemove, query, where, deleteDoc, addDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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
  level: 1
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
      completedQuests: completedQuests
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

  if (didLevelUp) {
    playSound('levelUp');
    alert(`🎉 LEVEL UP! You reached Level ${characterState.level}!`);
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
      
      let avatarHtml = '';
      if (f.avatarType === 'custom' && f.avatarData) {
        avatarHtml = `<img src="${f.avatarData}" alt="Avatar" style="width: 100%; height: 100%; object-fit: cover; border-radius: 2px;">`;
      } else {
        avatarHtml = AVATAR_PRESETS[f.avatarClass] || '⚔️';
      }

      item.innerHTML = `
        <div class="friend-avatar">${avatarHtml}</div>
        <div class="friend-info">
          <span class="friend-name">${f.name}</span>
          <span class="friend-code-text">${f.code}</span>
        </div>
      `;

      item.addEventListener('click', () => {
        showFriendProfile(f);
      });

      listContainer.appendChild(item);
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
  ensureFriendStats(friend);
  
  document.getElementById('friend-profile-name').textContent = friend.name;
  document.getElementById('friend-profile-code').textContent = friend.code;
  
  const avatarImg = document.getElementById('friend-profile-avatar');
  const avatarPlaceholder = document.getElementById('friend-profile-avatar-placeholder');
  if (friend.avatarType === 'custom' && friend.avatarData) {
    avatarImg.src = friend.avatarData;
    avatarImg.classList.remove('hidden');
    avatarPlaceholder.classList.add('hidden');
  } else {
    avatarImg.classList.add('hidden');
    avatarPlaceholder.textContent = AVATAR_PRESETS[friend.avatarClass] || '⚔️';
    avatarPlaceholder.classList.remove('hidden');
  }
  
  const classTitles = {
    warrior: 'WARRIOR', mage: 'MAGE', rogue: 'ROGUE', ranger: 'RANGER', paladin: 'PALADIN', bard: 'BARD'
  };
  const title = classTitles[friend.avatarClass] || 'HERO';
  document.getElementById('friend-profile-class').textContent = `LEVEL ${friend.level} ${title}`;
  
  document.getElementById('friend-profile-status').textContent = 'AVAILABLE';
  
  const deedsList = document.getElementById('friend-deeds-list');
  deedsList.innerHTML = '';
  friend.deeds.forEach(d => {
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

// --- Quest Codex Modal Logic ---
let codexQuest = null;

function getQuestMaxPartySize(quest) {
  if (!quest.tags || !quest.tags.party) return 1;
  const p = quest.tags.party;
  if (p.includes('squad')) return 4;
  if (p.includes('duo')) return 2;
  return 1;
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
  quadrants.forEach(q => q.classList.remove('active'));
  
  const partyList = document.getElementById('xbox-party-list');
  partyList.innerHTML = '';
  
  const bonusRow = document.getElementById('codex-bonus-row');
  const actionBtn = document.getElementById('btn-codex-action');
  const inviteBtn = document.getElementById('btn-codex-invite');
  
  let myAvatarHtml = characterState.avatarType === 'custom' && characterState.avatarData ? 
    `<img src="${characterState.avatarData}" style="width:100%; height:100%; object-fit:cover;">` : 
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
      `<img src="${hostFriend.avatarData}" style="width:100%; height:100%; object-fit:cover;">` :
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
      
      // Play Xbox connect chime when joining
      playSound('xboxConnect');
      
      document.getElementById('quest-codex-modal').classList.remove('visible');
      if (currentView !== 'view-home') switchView('view-home');
      
      setTimeout(() => {
        openQuestCodex(newActive, 'view-home');
      }, 300);
    };
  } else if (activeInstance) {
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
    
    if (!activeInstance.coopFriends) activeInstance.coopFriends = [];
    
    const quadClasses = ['.q-tr', '.q-br', '.q-bl'];
    activeInstance.coopFriends.forEach((friend, idx) => {
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
        `<img src="${friend.avatarData}" style="width:100%; height:100%; object-fit:cover;">` :
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
    
    const currentPartySize = 1 + activeInstance.coopFriends.length;
    document.getElementById('ring-party-size').textContent = `${currentPartySize}/${maxParty}`;
    
    if (currentPartySize >= maxParty && activeInstance.coopFriends.every(f => f.status === 'ready')) {
      ring.classList.add('lobby-full');
    }
    
    actionBtn.textContent = 'COMPLETE QUEST ✓';
    actionBtn.className = 'stone-button success-btn';
    actionBtn.onclick = () => {
      completeQuest(activeInstance.id);
      document.getElementById('quest-codex-modal').classList.remove('visible');
    };
    
    if (currentPartySize < maxParty && friendsList.length > 0) {
      inviteBtn.classList.remove('hidden');
      inviteBtn.onclick = () => {
        openFriendPicker(activeInstance);
      };
    } else {
      inviteBtn.classList.add('hidden');
    }
    
    const readyFriends = activeInstance.coopFriends.filter(f => f.status === 'ready');
    if (readyFriends.length > 0) {
      bonusRow.classList.remove('hidden');
      document.getElementById('codex-bonus-xp').textContent = `+${Math.round(baseXP * 0.25)} XP`;
    } else {
      bonusRow.classList.add('hidden');
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
      document.getElementById('quest-codex-modal').classList.remove('visible');
      
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
      
      item.addEventListener('click', () => {
        playSound('click');
        document.getElementById('friend-picker-modal').classList.remove('visible');
        
        const friendCopy = { ...f, status: 'pending' };
        activeQuestInstance.coopFriends.push(friendCopy);
        saveToLocalStorage();
        openQuestCodex(activeQuestInstance, 'view-home');
        
        setTimeout(() => {
          friendCopy.status = 'ready';
          playSound('xboxConnect');
          
          const maxParty = getQuestMaxPartySize(activeQuestInstance);
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
        }, 1500);
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

  function triggerToastBanner(senderCode) {
    if (currentView !== 'view-home') switchView('view-home');
    const banner = document.getElementById('friend-request-banner');
    document.getElementById('banner-sender-code').textContent = senderCode;
    
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
    const isCoop = Math.random() > 0.5;
    
    try {
      if (isCoop) {
        const coopQuests = QUESTS.filter(q => getQuestMaxPartySize(q) > 1);
        const randomQuest = coopQuests[Math.floor(Math.random() * coopQuests.length)];
        
        await addDoc(collection(db, 'users', currentUser.uid, 'notifications'), {
          type: 'coop_invite',
          senderCode: randCode,
          senderUid: 'mock_uid',
          questId: randomQuest.id,
          questTitle: randomQuest.title,
          timestamp: Date.now(),
          read: false
        });
        playSound('notification');
        triggerToastBanner(`${randCode} (Co-op Invite)`);
      } else {
        await addDoc(collection(db, 'users', currentUser.uid, 'notifications'), {
          type: 'friend_request',
          senderCode: randCode,
          timestamp: Date.now(),
          read: false
        });
        playSound('notification');
        triggerToastBanner(randCode);
      }
    } catch (err) {
      console.error(err);
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
        // Add to friendsList
        friendsList.push({
          code: noti.senderCode,
          name: 'HERO_' + (noti.senderCode.split('-')[1] || 'HERO'),
          avatarType: 'preset',
          avatarClass: Object.keys(AVATAR_PRESETS)[Math.floor(Math.random() * 6)],
          avatarData: '',
          level: Math.floor(Math.random() * 8) + 2,
          xp: Math.floor(Math.random() * 150),
          deeds: [
            { title: 'Rescued a cat from tavern', xpEarned: 25 },
            { title: 'Conquered epic workout', xpEarned: 100 }
          ]
        });
        playSound('success');
        saveToLocalStorage();
      } else if (action === 'decline') {
        playSound('toggleOff');
      } else if (action === 'accept-coop') {
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
      } else if (action === 'decline-coop') {
        playSound('toggleOff');
      }
      
      // Delete notification from Firestore
      await deleteDoc(doc(db, 'users', currentUser.uid, 'notifications', notiId));
    } catch (err) {
      console.error(err);
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
    document.getElementById('friends-modal').classList.add('visible');
  });

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
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const user = userCredential.user;
      
      // Generate unique friend code
      const generatedCode = 'QM-' + Math.random().toString(36).substring(2, 6).toUpperCase();
      
      // Create mapping in friendCodes
      await setDoc(doc(db, 'friendCodes', generatedCode), { uid: user.uid });
      
      // Create user document
      await setDoc(doc(db, 'users', user.uid), {
        nickname: 'ADVENTURER',
        avatarType: 'preset',
        avatarClass: 'warrior',
        avatarData: '',
        xp: 0,
        level: 1,
        friendCode: generatedCode,
        friendsList: [],
        activeQuests: [],
        completedQuests: []
      });
    } catch (err) {
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
      const result = await signInWithPopup(auth, provider);
      const user = result.user;
      
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      if (!userDoc.exists()) {
        const generatedCode = 'QM-' + Math.random().toString(36).substring(2, 6).toUpperCase();
        await setDoc(doc(db, 'friendCodes', generatedCode), { uid: user.uid });
        await setDoc(doc(db, 'users', user.uid), {
          nickname: user.displayName ? user.displayName.toUpperCase().slice(0, 15) : 'ADVENTURER',
          avatarType: 'preset',
          avatarClass: 'warrior',
          avatarData: '',
          xp: 0,
          level: 1,
          friendCode: generatedCode,
          friendsList: [],
          activeQuests: [],
          completedQuests: []
        });
      }
    } catch (err) {
      console.error(err);
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
    
    await signUp(tempEmail, tempPassword);
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
    signOut(auth);
  });

  // --- Listen for Auth Changes ---
  onAuthStateChanged(auth, (user) => {
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

    // Redraw UI to reflect cleared state
    updateProfileUI();
    updateActiveQuestsUI();
    updateFriendsUI();
    updateNotificationsUI();

    if (user) {
      currentUser = user;
      document.getElementById('view-auth').classList.remove('visible');
      
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
          
          updateProfileUI();
          updateActiveQuestsUI();
          updateFriendsUI();
        }
      });
      
      // Subscribe to notifications
      unsubscribeNotifications = onSnapshot(collection(db, 'users', user.uid, 'notifications'), (snapshot) => {
        notificationsList = [];
        snapshot.forEach(docSnap => {
          notificationsList.push({ id: docSnap.id, ...docSnap.data() });
        });
        updateNotificationsUI();
      });
    } else {
      currentUser = null;
      document.getElementById('view-auth').classList.add('visible');
      
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
});
