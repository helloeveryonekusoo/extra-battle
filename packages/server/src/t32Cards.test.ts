/**
 * T32: トラッシュ操作と入れ替え・除去（23枚）。
 * 指示書 §7-4 のとおり、1枚ずつ「初期状態 → 使う → 期待する状態」のゴールデンテストにする。
 *
 * ★バトルコンプレッサーとバトルサーチャーはエクストラの根幹なので、
 *   他より厚めに（枚数・行き先・シャッフルまで）確かめる。
 */
import { describe, expect, it } from 'vitest';
import { cardsInZone, type CardText, type Zone } from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const pool = loadCardTexts();

const names = [
  'バトルコンプレッサー', 'バトルサーチャー', 'レスキュータンカ', '夜のタンカ',
  'スペシャルチャージ', 'エネルギー回収', 'スーパーエネルギー回収', '炎の結晶',
  'ダークパッチ', 'アクアパッチ', 'メタルソーサー', 'ピーピーマックス',
  'ポケモンいれかえ', 'あなぬけのヒモ', 'ポケモンキャッチャー', 'クロススイッチャー',
  'グズマ', 'ボスの指令', 'フィールドブロアー', 'ツールスクラッパー',
  'クセロシキ', '改造ハンマー', 'ポケモンレンジャー',
] as const;

const card = (name: string): CardText => {
  const found = pool.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is missing`);
  return found;
};

/** 特殊エネルギーはまだサンプルにないので、テスト用に1枚だけ用意する（T33 で本実装） */
const SPECIAL_ENERGY: CardText = {
  functionalId: 't32-test-special-energy',
  name: 'テスト特殊エネルギー',
  supertype: 'energy',
  isBasicEnergy: false,
  energyProvides: ['colorless'],
};

const TEST_POOL = [...pool, SPECIAL_ENERGY];

/** 同じカードを複数回渡せば、その枚数だけ実体ができる */
const deck = (cards: readonly CardText[]) => {
  const counts = new Map<string, number>();
  for (const entry of cards) {
    counts.set(entry.functionalId, (counts.get(entry.functionalId) ?? 0) + 1);
  }
  return {
    name: 'golden',
    cards: [...counts].map(([functionalId, count]) => ({ functionalId, count })),
  };
};

/** 効果を持たない埋め草。山札の枚数合わせに使う */
const filler = (n: number) => pool.filter((entry) => !entry.effects).slice(0, n);

interface Table {
  room: Room;
  alice: string;
  bob: string;
  source: string;
  /** functionalId から自分のカード実体を引く */
  mine: (functionalId: string, nth?: number) => string;
  theirs: (functionalId: string, nth?: number) => string;
}

/**
 * 卓を用意して、対象のカードをアリスの手札に置く。
 * aliceExtra / bobExtra は山札に入れておくカード（テストごとに動かして使う）。
 */
function setup(
  sourceName: string,
  aliceExtra: readonly CardText[] = [],
  bobExtra: readonly CardText[] = [],
  rngSeed = `gold32-${sourceName}`,
): Table {
  const source = card(sourceName);
  const room = new Room({ code: 'T32GLD', rngSeed, cardPool: TEST_POOL });
  const alice = room.join('Alice', undefined, deck([source, ...aliceExtra, ...filler(10)])).playerId;
  const bob = room.join('Bob', undefined, deck([...bobExtra, ...filler(10)])).playerId;
  room.submitAction(alice, { type: 'setPhase', phase: 'turn' });

  const pick = (ownerId: string) => (functionalId: string, nth = 0) => {
    const found = Object.values(room.rawState.cards).filter(
      (instance) => instance.ownerId === ownerId && instance.functionalId === functionalId,
    )[nth];
    if (!found) throw new Error(`${functionalId} (#${nth}) が ${ownerId} にありません`);
    return found.instanceId;
  };

  const mine = pick(alice);
  const sourceId = mine(source.functionalId);
  room.submitAction(alice, { type: 'moveCard', cardId: sourceId, toZone: 'hand' });
  return { room, alice, bob, source: sourceId, mine, theirs: pick(bob) };
}

/** 応答待ちがなくなるまで答え続ける。count 省略時は上限まで選ぶ */
function finish(table: Table, counts: readonly number[] = []): void {
  const { room, alice, bob } = table;
  for (let i = 0; i < 20 && room.rawState.execution; i += 1) {
    const choice = room.rawState.execution.pendingChoice;
    if (!choice) break;
    const chooser = choice.chooser === bob ? bob : alice;
    const wanted = counts[i] ?? choice.max;
    const allowed = choice.allowedCounts
      ? ([...choice.allowedCounts].sort((a, b) => b - a).find((v) => v <= choice.candidates.length) ?? 0)
      : Math.min(wanted, choice.candidates.length);
    room.submitIntent(chooser, {
      type: 'resolveChoice',
      requestId: choice.requestId,
      selected: choice.candidates.slice(0, allowed),
    });
  }
}

/** 応答待ちの候補から、この instanceId を選んで答える */
function answerWith(table: Table, instanceIds: readonly string[]): void {
  const choice = table.room.rawState.execution?.pendingChoice;
  if (!choice) throw new Error('応答待ちではありません');
  const chooser = choice.chooser === table.bob ? table.bob : table.alice;
  table.room.submitIntent(chooser, {
    type: 'resolveChoice',
    requestId: choice.requestId,
    selected: [...instanceIds],
  });
}

const use = (table: Table) =>
  table.room.submitIntent(table.alice, { type: 'useCardEffect', instanceId: table.source });

const count = (table: Table, player: string, zone: Zone) =>
  cardsInZone(table.room.rawState, player, zone).length;

const zoneOf = (table: Table, instanceId: string) => table.room.rawState.cards[instanceId]?.zone;

const slots = (table: Table, player: string) => table.room.rawState.players[player]!.pokemon;

const activeTop = (table: Table, player: string) =>
  slots(table, player).find((slot) => slot.slotId === 'active')?.stack.at(-1);

/** 山札からベンチにポケモンを1匹置く */
function place(table: Table, player: string, instanceId: string, slotId: string): void {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'hand' });
  table.room.submitAction(player, {
    type: 'placePokemon',
    playerId: player,
    slotId: slotId as never,
    cardId: instanceId,
  });
}

const BASIC = card('ゼニガメ');
const DARK = card('ヤミカラス');
const METAL = card('コイル');
const WATER_ENERGY = card('基本水エネルギー');
const DARK_ENERGY = card('基本悪エネルギー');
const METAL_ENERGY = card('基本鋼エネルギー');
const FIRE_ENERGY = card('基本炎エネルギー');
const TOOL = card('がんじょうベルト');
const STADIUM = card('拡張フィールド');

// ── 定義そのものの確認 ──────────────────

describe('T32 定義', () => {
  it('指示された23枚がすべて AUTO の効果を持つ', () => {
    expect(names).toHaveLength(23);
    for (const name of names) {
      const entry = card(name);
      expect(entry.effects, name).toBeTruthy();
      // manual を含めば ASSISTED になる。T32 はすべて AUTO で書けているはず
      expect(JSON.stringify(entry.effects), name).not.toContain('"manual"');
    }
  });
});

// ── ★エクストラの根幹の2枚 ───────────────

describe('★バトルコンプレッサー', () => {
  it('山札から好きなカードを3枚トラッシュし、山札を切る', () => {
    const table = setup('バトルコンプレッサー');
    const deckBefore = count(table, table.alice, 'deck');
    const discardBefore = count(table, table.alice, 'discard');

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    // 山札の中身は選ぶ本人にだけ一時公開される
    expect(choice.chooser).toBe(table.alice);
    expect(choice.max).toBe(3);
    expect(choice.min).toBe(0); // 「3枚まで」なので0枚もあり
    const picked = choice.candidates.slice(0, 3);
    answerWith(table, picked);

    for (const id of picked) expect(zoneOf(table, id)).toBe('discard');
    expect(count(table, table.alice, 'deck')).toBe(deckBefore - 3);
    // 使ったバトルコンプレッサー自身もトラッシュに落ちている
    expect(count(table, table.alice, 'discard')).toBe(discardBefore + 4);
    expect(table.room.rawState.execution).toBeNull();
  });

  it('★選び終わったあと、山札の中身は誰にも見えない状態に戻る', () => {
    const table = setup('バトルコンプレッサー');
    use(table);
    finish(table, [1]);
    for (const instance of cardsInZone(table.room.rawState, table.alice, 'deck')) {
      expect(instance.visibleTo).toEqual([]);
    }
  });

  it('0枚選んでも成立する（「3枚まで」）', () => {
    const table = setup('バトルコンプレッサー');
    const deckBefore = count(table, table.alice, 'deck');
    use(table);
    answerWith(table, []);
    expect(count(table, table.alice, 'deck')).toBe(deckBefore);
    expect(table.room.rawState.execution).toBeNull();
  });
});

describe('★バトルサーチャー', () => {
  it('トラッシュのサポートを相手に見せて手札に加える', () => {
    const supporter = card('N');
    const table = setup('バトルサーチャー', [supporter, BASIC]);
    const nId = table.mine(supporter.functionalId);
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: nId, toZone: 'discard' });

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    // ★サポートだけが候補。ポケモンやグッズは出てこない
    expect(choice.candidates).toEqual([nId]);
    expect(choice.min).toBe(1);
    answerWith(table, [nId]);

    expect(zoneOf(table, nId)).toBe('hand');
    // 「相手に見せて」加えるので、相手にも見えたまま
    expect(table.room.rawState.cards[nId]?.visibleTo).toContain(table.bob);
  });

  it('トラッシュにサポートが1枚もなければ、何も起きずに終わる', () => {
    const table = setup('バトルサーチャー');
    use(table);
    expect(table.room.rawState.execution).toBeNull();
  });
});

// ── トラッシュから回収する ────────────────

describe('T32 トラッシュ回収', () => {
  it('レスキュータンカ: ポケモン1枚を手札に加える（選択肢A）', () => {
    const table = setup('レスキュータンカ', [BASIC]);
    const basicId = table.mine(BASIC.functionalId);
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: basicId, toZone: 'discard' });

    use(table);
    const option = table.room.rawState.execution!.pendingChoice!;
    expect(option.kind).toBe('selectOption');
    expect(option.optionLabels).toBeTruthy();
    answerWith(table, ['hand']);
    finish(table);

    expect(zoneOf(table, basicId)).toBe('hand');
  });

  it('レスキュータンカ: ポケモン3枚を山札にもどす（選択肢B）', () => {
    const basics = [card('ゼニガメ'), card('ヒトカゲ'), card('ピカチュウ')];
    const table = setup('レスキュータンカ', basics);
    const ids = basics.map((entry) => table.mine(entry.functionalId));
    for (const id of ids) {
      table.room.submitAction(table.alice, { type: 'moveCard', cardId: id, toZone: 'discard' });
    }

    use(table);
    answerWith(table, ['deck']);
    finish(table);

    for (const id of ids) expect(zoneOf(table, id)).toBe('deck');
  });

  it('夜のタンカ: ポケモンでも基本エネルギーでも選べる（anyOf）', () => {
    const table = setup('夜のタンカ', [BASIC, WATER_ENERGY, TOOL]);
    const basicId = table.mine(BASIC.functionalId);
    const energyId = table.mine(WATER_ENERGY.functionalId);
    const toolId = table.mine(TOOL.functionalId);
    for (const id of [basicId, energyId, toolId]) {
      table.room.submitAction(table.alice, { type: 'moveCard', cardId: id, toZone: 'discard' });
    }

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.candidates).toContain(basicId);
    expect(choice.candidates).toContain(energyId);
    // ★どうぐは対象外
    expect(choice.candidates).not.toContain(toolId);
    answerWith(table, [energyId]);
    expect(zoneOf(table, energyId)).toBe('hand');
  });

  it('スペシャルチャージ: 特殊エネルギーだけを2枚まで山札にもどす', () => {
    const table = setup('スペシャルチャージ', [SPECIAL_ENERGY, WATER_ENERGY]);
    const specialId = table.mine(SPECIAL_ENERGY.functionalId);
    const basicId = table.mine(WATER_ENERGY.functionalId);
    for (const id of [specialId, basicId]) {
      table.room.submitAction(table.alice, { type: 'moveCard', cardId: id, toZone: 'discard' });
    }

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    // ★基本エネルギーは候補に出ない
    expect(choice.candidates).toEqual([specialId]);
    answerWith(table, [specialId]);
    finish(table);

    expect(zoneOf(table, specialId)).toBe('deck');
    expect(zoneOf(table, basicId)).toBe('discard');
  });

  it('エネルギー回収: 基本エネルギーを2枚まで手札に加える', () => {
    const table = setup('エネルギー回収', [WATER_ENERGY, FIRE_ENERGY, SPECIAL_ENERGY]);
    const ids = [WATER_ENERGY, FIRE_ENERGY, SPECIAL_ENERGY].map((e) => table.mine(e.functionalId));
    for (const id of ids) {
      table.room.submitAction(table.alice, { type: 'moveCard', cardId: id, toZone: 'discard' });
    }

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.max).toBe(2);
    expect(choice.candidates).not.toContain(ids[2]); // 特殊エネルギーは対象外
    answerWith(table, choice.candidates.slice(0, 2));

    expect(zoneOf(table, ids[0]!)).toBe('hand');
    expect(zoneOf(table, ids[1]!)).toBe('hand');
  });

  it('スーパーエネルギー回収: 先に手札を2枚トラッシュしてから回収する', () => {
    const energies = [WATER_ENERGY, FIRE_ENERGY, DARK_ENERGY, METAL_ENERGY];
    const table = setup('スーパーエネルギー回収', energies);
    const energyIds = energies.map((e) => table.mine(e.functionalId));
    for (const id of energyIds) {
      table.room.submitAction(table.alice, { type: 'moveCard', cardId: id, toZone: 'discard' });
    }
    // 捨てるための手札を3枚用意する
    const handIds = cardsInZone(table.room.rawState, table.alice, 'deck')
      .slice(0, 3)
      .map((instance) => instance.instanceId);
    for (const id of handIds) {
      table.room.submitAction(table.alice, { type: 'moveCard', cardId: id, toZone: 'hand' });
    }

    use(table);
    // 1つめの応答＝コストの手札2枚
    const cost = table.room.rawState.execution!.pendingChoice!;
    expect(cost.max).toBe(2);
    answerWith(table, cost.candidates.slice(0, 2));
    // 2つめの応答＝トラッシュの基本エネルギー4枚まで
    const gain = table.room.rawState.execution!.pendingChoice!;
    expect(gain.max).toBe(4);
    answerWith(table, gain.candidates);

    for (const id of energyIds) expect(zoneOf(table, id)).toBe('hand');
  });

  it('炎の結晶: 基本炎エネルギーだけを3枚まで手札に加える', () => {
    const table = setup('炎の結晶', [FIRE_ENERGY, WATER_ENERGY]);
    const fireId = table.mine(FIRE_ENERGY.functionalId);
    const waterId = table.mine(WATER_ENERGY.functionalId);
    for (const id of [fireId, waterId]) {
      table.room.submitAction(table.alice, { type: 'moveCard', cardId: id, toZone: 'discard' });
    }

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.candidates).toEqual([fireId]);
    answerWith(table, [fireId]);
    expect(zoneOf(table, fireId)).toBe('hand');
  });
});

// ── トラッシュ・山札からエネルギーをつける ──

describe('T32 エネルギーをつける', () => {
  const patches: readonly [string, CardText, CardText][] = [
    ['ダークパッチ', DARK_ENERGY, DARK],
    ['アクアパッチ', WATER_ENERGY, BASIC],
    ['メタルソーサー', METAL_ENERGY, METAL],
  ];

  it.each(patches)('%s: トラッシュの基本エネルギーをベンチの該当タイプにつける', (name, energy, pokemon) => {
    const table = setup(name, [energy, pokemon, card('カビゴン')]);
    const energyId = table.mine(energy.functionalId);
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: energyId, toZone: 'discard' });
    place(table, table.alice, table.mine(card('カビゴン').functionalId), 'active');
    const benchId = table.mine(pokemon.functionalId);
    place(table, table.alice, benchId, 'bench-0');

    use(table);
    // 1. つける先のポケモンを選ぶ（★バトル場は候補に出ない）
    const target = table.room.rawState.execution!.pendingChoice!;
    expect(target.kind).toBe('selectSlot');
    expect(target.candidates).toEqual([benchId]);
    answerWith(table, [benchId]);
    // 2. つけるエネルギーを選ぶ
    answerWith(table, [energyId]);

    const bench = slots(table, table.alice).find((slot) => slot.slotId === 'bench-0');
    expect(bench?.attachedEnergy).toEqual([energyId]);
    expect(zoneOf(table, energyId)).toBe('bench');
  });

  it('ピーピーマックス: 山札の上6枚だけを見て、ベンチのたねポケモンにつける', () => {
    const table = setup('ピーピーマックス', [WATER_ENERGY, BASIC, card('カビゴン')]);
    place(table, table.alice, table.mine(card('カビゴン').functionalId), 'active');
    const benchId = table.mine(BASIC.functionalId);
    place(table, table.alice, benchId, 'bench-0');
    // 見えるところ（山札の一番上）にエネルギーを置く
    const energyId = table.mine(WATER_ENERGY.functionalId);
    table.room.submitAction(table.alice, {
      type: 'moveCard',
      cardId: energyId,
      toZone: 'deck',
      insertAt: 'top',
    });

    use(table);
    answerWith(table, [benchId]);
    const choice = table.room.rawState.execution!.pendingChoice!;
    // ★上から6枚しか見ない
    expect(choice.candidates.length).toBeLessThanOrEqual(6);
    expect(choice.candidates).toContain(energyId);
    answerWith(table, [energyId]);

    expect(slots(table, table.alice).find((s) => s.slotId === 'bench-0')?.attachedEnergy).toEqual([
      energyId,
    ]);
    // 残りは山札にもどして切るので、誰にも見えない
    for (const instance of cardsInZone(table.room.rawState, table.alice, 'deck')) {
      expect(instance.visibleTo).toEqual([]);
    }
  });
});

// ── 入れ替え ────────────────────────

describe('T32 入れ替え', () => {
  /** アリスとボブに バトル場1匹・ベンチ1匹 ずつ用意する */
  function withBoards(name: string, seed?: string): Table {
    const table = setup(
      name,
      [BASIC, card('カビゴン')],
      [card('ヒトカゲ'), card('ピカチュウ')],
      seed,
    );
    place(table, table.alice, table.mine(card('カビゴン').functionalId), 'active');
    place(table, table.alice, table.mine(BASIC.functionalId), 'bench-0');
    place(table, table.bob, table.theirs(card('ヒトカゲ').functionalId), 'active');
    place(table, table.bob, table.theirs(card('ピカチュウ').functionalId), 'bench-0');
    return table;
  }

  it('ポケモンいれかえ: 自分のバトルポケモンをベンチと入れ替える', () => {
    const table = withBoards('ポケモンいれかえ');
    const benchTop = slots(table, table.alice).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.chooser).toBe(table.alice);
    answerWith(table, [benchTop]);

    expect(activeTop(table, table.alice)).toBe(benchTop);
    expect(zoneOf(table, benchTop)).toBe('active');
  });

  it('★あなぬけのヒモ: 相手から先に、相手が自分で選んで入れ替える', () => {
    const table = withBoards('あなぬけのヒモ');
    const bobBench = slots(table, table.bob).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;
    const aliceBench = slots(table, table.alice).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;

    use(table);
    // ★選ぶのは相手自身（あなぬけのヒモは「それぞれ自分の」ポケモンを入れ替える）
    const first = table.room.rawState.execution!.pendingChoice!;
    expect(first.chooser).toBe(table.bob);
    answerWith(table, [bobBench]);

    const second = table.room.rawState.execution!.pendingChoice!;
    expect(second.chooser).toBe(table.alice);
    answerWith(table, [aliceBench]);

    expect(activeTop(table, table.bob)).toBe(bobBench);
    expect(activeTop(table, table.alice)).toBe(aliceBench);
  });

  it('★ボスの指令: 相手のベンチを、使った側が選んでバトル場に引きずり出す', () => {
    const table = withBoards('ボスの指令');
    const bobBench = slots(table, table.bob).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;
    const bobActiveBefore = activeTop(table, table.bob);

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    // ★選ぶのは相手ではなく自分
    expect(choice.chooser).toBe(table.alice);
    answerWith(table, [bobBench]);

    expect(activeTop(table, table.bob)).toBe(bobBench);
    expect(slots(table, table.bob).find((s) => s.slotId === 'bench-0')?.stack.at(-1)).toBe(
      bobActiveBefore,
    );
  });

  it('グズマ: 相手を引きずり出したあと、自分も入れ替える', () => {
    const table = withBoards('グズマ');
    const bobBench = slots(table, table.bob).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;
    const aliceBench = slots(table, table.alice).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;

    use(table);
    expect(table.room.rawState.execution!.pendingChoice!.chooser).toBe(table.alice);
    answerWith(table, [bobBench]);
    expect(table.room.rawState.execution!.pendingChoice!.chooser).toBe(table.alice);
    answerWith(table, [aliceBench]);

    expect(activeTop(table, table.bob)).toBe(bobBench);
    expect(activeTop(table, table.alice)).toBe(aliceBench);
  });

  /** ログに載ったコインの結果を読む（乱数はサーバーが振って Action に載る。§4.2） */
  const coinOf = (table: Table): string | undefined =>
    table.room.rawState.log
      .flatMap((entry) => (entry.action.type === 'effectStep' ? [entry.action.rolls?.coins] : []))
      .find((value) => value && value.length > 0)?.[0];

  /**
   * 指定した面が出るシードを探して卓を作る。
   * ★コインは乱数なので「たまたま通った」で済ませない。オモテ・ウラの両方を必ず確かめる。
   */
  function withCoin(face: 'heads' | 'tails'): Table {
    for (let i = 0; i < 40; i += 1) {
      const table = withBoards('ポケモンキャッチャー', `catcher-${face}-${i}`);
      use(table);
      if (coinOf(table) === face) return table;
    }
    throw new Error(`${face} が出るシードが見つかりません`);
  }

  it('★ポケモンキャッチャー: オモテなら相手を引きずり出す', () => {
    const table = withCoin('heads');
    const bobBench = slots(table, table.bob).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;

    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.chooser).toBe(table.alice);
    answerWith(table, [bobBench]);

    expect(activeTop(table, table.bob)).toBe(bobBench);
    expect(table.room.rawState.execution).toBeNull();
  });

  it('★ポケモンキャッチャー: ウラなら何も起きずに終わる', () => {
    const table = withCoin('tails');
    // if の else 枝が空なので、応答待ちにならずそのまま終わる
    expect(table.room.rawState.execution).toBeNull();
    expect(slots(table, table.bob).find((s) => s.slotId === 'bench-0')).toBeTruthy();
  });

  it('★クロススイッチャー: もう1枚を手札から捨ててから、両者を入れ替える', () => {
    const table = setup(
      'クロススイッチャー',
      [card('クロススイッチャー'), BASIC, card('カビゴン')],
      [card('ヒトカゲ'), card('ピカチュウ')],
    );
    place(table, table.alice, table.mine(card('カビゴン').functionalId), 'active');
    place(table, table.alice, table.mine(BASIC.functionalId), 'bench-0');
    place(table, table.bob, table.theirs(card('ヒトカゲ').functionalId), 'active');
    place(table, table.bob, table.theirs(card('ピカチュウ').functionalId), 'bench-0');

    // 2枚目を手札に用意する（2枚同時にしか使えないカード）
    const second = Object.values(table.room.rawState.cards).find(
      (instance) =>
        instance.ownerId === table.alice &&
        instance.functionalId === card('クロススイッチャー').functionalId &&
        instance.instanceId !== table.source,
    )!;
    table.room.submitAction(table.alice, {
      type: 'moveCard',
      cardId: second.instanceId,
      toZone: 'hand',
    });

    const bobBench = slots(table, table.bob).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;
    const aliceBench = slots(table, table.alice).find((s) => s.slotId === 'bench-0')!.stack.at(-1)!;

    use(table);
    // 1. コストの1枚。手札に同名カードが1枚しかないので、選ぶまでもなく落ちる
    expect(zoneOf(table, second.instanceId)).toBe('discard');

    // 2. 相手 → 3. 自分 の順に、どちらも使った側が選ぶ
    expect(table.room.rawState.execution!.pendingChoice!.chooser).toBe(table.alice);
    answerWith(table, [bobBench]);
    answerWith(table, [aliceBench]);

    expect(activeTop(table, table.bob)).toBe(bobBench);
    expect(activeTop(table, table.alice)).toBe(aliceBench);
    expect(table.room.rawState.execution).toBeNull();
  });
});

// ── 場からの除去 ────────────────────

describe('T32 場からの除去', () => {
  /**
   * おたがいのバトル場にポケモンを1匹ずつ置き、どうぐと特殊エネルギーをつける。
   * ★相手には特殊エネルギーを2枚つける。1枚しかないと「選ぶ余地がない」ので
   *   インタプリタが聞かずに自動で処理してしまい、候補の絞り込みを確かめられない。
   */
  function withAttachments(name: string): Table {
    const table = setup(
      name,
      [BASIC, TOOL, SPECIAL_ENERGY, STADIUM],
      [card('ヒトカゲ'), TOOL, SPECIAL_ENERGY, SPECIAL_ENERGY],
    );
    place(table, table.alice, table.mine(BASIC.functionalId), 'active');
    place(table, table.bob, table.theirs(card('ヒトカゲ').functionalId), 'active');

    const attach = (player: string, cardId: string, as: 'tool' | 'energy') => {
      table.room.submitAction(player, { type: 'moveCard', cardId, toZone: 'hand' });
      table.room.submitAction(player, {
        type: 'attachCard',
        playerId: player,
        slotId: 'active',
        cardId,
        as,
      });
    };
    attach(table.alice, table.mine(TOOL.functionalId), 'tool');
    attach(table.alice, table.mine(SPECIAL_ENERGY.functionalId), 'energy');
    attach(table.bob, table.theirs(TOOL.functionalId), 'tool');
    attach(table.bob, table.theirs(SPECIAL_ENERGY.functionalId, 0), 'energy');
    attach(table.bob, table.theirs(SPECIAL_ENERGY.functionalId, 1), 'energy');
    return table;
  }

  it('フィールドブロアー: どうぐとスタジアムを2枚までトラッシュする', () => {
    const table = withAttachments('フィールドブロアー');
    const stadiumOwner = table.mine(STADIUM.functionalId, 0);
    table.room.submitAction(table.alice, { type: 'setStadium', cardId: stadiumOwner });

    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.max).toBe(2);
    expect(choice.candidates).toContain(table.mine(TOOL.functionalId));
    expect(choice.candidates).toContain(stadiumOwner);
    // ★特殊エネルギーは対象外（どうぐとスタジアムだけ）
    expect(choice.candidates).not.toContain(table.mine(SPECIAL_ENERGY.functionalId));

    const picked = [table.mine(TOOL.functionalId), table.theirs(TOOL.functionalId)];
    answerWith(table, picked);
    for (const id of picked) expect(zoneOf(table, id)).toBe('discard');
  });

  it('ツールスクラッパー: おたがいのどうぐを2枚まで', () => {
    const table = withAttachments('ツールスクラッパー');
    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.candidates).toContain(table.mine(TOOL.functionalId));
    expect(choice.candidates).toContain(table.theirs(TOOL.functionalId));
    expect(choice.candidates).not.toContain(table.theirs(SPECIAL_ENERGY.functionalId));

    answerWith(table, [table.mine(TOOL.functionalId), table.theirs(TOOL.functionalId)]);
    expect(zoneOf(table, table.mine(TOOL.functionalId))).toBe('discard');
    expect(zoneOf(table, table.theirs(TOOL.functionalId))).toBe('discard');
    expect(
      slots(table, table.bob).find((slot) => slot.slotId === 'active')?.attachedTool,
    ).toBeNull();
  });

  it('クセロシキ: どうぐか特殊エネルギーのうち1枚（anyOf）', () => {
    const table = withAttachments('クセロシキ');
    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.max).toBe(1);
    expect(choice.candidates).toContain(table.theirs(TOOL.functionalId));
    expect(choice.candidates).toContain(table.theirs(SPECIAL_ENERGY.functionalId));

    answerWith(table, [table.theirs(SPECIAL_ENERGY.functionalId)]);
    expect(zoneOf(table, table.theirs(SPECIAL_ENERGY.functionalId))).toBe('discard');
  });

  it('★改造ハンマー: 相手の特殊エネルギーだけが候補になる', () => {
    const table = withAttachments('改造ハンマー');
    use(table);
    const choice = table.room.rawState.execution!.pendingChoice!;
    expect(choice.max).toBe(1);
    expect(choice.candidates).toEqual([
      table.theirs(SPECIAL_ENERGY.functionalId, 0),
      table.theirs(SPECIAL_ENERGY.functionalId, 1),
    ]);
    // ★自分のものも、どうぐも対象外
    expect(choice.candidates).not.toContain(table.mine(SPECIAL_ENERGY.functionalId));
    expect(choice.candidates).not.toContain(table.theirs(TOOL.functionalId));

    const picked = table.theirs(SPECIAL_ENERGY.functionalId, 0);
    answerWith(table, [picked]);
    expect(zoneOf(table, picked)).toBe('discard');
    expect(
      slots(table, table.bob).find((slot) => slot.slotId === 'active')?.attachedEnergy,
    ).toEqual([table.theirs(SPECIAL_ENERGY.functionalId, 1)]);
  });

  it('相手の特殊エネルギーが1枚しかないなら、選ばせずにそのままトラッシュする', () => {
    const table = setup('改造ハンマー', [BASIC], [card('ヒトカゲ'), SPECIAL_ENERGY]);
    place(table, table.alice, table.mine(BASIC.functionalId), 'active');
    place(table, table.bob, table.theirs(card('ヒトカゲ').functionalId), 'active');
    const energyId = table.theirs(SPECIAL_ENERGY.functionalId);
    table.room.submitAction(table.bob, { type: 'moveCard', cardId: energyId, toZone: 'hand' });
    table.room.submitAction(table.bob, {
      type: 'attachCard',
      playerId: table.bob,
      slotId: 'active',
      cardId: energyId,
      as: 'energy',
    });

    use(table);
    // 選ぶ余地がないので応答待ちにならない
    expect(table.room.rawState.execution).toBeNull();
    expect(zoneOf(table, energyId)).toBe('discard');
  });

  it('ポケモンレンジャー: ワザによる効果だけを消し、それ以外は残す', () => {
    const table = setup('ポケモンレンジャー', [BASIC]);
    place(table, table.alice, table.mine(BASIC.functionalId), 'active');

    const base = {
      target: { slotId: `${table.alice}/active` },
      applyAt: 'none' as const,
      kind: 'cannotRetreat' as const,
      payload: {},
      duration: { type: 'thisTurn' as const },
      expiresOn: [],
      createdOnTurn: 1,
    };
    table.room.rawState.effects = [
      {
        ...base,
        effectId: 'from-attack',
        source: { instanceId: null, playerId: table.bob, label: 'ワザ', attackIndex: 0 },
      },
      {
        ...base,
        effectId: 'from-ability',
        source: { instanceId: null, playerId: table.bob, label: '特性', abilityIndex: 0 },
      },
    ];

    use(table);
    finish(table);

    const remaining = table.room.rawState.effects.map((effect) => effect.effectId);
    expect(remaining).toEqual(['from-ability']);
  });
});

// ── T29 との組み合わせ ────────────────

/**
 * T32 は「対象がいなければ何も起きない」カードの塊なので、
 * T29 の「状況が変化しないなら使えない」がいちばん効く場所になる。
 *
 * ★ただし **止めない**（第2段階 §2）。警告をログに残して、操作はそのまま通す。
 */
describe('T32 × T29 状況が変化しないとき', () => {
  const warningsFor = (table: Table): string[] =>
    table.room.rawState.log
      .filter((entry) => entry.action.type === 'startEffect')
      .flatMap((entry) => entry.warnings.map((warning) => warning.code));

  const cases: readonly [string, (table: Table) => void][] = [
    // トラッシュにサポートが1枚もない
    ['バトルサーチャー', () => {}],
    // トラッシュに基本エネルギーが1枚もない
    ['エネルギー回収', () => {}],
    // 相手の場に特殊エネルギーが1枚もない
    [
      '改造ハンマー',
      (table) => {
        place(table, table.bob, table.theirs(card('ヒトカゲ').functionalId), 'active');
      },
    ],
    // ベンチが空なので入れ替えられない
    [
      'ポケモンいれかえ',
      (table) => {
        place(table, table.alice, table.mine(BASIC.functionalId), 'active');
      },
    ],
  ];

  it.each(cases)('%s: 警告は出るが、操作は通る', (name, prepare) => {
    const table = setup(name, [BASIC], [card('ヒトカゲ')]);
    prepare(table);

    use(table);

    // ★グッズなので「そもそも使えない」と警告される
    expect(warningsFor(table)).toContain('EFFECT_NO_CHANGE');
    // ★それでも操作は通る。カードはトラッシュに落ち、処理は終わっている
    expect(zoneOf(table, table.source)).toBe('discard');
    expect(table.room.rawState.execution).toBeNull();
  });

  it('★対象がいれば警告は出ない', () => {
    const table = setup('バトルサーチャー', [card('N')]);
    const nId = table.mine(card('N').functionalId);
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: nId, toZone: 'discard' });

    use(table);
    expect(warningsFor(table)).not.toContain('EFFECT_NO_CHANGE');
  });
});
