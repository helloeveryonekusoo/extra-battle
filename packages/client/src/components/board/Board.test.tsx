/**
 * T8 の完了条件:
 * 「サンプル状態を流し込んで盤面が正しく描画される」
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { applyActions, cardsInZone, type Action } from '@pokeca/shared';
import { Board } from './Board';
import { buildDemoState, DEMO_ME, DEMO_OPPONENT } from '../../cards/demoState';
import { sampleCardIndex } from '../../cards/sampleCards';

const state = buildDemoState()!;

const renderBoard = () =>
  render(<Board state={state} viewerId={DEMO_ME} cardIndex={sampleCardIndex} />);

describe('盤面にサンプル状態を流し込む', () => {
  it('デモ状態が組み上がっている', () => {
    expect(state).not.toBeNull();
    expect(state.players[DEMO_ME]?.pokemon).toHaveLength(4); // バトル場 + ベンチ3
    expect(state.players[DEMO_OPPONENT]?.pokemon).toHaveLength(4);
  });

  it('自分と相手のバトル場が描かれる', () => {
    renderBoard();
    expect(screen.getAllByText('カメックス').length).toBeGreaterThan(0);
    expect(screen.getAllByText('リザードンex').length).toBeGreaterThan(0);
  });

  it('進化スタックの枚数が出る', () => {
    renderBoard();
    expect(screen.getAllByText('進化 3枚').length).toBe(2);
  });

  it('残りHPがダメカンから計算されて出る', () => {
    renderBoard();
    // カメックス HP180 にダメカン7個 → 110
    expect(screen.getByText('110/180')).toBeTruthy();
    // リザードンex HP330 にダメカン12個 → 210
    expect(screen.getByText('210/330')).toBeTruthy();
  });

  it('どうぐと特殊状態が出る', () => {
    renderBoard();
    const board = within(screen.getByLabelText('盤面'));
    expect(board.getByText(/スピードふうせん/)).toBeTruthy();
    expect(board.getByText(/がんじょうベルト/)).toBeTruthy();
    expect(board.getByText('どく')).toBeTruthy();
    expect(board.getByText('こんらん')).toBeTruthy();
    expect(board.getByText('ねむり')).toBeTruthy();
  });

  it('スタジアムが場に出ている', () => {
    renderBoard();
    expect(within(screen.getByLabelText('盤面')).getByText('拡張フィールド')).toBeTruthy();
  });

  it('★ベンチ上限が可変で、8個ぶんのスロットが出る', () => {
    renderBoard();
    // スタジアムでベンチ上限8。空きスロットは「ベンチ4」〜「ベンチ8」
    expect(screen.getAllByText('ベンチ8')).toHaveLength(2); // 自分と相手
    expect(state.players[DEMO_ME]?.benchLimit).toBe(8);
  });

  it('サイドは残っている枚数だけ点灯し、数字も併記される', () => {
    const { container } = renderBoard();
    const huds = container.querySelectorAll('[aria-label^="サイド残り"]');
    expect([...huds].map((h) => h.textContent)).toEqual(['5', '4']); // 相手が上・自分が下
  });

  it('★相手の手札は中身が出ず、枚数だけ分かる', () => {
    renderBoard();
    // 自分の手札のカード名は出る
    expect(screen.getAllByText('サーチボール').length).toBeGreaterThan(0);
    // 相手の手札の中身（リザードンexなど以外の手札カード）は state 上で伏せられている
    const opponentHand = Object.values(state.cards).filter(
      (c) => c.ownerId === DEMO_OPPONENT && c.zone === 'hand',
    );
    expect(opponentHand).toHaveLength(5);
    expect(opponentHand.every((c) => c.functionalId === '')).toBe(true);
  });

  it('ウラのまま出されたベンチポケモンは中身が見えない', () => {
    renderBoard();
    // 相手のベンチ3匹目はウラのまま
    expect(screen.getAllByText('非公開').length).toBeGreaterThan(0);
  });

  it('1ターン制限インジケータが使用済みを示す', () => {
    renderBoard();
    expect(screen.getAllByTitle('エネルギー：使用済み')).toHaveLength(1);
    expect(screen.getAllByTitle('サポート：使用済み')).toHaveLength(1);
    // スタジアムを出したのは自分だけなので、相手側だけが「まだ使える」
    expect(screen.getAllByTitle('スタジアム：使用済み')).toHaveLength(1);
    expect(screen.getAllByTitle('スタジアム：まだ使える')).toHaveLength(1);
    expect(screen.getAllByTitle('にげる：まだ使える')).toHaveLength(2);
  });

  it('操作ログが並ぶ', () => {
    const { container } = renderBoard();
    const log = container.querySelector('aside')!;
    expect(within(log).getByText('操作ログ')).toBeTruthy();
    expect(within(log).getByText(/デモ用のサンプル状態です/)).toBeTruthy();
  });

  it('山札が十分あるうちは警告色が付かない', () => {
    renderBoard();
    const deck = screen.getAllByText('山札')[0]!;
    expect(cardsInZone(state, DEMO_ME, 'deck').length).toBeGreaterThan(10);
    expect(deck.className).not.toContain('low');
  });

  it('山札が10枚以下になると警告色が付く（§6.5）', () => {
    const deck = cardsInZone(state, DEMO_ME, 'deck');
    // 10枚だけ残して他をトラッシュへ送る
    const thin = applyActions(
      state,
      deck.slice(10).map(
        (c) =>
          ({
            type: 'moveCard',
            cardId: c.instanceId,
            toZone: 'discard',
            actorId: DEMO_ME,
            at: 1,
          }) as Action,
      ),
    );
    render(<Board state={thin} viewerId={DEMO_ME} cardIndex={sampleCardIndex} />);
    expect(cardsInZone(thin, DEMO_ME, 'deck')).toHaveLength(10);
    expect(screen.getAllByText('山札')[1]!.className).toContain('low');
  });

  it('★画像を1枚も使っていない（絶対制約）', () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
    expect(container.innerHTML).not.toMatch(/url\(/);
  });
});
