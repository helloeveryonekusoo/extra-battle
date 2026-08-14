/**
 * コンテキストメニューの中身（§6.6）。
 *
 * ★ここは純粋関数にしてある。状態と対象を渡すとメニュー項目の配列が返るだけ。
 *   おかげで「すべての原子操作がUIから実行できる」という T9 の完了条件を、
 *   目視ではなくテストで確かめられる（menus.test.ts）。
 *
 * ルール判定はしない。「たねポケモンしか出せない」等は人間が守る。
 * メニューは操作の可否ではなく、盤面の構造として不可能なものだけを disabled にする。
 */
import {
  cardsInZone,
  canUseAbilityThisTurn,
  effectModeOf,
  effectSlotKey,
  getEffectiveAbilityEntries,
  getBenchLimit,
  HIDDEN_FUNCTIONAL_ID,
  prizesForRuleBox,
  topCardOf,
  type ActionRequest,
  type ActionType,
  type CardIndex,
  type CardText,
  type GameState,
  type Intent,
  type PlayerId,
  type SlotId,
  type SpecialCondition,
  type Zone,
} from '@pokeca/shared';

// ── 型 ───────────────────────────────

/** 入力を受けたあとに何を送るか。Action と Intent のどちらもありうる */
export type PromptResult = { action: ActionRequest } | { intent: Intent };

export type PromptSpec =
  | {
      input: 'text';
      title: string;
      initial: string;
      placeholder?: string;
      build: (value: string) => PromptResult;
    }
  | {
      input: 'number';
      title: string;
      initial: number;
      min?: number;
      max?: number;
      build: (value: number) => PromptResult;
    }
  | {
      /** 他カードのワザを参照させる（§5.1-3）。専用のダイアログで選ぶ */
      input: 'attackRef';
      title: string;
      playerId: PlayerId;
      slotId: SlotId;
    };

export type MenuCommand =
  | { kind: 'action'; action: ActionRequest }
  | { kind: 'intent'; intent: Intent; produces: ActionType }
  /** 入力を受けてから実行する操作 */
  | { kind: 'prompt'; produces: ActionType; prompt: PromptSpec };

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  command?: MenuCommand;
  submenu?: MenuItem[];
}

export type MenuTarget =
  | { kind: 'card'; instanceId: string }
  | { kind: 'slot'; playerId: PlayerId; slotId: SlotId }
  | { kind: 'zone'; playerId: PlayerId; zone: Zone }
  | { kind: 'table' };

export interface MenuContext {
  state: GameState;
  cardIndex: CardIndex | null;
  viewerId: PlayerId;
  /** サーバーに繋がっていて、乱数を伴う操作を頼めるか（§4.2） */
  canRandomize: boolean;
}

// ── 補助 ─────────────────────────────

const CONDITIONS: { value: SpecialCondition; label: string }[] = [
  { value: 'poisoned', label: 'どく' },
  { value: 'burned', label: 'やけど' },
  { value: 'asleep', label: 'ねむり' },
  { value: 'paralyzed', label: 'マヒ' },
  { value: 'confused', label: 'こんらん' },
];

const ZONE_LABEL: Record<Zone, string> = {
  deck: '山札',
  hand: '手札',
  active: 'バトル場',
  bench: 'ベンチ',
  prize: 'サイド',
  discard: 'トラッシュ',
  lost: 'ロストゾーン',
  stadium: 'スタジアム',
};

export const slotLabel = (slotId: SlotId): string =>
  slotId === 'active' ? 'バトル場' : `ベンチ${Number(slotId.slice('bench-'.length)) + 1}`;

const action = (a: ActionRequest): MenuCommand => ({ kind: 'action', action: a });
const intentOf = (i: Intent, produces: ActionType): MenuCommand => ({
  kind: 'intent',
  intent: i,
  produces,
});

function cardNameOf(ctx: MenuContext, instanceId: string): string {
  const instance = ctx.state.cards[instanceId];
  if (!instance) return 'カード';
  if (instance.functionalId === HIDDEN_FUNCTIONAL_ID) return '非公開のカード';
  return ctx.cardIndex?.byFunctionalId.get(instance.functionalId)?.name ?? 'カード';
}

function cardTextOf(ctx: MenuContext, instanceId: string): CardText | undefined {
  const instance = ctx.state.cards[instanceId];
  if (!instance || instance.functionalId === HIDDEN_FUNCTIONAL_ID) return undefined;
  return ctx.cardIndex?.byFunctionalId.get(instance.functionalId);
}

/** そのプレイヤーの全スロットID（埋まっている場所 + 上限までの空き） */
function allSlotIds(ctx: MenuContext, playerId: PlayerId): SlotId[] {
  const { state } = ctx;
  const player = state.players[playerId];
  if (!player) return [];
  const bench = player.pokemon
    .filter((p) => p.slotId !== 'active')
    .map((p) => Number(p.slotId.slice('bench-'.length)));
  // 上限は派生状態から（スカイフィールド等を合成。T27）
  const limit = getBenchLimit(state, playerId, { cards: ctx.cardIndex });
  const count = Math.max(limit, bench.length > 0 ? Math.max(...bench) + 1 : 0);
  return ['active', ...Array.from({ length: count }, (_, i) => `bench-${i}` as SlotId)];
}

const isOccupied = (state: GameState, playerId: PlayerId, slotId: SlotId): boolean =>
  Boolean(state.players[playerId]?.pokemon.some((p) => p.slotId === slotId));

/** そのカードが場のどのスロットにいるか。`p-1/active` の形。場になければ null */
function slotKeyOfCard(state: GameState, instanceId: string): string | null {
  for (const [playerId, player] of Object.entries(state.players)) {
    const slot = player.pokemon.find((p) => p.stack.includes(instanceId));
    if (slot) return effectSlotKey(playerId, slot.slotId);
  }
  return null;
}

/** 2人卓の相手。1人しかいなければ null */
const opponentOf = (state: GameState, playerId: PlayerId): PlayerId | null =>
  Object.keys(state.players).find((id) => id !== playerId) ?? null;

// ── カードのメニュー ───────────────────

function buildCardMenu(ctx: MenuContext, instanceId: string): MenuItem[] {
  const instance = ctx.state.cards[instanceId];
  if (!instance) return [];

  const owner = instance.ownerId;
  const card = cardTextOf(ctx, instanceId);
  const effectMode = effectModeOf(card?.effects);
  const inPlay = instance.zone === 'active' || instance.zone === 'bench';
  const everyone = Object.keys(ctx.state.players);
  const revealed = everyone.every((p) => instance.visibleTo.includes(p));

  const moveTo = (zone: Zone, label: string, insertAt?: 'top' | 'bottom'): MenuItem => ({
    id: `move-${zone}-${insertAt ?? ''}`,
    label,
    command: action({
      type: 'moveCard',
      cardId: instanceId,
      toZone: zone,
      ...(insertAt ? { insertAt } : {}),
    }),
  });

  const slots = allSlotIds(ctx, owner);

  /*
   * 特性を使う（T34）。
   * ★「自分の番に1回」をもう使っていても項目は消さない。
   *   ラベルで知らせるだけにして、押せば通す（第2段階 §2「警告はするが、禁止はしない」）。
   *   効果で追加で使えるカードがあるので、消すと遊べなくなる。
   */
  const slotKeyOfThis = inPlay ? slotKeyOfCard(ctx.state, instanceId) : null;
  const abilityItems: MenuItem[] =
    owner === ctx.viewerId && slotKeyOfThis
      ? // ★BREAK進化していると特性が2枚のカードにまたがる（T37）。
        //   合成した一覧から、どのカードのどの番号かを指して使う
        getEffectiveAbilityEntries(ctx.state, slotKeyOfThis, { cards: ctx.cardIndex }).flatMap(
          (entry, i) => {
            const { ability } = entry;
            if (!ability.effects || ability.trigger === 'passive') return [];
            const used =
              ability.oncePerTurn &&
              !canUseAbilityThisTurn(ctx.state, entry.instanceId, entry.abilityIndex);
            const inherited = entry.instanceId !== instanceId;
            return [
              {
                id: `use-ability-${i}`,
                label:
                  `特性「${ability.name}」を使う` +
                  (inherited ? `（${entry.fromCard?.name ?? '進化前'}から）` : '') +
                  (used ? '（この番すでに使用）' : ''),
                command: intentOf(
                  {
                    type: 'useCardEffect',
                    instanceId: entry.instanceId,
                    abilityIndex: entry.abilityIndex,
                  },
                  'startEffect',
                ),
              } satisfies MenuItem,
            ];
          },
        )
      : [];

  return [
    ...abilityItems,
    ...(owner === ctx.viewerId && effectMode !== 'MANUAL'
      ? [
          {
            id: 'use-card-effect',
            label: `効果を実行（${effectMode}）`,
            command: intentOf({ type: 'useCardEffect', instanceId }, 'startEffect'),
          } satisfies MenuItem,
        ]
      : []),
    moveTo('hand', '手札へ'),
    moveTo('deck', '山札の上へ', 'top'),
    moveTo('deck', '山札の下へ', 'bottom'),
    {
      id: 'shuffle-into-deck',
      label: '山札に加えて切る',
      disabled: !ctx.canRandomize,
      ...(ctx.canRandomize ? {} : { hint: 'サーバー接続時のみ' }),
      command: intentOf(
        { type: 'shuffleIntoDeck', playerId: owner, cardIds: [instanceId] },
        'shuffleIntoDeck',
      ),
    },
    { ...moveTo('discard', 'トラッシュへ'), separatorBefore: true },
    moveTo('lost', 'ロストゾーンへ'),
    moveTo('prize', 'サイドへ'),

    {
      id: 'place',
      label: 'バトル場へ',
      separatorBefore: true,
      disabled: isOccupied(ctx.state, owner, 'active'),
      command: action({ type: 'placePokemon', playerId: owner, slotId: 'active', cardId: instanceId }),
    },
    {
      id: 'place-bench',
      label: 'ベンチへ',
      submenu: slots
        .filter((s) => s !== 'active')
        .map((slotId) => ({
          id: `place-${slotId}`,
          label: slotLabel(slotId),
          disabled: isOccupied(ctx.state, owner, slotId),
          command: action({ type: 'placePokemon', playerId: owner, slotId, cardId: instanceId }),
        })),
    },
    {
      id: 'place-facedown',
      label: 'ウラのまま場に出す',
      hint: '対戦準備',
      submenu: slots.map((slotId) => ({
        id: `place-fd-${slotId}`,
        label: slotLabel(slotId),
        disabled: isOccupied(ctx.state, owner, slotId),
        command: action({
          type: 'placePokemon',
          playerId: owner,
          slotId,
          cardId: instanceId,
          faceUp: false,
        }),
      })),
    },
    {
      id: 'evolve',
      label: 'このカードで進化させる',
      submenu: slots.map((slotId) => ({
        id: `evolve-${slotId}`,
        label: slotLabel(slotId),
        disabled: !isOccupied(ctx.state, owner, slotId),
        command: action({ type: 'evolvePokemon', playerId: owner, slotId, cardId: instanceId }),
      })),
    },
    {
      id: 'attach-energy',
      label: 'エネルギーとしてつける',
      submenu: slots.map((slotId) => ({
        id: `attach-e-${slotId}`,
        label: slotLabel(slotId),
        disabled: !isOccupied(ctx.state, owner, slotId),
        command: action({
          type: 'attachCard',
          playerId: owner,
          slotId,
          cardId: instanceId,
          as: 'energy',
        }),
      })),
    },
    {
      id: 'attach-tool',
      label: 'どうぐとしてつける',
      submenu: slots.map((slotId) => ({
        id: `attach-t-${slotId}`,
        label: slotLabel(slotId),
        disabled: !isOccupied(ctx.state, owner, slotId),
        command: action({
          type: 'attachCard',
          playerId: owner,
          slotId,
          cardId: instanceId,
          as: 'tool',
        }),
      })),
    },
    /*
     * ★ポケモンをどうぐ化する（クレッフィのワンダーロック。T40）。
     *   相手の番の終わりにトラッシュされるので、期限つきで付ける項目を分けて出す。
     *   相手のポケモンにも付けられる（フレア団ハイパーギア）。
     */
    ...(card?.supertype === 'pokemon'
      ? [
          {
            id: 'attach-tool-temporary',
            label: 'どうぐとしてつける（相手の番の終わりにトラッシュ）',
            submenu: everyone.flatMap((holder) =>
              allSlotIds(ctx, holder).map((slotId) => ({
                id: `attach-tt-${holder}-${slotId}`,
                label: `${holder === owner ? '自分' : '相手'}の${slotLabel(slotId)}`,
                disabled: !isOccupied(ctx.state, holder, slotId),
                command: action({
                  type: 'attachCard',
                  playerId: holder,
                  slotId,
                  cardId: instanceId,
                  as: 'tool',
                  until: 'endOfNextOpponentTurn',
                }),
              })),
            ),
          } satisfies MenuItem,
        ]
      : []),
    /*
     * ★相手のポケモンにつけるどうぐ（フレア団ハイパーギア。T40）。
     *   `attachedTool` の持ち主と装着先が違うケース。
     */
    ...(card?.trainerKind === 'tool'
      ? [
          {
            id: 'attach-tool-opponent',
            label: '相手のポケモンにどうぐとしてつける',
            submenu: everyone
              .filter((holder) => holder !== owner)
              .flatMap((holder) =>
                allSlotIds(ctx, holder).map((slotId) => ({
                  id: `attach-to-${holder}-${slotId}`,
                  label: slotLabel(slotId),
                  disabled: !isOccupied(ctx.state, holder, slotId),
                  command: action({
                    type: 'attachCard',
                    playerId: holder,
                    slotId,
                    cardId: instanceId,
                    as: 'tool',
                  }),
                })),
              ),
          } satisfies MenuItem,
        ]
      : []),
    {
      id: 'set-stadium',
      label: 'スタジアムとして出す',
      disabled: card !== undefined && card.trainerKind !== 'stadium',
      submenu: undefined,
      command: action({ type: 'setStadium', cardId: instanceId }),
    },

    {
      id: 'flip',
      label: instance.faceUp ? 'ウラにする' : 'オモテにする',
      separatorBefore: true,
      command: action({ type: 'setFaceUp', cardId: instanceId, faceUp: !instance.faceUp }),
    },
    {
      id: 'reveal',
      label: revealed ? '公開をやめる' : '相手に公開',
      command: action({
        type: 'setCardVisibility',
        cardIds: [instanceId],
        visibleTo: revealed ? [owner] : everyone,
      }),
    },
    ...(inPlay
      ? []
      : [
          {
            id: 'note',
            label: 'ログにメモを残す',
            separatorBefore: true,
            command: {
              kind: 'prompt' as const,
              produces: 'note' as ActionType,
              prompt: {
                input: 'text' as const,
                title: `「${cardNameOf(ctx, instanceId)}」についてのメモ`,
                initial: '',
                placeholder: '例: 効果でロックされている',
                build: (value: string): PromptResult => ({
                  action: { type: 'note', text: value },
                }),
              },
            },
          },
        ]),
  ];
}

// ── 場のポケモンのメニュー ─────────────

function buildSlotMenu(ctx: MenuContext, playerId: PlayerId, slotId: SlotId): MenuItem[] {
  const slot = ctx.state.players[playerId]?.pokemon.find((p) => p.slotId === slotId);
  if (!slot) return [];

  const attached = [
    ...slot.attachedEnergy.map((id) => ({ id, kind: 'エネルギー' })),
    ...(slot.attachedTool ? [{ id: slot.attachedTool, kind: 'どうぐ' }] : []),
  ];
  const otherSlots = allSlotIds(ctx, playerId).filter((s) => s !== slotId);
  const opponentId = opponentOf(ctx.state, playerId);
  const opponentName = opponentId ? (ctx.state.players[opponentId]?.displayName ?? '相手') : '相手';

  // 進化スタックの一番上のカードのワザ + 他カードから参照しているワザ（§5.1-3）
  const topId = slot.stack[slot.stack.length - 1];
  const topCard = topId ? cardTextOf(ctx, topId) : undefined;
  const ownAttacks = (topCard?.attacks ?? []).map((a, index) => ({
    index,
    label: a.damage ? `${a.name}  ${a.damage}` : a.name,
    name: a.name,
  }));
  const grantedAttacks = slot.grantedAttacks.map((ref) => {
    const source = ctx.cardIndex?.byFunctionalId.get(ref.functionalId);
    const attack = source?.attacks?.[ref.attackIndex];
    return {
      index: ref.attackIndex,
      label: `${attack?.name ?? 'ワザ'}（${source?.name ?? '参照'}）`,
      name: attack?.name ?? 'ワザ',
    };
  });
  const attacks = [...ownAttacks, ...grantedAttacks];
  const attackEffects = (topCard?.attacks ?? [])
    .map((a, index) => ({ index, name: a.name, effects: a.effects }))
    .filter((a) => Boolean(a.effects) && playerId === ctx.viewerId);

  return [
    {
      id: 'use-attack',
      label: 'ワザを使う',
      disabled: attacks.length === 0,
      ...(attacks.length === 0 ? { hint: 'ワザがありません' } : {}),
      submenu: attacks.map((attack, i) => ({
        id: `attack-${i}`,
        label: attack.label,
        command: action({
          type: 'useAttack',
          playerId,
          slotId,
          attackIndex: attack.index,
          attackName: attack.name,
        }),
      })),
    },
    /*
     * ★ワザに付随する効果（T42）。
     *   「ワザを使う」とは分けてある。ダメージは人が確定させ、
     *   効果（グッズロック等）だけをここから動かす。
     */
    ...(attackEffects.length > 0
      ? [
          {
            id: 'use-attack-effect',
            label: 'ワザの効果を実行',
            submenu: attackEffects.map((attack) => ({
              id: `attack-effect-${attack.index}`,
              label: attack.name,
              command: intentOf(
                { type: 'useCardEffect', instanceId: topId ?? '', attackIndex: attack.index },
                'startEffect',
              ),
            })),
          } satisfies MenuItem,
        ]
      : []),
    {
      id: 'damage',
      label: 'ダメカン',
      separatorBefore: true,
      submenu: [
        {
          id: 'dmg+1',
          label: '+1（10ダメージ）',
          command: action({ type: 'adjustDamage', playerId, slotId, delta: 1 }),
        },
        {
          id: 'dmg+5',
          label: '+5（50ダメージ）',
          command: action({ type: 'adjustDamage', playerId, slotId, delta: 5 }),
        },
        {
          id: 'dmg-1',
          label: '−1',
          command: action({ type: 'adjustDamage', playerId, slotId, delta: -1 }),
        },
        {
          id: 'dmg0',
          label: 'すべて取り除く',
          command: action({ type: 'setDamage', playerId, slotId, counters: 0 }),
        },
        {
          id: 'dmg-set',
          label: '個数を指定…',
          command: {
            kind: 'prompt',
            produces: 'setDamage',
            prompt: {
              input: 'number',
              title: 'ダメカンの個数',
              initial: slot.damageCounters,
              min: 0,
              build: (value): PromptResult => ({
                action: { type: 'setDamage', playerId, slotId, counters: value },
              }),
            },
          },
        },
      ],
    },
    {
      id: 'conditions',
      label: '特殊状態',
      submenu: [
        ...CONDITIONS.map((c) => {
          const on = slot.conditions.includes(c.value);
          return {
            id: `cond-${c.value}`,
            label: `${c.label}${on ? ' を解除' : ' を付与'}`,
            command: action({
              type: 'setCondition',
              playerId,
              slotId,
              condition: c.value,
              on: !on,
            }),
          };
        }),
        {
          id: 'cond-clear',
          label: 'すべて回復',
          separatorBefore: true,
          disabled: slot.conditions.length === 0,
          command: action({ type: 'clearConditions', playerId, slotId }),
        },
      ],
    },

    {
      id: 'retreat',
      label: 'にげる',
      separatorBefore: true,
      hint: '1ターン1回',
      disabled: slotId !== 'active',
      submenu: otherSlots.map((toSlotId) => ({
        id: `retreat-${toSlotId}`,
        label: `${slotLabel(toSlotId)} と交代`,
        command: action({
          type: 'movePokemon',
          playerId,
          fromSlotId: slotId,
          toSlotId,
          asRetreat: true,
        }),
      })),
    },
    {
      id: 'move',
      label: '入れ替え',
      hint: 'にげる ではない',
      submenu: otherSlots.map((toSlotId) => ({
        id: `move-${toSlotId}`,
        label: `${slotLabel(toSlotId)} と入れ替え`,
        command: action({ type: 'movePokemon', playerId, fromSlotId: slotId, toSlotId }),
      })),
    },
    {
      id: 'devolve',
      label: '一番上をはがす（退化）',
      disabled: slot.stack.length <= 1,
      submenu: (['hand', 'discard', 'deck', 'lost'] as Zone[]).map((zone) => ({
        id: `devolve-${zone}`,
        label: `${ZONE_LABEL[zone]}へ`,
        disabled: slot.stack.length <= 1,
        command: action({ type: 'devolvePokemon', playerId, slotId, toZone: zone }),
      })),
    },
    {
      id: 'detach',
      label: 'ついているカードを外す',
      disabled: attached.length === 0,
      submenu: attached.map((a) => ({
        id: `detach-${a.id}`,
        label: `${a.kind}: ${cardNameOf(ctx, a.id)}`,
        submenu: (['discard', 'hand', 'lost', 'deck'] as Zone[]).map((zone) => ({
          id: `detach-${a.id}-${zone}`,
          label: `${ZONE_LABEL[zone]}へ`,
          command: action({ type: 'detachCard', playerId, slotId, cardId: a.id, toZone: zone }),
        })),
      })),
    },
    {
      id: 'remove',
      label: 'まとめて場から出す',
      hint: '回収。サイドは動かない',
      danger: true,
      submenu: (['discard', 'hand', 'deck', 'lost'] as Zone[]).map((zone) => ({
        id: `remove-${zone}`,
        label: `${ZONE_LABEL[zone]}へ`,
        danger: zone === 'discard',
        command: action({ type: 'removePokemon', playerId, slotId, toZone: zone }),
      })),
    },
    {
      id: 'knockout',
      label: 'きぜつとして処理…',
      hint: 'トラッシュ + サイド',
      danger: true,
      command: {
        kind: 'prompt',
        produces: 'knockOut',
        prompt: {
          input: 'number',
          title: `${slotLabel(slotId)} のきぜつ — ${opponentName}がとるサイドの枚数`,
          // ruleBox からの既定値。ここで手で変えられるのが T16 の要件
          initial: prizesForRuleBox(topCardOf(ctx.state, { cards: ctx.cardIndex }, slot)?.ruleBox),
          min: 0,
          build: (value): PromptResult => ({
            intent: {
              type: 'knockOut',
              playerId,
              slotId,
              expectedTopInstanceId: slot.stack[slot.stack.length - 1]!,
              prizePlayerId: opponentId,
              prizeCount: value,
            },
          }),
        },
      },
    },

    {
      id: 'grant',
      label: '他のカードのワザを参照',
      separatorBefore: true,
      hint: 'イカサマ・メタモン・わざマシン',
      command: {
        kind: 'prompt',
        produces: 'grantAttack',
        prompt: { input: 'attackRef', title: '参照するワザを選ぶ', playerId, slotId },
      },
    },
    {
      id: 'grant-clear',
      label: 'ワザの参照を解除',
      disabled: slot.grantedAttacks.length === 0,
      command: action({ type: 'clearGrantedAttacks', playerId, slotId }),
    },
    {
      id: 'notes',
      label: 'メモを追加',
      separatorBefore: true,
      command: {
        kind: 'prompt',
        produces: 'setNotes',
        prompt: {
          input: 'text',
          title: `${slotLabel(slotId)} のメモ`,
          initial: slot.notes,
          placeholder: '例: このターン、ワザが使えない',
          build: (value): PromptResult => ({
            action: { type: 'setNotes', playerId, slotId, notes: value },
          }),
        },
      },
    },
  ];
}

// ── ゾーンのメニュー ───────────────────

function buildZoneMenu(ctx: MenuContext, playerId: PlayerId, zone: Zone): MenuItem[] {
  const player = ctx.state.players[playerId];
  const count = cardsInZone(ctx.state, playerId, zone).length;
  const needsServer = { disabled: !ctx.canRandomize, hint: 'サーバー接続時のみ' };

  if (zone === 'deck') {
    return [
      {
        id: 'shuffle',
        label: '山札を切る',
        ...(ctx.canRandomize ? {} : needsServer),
        command: intentOf({ type: 'shuffleDeck', playerId }, 'shuffleDeck'),
      },
      {
        id: 'draw1',
        label: '1枚引く',
        disabled: count === 0,
        command: intentOf({ type: 'drawCards', playerId, count: 1 }, 'drawCards'),
      },
      {
        id: 'draw7',
        label: '7枚引く',
        disabled: count === 0,
        command: intentOf({ type: 'drawCards', playerId, count: Math.min(7, count) }, 'drawCards'),
      },
      {
        id: 'drawN',
        label: '枚数を指定して引く…',
        disabled: count === 0,
        command: {
          kind: 'prompt',
          produces: 'drawCards',
          prompt: {
            input: 'number',
            title: '何枚引く？',
            initial: 1,
            min: 1,
            max: count,
            build: (value): PromptResult => ({
              intent: { type: 'drawCards', playerId, count: value },
            }),
          },
        },
      },
      {
        id: 'setup',
        label: 'サンプルの山札を置く',
        separatorBefore: true,
        hint: '開発用。T10 で本物のデッキ投入に置き換わる',
        ...(ctx.canRandomize ? {} : needsServer),
        command: intentOf({ type: 'devDealSampleDeck', playerId, size: 60 }, 'setupDeck'),
      },
    ];
  }

  if (zone === 'prize') {
    return [
      {
        id: 'take',
        label: 'サイドを1枚とる',
        hint: '枚数を減らす',
        disabled: !player || player.prizesRemaining === 0,
        command: action({
          type: 'setPrizes',
          playerId,
          prizesRemaining: Math.max(0, (player?.prizesRemaining ?? 0) - 1),
        }),
      },
      {
        id: 'give-back',
        label: 'サイドを1枚もどす',
        command: action({
          type: 'setPrizes',
          playerId,
          prizesRemaining: (player?.prizesRemaining ?? 0) + 1,
        }),
      },
      {
        id: 'set-prizes',
        label: '枚数を指定…',
        command: {
          kind: 'prompt',
          produces: 'setPrizes',
          prompt: {
            input: 'number',
            title: 'サイドの残り枚数',
            initial: player?.prizesRemaining ?? 6,
            min: 0,
            build: (value): PromptResult => ({
              action: {
                type: 'setPrizes',
                playerId,
                prizesRemaining: value,
                prizesTotal: Math.max(value, player?.prizesTotal ?? 6),
              },
            }),
          },
        },
      },
    ];
  }

  return [
    {
      id: 'bench-limit',
      label: 'ベンチ上限を変える…',
      hint: 'スカイフィールド8 / ウソッキー4',
      command: {
        kind: 'prompt',
        produces: 'setBenchLimit',
        prompt: {
          input: 'number',
          title: 'ベンチ上限',
          initial: player?.benchLimit ?? 5,
          min: 0,
          max: 8,
          build: (value): PromptResult => ({
            action: { type: 'setBenchLimit', playerId, benchLimit: value },
          }),
        },
      },
    },
  ];
}

// ── 卓のメニュー ──────────────────────

function buildTableMenu(ctx: MenuContext): MenuItem[] {
  const { state, viewerId, canRandomize } = ctx;
  const players = Object.keys(state.players);
  const needsServer = canRandomize ? {} : { disabled: true, hint: 'サーバー接続時のみ' };

  return [
    {
      id: 'end-turn',
      label: '番を終える（次の人が1枚引く）',
      disabled: state.turnQueue.length <= 1,
      command: intentOf({ type: 'endTurn' }, 'endTurn'),
    },
    {
      id: 'end-turn-nodraw',
      label: '番を終える（ドローなし）',
      hint: '効果でドローできないとき',
      disabled: state.turnQueue.length <= 1,
      command: intentOf({ type: 'endTurn', drawCount: 0 }, 'endTurn'),
    },
    {
      id: 'extra-turn',
      label: '追加の番を差し込む…',
      hint: 'スタークロノス等',
      submenu: players.map((playerId) => ({
        id: `extra-${playerId}`,
        label: state.players[playerId]?.displayName ?? playerId,
        command: {
          kind: 'prompt',
          produces: 'insertExtraTurn',
          prompt: {
            input: 'text',
            title: `${state.players[playerId]?.displayName ?? playerId} の追加の番`,
            initial: '',
            placeholder: '例: スタークロノス（空欄でも可）',
            build: (value): PromptResult => ({
              action: {
                type: 'insertExtraTurn',
                playerId,
                ...(value.trim() ? { source: value.trim() } : {}),
              },
            }),
          },
        },
      })),
    },
    {
      id: 'active-player',
      label: '手番を移す',
      submenu: players.map((playerId) => ({
        id: `active-${playerId}`,
        label: state.players[playerId]?.displayName ?? playerId,
        command: action({ type: 'setActivePlayer', playerId }),
      })),
    },
    {
      id: 'phase',
      label: 'フェーズ',
      submenu: (['setup', 'turn', 'pokemonCheck', 'ended'] as const).map((phase) => ({
        id: `phase-${phase}`,
        label: { setup: '対戦準備', turn: '対戦中', pokemonCheck: 'ポケモンチェック', ended: '終了' }[
          phase
        ],
        command: action({ type: 'setPhase', phase }),
      })),
    },

    {
      id: 'coin',
      label: 'コインを投げる',
      separatorBefore: true,
      ...needsServer,
      command: intentOf({ type: 'flipCoin', playerId: viewerId, count: 1 }, 'flipCoin'),
    },
    {
      id: 'coin-n',
      label: 'コインを複数枚投げる…',
      ...needsServer,
      command: {
        kind: 'prompt',
        produces: 'flipCoin',
        prompt: {
          input: 'number',
          title: '何回投げる？',
          initial: 2,
          min: 1,
          max: 10,
          build: (value): PromptResult => ({
            intent: { type: 'flipCoin', playerId: viewerId, count: value },
          }),
        },
      },
    },
    {
      id: 'janken',
      label: 'じゃんけん（先攻後攻を決める）',
      ...needsServer,
      command: intentOf(
        { type: 'randomChoice', label: 'じゃんけん', options: players },
        'randomChoice',
      ),
    },

    {
      id: 'stadium-off',
      label: 'スタジアムを場から外す',
      separatorBefore: true,
      disabled: state.stadium === null,
      command: action({ type: 'setStadium', cardId: null }),
    },
    {
      id: 'turn-flags',
      label: '1ターン制限を戻す',
      submenu: (
        [
          ['energyAttached', 'エネルギー'],
          ['supporterUsed', 'サポート'],
          ['stadiumPlayed', 'スタジアム'],
          ['retreated', 'にげる'],
        ] as const
      ).map(([flag, label]) => ({
        id: `flag-${flag}`,
        label: `${label} を未使用に戻す`,
        command: action({ type: 'setTurnFlag', playerId: viewerId, flag, value: false }),
      })),
    },

    {
      id: 'rename',
      label: '表示名を変える…',
      separatorBefore: true,
      command: {
        kind: 'prompt',
        produces: 'setPlayerName',
        prompt: {
          input: 'text',
          title: '表示名',
          initial: state.players[viewerId]?.displayName ?? '',
          build: (value): PromptResult => ({
            action: { type: 'setPlayerName', playerId: viewerId, displayName: value },
          }),
        },
      },
    },
    {
      id: 'note',
      label: 'ログにメモを残す…',
      command: {
        kind: 'prompt',
        produces: 'note',
        prompt: {
          input: 'text',
          title: 'ログに残すメモ',
          initial: '',
          placeholder: '例: 効果の確認を口頭で行った',
          build: (value): PromptResult => ({ action: { type: 'note', text: value } }),
        },
      },
    },
  ];
}

// ── 入口 ─────────────────────────────

export function buildMenu(ctx: MenuContext, target: MenuTarget): { title: string; items: MenuItem[] } {
  switch (target.kind) {
    case 'card':
      return { title: cardNameOf(ctx, target.instanceId), items: buildCardMenu(ctx, target.instanceId) };
    case 'slot':
      return {
        title: slotLabel(target.slotId),
        items: buildSlotMenu(ctx, target.playerId, target.slotId),
      };
    case 'zone':
      return {
        title: ZONE_LABEL[target.zone],
        items: buildZoneMenu(ctx, target.playerId, target.zone),
      };
    case 'table':
      return { title: '卓の操作', items: buildTableMenu(ctx) };
  }
}

/** メニューから実行できる原子操作の種類を集める（完了条件の検証用） */
export function producedActionTypes(items: readonly MenuItem[]): Set<ActionType> {
  const found = new Set<ActionType>();
  const walk = (list: readonly MenuItem[]): void => {
    for (const item of list) {
      if (item.command) {
        if (item.command.kind === 'action') found.add(item.command.action.type);
        else found.add(item.command.produces);
      }
      if (item.submenu) walk(item.submenu);
    }
  };
  walk(items);
  return found;
}
