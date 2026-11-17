// standard.ts — the kit's contracts. The old Platform splits into lifecycle / save / audio /
// language / ads (the web / youtube / mock adapters implement them — ./platform.ts); wallet / iap /
// leaderboard are new, mock + local only (no real backends here).
//
// Mocks are full local implementations, not stubs: saves in localStorage (memory without it), the
// wallet in memory + the game's save, purchases always succeed, a local leaderboard.

import type { RewardedResult } from '../platform/types.js';
import { contract, once, sticky } from './contract.js';
import { webStorage } from './storage.js';

export const Lifecycle = contract('lifecycle', {
  state: { paused: false },
  events: { pause: once(), resume: once() },
  mock: (ctx) => ({
    async init(): Promise<void> {},
    firstFrameReady(): void {},
    gameReady(): void {},
    /** Mock only: what the host does (the dev panel, tests). */
    hostPause(): void {
      ctx.state.paused = true;
      ctx.emit('pause');
    },
    hostResume(): void {
      ctx.state.paused = false;
      ctx.emit('resume');
    },
  }),
})<{ init(): Promise<void>; firstFrameReady(): void; gameReady(): void }>();

export const SaveService = contract('save', {
  mock: () => {
    const key = 'trempel.save';
    let mem: string | null = null;
    return {
      async load(): Promise<string | null> {
        const s = webStorage();
        if (s) {
          try {
            return s.getItem(key);
          } catch {
            /* disabled storage: memory */
          }
        }
        return mem;
      },
      async save(data: string): Promise<void> {
        mem = data;
        try {
          webStorage()?.setItem(key, data);
        } catch {
          /* storage full / disabled — memory keeps it for the session */
        }
      },
    };
  },
})<{ load(): Promise<string | null>; save(data: string): Promise<void> }>();

export const AudioService = contract('audio', {
  state: { enabled: true },
  events: { changed: sticky<boolean>('enabled') },
  mock: (ctx) => ({
    /** Mock only: flip the host's audio switch. */
    hostSet(on: boolean): void {
      if (ctx.state.enabled === on) return;
      ctx.state.enabled = on;
      ctx.emit('changed', on);
    },
  }),
})<object>();

export const Language = contract('language', {
  state: { lang: 'en' },
  events: { changed: sticky<string>('lang') },
  mock: (ctx) => ({
    /** Mock only: switch the host's language. */
    hostSet(lang: string): void {
      if (ctx.state.lang === lang) return;
      ctx.state.lang = lang;
      ctx.emit('changed', lang);
    },
  }),
})<object>();

export const AdsService = contract('ads', {
  state: { available: true },
  events: { changed: sticky<boolean>('available') },
  // closed: rewarded ads are closed early; no-ads: nothing to show.
  modes: ['closed', 'no-ads'],
  mock: (ctx) => {
    const sync = () => {
      const on = !ctx.mode['no-ads'];
      if (ctx.state.available !== on) {
        ctx.state.available = on;
        ctx.emit('changed', on);
      }
    };
    return {
      async interstitial(): Promise<void> {
        sync();
      },
      async rewarded(): Promise<RewardedResult> {
        sync();
        if (!ctx.state.available) return 'failed';
        return ctx.mode.closed ? 'closed' : 'rewarded';
      },
    };
  },
})<{ interstitial(): Promise<void>; rewarded(): Promise<RewardedResult> }>();

export interface SpendResult {
  ok: boolean;
  balance: number;
}

export const Wallet = contract('wallet', {
  state: { balance: 0, currency: 'coins' },
  events: { changed: sticky<number>('balance'), spent: once<{ amount: number; reason?: string }>() },
  // no-funds: every spend is refused.
  modes: ['no-funds'],
  mock: (ctx) => {
    const saved = ctx.store.get<{ balance: number }>();
    if (saved && typeof saved.balance === 'number' && Number.isFinite(saved.balance)) ctx.state.balance = saved.balance;
    const set = (b: number) => {
      ctx.state.balance = b;
      ctx.store.set({ balance: b });
      ctx.emit('changed', b);
    };
    return {
      async balance(): Promise<number> {
        return ctx.state.balance;
      },
      async add(amount: number, reason?: string): Promise<number> {
        void reason;
        if (!(amount > 0)) throw new Error(`wallet.add: amount must be > 0 (got ${amount})`);
        set(ctx.state.balance + amount);
        return ctx.state.balance;
      },
      async spend(amount: number, reason?: string): Promise<SpendResult> {
        if (!(amount > 0)) throw new Error(`wallet.spend: amount must be > 0 (got ${amount})`);
        if (ctx.mode['no-funds'] || ctx.state.balance < amount) return { ok: false, balance: ctx.state.balance };
        set(ctx.state.balance - amount);
        ctx.emit('spent', { amount, reason });
        return { ok: true, balance: ctx.state.balance };
      },
    };
  },
})<{ balance(): Promise<number>; add(amount: number, reason?: string): Promise<number>; spend(amount: number, reason?: string): Promise<SpendResult> }>();

export interface Product {
  id: string;
  title: string;
  /** Display price ("$0.99", "50 coins"). */
  price: string;
  /** Bought once and kept (restore() returns it); else consumable. */
  permanent?: boolean;
}

export interface PurchaseResult {
  ok: boolean;
  id: string;
  /** Why not: 'cancelled' | 'unknown-product' | 'owned'. */
  reason?: string;
}

export const Iap = contract('iap', {
  state: { products: [] as Product[] },
  events: { purchased: once<{ id: string }>() },
  // cancel: the player cancels every purchase.
  modes: ['cancel'],
  mock: (ctx) => {
    const owned = new Set(ctx.store.get<string[]>() ?? []);
    return {
      async products(): Promise<Product[]> {
        return ctx.state.products.map((p) => ({ ...p }));
      },
      async purchase(id: string): Promise<PurchaseResult> {
        const p = ctx.state.products.find((x) => x.id === id);
        // The mock sells anything when the catalogue is empty (a game that never set it).
        if (!p && ctx.state.products.length) return { ok: false, id, reason: 'unknown-product' };
        if (ctx.mode.cancel) return { ok: false, id, reason: 'cancelled' };
        if (p?.permanent) {
          if (owned.has(id)) return { ok: false, id, reason: 'owned' };
          owned.add(id);
          ctx.store.set([...owned]);
        }
        ctx.emit('purchased', { id });
        return { ok: true, id };
      },
      async restore(): Promise<string[]> {
        return [...owned];
      },
    };
  },
})<{ products(): Promise<Product[]>; purchase(id: string): Promise<PurchaseResult>; restore(): Promise<string[]> }>();

export interface LeaderEntry {
  rank: number;
  name: string;
  score: number;
  /** The player's own entry. */
  me?: boolean;
}

export const Leaderboard = contract('leaderboard', {
  mock: (ctx) => {
    const boards: Record<string, number[]> = ctx.store.get<Record<string, number[]>>() ?? {};
    const sorted = (b: string) => [...(boards[b] ?? [])].sort((x, y) => y - x);
    return {
      async submit(score: number, board = 'default'): Promise<void> {
        (boards[board] ??= []).push(score);
        boards[board] = sorted(board).slice(0, 100);
        ctx.store.set(boards);
      },
      /** The local board: the player's own best runs. */
      async top(n = 10, board = 'default'): Promise<LeaderEntry[]> {
        return sorted(board)
          .slice(0, n)
          .map((score, i) => ({ rank: i + 1, name: 'you', score, me: true }));
      },
      async me(board = 'default'): Promise<LeaderEntry | null> {
        const best = sorted(board)[0];
        return best === undefined ? null : { rank: 1, name: 'you', score: best, me: true };
      },
    };
  },
})<{ submit(score: number, board?: string): Promise<void>; top(n?: number, board?: string): Promise<LeaderEntry[]>; me(board?: string): Promise<LeaderEntry | null> }>();

/** Every contract the kit registers in a game. */
export const KIT_CONTRACTS = [Lifecycle, SaveService, AudioService, Language, AdsService, Wallet, Iap, Leaderboard] as const;
