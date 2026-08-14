/**
 * T43 デッキ② オリジンパルキアVSTAR。
 *
 * ★指示書 §6: デッキ単位で完成させる。①こくばを終えてからこれに着手している。
 *
 * このデッキが試すもの:
 *   1. VSTARパワー「スターポータル」… ★T36 の「対戦中1回・プレイヤー単位」の実地確認。
 *      別のパルキアに交代しても戻らない
 *   2. 特性「うらこうさく」        … ★「進化したとき」トリガ（T43 で追加）。
 *      ふしぎなアメで飛び級しても、出てきたポケモンの分だけはたらく
 *   3. 特性「クイックシューター」  … ダメカンをのせる。★ダメージではないので
 *      弱点・抵抗力・軽減を一切通さない（T28 の決めごと）
 */
import { describe, expect, it } from 'vitest';
import {
  canUseAbilityThisTurn,
  hasUsedOncePerGame,
  validateDeck,
  type CardText,
  type DeckEntry,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';
import { loadDeck } from './deckStore';

const pool = loadCardTexts();

const deck = loadDeck('tier1-origin-palkia-vstar.json');

const PALKIA_V = 't43-origin-palkia-v';
const PALKIA_VSTAR = 't43-origin-palkia-vstar';
const SOBBLE = 't43-sobble';
const DRIZZILE = 't43-drizzile';
const INTELEON = 't43-inteleon-quick-shooter';
const WATER = 'smpl-energy-water';

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
  const room = new Room({ code: 'T43PAL', rngSeed: 'palkia43', cardPool: pool });
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

const evolve = (table: Table, player: string, slotId: string, cardId: string): void => {
  table.room.submitAction(player, {
    type: 'evolvePokemon',
    playerId: player,
    slotId: slotId as never,
    cardId,
  });
};

const toDiscard = (table: Table, player: string, instanceId: string): void => {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'discard' });
};

function finish(table: Table): void {
  for (let i = 0; i < 12 && table.room.rawState.execution; i += 1) {
    const choice = table.room.rawState.execution.pendingChoice;
    if (!choice) {
      table.room.submitAction(table.alice, {
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

const handCount = (table: Table, player: string): number =>
  Object.values(table.room.rawState.cards).filter(
    (c) => c.ownerId === player && c.zone === 'hand',
  ).length;

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

  it('メッソン→ジメレオン→インテレオンの進化ラインがつながっている', () => {
    expect(card(DRIZZILE).evolvesFrom).toBe(card(SOBBLE).name);
    expect(card(INTELEON).evolvesFrom).toBe(card(DRIZZILE).name);
    // ★レベルボールで持ってこられるHP（90以下）
    expect(card(SOBBLE).hp).toBeLessThanOrEqual(90);
    expect(card(DRIZZILE).hp).toBeLessThanOrEqual(90);
  });
});

// ── ① スターポータル（VSTARパワー） ──────

describe('VSTARパワー「スターポータル」', () => {
  const ready = (table: Table): string => {
    put(table, table.alice, table.mine(PALKIA_V), 'active');
    const vstar = table.mine(PALKIA_VSTAR);
    evolve(table, table.alice, 'active', vstar);
    toDiscard(table, table.alice, table.mine(WATER));
    toDiscard(table, table.alice, table.mine(WATER, 1));
    toDiscard(table, table.alice, table.mine(WATER, 2));
    return vstar;
  };

  it('トラッシュの水エネルギーを3枚まで、自分の水ポケモンにつける', () => {
    const table = setup();
    const vstar = ready(table);
    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vstar,
      abilityIndex: 0,
    });
    finish(table);
    expect(energyOn(table, table.alice, 'active')).toBe(3);
  });

  it('★対戦中1回。使うと枠が埋まる（プレイヤー単位）', () => {
    const table = setup();
    const vstar = ready(table);
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'vstar')).toBe(false);

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vstar,
      abilityIndex: 0,
    });
    finish(table);
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'vstar')).toBe(true);
    // ★相手の枠は減らない
    expect(hasUsedOncePerGame(table.room.rawState, table.bob, 'vstar')).toBe(false);
  });

  it('★別のパルキアVSTARに替えても戻らない（ポケモン単位ではない）', () => {
    const table = setup();
    const vstar = ready(table);
    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vstar,
      abilityIndex: 0,
    });
    finish(table);

    put(table, table.alice, table.mine(PALKIA_V, 1), 'bench-0');
    const second = table.mine(PALKIA_VSTAR, 1);
    evolve(table, table.alice, 'bench-0', second);
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'vstar')).toBe(true);

    // ★2匹目でも使えてしまうが、警告が出る（止めはしない。第2段階 §2）
    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: second,
      abilityIndex: 0,
    });
    const codes = table.room.rawState.log.flatMap((e) => e.warnings.map((w) => w.code));
    expect(codes).toContain('ONCE_PER_GAME_USED');
  });
});

// ── ② うらこうさく（進化したとき） ────────

describe('特性「うらこうさく」', () => {
  it('★進化させた瞬間に、山札からトレーナーズを手札に加える', () => {
    const table = setup();
    put(table, table.alice, table.mine(PALKIA_V), 'active');
    put(table, table.alice, table.mine(SOBBLE), 'bench-0');
    const before = handCount(table, table.alice);

    evolve(table, table.alice, 'bench-0', table.mine(DRIZZILE));
    // ★操作を待たずに効果が始まっている
    expect(table.room.rawState.execution).not.toBeNull();
    finish(table);
    expect(handCount(table, table.alice)).toBe(before + 1);
  });

  it('★加えたのはトレーナーズだけ', () => {
    const table = setup();
    put(table, table.alice, table.mine(PALKIA_V), 'active');
    put(table, table.alice, table.mine(SOBBLE), 'bench-0');
    const handBefore = new Set(
      Object.values(table.room.rawState.cards)
        .filter((c) => c.ownerId === table.alice && c.zone === 'hand')
        .map((c) => c.instanceId),
    );

    evolve(table, table.alice, 'bench-0', table.mine(DRIZZILE));
    finish(table);

    const added = Object.values(table.room.rawState.cards).filter(
      (c) => c.ownerId === table.alice && c.zone === 'hand' && !handBefore.has(c.instanceId),
    );
    expect(added).toHaveLength(1);
    expect(card(added[0]?.functionalId ?? '').supertype).toBe('trainer');
  });

  it('進化ではない（手札から出しただけ）ならはたらかない', () => {
    const table = setup();
    put(table, table.alice, table.mine(PALKIA_V), 'active');
    const before = handCount(table, table.alice);
    put(table, table.alice, table.mine(SOBBLE), 'bench-0');
    expect(table.room.rawState.execution).toBeNull();
    // 場に出したぶん手札が1枚減っているだけ
    expect(handCount(table, table.alice)).toBeLessThanOrEqual(before);
  });

  it('★ふしぎなアメで飛び級しても、出てきたポケモンの特性だけがはたらく', () => {
    const table = setup();
    put(table, table.alice, table.mine(PALKIA_V), 'active');
    put(table, table.alice, table.mine(SOBBLE), 'bench-0');
    // メッソンからインテレオンへ直接（ふしぎなアメ相当の操作）
    evolve(table, table.alice, 'bench-0', table.mine(INTELEON));
    // インテレオンのクイックシューターは「進化したとき」ではないので自動では動かない
    expect(table.room.rawState.execution).toBeNull();
  });
});

// ── ③ クイックシューター ──────────────

describe('特性「クイックシューター」', () => {
  const ready = (table: Table): string => {
    put(table, table.alice, table.mine(PALKIA_V), 'active');
    put(table, table.alice, table.mine(SOBBLE), 'bench-0');
    put(table, table.bob, table.theirs(PALKIA_V), 'active');
    const inteleon = table.mine(INTELEON);
    evolve(table, table.alice, 'bench-0', inteleon);
    finish(table);
    return inteleon;
  };

  const damageOn = (table: Table, player: string, slotId: string): number =>
    table.room.rawState.players[player]?.pokemon.find((p) => p.slotId === slotId)
      ?.damageCounters ?? 0;

  it('相手のポケモンにダメカンを2個のせる', () => {
    const table = setup();
    const inteleon = ready(table);
    expect(damageOn(table, table.bob, 'active')).toBe(0);

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: inteleon,
      abilityIndex: 0,
    });
    finish(table);
    expect(damageOn(table, table.bob, 'active')).toBe(2);
  });

  it('★この番はもう使えない（実体ごとに1回）', () => {
    const table = setup();
    const inteleon = ready(table);
    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: inteleon,
      abilityIndex: 0,
    });
    finish(table);
    expect(canUseAbilityThisTurn(table.room.rawState, inteleon, 0)).toBe(false);

    // ★番が変われば戻る（カウンタを戻す処理はどこにも書いていない）
    table.room.submitIntent(table.alice, { type: 'endTurn' });
    expect(canUseAbilityThisTurn(table.room.rawState, inteleon, 0)).toBe(true);
  });
});

// ── カード定義そのもの ─────────────────

describe('カード定義', () => {
  it('オリジンパルキアVSTAR は VSTAR（サイド2枚）で、VSTARパワーを持つ', () => {
    const vstar = card(PALKIA_VSTAR);
    expect(vstar.ruleBox).toBe('VSTAR');
    expect(vstar.stage).toBe('vstar');
    expect(vstar.abilities?.[0]?.oncePerGame).toBe('vstar');
  });

  it('★ワザのダメージは自動化していない（あくうのうねりは人が数える）', () => {
    const attack = card(PALKIA_VSTAR).attacks?.[0];
    expect(attack?.name).toBe('あくうのうねり');
    expect(attack?.damage).toBe('60+');
    expect(attack?.effects).toBeUndefined();
  });

  it('うらこうさくは「進化したとき」トリガ', () => {
    expect(card(DRIZZILE).abilities?.[0]?.trigger).toBe('onEvolve');
  });
});
