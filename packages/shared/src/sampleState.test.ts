import { describe, expect, it } from 'vitest';
import { sampleGameState } from './sampleState';

describe('sampleGameState（§5 の型が成立することの確認）', () => {
  it('ベンチ上限を定数5にしていない', () => {
    const limits = Object.values(sampleGameState.players).map((p) => p.benchLimit);
    expect(limits).toContain(8);
    expect(new Set(limits).size).toBeGreaterThan(1);
  });

  it('サイド枚数を6固定にしていない', () => {
    const totals = Object.values(sampleGameState.players).map((p) => p.prizesTotal);
    expect(totals).toContain(3);
  });

  it('ターン順を配列で持ち、追加ターンを挿入できる', () => {
    expect(sampleGameState.turnQueue[0]).toBe(sampleGameState.turnQueue[1]);
  });

  it('可視性はゾーンではなくカード単位で決まる', () => {
    const cards = sampleGameState.cards;

    // 同じ hand ゾーンでも、公開済みかどうかで visibleTo が違う
    expect(cards['c-a-hand0']?.visibleTo).toEqual(['p-alice']);
    expect(cards['c-a-hand1']?.visibleTo).toEqual(['p-alice', 'p-bob']);

    // バトル場でもウラのままなら誰にも見えない
    expect(cards['c-a-active']?.zone).toBe('active');
    expect(cards['c-a-active']?.visibleTo).toEqual([]);
    expect(cards['c-a-active']?.faceUp).toBe(false);

    // サイドでもオモテなら両者に見える
    expect(cards['c-a-prize0']?.visibleTo).toEqual(['p-alice', 'p-bob']);
  });

  it('他カードのワザを動的に参照できる', () => {
    const active = sampleGameState.players['p-alice']?.pokemon[0];
    expect(active?.grantedAttacks[0]?.sourceInstanceId).toBe('c-b-active');
  });
});
