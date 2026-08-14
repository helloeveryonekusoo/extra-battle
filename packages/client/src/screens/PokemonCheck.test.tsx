import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  applyAction,
  findKnockoutCandidates,
  isPokemonCheckComplete,
  nextPokemonCheckTarget,
  type Action,
  type ActionRequest,
  type GameState,
  type Intent,
  type UnstampedAction,
} from '@pokeca/shared';
import { Board } from '../components/board/Board';
import { DragProvider } from '../interaction/dnd';
import { useTableController, type Dispatcher } from '../interaction/useTableController';
import { buildDemoState, DEMO_ME } from '../cards/demoState';
import { sampleCardIndex } from '../cards/sampleCards';
import { PokemonCheck } from './PokemonCheck';

const base = buildDemoState()!;
const act = (action: UnstampedAction): Action =>
  ({ ...action, actorId: 'server', at: Date.now() }) as Action;

const enterCheck = (state: GameState = base): GameState =>
  applyAction(state, act({ type: 'setPhase', phase: 'pokemonCheck' }));

function resolveCurrent(
  state: GameState,
  extra: Partial<Extract<UnstampedAction, { type: 'resolvePokemonCheckTarget' }>> = {},
): GameState {
  const current = nextPokemonCheckTarget(state)!;
  return applyAction(
    state,
    act({
      type: 'resolvePokemonCheckTarget',
      order: current.step.order,
      playerId: current.target.playerId,
      slotId: current.target.slotId,
      expectedTopInstanceId: current.target.topInstanceId,
      ...extra,
    }),
  );
}

function renderCheck(state: GameState) {
  const dispatch = vi.fn<(action: ActionRequest) => void>();
  const intent = vi.fn<(intent: Intent) => void>();
  render(
    <PokemonCheck
      state={state}
      viewerId={DEMO_ME}
      cardIndex={sampleCardIndex}
      dispatch={dispatch}
      intent={intent}
      canRandomize
    />,
  );
  return { dispatch, intent };
}

describe('番の終了からポケモンチェックへ入る', () => {
  it('盤面の「番を終える」で専用フェーズを開始する', () => {
    const dispatch = vi.fn<(action: ActionRequest) => void>();
    const dispatcher: Dispatcher = { dispatch, intent: vi.fn(), canRandomize: true };

    function Harness() {
      const controller = useTableController({
        state: base,
        cardIndex: sampleCardIndex,
        viewerId: DEMO_ME,
        dispatcher,
      });
      return (
        <DragProvider>
          <Board state={base} viewerId={DEMO_ME} cardIndex={sampleCardIndex} controller={controller} />
        </DragProvider>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByText('番を終える'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'setPhase', phase: 'pokemonCheck' });
  });

  it('開始時に対象が共有状態へ自動列挙される', () => {
    const checking = enterCheck();
    expect(checking.pokemonCheck?.steps).toHaveLength(4);
    expect(checking.pokemonCheck?.steps[0]?.targets).toEqual([
      expect.objectContaining({ playerId: DEMO_ME, slotId: 'active', resolved: false }),
    ]);
    // デモのベンチ1にある「ねむり」は、バトル場でないため処理対象外。
    expect(checking.pokemonCheck?.steps[2]?.targets).toEqual([]);
    renderCheck(checking);
    expect(screen.getByRole('dialog', { name: 'ポケモンチェック' })).toBeTruthy();
  });
});

describe('公式順での実処理', () => {
  it('4段が どく→やけど→ねむり→マヒ の順に並ぶ', () => {
    renderCheck(enterCheck());
    const dialog = within(screen.getByRole('dialog'));
    const sections = ['どく', 'やけど', 'ねむり', 'マヒ'].map(
      (label) => dialog.getByText(label).closest('section')!,
    );
    for (let index = 1; index < sections.length; index += 1) {
      expect(
        sections[index - 1]!.compareDocumentPosition(sections[index]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('どくの個数を変更して、現在対象の解決Intentを送る', () => {
    const checking = enterCheck();
    const target = checking.pokemonCheck!.steps[0]!.targets[0]!;
    const { intent } = renderCheck(checking);
    fireEvent.click(screen.getByRole('button', { name: 'どくのダメカンを増やす' }));
    fireEvent.click(screen.getByRole('button', { name: 'ダメカンをのせる' }));
    expect(intent).toHaveBeenCalledWith({
      type: 'resolvePokemonCheckTarget',
      order: 1,
      playerId: target.playerId,
      slotId: target.slotId,
      expectedTopInstanceId: target.topInstanceId,
      poisonCounters: 2,
    });
  });

  it('やけどはダメカン+2とコインをまとめてサーバーへ頼む', () => {
    const burned = applyAction(
      base,
      act({ type: 'setCondition', playerId: DEMO_ME, slotId: 'active', condition: 'burned', on: true }),
    );
    let checking = enterCheck(burned);
    checking = resolveCurrent(checking, { poisonCounters: 1 });
    const target = nextPokemonCheckTarget(checking)!.target;
    const { intent } = renderCheck(checking);
    fireEvent.click(screen.getByRole('button', { name: '+2してコイン' }));
    expect(intent).toHaveBeenCalledWith({
      type: 'resolvePokemonCheckTarget',
      order: 2,
      playerId: target.playerId,
      slotId: target.slotId,
      expectedTopInstanceId: target.topInstanceId,
    });
  });

  it('ねむりはサーバー側コインの対象になり、結果を共有表示する', () => {
    const asleep = applyAction(
      base,
      act({ type: 'setCondition', playerId: DEMO_ME, slotId: 'active', condition: 'asleep', on: true }),
    );
    let checking = enterCheck(asleep);
    checking = resolveCurrent(checking, { poisonCounters: 1 });
    const target = nextPokemonCheckTarget(checking)!.target;
    const { intent, dispatch } = renderCheck(checking);
    fireEvent.click(screen.getByRole('button', { name: 'コインを投げる' }));
    expect(intent).toHaveBeenCalledWith({
      type: 'resolvePokemonCheckTarget',
      order: 3,
      playerId: target.playerId,
      slotId: target.slotId,
      expectedTopInstanceId: target.topInstanceId,
    });
    expect(dispatch).not.toHaveBeenCalled();

    const resolved = resolveCurrent(checking, { coinResult: 'heads' });
    renderCheck(resolved);
    expect(screen.getByText('コイン オモテ')).toBeTruthy();
  });

  it('マヒは直前に番を行った持ち主の画面から自動回復を依頼する', async () => {
    const paralyzed = applyAction(
      base,
      act({
        type: 'setCondition',
        playerId: DEMO_ME,
        slotId: 'active',
        condition: 'paralyzed',
        on: true,
      }),
    );
    let checking = enterCheck(paralyzed);
    checking = resolveCurrent(checking, { poisonCounters: 1 });
    const target = nextPokemonCheckTarget(checking)!.target;
    const { intent } = renderCheck(checking);
    await waitFor(() =>
      expect(intent).toHaveBeenCalledWith({
        type: 'resolvePokemonCheckTarget',
        order: 4,
        playerId: target.playerId,
        slotId: target.slotId,
        expectedTopInstanceId: target.topInstanceId,
      }),
    );
  });

  it('未実装効果の例外はスキップして先へ進める', () => {
    const checking = enterCheck();
    const target = nextPokemonCheckTarget(checking)!.target;
    const { intent } = renderCheck(checking);
    fireEvent.click(screen.getByRole('button', { name: 'スキップ' }));
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resolvePokemonCheckTarget',
        order: 1,
        playerId: target.playerId,
        skip: true,
      }),
    );
  });
});

describe('処理完了ときぜつ検出', () => {
  it('未処理中は完了できず、全対象の解決後に番を進められる', () => {
    const checking = enterCheck();
    const first = renderCheck(checking);
    expect((screen.getByRole('button', { name: 'チェック完了' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(first.intent).not.toHaveBeenCalled();

    const complete = resolveCurrent(checking, { poisonCounters: 1 });
    expect(isPokemonCheckComplete(complete)).toBe(true);
    const second = renderCheck(complete);
    fireEvent.click(screen.getAllByRole('button', { name: 'チェック完了' }).at(-1)!);
    expect(second.intent).toHaveBeenCalledWith({ type: 'endTurn' });
  });

  it('最後の特殊状態処理でHPが0になると、番を移す前にきぜつ候補になる', () => {
    const nearKnockout = applyAction(
      base,
      act({ type: 'setDamage', playerId: DEMO_ME, slotId: 'active', counters: 17 }),
    );
    const checking = enterCheck(nearKnockout);
    const complete = resolveCurrent(checking, { poisonCounters: 1 });
    expect(isPokemonCheckComplete(complete)).toBe(true);
    expect(findKnockoutCandidates(complete, { cards: sampleCardIndex })).toEqual([
      expect.objectContaining({ playerId: DEMO_ME, slotId: 'active' }),
    ]);
    expect(complete.phase).toBe('pokemonCheck');
  });
});
