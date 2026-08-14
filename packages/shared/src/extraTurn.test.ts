/**
 * T41 の完了条件:
 *   「GXワザ使用後、同じプレイヤーの番がもう一度来る」
 *
 * ★ターンの並びは盤面の帳簿。第2段階で作った turnQueue / turnQueueMeta に差し込む。
 *   追加の番は **消費したら消える**（戻すと通常の番が1回増えてしまう）。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import { hasUsedOncePerGame } from './ruleBox';
import { WARNING_CODES, type RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

/** ★タイムレスGX 相当。GXワザで追加の番が来る */
const DIALGA: CardText = {
  functionalId: 'fn-dialga',
  name: 'ダミーのディアルガGX',
  supertype: 'pokemon',
  hp: 250,
  types: ['metal'],
  stage: 'basic',
  ruleBox: 'GX',
  attacks: [
    { name: 'メタルスラッシュ', cost: ['metal'], damage: '60', text: '' },
    {
      name: 'タイムレスGX',
      cost: ['metal', 'metal'],
      damage: '0',
      text: 'この番の次に、もう1回自分の番を続ける。',
      oncePerGame: 'gx',
      extraTurn: true,
    },
  ],
  weakness: null,
  resistance: null,
  retreatCost: 3,
};

const PLAIN: CardText = { ...DIALGA, functionalId: 'fn-plain', name: 'ゼニガメ', ruleBox: null,
  attacks: [{ name: 'たいあたり', cost: ['colorless'], damage: '20', text: '' }] };

const ctx: RuleContext = { cards: buildCardIndex([DIALGA, PLAIN]) };

const card = (instanceId: string, fid: string, ownerId: PlayerId = ALICE): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'deck',
  visibleTo: [],
  faceUp: false,
});

function table(): GameState {
  const base = createGameState({
    gameId: 'g-extraturn',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  return applyActions(
    withCards(
      { ...base, phase: 'turn', turn: 1, setup: null, activePlayer: ALICE },
      [card('a-dialga', 'fn-dialga'), card('b-plain', 'fn-plain', BOB)],
    ),
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-dialga' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-plain' }, BOB),
    ],
    ctx,
  );
}

const useAttack = (state: GameState, attackIndex: number): GameState =>
  applyAction(
    state,
    act({ type: 'useAttack', playerId: ALICE, slotId: 'active', attackIndex }),
    ctx,
  );

const endTurn = (state: GameState, actor: PlayerId = state.activePlayer): GameState =>
  applyAction(state, act({ type: 'endTurn' }, actor), ctx);

const lastWarnings = (state: GameState): string[] =>
  (state.log[state.log.length - 1]?.warnings ?? []).map((w) => w.code);

// ── ★完了条件 ────────────────────────

describe('★GXワザ使用後、同じプレイヤーの番がもう一度来る', () => {
  it('通常のワザでは追加の番は入らない', () => {
    const after = useAttack(table(), 0);
    expect(after.turnQueueMeta.some((meta) => meta.isExtra)).toBe(false);
    expect(endTurn(after).activePlayer).toBe(BOB);
  });

  it('★GXワザを使うと、列に追加の番が差し込まれる', () => {
    const after = useAttack(table(), 1);
    // 先頭は進行中の番。次（index 1）が追加の番になる
    expect(after.turnQueue[1]).toBe(ALICE);
    expect(after.turnQueueMeta[1]).toEqual({ isExtra: true, source: 'タイムレスGX' });
  });

  it('★番を終えると、もう一度自分の番が来る', () => {
    const next = endTurn(useAttack(table(), 1));
    expect(next.activePlayer).toBe(ALICE);
    expect(next.turnHistory.at(-1)).toMatchObject({ playerId: ALICE, isExtra: true });
  });

  it('★追加の番のあとは、ちゃんと相手の番になる（通常の番が増えない）', () => {
    const extra = endTurn(useAttack(table(), 1));
    const afterExtra = endTurn(extra);
    expect(afterExtra.activePlayer).toBe(BOB);
    // アリスの番が2回続いたあと、ボブ → アリス と戻る
    expect(endTurn(afterExtra).activePlayer).toBe(ALICE);
  });

  it('追加の番の履歴には出どころが残る', () => {
    const next = endTurn(useAttack(table(), 1));
    expect(next.turnHistory.at(-1)?.source).toBe('タイムレスGX');
  });

  it('★ログに残る（相手にも見える）', () => {
    const after = useAttack(table(), 1);
    expect(lastWarnings(after)).toContain(WARNING_CODES.EXTRA_TURN_INSERTED);
  });

  it('GXワザなので対戦中1回の枠も消費する（T36 と噛み合う）', () => {
    const after = useAttack(table(), 1);
    expect(hasUsedOncePerGame(after, ALICE, 'gx')).toBe(true);
  });

  it('★2回目は警告が出るが、止めない（追加の番も入る）', () => {
    const twice = useAttack(useAttack(table(), 1), 1);
    expect(lastWarnings(twice)).toContain(WARNING_CODES.ONCE_PER_GAME_USED);
    expect(twice.turnQueueMeta.filter((meta) => meta.isExtra)).toHaveLength(2);
  });

  it('手で差し込むこともできる（insertExtraTurn）', () => {
    const inserted = applyAction(
      table(),
      act({ type: 'insertExtraTurn', playerId: ALICE, source: '手で追加' }),
      ctx,
    );
    expect(inserted.turnQueueMeta[1]).toEqual({ isExtra: true, source: '手で追加' });
    expect(endTurn(inserted).activePlayer).toBe(ALICE);
  });

  it('★Undo で戻せる（差し込みも取り消せる）', () => {
    const before = table();
    const after = useAttack(before, 1);
    expect(after.turnQueue).not.toEqual(before.turnQueue);
    // applyAction は純粋関数なので、前の状態はそのまま残っている
    expect(before.turnQueueMeta.some((meta) => meta.isExtra)).toBe(false);
  });
});
