import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from './io.js';

const DIR = join(homedir(), '.joi-todo');
const FILE = join(DIR, 'config.json');

const DEFAULT = {
  categories: [
    { code: 'BP', name: 'Business Partner', children: ['klc', 'mighty', 'özaydın'] },
    { code: 'NX', name: 'NXDIA', children: ['nxdia'] },
    { code: 'NW', name: 'NewWorker', children: ['newworker', 'allianz', 'qnb', 'bbva'] },
    { code: 'LR', name: 'Learn', children: ['contentia', 'time-intel', 'nfes-design', 'enhijyen', 'mobile', 'aiworks', 'reading'] },
    { code: 'PS', name: 'Personal', children: ['personal'] },
  ],
  missions: {},
};

function ensure() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  if (!existsSync(FILE)) writeAtomic(FILE, JSON.stringify(DEFAULT, null, 2));
}

export function loadConfig() {
  ensure();
  const raw = JSON.parse(readFileSync(FILE, 'utf8'));
  return {
    ...DEFAULT,
    ...raw,
    categories: raw.categories ?? DEFAULT.categories,
    missions: raw.missions ?? {},
  };
}

export function saveConfig(cfg) {
  ensure();
  writeAtomic(FILE, JSON.stringify(cfg, null, 2));
}

// Map: project name (or lowercased category code) → uppercase category code
export function catByProject(cfg) {
  const m = new Map();
  for (const cat of cfg.categories) {
    m.set(cat.code.toLowerCase(), cat.code);
    for (const child of cat.children) m.set(child, cat.code);
  }
  return m;
}

// Get category object by code (case-insensitive)
export function getCategory(cfg, code) {
  if (!code) return null;
  return cfg.categories.find((c) => c.code.toLowerCase() === String(code).toLowerCase()) || null;
}

// All valid project names (children + lowercase category codes)
export function allProjects(cfg) {
  const set = new Set();
  for (const cat of cfg.categories) {
    set.add(cat.code.toLowerCase());
    for (const c of cat.children) set.add(c);
  }
  return [...set];
}

// Project display order — for grouped rendering
export function projectOrder(cfg) {
  const order = [];
  for (const cat of cfg.categories) {
    order.push(cat.code.toLowerCase()); // category-level (direct) tasks first
    for (const child of cat.children) order.push(child);
  }
  return order;
}

// Is this project a category-level (i.e. direct BP/NX/... task) vs a child
export function isCategoryLevel(cfg, project) {
  if (!project) return false;
  return cfg.categories.some((c) => c.code.toLowerCase() === project.toLowerCase());
}

export const configPath = FILE;
