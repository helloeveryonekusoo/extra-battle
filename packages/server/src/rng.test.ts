import { describe, expect, it } from 'vitest';
import { SeededRng } from './rng';

const DECK = Array.from({ length: 20 }, (_, i) => `card-${i}`);

describe('SeededRng', () => {
  it('同じシードなら同じ結果が出る（対戦の再現）', () => {
    const a = new SeededRng('game-1');
    const b = new SeededRng('game-1');
    expect(a.shuffle(DECK).value).toEqual(b.shuffle(DECK).value);
    expect(a.coins(5).value).toEqual(b.coins(5).value);
  });

  it('シードが違えば結果も変わる', () => {
    const a = new SeededRng('game-1').shuffle(DECK).value;
    const b = new SeededRng('game-2').shuffle(DECK).value;
    expect(a).not.toEqual(b);
  });

  it('同じ卓でも引くたびに違う結果になる', () => {
    const rng = new SeededRng('game-1');
    expect(rng.shuffle(DECK).value).not.toEqual(rng.shuffle(DECK).value);
  });

  it('途中から再開しても続きの結果が一致する', () => {
    const full = new SeededRng('game-1');
    full.shuffle(DECK);
    full.shuffle(DECK);
    const third = full.shuffle(DECK).value;

    const resumed = new SeededRng('game-1', 2);
    expect(resumed.shuffle(DECK).value).toEqual(third);
  });

  it('シャッフルは元の配列を壊さず、枚数と中身を保つ', () => {
    const source = [...DECK];
    const { value } = new SeededRng('game-1').shuffle(source);
    expect(source).toEqual(DECK);
    expect([...value].sort()).toEqual([...DECK].sort());
  });

  it('ラベルをログに残せる', () => {
    const rng = new SeededRng('game-1');
    expect(rng.shuffle(DECK).seed).toBe('game-1:1');
    expect(rng.coins(1).seed).toBe('game-1:2');
    expect(rng.drawn).toBe(2);
  });

  it('コインはオモテもウラも出る', () => {
    const { value } = new SeededRng('game-1').coins(200);
    expect(value.filter((f) => f === 'heads').length).toBeGreaterThan(60);
    expect(value.filter((f) => f === 'tails').length).toBeGreaterThan(60);
  });
});
