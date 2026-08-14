/**
 * T43 デッキ① こくばバドレックスVMAX。
 *
 * ★指示書 §6: **デッキ単位で完成させる**。4デッキを並行して進めない。
 *   ここではこの1デッキが「ほぼ全自動で回る」ことだけを確かめる。
 *
 * このデッキが試すもの:
 *   1. 特性「めいかいのとびら」… 手札→ベンチのエネ加速 + 2ドロー。
 *      ★使用回数は CardInstance 単位（T34）なので、VMAXが2匹なら2回使える
 *   2. ワザ「シャドーミスト」  … ★T42 の lockCardKind をワザからかける（スタジアム）
 *   3. マナフィ「なみのヴェール」… ★T42 の attackDamageImmunity を **ベンチ全員** に効かせる
 */
import { describe, expect, it } from 'vitest';
import {
  buildCardIndex,
  canUseAbilityThisTurn,
  canUseCardKind,
  damageInputFromState,
  playLockFor,
  validateDeck,
  type CardText,
  type DeckEntry,
  type RuleContext,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';
import { loadDeck } from './deckStore';

const pool = loadCardTexts();
const index = buildCardIndex(pool);
const CTX: RuleContext = { cards: index };

const DECK_FILE = 'tier1-kokuba-badrex-vmax.json';
const deck = loadDeck(DECK_FILE);

const CALYREX_V = 't43-shadow-rider-calyrex-v';
const CALYREX_VMAX = 't43-shadow-rider-calyrex-vmax';
const MANAPHY = 't43-manaphy';
const PSYCHIC = 'smpl-energy-psychic';

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

/** 両者ともこのデッキで座る。★Tier1同士の対戦が成立するかを見たいので同じデッキで回す */
function setup(): Table {
  const room = new Room({ code: 'T43KOK', rngSeed: 'kokuba43', cardPool: pool });
  const alice = room.join('Alice', undefined, deck).playerId;
  const bob = room.join('Bob', undefined, deck).playerId;
  // ★ボブ先攻。「次の相手の番の終わりまで」を正しい向きで試すため
  room.submitAction(alice, { type: 'setFirstPlayer', playerId: bob });
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

const toHand = (table: Table, player: string, instanceId: string): void => {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'hand' });
};

const toDiscard = (table: Table, player: string, instanceId: string): void => {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'discard' });
};

/** 選択が出ていれば、先頭から必要数を選んで進める */
function finish(table: Table, chooserId: string): void {
  for (let i = 0; i < 10 && table.room.rawState.execution; i += 1) {
    const choice = table.room.rawState.execution.pendingChoice;
    if (!choice) {
      table.room.submitAction(chooserId, {
        type: 'effectStep',
        executionId: table.room.rawState.execution.executionId,
      });
      continue;
    }
    const chooser = choice.chooser === table.bob ? table.bob : table.alice;
    table.room.submitIntent(chooser, {
      type: 'resolveChoice',
      requestId: choice.requestId,
      selected: choice.candidates.slice(0, choice.max),
    });
  }
}

const energyOn = (table: Table, player: string, slotId: string): number =>
  table.room.rawState.players[player]?.pokemon.find((p) => p.slotId === slotId)?.attachedEnergy
    .length ?? 0;

// ── デッキそのもの ────────────────────

describe('デッキリスト', () => {
  it('60枚ちょうどで、エクストラのデッキ制限に引っかからない', () => {
    const entries: DeckEntry[] = deck.cards.map((entry) => ({
      card: card(entry.functionalId),
      count: entry.count,
    }));
    expect(entries.reduce((sum, e) => sum + e.count, 0)).toBe(60);
    expect(validateDeck(entries)).toEqual([]);
  });

  it('たねポケモンが入っている（置けないデッキではない）', () => {
    const basics = deck.cards.filter((entry) => card(entry.functionalId).stage === 'basic');
    expect(basics.length).toBeGreaterThan(0);
  });

  it('デッキの中身がすべてカードデータに存在する', () => {
    for (const entry of deck.cards) expect(card(entry.functionalId), entry.functionalId).toBeTruthy();
  });
});

// ── ① めいかいのとびら（エネ加速） ────────

describe('特性「めいかいのとびら」', () => {
  it('トラッシュの基本超エネルギーをベンチにつける', () => {
    const table = setup();
    put(table, table.alice, table.mine(CALYREX_V), 'active');
    const vmaxTarget = table.mine(CALYREX_V, 1);
    put(table, table.alice, vmaxTarget, 'bench-0');
    // ベンチのVを VMAX に進化させる
    const vmax = table.mine(CALYREX_VMAX);
    table.room.submitAction(table.alice, {
      type: 'evolvePokemon',
      playerId: table.alice,
      slotId: 'bench-0',
      cardId: vmax,
    });
    toHand(table, table.alice, table.mine(PSYCHIC));

    expect(energyOn(table, table.alice, 'bench-0')).toBe(0);
    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vmax,
      abilityIndex: 0,
    });
    finish(table, table.alice);

    expect(energyOn(table, table.alice, 'bench-0')).toBe(1);
    expect(table.room.rawState.cards[table.mine(PSYCHIC)]?.zone).toBe('bench');
  });

  it('手札にエネルギーがなければ何も起きない（止まらない）', () => {
    const table = setup();
    put(table, table.alice, table.mine(CALYREX_V), 'active');
    put(table, table.alice, table.mine(CALYREX_V, 1), 'bench-0');
    const vmax = table.mine(CALYREX_VMAX);
    table.room.submitAction(table.alice, {
      type: 'evolvePokemon',
      playerId: table.alice,
      slotId: 'bench-0',
      cardId: vmax,
    });

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vmax,
      abilityIndex: 0,
    });
    finish(table, table.alice);
    expect(energyOn(table, table.alice, 'bench-0')).toBe(0);
    expect(table.room.rawState.execution).toBeNull();
  });

  it('★VMAXが2匹なら、この番に2回使える（使用回数は実体ごと）', () => {
    const table = setup();
    put(table, table.alice, table.mine(CALYREX_V), 'active');
    put(table, table.alice, table.mine(CALYREX_V, 1), 'bench-0');
    put(table, table.alice, table.mine(CALYREX_V, 2), 'bench-1');
    const first = table.mine(CALYREX_VMAX);
    const second = table.mine(CALYREX_VMAX, 1);
    for (const [slotId, cardId] of [
      ['bench-0', first],
      ['bench-1', second],
    ] as const) {
      table.room.submitAction(table.alice, {
        type: 'evolvePokemon',
        playerId: table.alice,
        slotId,
        cardId,
      });
    }
    toHand(table, table.alice, table.mine(PSYCHIC));
    toHand(table, table.alice, table.mine(PSYCHIC, 1));

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: first,
      abilityIndex: 0,
    });
    finish(table, table.alice);
    // 1匹目はもう使えないが、2匹目はまだ使える
    expect(canUseAbilityThisTurn(table.room.rawState, first, 0)).toBe(false);
    expect(canUseAbilityThisTurn(table.room.rawState, second, 0)).toBe(true);

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: second,
      abilityIndex: 0,
    });
    finish(table, table.alice);
    const total =
      energyOn(table, table.alice, 'bench-0') + energyOn(table, table.alice, 'bench-1');
    expect(total).toBe(2);
  });
});

// ── ② シャドーミスト（ワザからのグッズロック） ──

describe('ワザ「シャドーミスト」', () => {
  const shadowMist = (table: Table) => {
    const active = table.theirs(CALYREX_V);
    put(table, table.bob, active, 'active');
    table.room.submitIntent(table.bob, {
      type: 'useCardEffect',
      instanceId: active,
      attackIndex: 0,
    });
    finish(table, table.bob);
  };

  it('相手はスタジアムを出せなくなる', () => {
    const table = setup();
    expect(canUseCardKind(table.room.rawState, table.alice, 'stadium', CTX)).toBe(true);
    shadowMist(table);
    expect(canUseCardKind(table.room.rawState, table.alice, 'stadium', CTX)).toBe(false);
    // ★使った側は止まらない
    expect(canUseCardKind(table.room.rawState, table.bob, 'stadium', CTX)).toBe(true);
    // グッズ・サポートは止まらない（特殊エネルギーの制限は手処理）
    expect(canUseCardKind(table.room.rawState, table.alice, 'item', CTX)).toBe(true);
    expect(canUseCardKind(table.room.rawState, table.alice, 'supporter', CTX)).toBe(true);
  });

  it('★次の相手の番が終われば解ける', () => {
    const table = setup();
    shadowMist(table);
    expect(canUseCardKind(table.room.rawState, table.alice, 'stadium', CTX)).toBe(false);

    // ボブの番を終えただけでは解けない（アリスがまだ1回も番をもらっていない）
    table.room.submitIntent(table.bob, { type: 'endTurn' });
    expect(table.room.rawState.activePlayer).toBe(table.alice);
    expect(canUseCardKind(table.room.rawState, table.alice, 'stadium', CTX)).toBe(false);
    // ★アリスの番が終われば解ける
    table.room.submitIntent(table.alice, { type: 'endTurn' });
    expect(canUseCardKind(table.room.rawState, table.alice, 'stadium', CTX)).toBe(true);
  });

  it('★止まっていてもスタジアムは出せる（警告だけ）', () => {
    const table = setup();
    shadowMist(table);
    const stadium = table.mine('t33-path-to-the-peak');
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: stadium, toZone: 'hand' });
    table.room.submitAction(table.alice, { type: 'setStadium', cardId: stadium });
    expect(table.room.rawState.stadium).toBe(stadium);
    const codes = table.room.rawState.log.flatMap((e) => e.warnings.map((w) => w.code));
    expect(codes).toContain('CARD_KIND_LOCKED');
  });
});

// ── ③ マナフィ（ベンチを守る） ──────────

describe('マナフィ「なみのヴェール」', () => {
  const astralBarrageAt = (table: Table, slotId: string) =>
    damageInputFromState(
      table.room.rawState,
      CTX,
      { playerId: table.bob, slotId: 'active' },
      { playerId: table.alice, slotId: slotId as never },
      {
        baseDamage: 100,
        attackerTypes: ['psychic'],
        defender: {},
        targetIsBench: slotId !== 'active',
      },
    );

  it('★ベンチ全員が守られる（マナフィ自身だけではない）', () => {
    const table = setup();
    put(table, table.alice, table.mine(CALYREX_V), 'active');
    put(table, table.alice, table.mine(CALYREX_V, 1), 'bench-0');
    put(table, table.bob, table.theirs(CALYREX_V), 'active');
    // マナフィを置く前は通る
    expect(astralBarrageAt(table, 'bench-0').targetPreventsDamage).toBe(false);

    put(table, table.alice, table.mine(MANAPHY), 'bench-1');
    expect(astralBarrageAt(table, 'bench-0').targetPreventsDamage).toBe(true);
    expect(astralBarrageAt(table, 'bench-1').targetPreventsDamage).toBe(true);
  });

  it('バトル場は守らない', () => {
    const table = setup();
    put(table, table.alice, table.mine(CALYREX_V), 'active');
    put(table, table.alice, table.mine(MANAPHY), 'bench-0');
    put(table, table.bob, table.theirs(CALYREX_V), 'active');
    expect(astralBarrageAt(table, 'active').targetPreventsDamage).toBe(false);
  });

  it('★場を離れれば守りも消える', () => {
    const table = setup();
    put(table, table.alice, table.mine(CALYREX_V), 'active');
    put(table, table.alice, table.mine(CALYREX_V, 1), 'bench-0');
    put(table, table.alice, table.mine(MANAPHY), 'bench-1');
    put(table, table.bob, table.theirs(CALYREX_V), 'active');
    expect(astralBarrageAt(table, 'bench-0').targetPreventsDamage).toBe(true);

    toDiscard(table, table.alice, table.mine(MANAPHY));
    expect(astralBarrageAt(table, 'bench-0').targetPreventsDamage).toBe(false);
  });
});

// ── カード定義そのもの ─────────────────

describe('カード定義', () => {
  it('こくばバドレックスVMAX は VMAX（サイド3枚・進化ポケモン）', () => {
    const vmax = card(CALYREX_VMAX);
    expect(vmax.ruleBox).toBe('VMAX');
    expect(vmax.stage).toBe('vmax');
    expect(vmax.evolvesFrom).toBe('こくばバドレックスV');
    expect(vmax.hp).toBe(320);
  });

  it('★ワザのダメージは自動化していない（人が6段で確定させる）', () => {
    const daigeist = card(CALYREX_VMAX).attacks?.[0];
    expect(daigeist?.name).toBe('ダイガイスト');
    expect(daigeist?.damage).toBe('10+');
    // 付随する効果を持たない＝ダメージだけのワザ
    expect(daigeist?.effects).toBeUndefined();
  });

  it('★シャドーミストは1本の宣言で「特殊エネルギー」と「スタジアム」を止める', () => {
    const mist = card(CALYREX_V).attacks?.[0];
    expect(mist?.name).toBe('シャドーミスト');
    expect(mist?.damage).toBe('10');
    expect(mist?.effects).toHaveLength(1);
  });

  it('★特殊エネルギーも出せなくなる（種別では指せないので条件で指す）', () => {
    const table = setup();
    const special = card('t33-double-turbo');
    expect(playLockFor(table.room.rawState, table.alice, special, CTX).locked).toBe(false);

    const active = table.theirs(CALYREX_V);
    put(table, table.bob, active, 'active');
    table.room.submitIntent(table.bob, {
      type: 'useCardEffect',
      instanceId: active,
      attackIndex: 0,
    });
    for (let i = 0; i < 5 && table.room.rawState.execution; i += 1) {
      table.room.submitAction(table.bob, {
        type: 'effectStep',
        executionId: table.room.rawState.execution.executionId,
      });
    }

    expect(playLockFor(table.room.rawState, table.alice, special, CTX).locked).toBe(true);
    // ★基本エネルギーは止まらない
    const basic = card('smpl-energy-psychic');
    expect(playLockFor(table.room.rawState, table.alice, basic, CTX).locked).toBe(false);
  });
});
