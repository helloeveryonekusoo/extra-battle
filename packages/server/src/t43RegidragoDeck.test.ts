/**
 * T43 デッキ③ レジドラゴVSTAR。
 *
 * ★指示書が名指ししている条件: **`useAttackAs` で解決する。個別実装しない。**
 *   アポカリプスドラゴンのためのコードは1行も書かず、
 *   §5.1-3 の「他カードのワザを参照する」1つの仕組みだけで通す。
 *
 * その仕組みは4種類を同じ形で解く:
 *   from: 'opponentActive' … ゾロアークGX（イカサマ）
 *   from: 'ownTrash'       … レジドラゴVSTAR（りゅうむそう）
 *   from: 'anyInPlay'      … メタモン（どこでもコピー）
 */
import { describe, expect, it } from 'vitest';
import {
  hasUsedOncePerGame,
  validateDeck,
  type CardText,
  type DeckEntry,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';
import { loadDeck } from './deckStore';

const pool = loadCardTexts();
const deck = loadDeck('tier1-regidrago-vstar.json');

const REGIDRAGO_V = 't43-regidrago-v';
const REGIDRAGO_VSTAR = 't43-regidrago-vstar';
const DRAGONITE_V = 't43-dragonite-v';
const CROBAT_V = 't34-crobat-v';

const card = (functionalId: string): CardText => {
  const found = pool.find((entry) => entry.functionalId === functionalId);
  if (!found) throw new Error(`${functionalId} is missing`);
  return found;
};

interface Table {
  room: Room;
  alice: string;
  bob: string;
  mine: (functionalId: string, nth?: number) => string;
  theirs: (functionalId: string, nth?: number) => string;
}

function setup(): Table {
  const room = new Room({ code: 'T43RGD', rngSeed: 'regidrago43', cardPool: pool });
  const alice = room.join('Alice', undefined, deck).playerId;
  const bob = room.join('Bob', undefined, deck).playerId;
  room.submitAction(alice, { type: 'setFirstPlayer', playerId: alice });
  room.submitAction(alice, { type: 'setPhase', phase: 'turn' });

  const pick = (ownerId: string) => (functionalId: string, nth = 0) => {
    const found = Object.values(room.rawState.cards).filter(
      (instance) => instance.ownerId === ownerId && instance.functionalId === functionalId,
    )[nth];
    if (!found) throw new Error(`${functionalId} (#${nth}) が ${ownerId} にありません`);
    return found.instanceId;
  };
  return { room, alice, bob, mine: pick(alice), theirs: pick(bob) };
}

const put = (table: Table, player: string, instanceId: string, slotId: string): void => {
  table.room.submitAction(player, {
    type: 'placePokemon',
    playerId: player,
    slotId: slotId as never,
    cardId: instanceId,
  });
};

const toDiscard = (table: Table, player: string, instanceId: string): void => {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'discard' });
};

const grantedOn = (table: Table, player: string, slotId: string) =>
  table.room.rawState.players[player]?.pokemon.find((p) => p.slotId === slotId)?.grantedAttacks ??
  [];

const choice = (table: Table) => table.room.rawState.execution?.pendingChoice ?? null;

/** アリスのバトル場に レジドラゴVSTAR を用意する */
function readyVstar(table: Table): string {
  put(table, table.alice, table.mine(REGIDRAGO_V), 'active');
  const vstar = table.mine(REGIDRAGO_VSTAR);
  table.room.submitAction(table.alice, {
    type: 'evolvePokemon',
    playerId: table.alice,
    slotId: 'active',
    cardId: vstar,
  });
  return vstar;
}

const dragonWithout = (table: Table, vstar: string): void => {
  table.room.submitIntent(table.alice, {
    type: 'useCardEffect',
    instanceId: vstar,
    attackIndex: 0,
  });
};

// ── デッキそのもの ────────────────────

describe('デッキリスト', () => {
  it('60枚ちょうどで、デッキ制限に引っかからない', () => {
    const entries: DeckEntry[] = deck.cards.map((entry) => ({
      card: card(entry.functionalId),
      count: entry.count,
    }));
    expect(entries.reduce((sum, e) => sum + e.count, 0)).toBe(60);
    expect(validateDeck(entries)).toEqual([]);
  });

  it('コピー元になるドラゴンポケモンと、それを落とす手段が入っている', () => {
    const dragons = deck.cards.filter((entry) => (card(entry.functionalId).types ?? []).includes('dragon'));
    expect(dragons.length).toBeGreaterThanOrEqual(2);
    // バトルコンプレッサー（山札からトラッシュへ送る）
    expect(deck.cards.some((entry) => entry.functionalId === 't32-battle-compressor')).toBe(true);
  });
});

// ── ★useAttackAs で解決する ─────────────

describe('りゅうむそう（★useAttackAs だけで解決）', () => {
  it('トラッシュのドラゴンポケモンが候補に出る', () => {
    const table = setup();
    const vstar = readyVstar(table);
    toDiscard(table, table.alice, table.mine(DRAGONITE_V));

    dragonWithout(table, vstar);
    const pending = choice(table);
    expect(pending?.kind).toBe('selectCards');
    expect(pending?.candidates).toContain(table.mine(DRAGONITE_V));
  });

  it('★ドラゴン以外はコピーできない（条件はカードが宣言している）', () => {
    const table = setup();
    const vstar = readyVstar(table);
    toDiscard(table, table.alice, table.mine(DRAGONITE_V));
    toDiscard(table, table.alice, table.mine(CROBAT_V));

    dragonWithout(table, vstar);
    const pending = choice(table);
    expect(pending?.candidates).toContain(table.mine(DRAGONITE_V));
    expect(pending?.candidates).not.toContain(table.mine(CROBAT_V));
  });

  it('相手のトラッシュのドラゴンは候補にならない（自分のトラッシュだけ）', () => {
    const table = setup();
    const vstar = readyVstar(table);
    toDiscard(table, table.alice, table.mine(DRAGONITE_V));
    toDiscard(table, table.bob, table.theirs(DRAGONITE_V));

    dragonWithout(table, vstar);
    expect(choice(table)?.candidates).not.toContain(table.theirs(DRAGONITE_V));
  });

  it('★選ぶと、そのカードのワザを使えるようになる', () => {
    const table = setup();
    const vstar = readyVstar(table);
    const dragonite = table.mine(DRAGONITE_V);
    toDiscard(table, table.alice, dragonite);

    dragonWithout(table, vstar);
    const pending = choice(table);
    table.room.submitIntent(table.alice, {
      type: 'resolveChoice',
      requestId: pending?.requestId ?? '',
      selected: [dragonite],
    });

    const granted = grantedOn(table, table.alice, 'active');
    expect(granted).toHaveLength(card(DRAGONITE_V).attacks?.length ?? 0);
    expect(granted[0]?.functionalId).toBe(DRAGONITE_V);
    expect(granted[0]?.sourceInstanceId).toBe(dragonite);
    // ★コピー元はトラッシュから動かない
    expect(table.room.rawState.cards[dragonite]?.zone).toBe('discard');
  });

  it('★りゅうむそうは通常ワザ。VSTARパワーの枠は使わない', () => {
    const table = setup();
    readyVstar(table);
    toDiscard(table, table.alice, table.mine(DRAGONITE_V));

    table.room.submitAction(table.alice, {
      type: 'useAttack',
      playerId: table.alice,
      slotId: 'active',
      attackIndex: 0,
      attackName: 'りゅうむそう',
    });
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'vstar')).toBe(false);
  });

  it('★VSTARパワーは別枠の「レガシースター」（対戦中1回・プレイヤー単位）', () => {
    const table = setup();
    const vstar = readyVstar(table);
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'vstar')).toBe(false);

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vstar,
      abilityIndex: 0,
    });
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'vstar')).toBe(true);
  });

  it('トラッシュにドラゴンがいなければ、何も聞かずに終わる（止まらない）', () => {
    const table = setup();
    const vstar = readyVstar(table);
    dragonWithout(table, vstar);
    expect(table.room.rawState.execution).toBeNull();
    expect(grantedOn(table, table.alice, 'active')).toEqual([]);
  });

  it('★コピーした参照は番をまたいで残らない', () => {
    const table = setup();
    const vstar = readyVstar(table);
    const dragonite = table.mine(DRAGONITE_V);
    toDiscard(table, table.alice, dragonite);
    dragonWithout(table, vstar);
    table.room.submitIntent(table.alice, {
      type: 'resolveChoice',
      requestId: choice(table)?.requestId ?? '',
      selected: [dragonite],
    });
    expect(grantedOn(table, table.alice, 'active').length).toBeGreaterThan(0);

    table.room.submitIntent(table.alice, { type: 'endTurn' });
    expect(grantedOn(table, table.alice, 'active')).toEqual([]);
  });
});

// ── 同じ仕組みで別のカードも解ける ─────────

describe('★同じ仕組みが他のコピー系にも通る（個別実装をしない証明）', () => {
  it("from: 'opponentActive' なら相手のバトルポケモンを見る（イカサマ）", () => {
    const table = setup();
    const vstar = readyVstar(table);
    put(table, table.bob, table.theirs(DRAGONITE_V), 'active');

    // カードデータを変えずに、同じオペコードを向きだけ変えて動かす
    table.room.submitAction(table.alice, {
      type: 'startEffect',
      executionId: 'x-foul-play',
      ops: [{ op: 'useAttackAs', from: 'opponentActive', requireEnergy: false }],
      source: { instanceId: vstar, playerId: table.alice, label: 'イカサマ相当' },
    });
    expect(choice(table)?.candidates).toEqual([table.theirs(DRAGONITE_V)]);
  });

  it("from: 'anyInPlay' なら場のポケモン全員が候補（メタモン）", () => {
    const table = setup();
    const vstar = readyVstar(table);
    put(table, table.bob, table.theirs(DRAGONITE_V), 'active');
    put(table, table.alice, table.mine(REGIDRAGO_V, 1), 'bench-0');

    table.room.submitAction(table.alice, {
      type: 'startEffect',
      executionId: 'x-transform',
      ops: [{ op: 'useAttackAs', from: 'anyInPlay', requireEnergy: false }],
      source: { instanceId: vstar, playerId: table.alice, label: 'へんしん相当' },
    });
    const candidates = choice(table)?.candidates ?? [];
    expect(candidates).toContain(table.theirs(DRAGONITE_V));
    expect(candidates).toContain(table.mine(REGIDRAGO_V, 1));
    expect(candidates).toContain(vstar);
  });
});

// ── カード定義そのもの ─────────────────

describe('カード定義', () => {
  it('★りゅうむそうのためのコードを書いていない（宣言だけ）', () => {
    const attack = card(REGIDRAGO_VSTAR).attacks?.[0];
    expect(attack?.name).toBe('りゅうむそう');
    // ★通常ワザなので oncePerGame は付かない
    expect(attack?.oncePerGame).toBeUndefined();
    expect(attack?.effects).toEqual([
      {
        op: 'useAttackAs',
        from: 'ownTrash',
        filter: { supertype: ['pokemon'], types: ['dragon'] },
        requireEnergy: false,
      },
    ]);
  });
});
