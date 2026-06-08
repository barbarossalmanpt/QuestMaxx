# QuestMax - Agent Context
This file contains the core context for AI agents working on the QuestMax application.

## Vision
QuestMax is a mobile-first web application designed to help teenagers find exciting "side quests" to do during their summer break. The aesthetic is heavily inspired by 2000s medieval MMOs (like RuneScape, Tibia, classic RPG Maker).

## Tech Stack
- Frontend: HTML5, CSS3, Vanilla JavaScript (No frameworks for MVP)
- Future Integrations: Firebase (Authentication & Database), GitHub Pages (Hosting)

## Core Features (V1 MVP)
1. **Swipeable Panel Layout**: Clash Royale-style UI with a central main hub and locked side panels.
2. **Quest Board**: A scrollable list of all available quests, styled like RPG item cards.
3. **Quest Wizard**: A multi-step questionnaire to generate 5 specific quest recommendations based on difficulty, party size, budget, environment, vibe, and time.
4. **Chest Reveal Animation**: A satisfying animation where a chest opens to reveal the generated quests.
5. **Retro Aesthetics**: Stone backgrounds, wooden frames, parchment textures, and 16-bit pixel fonts. 8-bit sound effects for interactions.

## Design System
- **Colors**: Deep Purple (`#1a0a2e`), Dark Indigo (`#16213e`), Surface Purple (`#1e1440`), Panel Indigo (`#241848`), Amber Gold (`#f4c430`), Emerald Green (`#2ecc71`).
- **Typography**: `Press Start 2P` for titles, `VT323` for body text.
- **Components**: UI elements are designed to look like physical game objects (stone buttons, metal plaques, inventory slots).

## Development Guidelines
- Always design mobile-first (max-width constraints, touch-friendly targets).
- Use semantic HTML.
- Avoid over-engineering; stick to Vanilla JS for the MVP.
