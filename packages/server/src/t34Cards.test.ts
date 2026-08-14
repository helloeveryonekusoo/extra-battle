/**
 * T34: システムポケモン（16枚）。
 *
 * 指示書が名指しした2点をここで確かめる:
 *   1. ★「自分の番に1回」のカウンタを **CardInstance 単位** で持つ
 *      （同名のポケモンが2匹いれば、それぞれ1回ずつ使える）
 *   2. ★「手札から出したとき」トリガ
 */
import { describe, expect, it } from 'vitest';
import {
  buildCardIndex,
  canUseAbilityThisTurn,
  cardsInZone,
  effectSlotKey,
  getBenchLimit,
  getEffectiveAbilities,
  continuousDamageModifier,
  effectModeOf,
  type CardText,
  type RuleContext,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const pool = loadCardTexts();
const CTX: RuleContext = { cards: buildCardIndex(pool) };

const names = [
  // 手札から出したとき（5）
  'クロバットV', 'カプ・テテフGX', 'シェイミEX', 'ネオラントV', 'かがやくルチャブル',
  // 自分の番に1回（8）
  'デデンネGX', 'かがやくゲッコウガ', 'ゾロアークGX', 'オクタン',
  'キュワワー', 'ミュウ', 'ジラーチ', 'ヤレユータン',
  // 常時（3）
  'アローラベトベトン', 'ダストダス', 'ウソッキー',
] as const;

const card = (name: string): CardText => {
  const found = pool.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is missing`);
  return found;
};

const deck = (cards: readonly CardText[]) => {
  const counts = new Map<string, number>();
  for (const entry of cards) counts.set(entry.functionalId, (counts.get(entry.functionalId) ?? 0) + 1);
  return {
    name: 'golden',
    cards: [...counts].map(([functionalId, count]) => ({ functionalId, count })),
  };
};

const filler = (n: number) => pool.filter((entry) => !entry.effects && !entry.abilities).slice(0, n);

interface Table {
  room: Room;
  alice: string;
  bob: string;
  mine: (functionalId: string, nth?: number) => string;
  theirs: (functionalId: string, nth?: number) => string;
}

function setup(aliceExtra: readonly CardText[] = [], bobExtra: readonly CardText[] = []): Table {
  const room = new Room({ code: 'T34GLD', rngSeed: 'gold34', cardPool: pool });
  const alice = room.join('Alice', undefined, deck([...aliceExtra, ...filler(12)])).playerId;
  const bob = room.join('Bob', undefined, deck([...bobExtra, ...filler(12)])).playerId;
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

/** 手札を経由して場に出す（＝「手札から出したとき」が成立する） */
function playFromHand(table: Table, player: string, instanceId: string, slotId: string): void {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'hand' });
  table.room.submitAction(player, {
    type: 'placePokemon',
    playerId: player,
    slotId: slotId as never,
    cardId: instanceId,
  });
}

/** 山札から直接場に出す（＝手札を経由しない） */
function playFromDeck(table: Table, player: string, instanceId: string, slotId: string): void {
  table.room.submitAction(player, {
    type: 'placePokemon',
    playerId: player,
    slotId: slotId as never,
    cardId: instanceId,
  });
}

function useAbility(table: Table, instanceId: string, abilityIndex = 0): void {
  table.room.submitIntent(table.alice, { type: 'useCardEffect', instanceId, abilityIndex });
}

function finish(table: Table): void {
  for (let i = 0; i < 20 && table.room.rawState.execution; i += 1) {
    const choice = table.room.rawState.execution.pendingChoice;
    if (!choice) break;
    const chooser = choice.chooser === table.bob ? table.bob : table.alice;
    table.room.submitIntent(chooser, {
      type: 'resolveChoice',
      requestId: choice.requestId,
      selected: choice.candidates.slice(0, choice.max),
    });
  }
}

const hand = (table: Table, player: string) => cardsInZone(table.room.rawState, player, 'hand').length;

const warningsFor = (table: Table): string[] =>
  table.room.rawState.log
    .filter((entry) => entry.action.type === 'startEffect')
    .flatMap((entry) => entry.warnings.map((warning) => warning.code));

const BASIC = card('ゼニガメ');

// ── 定義そのものの確認 ──────────────────

describe('T34 定義', () => {
  it('指示された16枚が揃っている', () => {
    expect(names).toHaveLength(16);
    for (const name of names) expect(card(name), name).toBeTruthy();
  });

  it('特性は trigger と oncePerTurn で役割が分かれている', () => {
    const onPlay = names.map(card).filter((c) =>
      c.abilities?.some((a) => a.trigger === 'onPlayFromHand'),
    );
    const once = names.map(card).filter((c) => c.abilities?.some((a) => a.oncePerTurn));
    const passive = names.map(card).filter((c) => c.abilities?.some((a) => a.trigger === 'passive'));
    expect(onPlay).toHaveLength(5);
    expect(once).toHaveLength(8);
    expect(passive).toHaveLength(3);
  });

  it('★条件を自動で判定できない特性は ASSISTED（manual に逃がしてある）', () => {
    expect(effectModeOf(card('ミュウ').abilities?.[0]?.effects)).toBe('ASSISTED');
    expect(effectModeOf(card('ジラーチ').abilities?.[0]?.effects)).toBe('ASSISTED');
    // 条件のないものは AUTO
    expect(effectModeOf(card('デデンネGX').abilities?.[0]?.effects)).toBe('AUTO');
  });
});

// ── ★1. 「自分の番に1回」は CardInstance 単位 ──

describe('★「自分の番に1回」はカードの実体ごとに数える', () => {
  /** デデンネGX を2匹ベンチに出した卓 */
  function twoDedenne(): Table & { first: string; second: string } {
    const dedenne = card('デデンネGX');
    const table = setup([dedenne, dedenne, BASIC]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    const first = table.mine(dedenne.functionalId, 0);
    const second = table.mine(dedenne.functionalId, 1);
    playFromDeck(table, table.alice, first, 'bench-0');
    playFromDeck(table, table.alice, second, 'bench-1');
    return { ...table, first, second };
  }

  it('デデンネGX: 手札をすべて捨てて6枚引く', () => {
    const table = twoDedenne();
    // 手札を3枚用意する
    for (const instance of cardsInZone(table.room.rawState, table.alice, 'deck').slice(0, 3)) {
      table.room.submitAction(table.alice, {
        type: 'moveCard',
        cardId: instance.instanceId,
        toZone: 'hand',
      });
    }
    expect(hand(table, table.alice)).toBe(3);

    useAbility(table, table.first);
    finish(table);
    expect(hand(table, table.alice)).toBe(6);
  });

  it('★2匹いれば、それぞれ1回ずつ使える', () => {
    const table = twoDedenne();
    expect(canUseAbilityThisTurn(table.room.rawState, table.first, 0)).toBe(true);
    expect(canUseAbilityThisTurn(table.room.rawState, table.second, 0)).toBe(true);

    useAbility(table, table.first);
    finish(table);

    // ★1匹目を使っても、2匹目はまだ使える
    expect(canUseAbilityThisTurn(table.room.rawState, table.first, 0)).toBe(false);
    expect(canUseAbilityThisTurn(table.room.rawState, table.second, 0)).toBe(true);

    useAbility(table, table.second);
    finish(table);
    expect(canUseAbilityThisTurn(table.room.rawState, table.second, 0)).toBe(false);

    // 2匹ぶん使ったので警告は出ていない
    expect(warningsFor(table)).not.toContain('ABILITY_ALREADY_USED');
  });

  it('★同じ実体で2回目は警告が出る。ただし止めない', () => {
    const table = twoDedenne();
    useAbility(table, table.first);
    finish(table);
    useAbility(table, table.first);
    finish(table);

    expect(warningsFor(table)).toContain('ABILITY_ALREADY_USED');
    // ★通っている（実行が始まり、最後まで進んだ）
    expect(table.room.rawState.execution).toBeNull();
    expect(hand(table, table.alice)).toBe(6);
  });

  it('★番が変われば、また使えるようになる', () => {
    const table = twoDedenne();
    useAbility(table, table.first);
    finish(table);
    expect(canUseAbilityThisTurn(table.room.rawState, table.first, 0)).toBe(false);

    table.room.submitIntent(table.alice, { type: 'endTurn' });
    expect(canUseAbilityThisTurn(table.room.rawState, table.first, 0)).toBe(true);
  });

  it('★記録は相手にも見える（もう使ったのか目で確かめられる）', () => {
    const table = twoDedenne();
    useAbility(table, table.first);
    finish(table);
    const seenByBob = table.room.stateFor(table.bob);
    expect(canUseAbilityThisTurn(seenByBob, table.first, 0)).toBe(false);
  });
});

// ── ★2. 「手札から出したとき」トリガ ────────

describe('★「手札から出したとき」は自動ではたらく', () => {
  it('クロバットV: 手札から出すと、手札が6枚になるように引く', () => {
    const crobat = card('クロバットV');
    const table = setup([crobat, BASIC]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');

    // 手札はクロバットVを出すぶんの1枚だけ → 出したあと手札0枚 → 6枚引く
    playFromHand(table, table.alice, table.mine(crobat.functionalId), 'bench-0');
    finish(table);
    expect(hand(table, table.alice)).toBe(6);
  });

  it('★すでに手札が6枚以上なら1枚も引かない', () => {
    const crobat = card('クロバットV');
    const table = setup([crobat, BASIC]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    const crobatId = table.mine(crobat.functionalId);
    // クロバットV 以外を7枚、手札に集める
    for (const instance of cardsInZone(table.room.rawState, table.alice, 'deck')
      .filter((c) => c.instanceId !== crobatId)
      .slice(0, 7)) {
      table.room.submitAction(table.alice, {
        type: 'moveCard',
        cardId: instance.instanceId,
        toZone: 'hand',
      });
    }
    const deckBefore = cardsInZone(table.room.rawState, table.alice, 'deck').length;

    playFromHand(table, table.alice, crobatId, 'bench-0');
    finish(table);
    // ★手札は7枚のまま。山札も1枚も減っていない（クロバットVは手札を経由しただけ）
    expect(hand(table, table.alice)).toBe(7);
    expect(cardsInZone(table.room.rawState, table.alice, 'deck').length).toBe(deckBefore - 1);
  });

  it('★山札から直接出したときははたらかない', () => {
    const crobat = card('クロバットV');
    const table = setup([crobat, BASIC]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    const before = hand(table, table.alice);

    playFromDeck(table, table.alice, table.mine(crobat.functionalId), 'bench-0');
    expect(table.room.rawState.execution).toBeNull();
    expect(hand(table, table.alice)).toBe(before);
  });

  it.each(['カプ・テテフGX', 'ネオラントV'] as const)(
    '%s: 手札から出すと山札からサポートを1枚',
    (name) => {
      const supporter = card('N');
      const table = setup([card(name), BASIC, supporter]);
      playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');

      playFromHand(table, table.alice, table.mine(card(name).functionalId), 'bench-0');
      const choice = table.room.rawState.execution?.pendingChoice;
      expect(choice?.candidates).toContain(table.mine(supporter.functionalId));
      finish(table);
      expect(table.room.rawState.cards[table.mine(supporter.functionalId)]?.zone).toBe('hand');
    },
  );

  it('シェイミEX: 手札から出すと手札が6枚になる', () => {
    const shaymin = card('シェイミEX');
    const table = setup([shaymin, BASIC]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    playFromHand(table, table.alice, table.mine(shaymin.functionalId), 'bench-0');
    finish(table);
    expect(hand(table, table.alice)).toBe(6);
  });

  it('★かがやくルチャブル: 相手のベンチ2匹にダメカンを1個ずつのせる', () => {
    const lucha = card('かがやくルチャブル');
    const fire = card('ヒトカゲ');
    const table = setup([lucha, BASIC], [BASIC, fire, fire]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    playFromDeck(table, table.bob, table.theirs(BASIC.functionalId), 'active');
    playFromDeck(table, table.bob, table.theirs(fire.functionalId, 0), 'bench-0');
    playFromDeck(table, table.bob, table.theirs(fire.functionalId, 1), 'bench-1');

    playFromHand(table, table.alice, table.mine(lucha.functionalId), 'bench-0');
    finish(table);

    const benches = table.room.rawState.players[table.bob]!.pokemon.filter(
      (s) => s.slotId !== 'active',
    );
    expect(benches.reduce((sum, s) => sum + s.damageCounters, 0)).toBe(2);
    // ★バトル場には乗らない
    const active = table.room.rawState.players[table.bob]!.pokemon.find((s) => s.slotId === 'active');
    expect(active?.damageCounters).toBe(0);
  });

  it('相手のベンチが空なら、何も起きずに終わる', () => {
    const lucha = card('かがやくルチャブル');
    const table = setup([lucha, BASIC], [BASIC]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    playFromDeck(table, table.bob, table.theirs(BASIC.functionalId), 'active');

    playFromHand(table, table.alice, table.mine(lucha.functionalId), 'bench-0');
    finish(table);
    expect(table.room.rawState.execution).toBeNull();
  });
});

// ── 起動型の特性 ───────────────────────

describe('T34 自分の番に1回の特性', () => {
  /** name をベンチに出した卓（手札経由しないので onPlayFromHand は動かない） */
  function withPokemon(name: string, extra: readonly CardText[] = []): Table & { id: string } {
    const target = card(name);
    const table = setup([target, BASIC, ...extra]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    const id = table.mine(target.functionalId);
    playFromDeck(table, table.alice, id, 'bench-0');
    return { ...table, id };
  }

  const toHand = (table: Table, n: number): string[] =>
    cardsInZone(table.room.rawState, table.alice, 'deck')
      .slice(0, n)
      .map((instance) => {
        table.room.submitAction(table.alice, {
          type: 'moveCard',
          cardId: instance.instanceId,
          toZone: 'hand',
        });
        return instance.instanceId;
      });

  it('ゾロアークGX とりひき: 手札を1枚捨てて2枚引く', () => {
    const table = withPokemon('ゾロアークGX');
    toHand(table, 3);
    const before = hand(table, table.alice);
    useAbility(table, table.id);
    finish(table);
    expect(hand(table, table.alice)).toBe(before - 1 + 2);
  });

  it('かがやくゲッコウガ かくしふだ: 水エネルギーを1枚捨てて2枚引く', () => {
    const water = card('基本水エネルギー');
    const table = withPokemon('かがやくゲッコウガ', [water]);
    table.room.submitAction(table.alice, {
      type: 'moveCard',
      cardId: table.mine(water.functionalId),
      toZone: 'hand',
    });
    const before = hand(table, table.alice);

    useAbility(table, table.id);
    finish(table);
    expect(table.room.rawState.cards[table.mine(water.functionalId)]?.zone).toBe('discard');
    expect(hand(table, table.alice)).toBe(before - 1 + 2);
  });

  it('★かくしふだ: 手札に水エネルギーがなければ何も起きない', () => {
    const table = withPokemon('かがやくゲッコウガ');
    const before = hand(table, table.alice);
    useAbility(table, table.id);
    finish(table);
    expect(hand(table, table.alice)).toBe(before);
  });

  it('オクタン しどうしれい: 山札からグッズを1枚', () => {
    const item = card('クイックボール');
    const table = withPokemon('オクタン', [item]);
    useAbility(table, table.id);
    const choice = table.room.rawState.execution?.pendingChoice;
    expect(choice?.candidates).toContain(table.mine(item.functionalId));
    finish(table);
    expect(table.room.rawState.cards[table.mine(item.functionalId)]?.zone).toBe('hand');
  });

  it('★キュワワー はなえらび: 上から3枚を見て1枚を手札、残り2枚をトラッシュ', () => {
    const table = withPokemon('キュワワー');
    const top3 = cardsInZone(table.room.rawState, table.alice, 'deck')
      .slice(0, 3)
      .map((instance) => instance.instanceId);

    useAbility(table, table.id);
    const choice = table.room.rawState.execution!.pendingChoice!;
    // ★見えるのは上から3枚だけ
    expect(choice.candidates).toEqual(top3);
    table.room.submitIntent(table.alice, {
      type: 'resolveChoice',
      requestId: choice.requestId,
      selected: [top3[0]!],
    });
    finish(table);

    expect(table.room.rawState.cards[top3[0]!]?.zone).toBe('hand');
    expect(table.room.rawState.cards[top3[1]!]?.zone).toBe('discard');
    expect(table.room.rawState.cards[top3[2]!]?.zone).toBe('discard');
  });

  it('ヤレユータン さるぢえ: 手札を山札の下にもどす', () => {
    const table = withPokemon('ヤレユータン');
    const inHand = toHand(table, 3);
    useAbility(table, table.id);
    finish(table);
    for (const id of inHand) expect(table.room.rawState.cards[id]?.zone).toBe('deck');
  });

  it.each(['ミュウ', 'ジラーチ'] as const)('%s: 条件は人に確認してもらう（ASSISTED）', (name) => {
    const table = withPokemon(name);
    useAbility(table, table.id);
    const choice = table.room.rawState.execution?.pendingChoice;
    expect(choice?.kind).toBe('confirm');
  });
});

// ── 常時型（ロック） ─────────────────

describe('T34 常時型の特性', () => {
  it('★アローラベトベトン: おたがいのたねポケモンの特性が止まる', () => {
    const muk = card('アローラベトベトン');
    const dedenne = card('デデンネGX');
    const table = setup([BASIC, dedenne], [muk, BASIC]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    const dedenneId = table.mine(dedenne.functionalId);
    playFromDeck(table, table.alice, dedenneId, 'bench-0');
    playFromDeck(table, table.bob, table.theirs(BASIC.functionalId), 'active');

    const key = effectSlotKey(table.alice, 'bench-0');
    expect(getEffectiveAbilities(table.room.rawState, key, CTX)).toHaveLength(1);

    // 相手がアローラベトベトンを出す
    playFromDeck(table, table.bob, table.theirs(muk.functionalId), 'bench-0');
    expect(getEffectiveAbilities(table.room.rawState, key, CTX)).toHaveLength(0);
    // ★1進化のベトベトン自身は止まらない
    expect(
      getEffectiveAbilities(table.room.rawState, effectSlotKey(table.bob, 'bench-0'), CTX),
    ).toHaveLength(1);
  });

  it('★ダストダス: おたがいのどうぐの効果が消える', () => {
    const band = card('ちからのハチマキ');
    const dustox = card('ダストダス');
    const table = setup([BASIC, band], [BASIC, dustox]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    playFromDeck(table, table.bob, table.theirs(BASIC.functionalId), 'active');
    table.room.submitAction(table.alice, {
      type: 'moveCard',
      cardId: table.mine(band.functionalId),
      toZone: 'hand',
    });
    table.room.submitAction(table.alice, {
      type: 'attachCard',
      playerId: table.alice,
      slotId: 'active',
      cardId: table.mine(band.functionalId),
      as: 'tool',
    });

    const step2 = () =>
      continuousDamageModifier(
        table.room.rawState,
        { playerId: table.alice, slotId: 'active' },
        { playerId: table.bob, slotId: 'active' },
        'step2',
        CTX,
      ).delta;

    expect(step2()).toBe(20);

    // 相手がダストダスを出すと、ハチマキの効果が消える
    playFromDeck(table, table.bob, table.theirs(dustox.functionalId), 'bench-0');
    expect(step2()).toBe(0);
    // ★どうぐ自体は外れていない
    expect(
      table.room.rawState.players[table.alice]!.pokemon.find((s) => s.slotId === 'active')
        ?.attachedTool,
    ).toBe(table.mine(band.functionalId));
  });

  it('★ウソッキー: ベンチ上限4。スカイフィールドと同時なら低いほうの4', () => {
    const sudowoodo = card('ウソッキー');
    const sky = card('スカイフィールド');
    const table = setup([BASIC, sky], [BASIC, sudowoodo]);
    playFromDeck(table, table.alice, table.mine(BASIC.functionalId), 'active');
    playFromDeck(table, table.bob, table.theirs(BASIC.functionalId), 'active');
    expect(getBenchLimit(table.room.rawState, table.alice, CTX)).toBe(5);

    table.room.submitAction(table.alice, {
      type: 'setStadium',
      cardId: table.mine(sky.functionalId),
    });
    expect(getBenchLimit(table.room.rawState, table.alice, CTX)).toBe(8);

    playFromDeck(table, table.bob, table.theirs(sudowoodo.functionalId), 'bench-0');
    // ★低いほうが優先される（§2.2）
    expect(getBenchLimit(table.room.rawState, table.alice, CTX)).toBe(4);
  });
});
