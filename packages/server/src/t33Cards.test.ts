/**
 * T33: エネルギー・スタジアム・どうぐ（24枚）。
 * §7-4 のとおり、1枚ずつ「初期状態 → 使う/場に出す → 期待する状態」で確かめる。
 *
 * ★T33 の肝は、特殊エネルギーの「何個ぶんはたらくか」を **固定値にしないこと**。
 *   仕組みそのものの試験は shared/src/energyValue.test.ts。
 *   ここでは **実データ（data/cards/t33.json）** が正しく書けているかを見る。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCardIndex,
  canPayCost,
  cardsInZone,
  continuousDamageModifier,
  energyCountOn,
  energyOnSlot,
  getBenchLimit,
  getEffectiveAbilities,
  getRetreatCost,
  ignoresWeakness,
  effectSlotKey,
  type CardText,
  type RuleContext,
} from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const pool = loadCardTexts();

const names = [
  // 特殊エネルギー（10）
  'ダブル無色エネルギー', 'ダブルターボエネルギー', 'ツインエネルギー', 'トリプル加速エネルギー',
  'ダブルドラゴンエネルギー', 'レインボーエネルギー', 'プリズムエネルギー', 'ユニットエネルギー闘悪妖',
  'ストロングエネルギー', 'ウィークガードエネルギー',
  // スタジアム（8）
  // ★「ムゲンゾーン」は拡張パック名で、スタジアムカードではなかった（実物照合で判明）。
  //   ベンチ8はムゲンダイナVMAXの特性。t42 にある
  'スカイフィールド', '頂への雪道', 'サイレントラボ',
  'シンオウ神殿', '無人発電所', '巨大なカマド', 'トレーニングコート',
  // どうぐ（7）
  'ふうせん', 'かるいし', 'ちからのハチマキ', 'こだわりハチマキ',
  'たつじんのおび', 'げんきのハチマキ', '森の封印石',
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

const filler = (n: number) => pool.filter((entry) => !entry.effects && !entry.continuous).slice(0, n);

interface Table {
  room: Room;
  alice: string;
  bob: string;
  mine: (functionalId: string, nth?: number) => string;
  theirs: (functionalId: string, nth?: number) => string;
}

function setup(aliceExtra: readonly CardText[] = [], bobExtra: readonly CardText[] = []): Table {
  const room = new Room({ code: 'T33GLD', rngSeed: 'gold33', cardPool: pool });
  const alice = room.join('Alice', undefined, deck([...aliceExtra, ...filler(8)])).playerId;
  const bob = room.join('Bob', undefined, deck([...bobExtra, ...filler(8)])).playerId;
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

/** 派生状態の計算にはカード定義が要る。Room と同じプールから組む */
const CTX: RuleContext = { cards: buildCardIndex(pool) };
const ctxOf = (_table: Table): RuleContext => CTX;

function place(table: Table, player: string, instanceId: string, slotId: string): void {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'hand' });
  table.room.submitAction(player, {
    type: 'placePokemon',
    playerId: player,
    slotId: slotId as never,
    cardId: instanceId,
  });
}

function attach(
  table: Table,
  player: string,
  instanceId: string,
  as: 'energy' | 'tool',
  slotId = 'active',
): void {
  table.room.submitAction(player, { type: 'moveCard', cardId: instanceId, toZone: 'hand' });
  table.room.submitAction(player, {
    type: 'attachCard',
    playerId: player,
    slotId: slotId as never,
    cardId: instanceId,
    as,
  });
}

function setStadium(table: Table, player: string, instanceId: string): void {
  table.room.submitAction(player, { type: 'setStadium', cardId: instanceId });
}

/** 応答待ちがなくなるまで答える */
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

const BASIC = card('ゼニガメ');
const DRAGON = card('ミニリュウ');
const FIGHTER = card('イワーク');
const STAGE1 = card('カメール');
const EX_MON = card('リザードンex');
const YAMIKARASU = card('ヤミカラス');

// ── 定義そのものの確認 ──────────────────

describe('T33 定義', () => {
  it('指示された24枚が揃っている', () => {
    expect(names).toHaveLength(24);
    for (const name of names) expect(card(name), name).toBeTruthy();
  });

  it('★特殊エネルギーは energyValue を持ち、基本エネルギーは持たない', () => {
    const specials = names
      .map(card)
      .filter((entry) => entry.supertype === 'energy' && entry.isBasicEnergy === false);
    expect(specials).toHaveLength(10);
    for (const entry of specials) {
      expect(entry.energyValue, entry.name).toBeTruthy();
    }
    for (const entry of pool.filter((e) => e.isBasicEnergy)) {
      expect(entry.energyValue, entry.name).toBeUndefined();
    }
  });
});

// ── ★特殊エネルギー（実データ） ─────────

describe('★特殊エネルギー: つけた相手で「何個ぶん」が変わる', () => {
  /** pokemonName のポケモンをバトル場に置き、energyName をつけた盤面を作る */
  function attached(pokemon: CardText, energyName: string): Table {
    const energy = card(energyName);
    const table = setup([pokemon, energy]);
    place(table, table.alice, table.mine(pokemon.functionalId), 'active');
    attach(table, table.alice, table.mine(energy.functionalId), 'energy');
    return table;
  }

  const valueOf = (table: Table) => energyOnSlot(table.room.rawState, table.alice, 'active', ctxOf(table))[0]!;

  const cases: readonly [string, string, number][] = [
    ['ダブル無色エネルギー', BASIC.name, 2],
    ['ダブルターボエネルギー', BASIC.name, 2],
    ['レインボーエネルギー', BASIC.name, 1],
    ['ユニットエネルギー闘悪妖', BASIC.name, 1],
    ['ウィークガードエネルギー', BASIC.name, 1],
    ['プリズムエネルギー', BASIC.name, 1],
    ['プリズムエネルギー', STAGE1.name, 0],
    ['ツインエネルギー', BASIC.name, 2],
    ['ツインエネルギー', EX_MON.name, 0],
    ['トリプル加速エネルギー', BASIC.name, 0],
    ['トリプル加速エネルギー', STAGE1.name, 3],
    ['ダブルドラゴンエネルギー', DRAGON.name, 2],
    ['ダブルドラゴンエネルギー', BASIC.name, 0],
    ['ストロングエネルギー', FIGHTER.name, 1],
    ['ストロングエネルギー', BASIC.name, 0],
  ];

  it.each(cases)('%s を %s につけると %i 個ぶん', (energyName, pokemonName, amount) => {
    expect(valueOf(attached(card(pokemonName), energyName)).amount).toBe(amount);
  });

  it('ダブルドラゴンエネルギーは「好きなタイプ」として払える', () => {
    const table = attached(DRAGON, 'ダブルドラゴンエネルギー');
    const values = energyOnSlot(table.room.rawState, table.alice, 'active', ctxOf(table));
    expect(canPayCost(['fire', 'water'], values)).toBe(true);
  });

  it('ユニットエネルギー闘悪妖は3タイプのどれか1個ぶん（雷は払えない）', () => {
    const table = attached(BASIC, 'ユニットエネルギー闘悪妖');
    const values = energyOnSlot(table.room.rawState, table.alice, 'active', ctxOf(table));
    expect(canPayCost(['darkness'], values)).toBe(true);
    expect(canPayCost(['lightning'], values)).toBe(false);
  });
});

// ── ★シンオウ神殿 ───────────────────

describe('★シンオウ神殿', () => {
  function board(): Table {
    const table = setup([DRAGON, card('ダブルドラゴンエネルギー'), card('シンオウ神殿')]);
    place(table, table.alice, table.mine(DRAGON.functionalId), 'active');
    attach(table, table.alice, table.mine(card('ダブルドラゴンエネルギー').functionalId), 'energy');
    return table;
  }

  it('出す前は好きなタイプ2個ぶん', () => {
    const table = board();
    expect(energyCountOn(table.room.rawState, table.alice, 'active', ctxOf(table))).toBe(2);
  });

  it('★出すと無色1個ぶんに落ちる', () => {
    const table = board();
    setStadium(table, table.alice, table.mine(card('シンオウ神殿').functionalId));
    const value = energyOnSlot(table.room.rawState, table.alice, 'active', ctxOf(table))[0]!;
    expect(value).toMatchObject({ types: ['colorless'], amount: 1 });
  });

  it('★片づけると2個ぶんに戻る（解除処理を書いていない）', () => {
    const table = board();
    setStadium(table, table.alice, table.mine(card('シンオウ神殿').functionalId));
    table.room.submitAction(table.alice, { type: 'setStadium', cardId: null });
    expect(energyCountOn(table.room.rawState, table.alice, 'active', ctxOf(table))).toBe(2);
  });
});

// ── スタジアム ─────────────────────

describe('T33 スタジアム', () => {
  it.each(['スカイフィールド'] as const)('%s: ベンチ上限が8になる', (name) => {
    const table = setup([card(name)]);
    expect(getBenchLimit(table.room.rawState, table.alice, ctxOf(table))).toBe(5);
    setStadium(table, table.alice, table.mine(card(name).functionalId));
    expect(getBenchLimit(table.room.rawState, table.alice, ctxOf(table))).toBe(8);
    // ★相手にも及ぶ（scope: all）
    expect(getBenchLimit(table.room.rawState, table.bob, ctxOf(table))).toBe(8);
  });

  it('★頂への雪道: ルールを持つポケモンの特性だけが止まる', () => {
    const table = setup([EX_MON, YAMIKARASU, card('頂への雪道')]);
    place(table, table.alice, table.mine(EX_MON.functionalId), 'active');
    place(table, table.alice, table.mine(YAMIKARASU.functionalId), 'bench-0');

    const key = (slot: string) => effectSlotKey(table.alice, slot as never);
    expect(getEffectiveAbilities(table.room.rawState, key('active'), ctxOf(table))).toHaveLength(1);

    setStadium(table, table.alice, table.mine(card('頂への雪道').functionalId));
    // ルールを持つリザードンex は止まる
    expect(getEffectiveAbilities(table.room.rawState, key('active'), ctxOf(table))).toHaveLength(0);
    // ルールを持たないヤミカラスは止まらない
    expect(
      getEffectiveAbilities(table.room.rawState, key('bench-0'), ctxOf(table)).length,
    ).toBeGreaterThan(0);
  });

  it('★サイレントラボ: たねポケモンの特性だけが止まる', () => {
    const table = setup([YAMIKARASU, EX_MON, card('サイレントラボ')]);
    place(table, table.alice, table.mine(YAMIKARASU.functionalId), 'active');
    place(table, table.alice, table.mine(EX_MON.functionalId), 'bench-0');
    setStadium(table, table.alice, table.mine(card('サイレントラボ').functionalId));

    const key = (slot: string) => effectSlotKey(table.alice, slot as never);
    // たねのヤミカラスは止まる
    expect(getEffectiveAbilities(table.room.rawState, key('active'), ctxOf(table))).toHaveLength(0);
    // 2進化のリザードンex は止まらない
    expect(
      getEffectiveAbilities(table.room.rawState, key('bench-0'), ctxOf(table)).length,
    ).toBeGreaterThan(0);
  });

  it('★無人発電所: GX・EX が対象。小文字の ex は別物なので止まらない', () => {
    const table = setup([EX_MON, card('無人発電所')]);
    place(table, table.alice, table.mine(EX_MON.functionalId), 'active');
    setStadium(table, table.alice, table.mine(card('無人発電所').functionalId));
    expect(
      getEffectiveAbilities(table.room.rawState, effectSlotKey(table.alice, 'active'), ctxOf(table)),
    ).toHaveLength(1);
  });

  it('巨大なカマド: 基本炎エネルギーを2枚捨てて、炎ポケモンを手札に加える', () => {
    const fire = card('基本炎エネルギー');
    const firePokemon = card('ヒトカゲ');
    const stadium = card('巨大なカマド');
    const table = setup([stadium, fire, fire, firePokemon]);
    const stadiumId = table.mine(stadium.functionalId);
    setStadium(table, table.alice, stadiumId);
    for (let i = 0; i < 2; i += 1) {
      table.room.submitAction(table.alice, {
        type: 'moveCard',
        cardId: table.mine(fire.functionalId, i),
        toZone: 'hand',
      });
    }

    table.room.submitIntent(table.alice, { type: 'useCardEffect', instanceId: stadiumId });
    finish(table);

    for (let i = 0; i < 2; i += 1) {
      expect(table.room.rawState.cards[table.mine(fire.functionalId, i)]?.zone).toBe('discard');
    }
    // 山札の炎ポケモンが1枚、手札に来ている
    const gained = cardsInZone(table.room.rawState, table.alice, 'hand')
      .map((instance) => pool.find((entry) => entry.functionalId === instance.functionalId))
      .filter((entry) => entry?.supertype === 'pokemon' && entry.types?.includes('fire'));
    expect(gained.length).toBeGreaterThan(0);
    // ★スタジアム自身は場に残る
    expect(table.room.rawState.stadium).toBe(stadiumId);
  });

  it('トレーニングコート: トラッシュの基本エネルギーを1枚手札に加える', () => {
    const energy = card('基本水エネルギー');
    const stadium = card('トレーニングコート');
    const table = setup([stadium, energy]);
    const stadiumId = table.mine(stadium.functionalId);
    setStadium(table, table.alice, stadiumId);
    const energyId = table.mine(energy.functionalId);
    table.room.submitAction(table.alice, { type: 'moveCard', cardId: energyId, toZone: 'discard' });

    table.room.submitIntent(table.alice, { type: 'useCardEffect', instanceId: stadiumId });
    finish(table);

    expect(table.room.rawState.cards[energyId]?.zone).toBe('hand');
  });
});

// ── どうぐ ─────────────────────────

describe('T33 どうぐ', () => {
  /** アリスのバトル場に BASIC を置き、どうぐをつける */
  function withTool(toolName: string, defender: CardText = BASIC): Table {
    const tool = card(toolName);
    const table = setup([BASIC, tool], [defender]);
    place(table, table.alice, table.mine(BASIC.functionalId), 'active');
    place(table, table.bob, table.theirs(defender.functionalId), 'active');
    attach(table, table.alice, table.mine(tool.functionalId), 'tool');
    return table;
  }

  const step2 = (table: Table, ctx: RuleContext = ctxOf(table)) =>
    continuousDamageModifier(
      table.room.rawState,
      { playerId: table.alice, slotId: 'active' },
      { playerId: table.bob, slotId: 'active' },
      'step2',
      ctx,
    );

  it('ふうせん: にげるためのエネルギーが2個ぶん少なくなる', () => {
    const table = withTool('ふうせん');
    // ゼニガメの にげる は1。−2 で0になる（0未満にはならない）
    expect(getRetreatCost(table.room.rawState, table.alice, 'active', ctxOf(table))).toBe(0);
  });

  it('★かるいし: にげるためのエネルギーがなくなる', () => {
    const heavy = card('カビゴン');
    const table = setup([heavy, card('かるいし')]);
    place(table, table.alice, table.mine(heavy.functionalId), 'active');
    expect(
      getRetreatCost(table.room.rawState, table.alice, 'active', ctxOf(table)),
    ).toBeGreaterThan(0);

    attach(table, table.alice, table.mine(card('かるいし').functionalId), 'tool');
    expect(getRetreatCost(table.room.rawState, table.alice, 'active', ctxOf(table))).toBe(0);
  });

  it('ちからのハチマキ: +20', () => {
    expect(step2(withTool('ちからのハチマキ')).delta).toBe(20);
  });

  it('げんきのハチマキ: +10', () => {
    expect(step2(withTool('げんきのハチマキ')).delta).toBe(10);
  });

  it('★こだわりハチマキ: 相手がルールを持つときだけ +30', () => {
    expect(step2(withTool('こだわりハチマキ')).delta).toBe(0);
    // リザードンex は ruleBox 'ex'。こだわりハチマキが見るのは V / GX なので効かない
    expect(step2(withTool('こだわりハチマキ', EX_MON)).delta).toBe(0);
  });

  it('★たつじんのおび: 相手がポケモンEXのときだけ +30', () => {
    expect(step2(withTool('たつじんのおび')).delta).toBe(0);
    const exCard: CardText = { ...EX_MON, functionalId: 'gold-EX', name: 'テストEX', ruleBox: 'EX' };
    const tool = card('たつじんのおび');
    const room = new Room({ code: 'T33BLT', rngSeed: 'belt', cardPool: [...pool, exCard] });
    const alice = room.join('A', undefined, deck([BASIC, tool])).playerId;
    const bob = room.join('B', undefined, deck([exCard])).playerId;
    room.submitAction(alice, { type: 'setPhase', phase: 'turn' });
    const table: Table = {
      room,
      alice,
      bob,
      mine: (fid, nth = 0) =>
        Object.values(room.rawState.cards).filter((c) => c.ownerId === alice && c.functionalId === fid)[nth]!
          .instanceId,
      theirs: (fid, nth = 0) =>
        Object.values(room.rawState.cards).filter((c) => c.ownerId === bob && c.functionalId === fid)[nth]!
          .instanceId,
    };
    place(table, alice, table.mine(BASIC.functionalId), 'active');
    place(table, bob, table.theirs(exCard.functionalId), 'active');
    attach(table, alice, table.mine(tool.functionalId), 'tool');
    expect(step2(table, { cards: buildCardIndex([...pool, exCard]) }).delta).toBe(30);
  });

  it('★どうぐを外すと、次の計算から効果が消える', () => {
    const table = withTool('ちからのハチマキ');
    expect(step2(table).delta).toBe(20);
    table.room.submitAction(table.alice, {
      type: 'detachCard',
      playerId: table.alice,
      slotId: 'active',
      cardId: table.mine(card('ちからのハチマキ').functionalId),
      toZone: 'discard',
    });
    expect(step2(table).delta).toBe(0);
  });

  it('森の封印石: 山札から好きなカードを1枚手札に加える', () => {
    const tool = card('森の封印石');
    const table = setup([BASIC, tool]);
    place(table, table.alice, table.mine(BASIC.functionalId), 'active');
    const toolId = table.mine(tool.functionalId);
    attach(table, table.alice, toolId, 'tool');

    const handBefore = cardsInZone(table.room.rawState, table.alice, 'hand').length;
    table.room.submitIntent(table.alice, { type: 'useCardEffect', instanceId: toolId });
    finish(table);
    expect(cardsInZone(table.room.rawState, table.alice, 'hand').length).toBe(handBefore + 1);
  });
});

// ── ウィークガードエネルギー ──────────

describe('★ウィークガードエネルギー（実データ）', () => {
  it('つけたポケモンは弱点を計算しない', () => {
    const guard = card('ウィークガードエネルギー');
    const table = setup([], [FIGHTER, guard]);
    place(table, table.bob, table.theirs(FIGHTER.functionalId), 'active');
    expect(ignoresWeakness(table.room.rawState, table.bob, 'active', ctxOf(table))).toBe(false);

    attach(table, table.bob, table.theirs(guard.functionalId), 'energy');
    expect(ignoresWeakness(table.room.rawState, table.bob, 'active', ctxOf(table))).toBe(true);
  });
});
