/**
 * T9 の完了条件:
 * 「すべての原子操作がUIから実行できる」
 *
 * メニューの組み立てを純粋関数にしてあるので、
 * 全メニューを実際に組んで、Action の全種類が現れることを機械的に確かめられる。
 */
import { describe, expect, it } from 'vitest';
import { buildCardIndex, cardsInZone, type ActionType, type GameState } from '@pokeca/shared';
import { buildMenu, producedActionTypes, type MenuContext, type MenuItem } from './menus';
import { buildDemoState, DEMO_ME } from '../cards/demoState';
import { sampleCardIndex } from '../cards/sampleCards';

const state = buildDemoState()!;

const ctx = (over: Partial<MenuContext> = {}): MenuContext => ({
  state,
  cardIndex: sampleCardIndex,
  viewerId: DEMO_ME,
  canRandomize: true,
  ...over,
});

const handCardId = cardsInZone(state, DEMO_ME, 'hand')[0]!.instanceId;

/** 画面上で開けるメニューをすべて組む */
function allMenus(context: MenuContext = ctx()): MenuItem[] {
  const s: GameState = context.state;
  const items: MenuItem[] = [];
  items.push(...buildMenu(context, { kind: 'table' }).items);
  items.push(...buildMenu(context, { kind: 'card', instanceId: handCardId }).items);
  for (const slot of s.players[DEMO_ME]?.pokemon ?? []) {
    items.push(...buildMenu(context, { kind: 'slot', playerId: DEMO_ME, slotId: slot.slotId }).items);
  }
  for (const zone of ['deck', 'hand', 'discard', 'prize', 'lost'] as const) {
    items.push(...buildMenu(context, { kind: 'zone', playerId: DEMO_ME, zone }).items);
  }
  return items;
}

/**
 * 対戦準備でしか使わない操作。専用の画面（SetupFlow）から実行するので、
 * 盤面のコンテキストメニューには載せない。
 */
const SETUP_ACTION_TYPES = [
  'setSetupStep',
  'setJankenWinner',
  'setFirstPlayer',
  'recordMulligan',
  'declareBonusDraw',
  'setSetupReady',
] as const satisfies readonly ActionType[];

/** 盤面のメニュー以外から出る操作。参加はサーバー、取り消しはログパネルが担当 */
const ELSEWHERE_ACTION_TYPES = [
  'addPlayer',
  'requestUndo',
  'resolveUndo',
  'resolvePokemonCheckTarget',
  'detectDefeat',
  'confirmGameEnd',
  'applyDamageCalculation',
  // カード効果の実行（T24）。開始も1歩ごとの前進もサーバーが回す
  'startEffect',
  'effectStep',
  'resolveChoice',
  'cancelEffect',
  // かかっている効果は盤面のバッジから直接外す（§5.2）
  'removeEffect',
  // 対戦中1回の枠は ★プレイヤー単位 なので、HUD のバッジから直接戻す（T36）
  'setOncePerGameUsed',
  // V-UNION は専用の組み立てパネルから出す（T38）
  'assembleVUnion',
] as const satisfies readonly ActionType[];

/** 盤面のメニューから実行できるべき Action */
const ALL_ACTION_TYPES = [
  'setupDeck',
  'moveCard',
  'shuffleDeck',
  'shuffleIntoDeck',
  'drawCards',
  'setFaceUp',
  'setCardVisibility',
  'placePokemon',
  'evolvePokemon',
  'devolvePokemon',
  'attachCard',
  'detachCard',
  'movePokemon',
  'removePokemon',
  'knockOut',
  'adjustDamage',
  'setDamage',
  'setCondition',
  'clearConditions',
  'setNotes',
  'useAttack',
  'grantAttack',
  'clearGrantedAttacks',
  'setBenchLimit',
  'setPrizes',
  'setTurnFlag',
  'setPlayerName',
  'setPhase',
  'endTurn',
  'insertExtraTurn',
  'setActivePlayer',
  'setStadium',
  'flipCoin',
  'randomChoice',
  'note',
] as const satisfies readonly ActionType[];

/**
 * ★どのリストにも入れ忘れた Action があれば、ここで **型エラー** になる。
 *   新しい操作を足したとき「UIから実行できるか」を必ず一度考えることになる。
 */
type Uncovered = Exclude<
  ActionType,
  | (typeof SETUP_ACTION_TYPES)[number]
  | (typeof ELSEWHERE_ACTION_TYPES)[number]
  | (typeof ALL_ACTION_TYPES)[number]
>;
type AssertNever<T extends never> = T;
export type _AllActionsAccountedFor = AssertNever<Uncovered>;

describe('★すべての原子操作がUIから実行できる', () => {
  it('盤面の操作がすべてどこかのメニューに現れる', () => {
    const produced = producedActionTypes(allMenus());
    const missing = ALL_ACTION_TYPES.filter((t) => !produced.has(t));
    expect(missing, `メニューから実行できない操作: ${missing.join(', ')}`).toEqual([]);
  });

  it('メニューに載っていない未知の操作がない', () => {
    const produced = [...producedActionTypes(allMenus())];
    const expected: readonly ActionType[] = ALL_ACTION_TYPES;
    const unknown = produced.filter((t) => !expected.includes(t));
    expect(unknown).toEqual([]);
  });

  it('対戦準備・参加・取り消しは別のUIが担当するので、盤面メニューには載せない', () => {
    const produced = producedActionTypes(allMenus());
    for (const type of [...SETUP_ACTION_TYPES, ...ELSEWHERE_ACTION_TYPES]) {
      expect(produced.has(type), `${type} が盤面メニューに混ざっている`).toBe(false);
    }
  });
});

describe('§6.6 が名指しする操作がカードのメニューに揃っている', () => {
  const required = [
    '手札へ',
    '山札の上へ',
    '山札の下へ',
    '山札に加えて切る',
    'トラッシュへ',
    'ロストゾーンへ',
    'サイドへ',
    'バトル場へ',
    'ベンチへ',
  ];

  it.each(required)('「%s」がある', (label) => {
    const { items } = buildMenu(ctx(), { kind: 'card', instanceId: handCardId });
    expect(items.some((i) => i.label === label)).toBe(true);
  });

  it('オモテ/ウラの反転と相手への公開がある', () => {
    const { items } = buildMenu(ctx(), { kind: 'card', instanceId: handCardId });
    expect(items.some((i) => i.label === 'オモテにする' || i.label === 'ウラにする')).toBe(true);
    expect(items.some((i) => i.label === '相手に公開' || i.label === '公開をやめる')).toBe(true);
  });

  it('AUTO/ASSISTEDだけカード定義の効果を開始し、MANUALは従来の手動操作だけを出す', () => {
    const base = sampleCardIndex.byFunctionalId.get(state.cards[handCardId]!.functionalId)!;
    const menuFor = (effects: typeof base.effects) => {
      const cardIndex = buildCardIndex([{ ...base, effects }]);
      return buildMenu(ctx({ cardIndex }), { kind: 'card', instanceId: handCardId }).items;
    };

    expect(menuFor(null).some((item) => item.id === 'use-card-effect')).toBe(false);

    const auto = menuFor([{ op: 'draw', player: 'self', count: 1 }]).find(
      (item) => item.id === 'use-card-effect',
    );
    expect(auto?.label).toBe('効果を実行（AUTO）');
    expect(auto?.command).toEqual({
      kind: 'intent',
      intent: { type: 'useCardEffect', instanceId: handCardId },
      produces: 'startEffect',
    });

    expect(menuFor([{ op: 'manual', prompt: '確認' }]).find(
      (item) => item.id === 'use-card-effect',
    )?.label).toBe('効果を実行（ASSISTED）');
  });

  it('特殊状態の付与/解除とメモがスロットのメニューにある', () => {
    const { items } = buildMenu(ctx(), { kind: 'slot', playerId: DEMO_ME, slotId: 'active' });
    const conditions = items.find((i) => i.id === 'conditions');
    expect(conditions?.submenu?.map((i) => i.label)).toContain('どく を解除'); // デモではどく状態
    expect(conditions?.submenu?.map((i) => i.label)).toContain('やけど を付与');
    expect(items.some((i) => i.label === 'メモを追加')).toBe(true);
  });
});

describe('メニューは構造的に不可能な操作だけを塞ぐ', () => {
  it('埋まっているバトル場には「バトル場へ」を出さない', () => {
    const { items } = buildMenu(ctx(), { kind: 'card', instanceId: handCardId });
    expect(items.find((i) => i.id === 'place')?.disabled).toBe(true);
  });

  it('進化していないポケモンは退化できない', () => {
    const { items } = buildMenu(ctx(), { kind: 'slot', playerId: DEMO_ME, slotId: 'bench-0' });
    expect(items.find((i) => i.id === 'devolve')?.disabled).toBe(true);
  });

  it('ルール違反は塞がない（ダメカンは上限なく増やせる）', () => {
    const { items } = buildMenu(ctx(), { kind: 'slot', playerId: DEMO_ME, slotId: 'active' });
    const damage = items.find((i) => i.id === 'damage');
    expect(damage?.submenu?.every((i) => !i.disabled)).toBe(true);
  });
});

describe('乱数を伴う操作はサーバーがないと実行できない（§4.2）', () => {
  it('オフラインではシャッフル・コイン・じゃんけんが無効になる', () => {
    const offline = ctx({ canRandomize: false });
    const deck = buildMenu(offline, { kind: 'zone', playerId: DEMO_ME, zone: 'deck' }).items;
    expect(deck.find((i) => i.id === 'shuffle')?.disabled).toBe(true);

    const table = buildMenu(offline, { kind: 'table' }).items;
    expect(table.find((i) => i.id === 'coin')?.disabled).toBe(true);
    expect(table.find((i) => i.id === 'janken')?.disabled).toBe(true);
  });

  it('サーバーに繋がっていれば実行できる', () => {
    const deck = buildMenu(ctx(), { kind: 'zone', playerId: DEMO_ME, zone: 'deck' }).items;
    expect(deck.find((i) => i.id === 'shuffle')?.disabled).toBeFalsy();
  });
});

// ── 特性を使うメニュー（T34） ──

describe('特性のメニュー', () => {
  /** 場のポケモンに、効果つきの特性を持つカードを差し込んだ盤面 */
  function withAbility(oncePerTurn: boolean, usedOnTurn?: number) {
    const base = buildDemoState()!;
    const slot = base.players[DEMO_ME]!.pokemon.find((p) => p.slotId === 'active')!;
    const topId = slot.stack[slot.stack.length - 1]!;
    const original = sampleCardIndex.byFunctionalId.get(base.cards[topId]!.functionalId)!;
    const withAbilities = {
      ...original,
      abilities: [
        {
          name: 'テストチェンジ',
          kind: 'ability' as const,
          text: '自分の番に1回使える。',
          ...(oncePerTurn ? { oncePerTurn: true } : {}),
          effects: [{ op: 'draw' as const, player: 'self' as const, count: 1 }],
        },
      ],
    };
    const state: GameState = {
      ...base,
      abilityUses: usedOnTurn === undefined ? {} : { [`${topId}#0`]: usedOnTurn },
      turn: usedOnTurn ?? base.turn,
    };
    return {
      items: buildMenu(
        ctx({ state, cardIndex: buildCardIndex([...sampleCardIndex.all, withAbilities]) }),
        { kind: 'card', instanceId: topId },
      ).items,
    };
  }

  it('効果を持つ特性は「特性「〜」を使う」がメニューに出る', () => {
    const { items } = withAbility(false);
    expect(items.find((i) => i.id === 'use-ability-0')?.label).toBe('特性「テストチェンジ」を使う');
  });

  it('★この番すでに使っていても項目は消さず、ラベルで知らせる（禁止しない）', () => {
    const { items } = withAbility(true, 5);
    const item = items.find((i) => i.id === 'use-ability-0');
    expect(item?.label).toContain('この番すでに使用');
    expect(item?.disabled).toBeFalsy();
  });
});
