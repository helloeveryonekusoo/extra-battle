/**
 * T42: ロック系カード（実データ）。
 *
 * ★確かめたいのは「カードごとの個別実装をしていない」こと。
 *   どのカードも `locks` の宣言だけで動き、判定は lock.ts の1本を通る。
 *
 * 完了条件:
 *   ★各ロックが正しく機能し、発生源が場を離れると解除される
 *   ★ロックが2つ以上同時にあるときは警告が出る（§2.1 / §4.5）
 */
import { describe, expect, it } from 'vitest';
import {
  abilityLockOn,
  attackDamageImmunity,
  attackLockOn,
  buildCardIndex,
  canUseCardKind,
  cardKindLockOn,
  collectLocks,
  effectSlotKey,
  getBenchLimit,
  getEffectiveAbilities,
  multipleLockWarning,
  toolsNullified,
  WARNING_CODES,
  type CardText,
  type RuleContext,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const pool = loadCardTexts();
const CTX: RuleContext = { cards: buildCardIndex(pool) };

/**
 * ★実物照合ずみのカード（2026-08-14）。
 *   ワザ封じは「メガニウム」ではなく **ラフレシア（にがにがかふん）** だった。
 *   グッズロックの「イライラかふん」版と **同名・別カード**（4枚制限は名前で共有する）。
 *   ダメージ無効はマナフィ（t43）が担う。
 */
const names = [
  // 特性ロック
  'ソーナンス', 'ガラルマタドガス', 'アローラベトベトン', 'ダストダス', '頂への雪道', 'サイレントラボ',
  // カード種別ロック
  'ラフレシア', 'オーロット', 'ムーランド', 'ガマゲロゲEX',
  // ベンチ操作
  'スカイフィールド', 'ウソッキー', 'ムゲンダイナVMAX',
] as const;

const VILEPLUME_ITEM_LOCK = 't42-vileplume';
const VILEPLUME_ATTACK_LOCK = 't42-vileplume-bitter';

const cardById = (functionalId: string): CardText => {
  const found = pool.find((entry) => entry.functionalId === functionalId);
  if (!found) throw new Error(`${functionalId} is missing`);
  return found;
};

const card = (name: string): CardText => {
  const found = pool.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is missing`);
  return found;
};

const deck = (cards: readonly CardText[]) => {
  const counts = new Map<string, number>();
  for (const entry of cards) counts.set(entry.functionalId, (counts.get(entry.functionalId) ?? 0) + 1);
  return {
    name: 'lock',
    cards: [...counts].map(([functionalId, count]) => ({ functionalId, count })),
  };
};

const filler = (n: number) =>
  pool.filter((entry) => !entry.effects && !entry.abilities && !entry.locks).slice(0, n);

interface Table {
  room: Room;
  alice: string;
  bob: string;
  mine: (functionalId: string, nth?: number) => string;
  theirs: (functionalId: string, nth?: number) => string;
}

function setup(aliceExtra: readonly CardText[] = [], bobExtra: readonly CardText[] = []): Table {
  const room = new Room({ code: 'T42LCK', rngSeed: 'lock42', cardPool: pool });
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

const put = (table: Table, player: string, instanceId: string, slotId: string): void => {
  table.room.submitAction(player, {
    type: 'placePokemon',
    playerId: player,
    slotId: slotId as never,
    cardId: instanceId,
  });
};

const BASIC = card('ロコン');

// ── 定義そのもの ─────────────────────

describe('T42 定義', () => {
  it('指示されたカードが揃っている', () => {
    for (const name of names) expect(card(name), name).toBeTruthy();
    expect(cardById(VILEPLUME_ITEM_LOCK).abilities?.[0]?.name).toBe('イライラかふん');
    expect(cardById(VILEPLUME_ATTACK_LOCK).abilities?.[0]?.name).toBe('にがにがかふん');
  });

  it('★どのカードもロックを宣言しているだけ（種類ごとの実装を持たない）', () => {
    const declared = names
      .map(card)
      .flatMap((c) => [...(c.locks ?? []), ...(c.continuous ?? [])]);
    expect(declared.length).toBeGreaterThanOrEqual(names.length - 1);
    // ★5種類すべてが実データに現れている（カードプール全体で見る）
    const kinds = new Set(pool.flatMap((c) => (c.locks ?? []).map((l) => l.kind)));
    expect(kinds).toEqual(
      new Set(['abilityLock', 'cardKindLock', 'attackLock', 'attackDamageImmunity', 'benchLimit']),
    );
  });

  it('exceptSelf と requiresActive を全部のカードが明示している', () => {
    for (const entry of pool) {
      for (const lock of entry.locks ?? []) {
        expect(typeof lock.exceptSelf, entry.name).toBe('boolean');
        expect(typeof lock.requiresActive, entry.name).toBe('boolean');
      }
    }
  });
});

// ── 特性ロック ───────────────────────

describe('特性ロック', () => {
  it('ソーナンス: たねポケモンの特性が止まる（自分はのぞく）', () => {
    const table = setup([card('クロバットV')], [card('ソーナンス')]);
    put(table, table.alice, table.mine('t34-crobat-v'), 'active');
    const key = effectSlotKey(table.alice, 'active');
    expect(getEffectiveAbilities(table.room.rawState, key, CTX)).toHaveLength(1);

    put(table, table.bob, table.theirs('t42-wobbuffet'), 'active');
    expect(getEffectiveAbilities(table.room.rawState, key, CTX)).toHaveLength(0);
    // ★ソーナンス自身は止まらない
    expect(abilityLockOn(table.room.rawState, table.bob, 'active', CTX).locked).toBe(false);
  });

  it('★ガラルマタドガス: バトル場にいるあいだだけ効く', () => {
    const table = setup([card('クロバットV')], [card('ガラルマタドガス'), BASIC]);
    put(table, table.alice, table.mine('t34-crobat-v'), 'active');
    put(table, table.bob, table.theirs(BASIC.functionalId), 'active');
    put(table, table.bob, table.theirs('t42-galarian-weezing'), 'bench-0');

    const key = effectSlotKey(table.alice, 'active');
    // ベンチにいるあいだは何も起きない
    expect(getEffectiveAbilities(table.room.rawState, key, CTX)).toHaveLength(1);
    expect(collectLocks(table.room.rawState, CTX)).toHaveLength(0);

    table.room.submitAction(table.bob, {
      type: 'movePokemon',
      playerId: table.bob,
      fromSlotId: 'bench-0',
      toSlotId: 'active',
    });
    expect(getEffectiveAbilities(table.room.rawState, key, CTX)).toHaveLength(0);
  });

  it('頂への雪道: ルールを持つポケモンの特性だけが止まる', () => {
    const table = setup([card('クロバットV'), card('オクタン')], [card('頂への雪道')]);
    put(table, table.alice, table.mine('t34-crobat-v'), 'active');
    put(table, table.alice, table.mine('t34-octillery'), 'bench-0');
    const stadium = table.theirs('t33-path-to-the-peak');
    table.room.submitAction(table.bob, { type: 'moveCard', cardId: stadium, toZone: 'stadium' });
    table.room.submitAction(table.bob, { type: 'setStadium', cardId: stadium });

    expect(abilityLockOn(table.room.rawState, table.alice, 'active', CTX).locked).toBe(true);
    expect(abilityLockOn(table.room.rawState, table.alice, 'bench-0', CTX).locked).toBe(false);

    // ★発生源（スタジアム）が場を離れれば解除される
    table.room.submitAction(table.bob, { type: 'setStadium', cardId: null });
    expect(abilityLockOn(table.room.rawState, table.alice, 'active', CTX).locked).toBe(false);
  });

  it('ダストダス: どうぐの効果だけが止まる（特性は止まらない）', () => {
    const table = setup([card('クロバットV'), card('ちからのハチマキ')], [card('ダストダス')]);
    put(table, table.alice, table.mine('t34-crobat-v'), 'active');
    put(table, table.bob, table.theirs('t34-garbodor'), 'active');

    expect(toolsNullified(table.room.rawState, table.alice, CTX)).toBe(true);
    // ★特性ロックではないので、ポケモンの特性は生きている
    expect(
      getEffectiveAbilities(table.room.rawState, effectSlotKey(table.alice, 'active'), CTX),
    ).toHaveLength(1);
  });
});

// ── カード種別ロック ──────────────────

describe('カード種別ロック', () => {
  it('ラフレシア: おたがいグッズが使えない', () => {
    const table = setup([], [card('ラフレシア')]);
    put(table, table.bob, table.theirs('t42-vileplume'), 'active');
    expect(canUseCardKind(table.room.rawState, table.alice, 'item', CTX)).toBe(false);
    expect(canUseCardKind(table.room.rawState, table.bob, 'item', CTX)).toBe(false);
    expect(canUseCardKind(table.room.rawState, table.alice, 'supporter', CTX)).toBe(true);
  });

  it('オーロット: バトル場にいるあいだだけグッズが止まる', () => {
    const table = setup([], [card('オーロット'), BASIC]);
    put(table, table.bob, table.theirs(BASIC.functionalId), 'active');
    put(table, table.bob, table.theirs('t42-trevenant'), 'bench-0');
    expect(canUseCardKind(table.room.rawState, table.alice, 'item', CTX)).toBe(true);

    table.room.submitAction(table.bob, {
      type: 'movePokemon',
      playerId: table.bob,
      fromSlotId: 'bench-0',
      toSlotId: 'active',
    });
    expect(canUseCardKind(table.room.rawState, table.alice, 'item', CTX)).toBe(false);
  });

  it('ムーランド: 相手だけサポートが止まる（自分は使える）', () => {
    const table = setup([], [card('ムーランド')]);
    put(table, table.bob, table.theirs('t42-stoutland'), 'active');
    expect(canUseCardKind(table.room.rawState, table.alice, 'supporter', CTX)).toBe(false);
    expect(canUseCardKind(table.room.rawState, table.bob, 'supporter', CTX)).toBe(true);
  });

  it('★グッズロック中でもグッズは使える（警告だけ）', () => {
    const table = setup([card('ハイパーボール')], [card('ラフレシア')]);
    put(table, table.bob, table.theirs('t42-vileplume'), 'active');
    const ball = table.mine('t31-ultra-ball');
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: ball, toZone: 'hand' });
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: ball, toZone: 'discard' });

    const codes = table.room.rawState.log.flatMap((e) => e.warnings.map((w) => w.code));
    expect(codes).toContain(WARNING_CODES.CARD_KIND_LOCKED);
    expect(table.room.rawState.cards[ball]?.zone).toBe('discard');
  });

  it('ガマゲロゲEX: ワザの効果でグッズが止まる（盤面のロックではない）', () => {
    const table = setup([], [card('ガマゲロゲEX')]);
    const frog = table.theirs('t42-seismitoad-ex');
    put(table, table.bob, frog, 'active');
    table.room.submitIntent(table.bob, {
      type: 'useCardEffect',
      instanceId: frog,
      attackIndex: 0,
    });
    // 選択のない効果は一度で終わる。残っていれば進める
    for (let i = 0; i < 5 && table.room.rawState.execution; i += 1) {
      table.room.submitAction(table.bob, {
        type: 'effectStep',
        executionId: table.room.rawState.execution.executionId,
      });
    }
    expect(table.room.rawState.effects).toHaveLength(1);

    expect(canUseCardKind(table.room.rawState, table.alice, 'item', CTX)).toBe(false);
    // ★盤面のロックとしては数えない（相互作用の警告を汚さないため）
    expect(collectLocks(table.room.rawState, CTX)).toHaveLength(0);
    expect(cardKindLockOn(table.room.rawState, table.alice, 'item', CTX).sources).toContain(
      'げこげこアタック',
    );
  });
});

// ── ワザ封じ / ダメージ無効 ────────────

describe('ワザ封じとダメージ無効', () => {
  it('★ラフレシア（にがにがかふん）: 相手のたねポケモンはワザを使えない', () => {
    const table = setup([card('クロバットV')], [cardById(VILEPLUME_ATTACK_LOCK)]);
    put(table, table.alice, table.mine('t34-crobat-v'), 'active');
    put(table, table.bob, table.theirs(VILEPLUME_ATTACK_LOCK), 'active');
    expect(attackLockOn(table.room.rawState, table.alice, 'active', CTX).locked).toBe(true);
    // 宣言した側は使える
    expect(attackLockOn(table.room.rawState, table.bob, 'active', CTX).locked).toBe(false);
  });

  it('★同名の2種類は、それぞれ別のロックを出す', () => {
    const table = setup(
      [card('クロバットV')],
      [cardById(VILEPLUME_ITEM_LOCK), cardById(VILEPLUME_ATTACK_LOCK), BASIC],
    );
    put(table, table.alice, table.mine('t34-crobat-v'), 'active');
    put(table, table.bob, table.theirs(BASIC.functionalId), 'active');

    put(table, table.bob, table.theirs(VILEPLUME_ITEM_LOCK), 'bench-0');
    expect(canUseCardKind(table.room.rawState, table.alice, 'item', CTX)).toBe(false);
    expect(attackLockOn(table.room.rawState, table.alice, 'active', CTX).locked).toBe(false);

    put(table, table.bob, table.theirs(VILEPLUME_ATTACK_LOCK), 'bench-1');
    expect(attackLockOn(table.room.rawState, table.alice, 'active', CTX).locked).toBe(true);
  });

  it('マナフィ: 自分のベンチはワザのダメージを受けない（ダメージ無効はここが担う）', () => {
    const table = setup([card('マナフィ'), BASIC], [BASIC]);
    put(table, table.alice, table.mine(BASIC.functionalId), 'active');
    put(table, table.alice, table.mine('t43-manaphy'), 'bench-0');
    put(table, table.bob, table.theirs(BASIC.functionalId), 'active');
    const verdict = attackDamageImmunity(
      table.room.rawState,
      { playerId: table.alice, slotId: 'bench-0' },
      { playerId: table.bob, slotId: 'active' },
      CTX,
    );
    expect(verdict.locked).toBe(true);
  });
});

// ── ベンチ操作 ──────────────────────

describe('ベンチ操作', () => {
  it('スカイフィールドで8、ウソッキーが出れば4（低いほうを採る）', () => {
    const table = setup([card('スカイフィールド')], [card('ウソッキー'), BASIC]);
    const stadium = table.mine('t33-sky-field');
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: stadium, toZone: 'stadium' });
    table.room.submitAction(table.alice, { type: 'setStadium', cardId: stadium });
    expect(getBenchLimit(table.room.rawState, table.alice, CTX)).toBe(8);

    put(table, table.bob, table.theirs(BASIC.functionalId), 'active');
    put(table, table.bob, table.theirs('t34-sudowoodo'), 'bench-0');
    expect(getBenchLimit(table.room.rawState, table.alice, CTX)).toBe(4);
  });

  it('★ムゲンダイナVMAX: 自分の場が悪ポケモンだけのときだけ8', () => {
    const table = setup([card('ムゲンダイナVMAX'), BASIC]);
    put(table, table.alice, table.mine('t42-eternatus-vmax'), 'active');
    expect(getBenchLimit(table.room.rawState, table.alice, CTX)).toBe(8);

    // 悪でないポケモンを並べると条件が崩れ、宣言そのものが消える
    put(table, table.alice, table.mine(BASIC.functionalId), 'bench-0');
    expect(getBenchLimit(table.room.rawState, table.alice, CTX)).toBe(5);
  });
});

// ── ★複数ロックの警告（§2.1 / §4.5） ────

describe('★ロックが2つ以上あるとき', () => {
  it('警告が出て、影響を受けるポケモンが ASSISTED に落ちる', () => {
    const table = setup([card('クロバットV')], [card('ソーナンス'), card('ラフレシア')]);
    put(table, table.alice, table.mine('t34-crobat-v'), 'active');
    put(table, table.bob, table.theirs('t42-wobbuffet'), 'active');
    expect(multipleLockWarning(table.room.rawState, CTX).multiple).toBe(false);

    put(table, table.bob, table.theirs('t42-vileplume'), 'bench-0');
    const warning = multipleLockWarning(table.room.rawState, CTX);
    expect(warning.multiple).toBe(true);
    expect(warning.details).toHaveLength(2);
    expect(abilityLockOn(table.room.rawState, table.alice, 'active', CTX).assisted).toBe(true);

    // ★ログにも1回だけ残る
    const codes = table.room.rawState.log.flatMap((e) => e.warnings.map((w) => w.code));
    expect(codes.filter((c) => c === WARNING_CODES.MULTIPLE_LOCKS)).toHaveLength(1);
  });
});
