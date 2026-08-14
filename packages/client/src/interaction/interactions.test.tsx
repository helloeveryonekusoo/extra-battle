/**
 * T9 の UI 側の確認。
 * メニューの中身は menus.test.ts が押さえているので、ここでは
 * 「操作したら正しい Action が飛ぶか」を見る。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { cardsInZone, type ActionRequest, type CardText, type Intent } from '@pokeca/shared';
import { Board, dropIntoSlot } from '../components/board/Board';
import { DragProvider } from './dnd';
import { useTableController, type Dispatcher } from './useTableController';
import { buildDemoState, DEMO_ME } from '../cards/demoState';
import { sampleCardIndex } from '../cards/sampleCards';

const state = buildDemoState()!;

function Harness({ dispatcher }: { dispatcher: Dispatcher }) {
  const controller = useTableController({
    state,
    cardIndex: sampleCardIndex,
    viewerId: DEMO_ME,
    dispatcher,
  });
  return (
    <DragProvider>
      <Board state={state} viewerId={DEMO_ME} cardIndex={sampleCardIndex} controller={controller} />
      {controller.overlay}
    </DragProvider>
  );
}

function setup() {
  const dispatch = vi.fn<(a: ActionRequest) => void>();
  const intent = vi.fn<(i: Intent) => void>();
  const result = render(<Harness dispatcher={{ dispatch, intent, canRandomize: true }} />);
  return { dispatch, intent, ...result };
}

/** 自分のバトル場（カメックス）のHP表示 */
const myActiveHp = () => screen.getByText('110/180').closest('div')!;

describe('ダメカンの操作（§6.6）', () => {
  it('クリックで +10（ダメカン+1）', () => {
    const { dispatch } = setup();
    fireEvent.click(myActiveHp());
    expect(dispatch).toHaveBeenCalledWith({
      type: 'adjustDamage',
      playerId: DEMO_ME,
      slotId: 'active',
      delta: 1,
    });
  });

  it('Shift+クリックで +50（ダメカン+5）', () => {
    const { dispatch } = setup();
    fireEvent.click(myActiveHp(), { shiftKey: true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'adjustDamage', delta: 5 }),
    );
  });

  it('右クリックで −10（ダメカン−1）', () => {
    const { dispatch } = setup();
    fireEvent.contextMenu(myActiveHp());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'adjustDamage', delta: -1 }),
    );
  });
});

describe('コンテキストメニューから操作できる', () => {
  it('場のポケモンを右クリック → 特殊状態 → やけどを付与', () => {
    const { dispatch } = setup();
    fireEvent.contextMenu(screen.getAllByText('カメックス')[0]!);

    const menu = screen.getByRole('menu');
    fireEvent.mouseEnter(within(menu).getByText('特殊状態'));
    fireEvent.click(screen.getByText('やけど を付与'));

    expect(dispatch).toHaveBeenCalledWith({
      type: 'setCondition',
      playerId: DEMO_ME,
      slotId: 'active',
      condition: 'burned',
      on: true,
    });
  });

  it('手札のカードを右クリック → トラッシュへ', () => {
    const { dispatch } = setup();
    const handCardId = cardsInZone(state, DEMO_ME, 'hand')[0]!.instanceId;
    const name = sampleCardIndex.byFunctionalId.get(state.cards[handCardId]!.functionalId)!.name;

    fireEvent.contextMenu(screen.getAllByText(name)[0]!);
    fireEvent.click(screen.getByText('トラッシュへ'));

    expect(dispatch).toHaveBeenCalledWith({
      type: 'moveCard',
      cardId: handCardId,
      toZone: 'discard',
    });
  });

  it('卓の操作から番を終えられる（次の人の開始ドローまでサーバーが行う）', () => {
    const { intent } = setup();
    fireEvent.click(screen.getByText('卓の操作 ▾'));
    fireEvent.click(
      within(screen.getByRole('menu')).getByText('番を終える（次の人が1枚引く）'),
    );
    expect(intent).toHaveBeenCalledWith({ type: 'endTurn' });
  });

  it('効果でドローできないときはドローなしで番を終えられる', () => {
    const { intent } = setup();
    fireEvent.click(screen.getByText('卓の操作 ▾'));
    fireEvent.click(within(screen.getByRole('menu')).getByText('番を終える（ドローなし）'));
    expect(intent).toHaveBeenCalledWith({ type: 'endTurn', drawCount: 0 });
  });

  it('乱数の要る操作はサーバー経由で送られる', () => {
    const { intent } = setup();
    fireEvent.click(screen.getAllByText('コイン')[0]!);
    expect(intent).toHaveBeenCalledWith({ type: 'flipCoin', playerId: DEMO_ME, count: 1 });
  });

  it('Escape でメニューが閉じる', () => {
    setup();
    fireEvent.contextMenu(screen.getAllByText('カメックス')[0]!);
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('1ターン制限インジケータを押して戻せる', () => {
  it('使用済みのサポートをクリックすると未使用に戻る', () => {
    const { dispatch } = setup();
    fireEvent.click(screen.getByTitle('サポート：使用済み'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'setTurnFlag',
      playerId: DEMO_ME,
      flag: 'supporterUsed',
      value: false,
    });
  });
});

describe('スロットへのドロップの解釈', () => {
  const controller = () => {
    const dispatch = vi.fn<(a: ActionRequest) => void>();
    return {
      dispatch,
      ctrl: {
        dispatch,
        intent: vi.fn(),
        canRandomize: true,
        openMenu: vi.fn(),
        overlay: null,
      },
    };
  };

  const payload = (card?: CardText, fromSlotId?: 'active' | 'bench-0') => ({
    instanceId: 'x-1',
    ownerId: DEMO_ME,
    fromZone: 'hand' as const,
    ...(fromSlotId ? { fromSlotId } : {}),
    card,
    faceDown: false,
  });

  it('空きスロットには「場に出す」', () => {
    const { dispatch, ctrl } = controller();
    dropIntoSlot(payload(), DEMO_ME, 'bench-4', false, ctrl);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'placePokemon', slotId: 'bench-4' }),
    );
  });

  it('埋まっているスロットにエネルギーを落とすと「つける」', () => {
    const { dispatch, ctrl } = controller();
    const energy = sampleCardIndex.byName.get('基本水エネルギー')![0]!;
    dropIntoSlot(payload(energy), DEMO_ME, 'active', true, ctrl);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'attachCard', as: 'energy' }),
    );
  });

  it('どうぐを落とすと「どうぐとしてつける」', () => {
    const { dispatch, ctrl } = controller();
    const tool = sampleCardIndex.byName.get('スピードふうせん')![0]!;
    dropIntoSlot(payload(tool), DEMO_ME, 'active', true, ctrl);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'attachCard', as: 'tool' }),
    );
  });

  it('ポケモンを落とすと「進化」', () => {
    const { dispatch, ctrl } = controller();
    const pokemon = sampleCardIndex.byName.get('カメール')![0]!;
    dropIntoSlot(payload(pokemon), DEMO_ME, 'active', true, ctrl);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'evolvePokemon' }));
  });

  it('場から場へ動かすと「入れ替え」', () => {
    const { dispatch, ctrl } = controller();
    dropIntoSlot(payload(undefined, 'bench-0'), DEMO_ME, 'active', true, ctrl);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'movePokemon',
      playerId: DEMO_ME,
      fromSlotId: 'bench-0',
      toSlotId: 'active',
    });
  });
});
