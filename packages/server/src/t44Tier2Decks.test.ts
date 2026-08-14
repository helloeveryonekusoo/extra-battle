/**
 * T44: 環境デッキ Tier2 以降（指示書では優先度低）。
 *
 * ★3デッキまとめて。すべてのカードは公式カード検索で照合ずみ（2026-08-14）。
 *
 *   ① ゾロアークGX   … ★イカサマ = `useAttackAs` の 'opponentActive'。
 *                        既存カードだけで組めた（新規はゾロア1枚）
 *   ② ミュウVMAX     … ★所属タグ「フュージョン」を初めて実戦投入する。
 *                        クロスフュージョン = `useAttackAs` の 'ownBench'
 *   ③ レックウザVMAX … 手札を捨てて引き直す特性 + エネルギーをトラッシュして打点
 */
import { describe, expect, it } from 'vitest';
import {
  buildCardIndex,
  damageInputFromState,
  runDamagePipeline,
  validateDeck,
  type CardText,
  type DeckEntry,
  type RuleContext,
  type SubmittedDeck,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';
import { loadAllDecks, loadDeck } from './deckStore';

const pool = loadCardTexts();
const CTX: RuleContext = { cards: buildCardIndex(pool) };

const ZOROARK = loadDeck('tier2-zoroark-gx.json');
const MEW = loadDeck('tier2-mew-vmax-fusion.json');
const RAYQUAZA = loadDeck('tier2-rayquaza-vmax.json');

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

function setup(aliceDeck: SubmittedDeck, bobDeck: SubmittedDeck = aliceDeck): Table {
  const room = new Room({ code: 'T44TR2', rngSeed: 'tier2-44', cardPool: pool });
  const alice = room.join('Alice', undefined, aliceDeck).playerId;
  const bob = room.join('Bob', undefined, bobDeck).playerId;
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

const toHand = (table: Table, player: string, instanceId: string): void => {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'hand' });
};

const choice = (table: Table) => table.room.rawState.execution?.pendingChoice ?? null;

function finish(table: Table, chooserId: string): void {
  for (let i = 0; i < 12 && table.room.rawState.execution; i += 1) {
    const pending = table.room.rawState.execution.pendingChoice;
    if (!pending) {
      table.room.submitAction(chooserId, {
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

const handCount = (table: Table, player: string): number =>
  Object.values(table.room.rawState.cards).filter(
    (c) => c.ownerId === player && c.zone === 'hand',
  ).length;

const grantedOn = (table: Table, player: string, slotId: string) =>
  table.room.rawState.players[player]?.pokemon.find((p) => p.slotId === slotId)?.grantedAttacks ??
  [];

// ── デッキそのもの ────────────────────

describe('Tier2 デッキリスト', () => {
  it.each([
    ['ゾロアークGX', ZOROARK],
    ['ミュウVMAX', MEW],
    ['レックウザVMAX', RAYQUAZA],
  ] as const)('%s: 60枚ちょうどで、デッキ制限に引っかからない', (_name, deck) => {
    const entries: DeckEntry[] = deck.cards.map((entry) => ({
      card: card(entry.functionalId),
      count: entry.count,
    }));
    expect(entries.reduce((sum, e) => sum + e.count, 0)).toBe(60);
    expect(validateDeck(entries)).toEqual([]);
  });

  it('data/decks/ にある全デッキが読めて、すべて60枚', () => {
    const decks = loadAllDecks();
    // Tier1 が4つ + Tier2 が3つ
    expect(decks.length).toBeGreaterThanOrEqual(7);
    for (const deck of decks) {
      const total = deck.cards.reduce((sum, e) => sum + e.count, 0);
      expect(total, deck.name).toBe(60);
      for (const entry of deck.cards) expect(card(entry.functionalId), entry.functionalId).toBeTruthy();
    }
  });
});

// ── ① ゾロアークGX ──────────────────

describe('① ゾロアークGX', () => {
  it('ゾロア→ゾロアークGX の進化ラインがつながっている', () => {
    expect(card('t34-zoroark-gx').evolvesFrom).toBe(card('t44-zorua').name);
  });

  it('★イカサマは useAttackAs（相手のバトルポケモン）で解決する', () => {
    const table = setup(ZOROARK);
    put(table, table.alice, table.mine('t44-zorua'), 'active');
    const zoroark = table.mine('t34-zoroark-gx');
    evolve(table, table.alice, 'active', zoroark);
    put(table, table.bob, table.theirs('t34-dedenne-gx'), 'active');

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: zoroark,
      attackIndex: 0,
    });
    const pending = choice(table);
    expect(pending?.candidates).toEqual([table.theirs('t34-dedenne-gx')]);

    table.room.submitIntent(table.alice, {
      type: 'resolveChoice',
      requestId: pending?.requestId ?? '',
      selected: [table.theirs('t34-dedenne-gx')],
    });
    const granted = grantedOn(table, table.alice, 'active');
    expect(granted[0]?.functionalId).toBe('t34-dedenne-gx');
  });

  it('とりひきは手札を1枚捨てて2枚引く', () => {
    const table = setup(ZOROARK);
    put(table, table.alice, table.mine('t44-zorua'), 'active');
    const zoroark = table.mine('t34-zoroark-gx');
    evolve(table, table.alice, 'active', zoroark);
    toHand(table, table.alice, table.mine('smpl-energy-darkness'));
    const before = handCount(table, table.alice);

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: zoroark,
      abilityIndex: 0,
    });
    finish(table, table.alice);
    expect(handCount(table, table.alice)).toBe(before + 1);
  });
});

// ── ② ミュウVMAX（フュージョン） ────────

describe('② ミュウVMAX（★所属タグの実戦投入）', () => {
  const ready = (table: Table): string => {
    put(table, table.alice, table.mine('t44-mew-v'), 'active');
    const vmax = table.mine('t44-mew-vmax');
    evolve(table, table.alice, 'active', vmax);
    put(table, table.alice, table.mine('t44-genesect-v'), 'bench-0');
    return vmax;
  };

  it('フュージョンのカードにタグがついている', () => {
    for (const fid of ['t44-mew-v', 't44-mew-vmax', 't44-genesect-v']) {
      expect(card(fid).tags, fid).toContain('フュージョン');
    }
  });

  it('★クロスフュージョン: 自分のベンチのフュージョンのワザをコピーする', () => {
    const table = setup(MEW);
    const vmax = ready(table);
    put(table, table.bob, table.theirs('t44-mew-v'), 'active');

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vmax,
      attackIndex: 0,
    });
    const pending = choice(table);
    // ★ベンチのゲノセクトVだけが候補。相手や自分のバトル場は出ない
    expect(pending?.candidates).toEqual([table.mine('t44-genesect-v')]);

    table.room.submitIntent(table.alice, {
      type: 'resolveChoice',
      requestId: pending?.requestId ?? '',
      selected: [table.mine('t44-genesect-v')],
    });
    expect(grantedOn(table, table.alice, 'active')[0]?.functionalId).toBe('t44-genesect-v');
  });

  it('★フュージョンでないベンチポケモンはコピーできない', () => {
    const table = setup(MEW);
    const vmax = ready(table);
    put(table, table.alice, table.mine('t43-manaphy'), 'bench-1');

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vmax,
      attackIndex: 0,
    });
    expect(choice(table)?.candidates).not.toContain(table.mine('t43-manaphy'));
  });

  it('★フュージョンシステム: 手札が「場のフュージョンの数」になるように引く', () => {
    const table = setup(MEW);
    ready(table);
    put(table, table.alice, table.mine('t44-genesect-v', 1), 'bench-1');
    // 場のフュージョン: ミュウVMAX + ゲノセクトV×2 = 3匹
    for (const c of Object.values(table.room.rawState.cards)) {
      if (c.ownerId === table.alice && c.zone === 'hand') {
        table.room.submitAction(table.alice, {
          type: 'moveCard',
          cardId: c.instanceId,
          toZone: 'deck',
        });
      }
    }
    expect(handCount(table, table.alice)).toBe(0);

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: table.mine('t44-genesect-v'),
      abilityIndex: 0,
    });
    finish(table, table.alice);
    expect(handCount(table, table.alice)).toBe(3);
  });

  it('★パワータブレット: フュージョンのワザだけ +30（バトル場へのダメージのみ）', () => {
    const table = setup(MEW);
    ready(table);
    put(table, table.bob, table.theirs('t44-mew-v'), 'active');
    const tablet = table.mine('t44-power-tablet');
    toHand(table, table.alice, tablet);
    table.room.submitIntent(table.alice, { type: 'useCardEffect', instanceId: tablet });
    finish(table, table.alice);

    const damage = (slotId: string, isBench: boolean) =>
      runDamagePipeline(
        damageInputFromState(
          table.room.rawState,
          CTX,
          { playerId: table.alice, slotId: 'active' },
          { playerId: table.bob, slotId: slotId as never },
          { baseDamage: 100, attackerTypes: ['psychic'], defender: {}, targetIsBench: isBench },
        ),
      ).finalDamage;

    expect(damage('active', false)).toBe(130);

    // ★フュージョンでないポケモンが撃つときは乗らない
    put(table, table.alice, table.mine('t43-manaphy'), 'bench-2');
    const fromManaphy = runDamagePipeline(
      damageInputFromState(
        table.room.rawState,
        CTX,
        { playerId: table.alice, slotId: 'bench-2' },
        { playerId: table.bob, slotId: 'active' },
        { baseDamage: 100, attackerTypes: ['water'], defender: {}, targetIsBench: false },
      ),
    ).finalDamage;
    expect(fromManaphy).toBe(100);
  });

  it('★フュージョンエネルギーはフュージョンにだけはたらく', () => {
    const energy = card('t44-fusion-energy');
    expect(energy.energyValue).toHaveLength(1);
    expect(energy.energyValue?.[0]?.when?.tag).toEqual(['フュージョン']);
  });

  it('★フュージョンエネルギーをつけると、相手の特性の対象にならない', () => {
    const table = setup(MEW, ZOROARK);
    ready(table);
    put(table, table.bob, table.theirs('t44-zorua'), 'active');
    const inteleon = table.theirs('t34-dedenne-gx');
    put(table, table.bob, inteleon, 'bench-0');

    const shooter = (): string[] => {
      table.room.submitAction(table.bob, {
        type: 'startEffect',
        executionId: `x-shoot-${Math.random()}`,
        ops: [
          {
            op: 'damageCounter',
            action: 'place',
            count: 2,
            distribution: 'single',
            target: { kind: 'choose', player: 'opponent', chooser: 'self' },
          },
        ],
        // ★特性から出ている効果（abilityIndex が入っている）
        source: { instanceId: inteleon, playerId: table.bob, label: '特性', abilityIndex: 0 },
      });
      const candidates = choice(table)?.candidates ?? [];
      table.room.submitAction(table.bob, { type: 'cancelEffect', reason: 'test' });
      return candidates;
    };

    // つける前はミュウVMAXも狙える
    expect(shooter()).toContain(table.mine('t44-mew-vmax'));

    table.room.submitAction(table.alice, {
      type: 'attachCard',
      playerId: table.alice,
      slotId: 'active',
      cardId: table.mine('t44-fusion-energy'),
      as: 'energy',
    });
    // ★つけたあとは対象から外れる
    expect(shooter()).not.toContain(table.mine('t44-mew-vmax'));
    // ★ベンチのゲノセクトVは守られていない
    expect(shooter()).toContain(table.mine('t44-genesect-v'));
  });
});

// ── ③ レックウザVMAX ───────────────

describe('③ レックウザVMAX', () => {
  it('そうくうのはどう: 手札をすべて捨てて3枚引く', () => {
    const table = setup(RAYQUAZA);
    put(table, table.alice, table.mine('t44-rayquaza-v'), 'active');
    const vmax = table.mine('t44-rayquaza-vmax');
    evolve(table, table.alice, 'active', vmax);
    for (let i = 0; i < 2; i += 1) toHand(table, table.alice, table.mine('smpl-energy-fire', i));

    table.room.submitIntent(table.alice, {
      type: 'useCardEffect',
      instanceId: vmax,
      abilityIndex: 0,
    });
    finish(table, table.alice);
    expect(handCount(table, table.alice)).toBe(3);
  });

  it('ダイバーストは炎・雷の両方のコストを持つ（原文どおり数値化しない）', () => {
    const attack = card('t44-rayquaza-vmax').attacks?.[0];
    expect(attack?.name).toBe('ダイバースト');
    expect(attack?.damage).toBe('20+');
    expect(attack?.cost).toEqual(['fire', 'lightning']);
    // ★トラッシュする枚数は人が決める。効果は持たせていない
    expect(attack?.effects).toBeUndefined();
  });
});
