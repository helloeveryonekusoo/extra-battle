/**
 * サーバー専用の乱数（§4.2）。
 *
 * コイントス・シャッフル・じゃんけんはすべてここを通る。クライアントには乱数を持たせない。
 * 呼び出しごとに `<対戦シード>:<通し番号>` というラベルを作り、
 * そのラベルから決定的に乱数列を作る。ラベルをログに残せば対戦を再現できる。
 */
import type { CoinFace } from '@pokeca/shared';

/** 文字列 → 32bit 種（FNV-1a） */
function seedFrom(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32。小さくて質が十分な決定的PRNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface RandomResult<T> {
  value: T;
  /** ログに残すラベル。同じラベルからは必ず同じ結果が出る */
  seed: string;
}

export class SeededRng {
  private counter: number;

  constructor(
    private readonly baseSeed: string,
    startCounter = 0,
  ) {
    this.counter = startCounter;
  }

  /** 何回乱数を引いたか。再接続時に続きから回すために使う */
  get drawn(): number {
    return this.counter;
  }

  private nextStream(): { rand: () => number; seed: string } {
    this.counter += 1;
    const seed = `${this.baseSeed}:${this.counter}`;
    return { rand: mulberry32(seedFrom(seed)), seed };
  }

  /** Fisher-Yates。元の配列は壊さない */
  shuffle<T>(items: readonly T[]): RandomResult<T[]> {
    const { rand, seed } = this.nextStream();
    const value = [...items];
    for (let i = value.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const a = value[i]!;
      const b = value[j]!;
      value[i] = b;
      value[j] = a;
    }
    return { value, seed };
  }

  coins(count: number): RandomResult<CoinFace[]> {
    const { rand, seed } = this.nextStream();
    const value: CoinFace[] = [];
    for (let i = 0; i < count; i += 1) {
      value.push(rand() < 0.5 ? 'heads' : 'tails');
    }
    return { value, seed };
  }

  pick<T>(options: readonly T[]): RandomResult<T> {
    if (options.length === 0) throw new Error('選択肢が空です');
    const { rand, seed } = this.nextStream();
    return { value: options[Math.floor(rand() * options.length)]!, seed };
  }
}
