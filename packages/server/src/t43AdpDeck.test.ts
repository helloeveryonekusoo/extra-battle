/**
 * T43 デッキ④ 三神ADP（アルセウス&ディアルガ&パルキアGX）。
 *
 * ★指示書が「第3段階のエフェクトシステムの試金石」と名指ししたデッキ。
 *   オルタージェネシスGX は `duration: {type:'wholeGame'}` の効果として与え、
 *   - ワザのダメージ +30（Step2）
 *   - とるサイドが1枚増える（getPrizeCount）
 *   の両方に、**対戦の最後まで** 効き続けるかを見る。
 *
 * ここが通れば「一度かかったら残る効果」の設計（§3.2）が正しかったことになる。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCardIndex,
  damageInputFromState,
  effectSlotKey,
  getPrizeCount,
  hasUsedOncePerGame,
  prizeCountForSlot,
  runDamagePipeline,
  validateDeck,
  type CardText,
  type DeckEntry,
  type RuleContext,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';
import { loadDeck } from './deckStore';

const pool = loadCardTexts();
const CTX: RuleContext = { cards: buildCardIndex(pool) };
const deck = loadDeck('tier1-adp.json');

const ADP = 't43-arceus-dialga-palkia-gx';
const ZACIAN = 't43-zacian-v';
const METAL = 'smpl-energy-metal';

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
  const room = new Room({ code: 'T43ADP', rngSeed: 'adp43', cardPool: pool });
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

function finish(table: Table, chooser: string): void {
  for (let i = 0; i < 12 && table.room.rawState.execution; i += 1) {
    const pending = table.room.rawState.execution.pendingChoice;
    if (!pending) {
      table.room.submitAction(chooser, {
        type: 'effectStep',
        executionId: table.room.rawState.execution.executionId,
      });
      continue;
    }
    const who = pending.chooser === table.bob ? table.bob : table.alice;
    table.room.submitIntent(who, {
      type: 'resolveChoice',
      requestId: pending.requestId,
      selected: pending.candidates.slice(0, pending.max),
    });
  }
}

/** アリスのバトル場に三神、ボブのバトル場にザシアンVを置く */
function board(table: Table): void {
  put(table, table.alice, table.mine(ADP), 'active');
  put(table, table.bob, table.theirs(ZACIAN), 'active');
}

/** オルタージェネシスGX を使う（ワザの付随効果として実行する） */
function alterGenesis(table: Table): void {
  const adp = table.mine(ADP);
  table.room.submitAction(table.alice, {
    type: 'useAttack',
    playerId: table.alice,
    slotId: 'active',
    attackIndex: 1,
    attackName: 'オルタージェネシスGX',
  });
  table.room.submitIntent(table.alice, {
    type: 'useCardEffect',
    instanceId: adp,
    attackIndex: 1,
  });
  finish(table, table.alice);
}

const damageFor = (table: Table, base: number): number => {
  const input = damageInputFromState(
    table.room.rawState,
    CTX,
    { playerId: table.alice, slotId: 'active' },
    { playerId: table.bob, slotId: 'active' },
    { baseDamage: base, attackerTypes: ['dragon'], defender: {}, targetIsBench: false },
  );
  return runDamagePipeline(input).finalDamage;
};

const endTurn = (table: Table, player: string): void => {
  table.room.submitIntent(player, { type: 'endTurn' });
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

  it('三神はTAG TEAM（きぜつでサイド3枚）', () => {
    expect(card(ADP).ruleBox).toBe('TAGTEAM');
    expect(card(ADP).stage).toBe('basic');
  });
});

// ── ★オルタージェネシスGX（試金石） ────────

describe('★オルタージェネシスGX は対戦の最後まで残る', () => {
  it('ダメージが +30 される（Step2）', () => {
    const table = setup();
    board(table);
    expect(damageFor(table, 150)).toBe(150);

    alterGenesis(table);
    expect(damageFor(table, 150)).toBe(180);
  });

  it('★+30 が乗るのは「相手のバトルポケモンへのダメージ」だけ（実物照合ずみ）', () => {
    const table = setup();
    board(table);
    put(table, table.bob, table.theirs(ZACIAN, 1), 'bench-0');
    alterGenesis(table);

    const benchInput = damageInputFromState(
      table.room.rawState,
      CTX,
      { playerId: table.alice, slotId: 'active' },
      { playerId: table.bob, slotId: 'bench-0' },
      { baseDamage: 100, attackerTypes: ['dragon'], defender: {}, targetIsBench: true },
    );
    expect(benchInput.attackerModifier).toBe(0);
    expect(runDamagePipeline(benchInput).finalDamage).toBe(100);
    // バトル場には乗る
    expect(damageFor(table, 100)).toBe(130);
  });

  it('★とるサイドが1枚増える（TAG TEAM の3枚 → 4枚）', () => {
    const table = setup();
    board(table);
    const bobActive = effectSlotKey(table.bob, 'active');
    // ザシアンV はサイド2枚
    expect(getPrizeCount(table.room.rawState, bobActive, CTX)).toBe(2);

    alterGenesis(table);
    expect(getPrizeCount(table.room.rawState, bobActive, CTX)).toBe(3);
  });

  it('★相手がとるサイドは増えない（使った側だけ）', () => {
    const table = setup();
    board(table);
    alterGenesis(table);
    // アリスの三神がきぜつしたときにボブがとる枚数は3枚のまま
    expect(prizeCountForSlot(table.room.rawState, table.alice, 'active', CTX)).toBe(3);
  });

  it('★番をまたいでも消えない（wholeGame）', () => {
    const table = setup();
    board(table);
    alterGenesis(table);

    for (let i = 0; i < 4; i += 1) {
      endTurn(table, table.room.rawState.activePlayer);
    }
    expect(table.room.rawState.effects).toHaveLength(2);
    expect(damageFor(table, 150)).toBe(180);
    expect(getPrizeCount(table.room.rawState, effectSlotKey(table.bob, 'active'), CTX)).toBe(3);
  });

  it('★三神がきぜつしても効果は残る（プレイヤーにかかっている）', () => {
    const table = setup();
    board(table);
    put(table, table.alice, table.mine(ZACIAN), 'bench-0');
    alterGenesis(table);

    // きぜつはサイドの選定にサーバーが要るので Intent 経由
    table.room.submitIntent(table.bob, {
      type: 'knockOut',
      playerId: table.alice,
      slotId: 'active',
      expectedTopInstanceId: table.mine(ADP),
      prizePlayerId: table.bob,
      prizeCount: 3,
    });
    // 発生源が場を離れても、プレイヤーにかかった効果は残る
    expect(getPrizeCount(table.room.rawState, effectSlotKey(table.bob, 'active'), CTX)).toBe(3);
  });

  it('GXワザの枠を使う（対戦中1回・プレイヤー単位）', () => {
    const table = setup();
    board(table);
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'gx')).toBe(false);
    alterGenesis(table);
    expect(hasUsedOncePerGame(table.room.rawState, table.alice, 'gx')).toBe(true);
    expect(hasUsedOncePerGame(table.room.rawState, table.bob, 'gx')).toBe(false);
  });

  it('6段パネルに出どころが出る（数字だけにしない。§5.3）', () => {
    const table = setup();
    board(table);
    alterGenesis(table);
    const input = damageInputFromState(
      table.room.rawState,
      CTX,
      { playerId: table.alice, slotId: 'active' },
      { playerId: table.bob, slotId: 'active' },
      { baseDamage: 150, attackerTypes: ['dragon'], defender: {}, targetIsBench: false },
    );
    expect(input.attackerModifierSources?.join('')).toContain('オルタージェネシスGX');
  });
});

// ── アルティメットレイ（エネ加速） ────────

describe('ワザ「アルティメットレイ」', () => {
  it('山札から基本エネルギーを3枚まで自分のポケモンにつける', () => {
    const table = setup();
    board(table);
    put(table, table.alice, table.mine(ZACIAN), 'bench-0');

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: table.mine(ADP),
      attackIndex: 0,
    });
    finish(table, table.alice);

    const attached = (table.room.rawState.players[table.alice]?.pokemon ?? []).reduce(
      (sum, slot) => sum + slot.attachedEnergy.length,
      0,
    );
    expect(attached).toBe(3);
  });
});

// ── ザシアンV（つけたら撃てない） ──────────

describe('特性「ふとうのつるぎ」', () => {
  const useSword = (table: Table): string => {
    const zacian = table.mine(ZACIAN);
    put(table, table.alice, zacian, 'active');
    // ★山札の上3枚を決め打ちにする（見るのは上から3枚だけなので）
    for (let i = 2; i >= 0; i -= 1) {
      table.room.submitAction(table.alice, {
        type: 'moveCard',
        cardId: table.mine(METAL, i),
        toZone: 'deck',
        insertAt: 'top',
      });
    }
    put(table, table.bob, table.theirs(ADP), 'active');
    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: zacian,
      abilityIndex: 0,
    });
    finish(table, table.alice);
    return zacian;
  };

  it('★山札の上3枚から、エネルギーをこのポケモンにつける（実物照合ずみ）', () => {
    const table = setup();
    useSword(table);
    const slot = table.room.rawState.players[table.alice]?.pokemon.find(
      (p) => p.slotId === 'active',
    );
    expect((slot?.attachedEnergy.length ?? 0)).toBeGreaterThan(0);
    for (const id of slot?.attachedEnergy ?? []) {
      const fid = table.room.rawState.cards[id]?.functionalId ?? '';
      expect([METAL, 'smpl-energy-water']).toContain(fid);
    }
  });

  it('★使うと番が終わる。知らせるだけで、勝手には終わらせない', () => {
    const table = setup();
    useSword(table);
    const codes = table.room.rawState.log.flatMap((e) => e.warnings.map((w) => w.code));
    expect(codes).toContain('ABILITY_ENDS_TURN');
    // ★番はまだアリスのまま（終えるのは人の操作）
    expect(table.room.rawState.activePlayer).toBe(table.alice);
  });

  it('残りを手札に加える部分は人に投げている（ASSISTED）', () => {
    const zacian = card(ZACIAN);
    const prompts = (zacian.abilities?.[0]?.effects ?? []).filter((op) => op.op === 'manual');
    expect(prompts).toHaveLength(1);
  });
});
