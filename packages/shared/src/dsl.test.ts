/**
 * T23 の完了条件:
 * 「型のみでコンパイルが通り、不正な Op を JSON Schema で弾ける」
 *
 * 型が通ることは typecheck が保証するので、ここでは
 *   1. 実在カードの効果を DSL で書けること（型と Schema の両方を通ること）
 *   2. 不正な Op が Schema で弾かれること
 *   3. 型とスキーマがずれていないこと
 * を確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  CONDITION_KINDS,
  COUNT_SOURCES,
  OP_CODES,
  SLOT_REF_KINDS,
  effectModeOf,
  type Op,
} from './dsl';
import {
  DslError,
  EFFECTS_JSON_SCHEMA,
  parseOps,
  validateAgainstSchema,
} from './dslSchema';

/**
 * 実在カードを DSL で書いてみる。
 * ★ここが「オペコードで数える」の確認。この4枚が書ければ汎用トレーナーズの大半が書ける。
 */
const REAL_CARDS: { name: string; ops: Op[] }[] = [
  {
    name: 'クイックボール',
    ops: [
      {
        op: 'discard',
        from: 'hand',
        owner: 'self',
        count: 1,
        chooser: 'self',
      },
      {
        op: 'search',
        from: 'deck',
        owner: 'self',
        filter: { supertype: ['pokemon'], stage: ['basic'] },
        count: 1,
        upTo: false,
        dest: 'hand',
        chooser: 'self',
        reveal: true,
        thenShuffle: true,
      },
    ],
  },
  {
    name: '博士の研究',
    ops: [
      { op: 'discard', from: 'hand', owner: 'self', count: 'all', chooser: 'self' },
      { op: 'draw', player: 'self', count: 7 },
    ],
  },
  {
    name: 'ダークパッチ',
    ops: [
      {
        op: 'attachEnergy',
        from: 'discard',
        filter: { isBasicEnergy: true, types: ['darkness'] },
        count: 1,
        upTo: false,
        target: { kind: 'choose', player: 'self', chooser: 'self', filter: { where: 'bench' } },
        distribution: 'single',
      },
    ],
  },
  {
    name: 'ボスの指令',
    ops: [{ op: 'switch', side: 'opponent', chooser: 'self' }],
  },
];

describe('実在カードを DSL で書ける', () => {
  it.each(REAL_CARDS)('$name', ({ ops }) => {
    expect(validateAgainstSchema(ops)).toEqual([]);
    expect(parseOps(ops)).toBe(ops);
  });
});

describe('入れ子・条件つきの効果も書ける', () => {
  it('コインを投げて、オモテならダメカンを追加する', () => {
    const ops: Op[] = [
      { op: 'coinFlip', count: 1, bind: 'flip' },
      {
        op: 'if',
        cond: { kind: 'coin', binding: 'flip', face: 'heads' },
        then: [
          {
            op: 'damageCounter',
            action: 'place',
            count: 3,
            target: { kind: 'active', player: 'opponent' },
            distribution: 'single',
          },
        ],
        else: [{ op: 'manual', prompt: 'ウラだったので何も起きません' }],
      },
    ];
    expect(validateAgainstSchema(ops)).toEqual([]);
  });

  it('サイドの枚数で分岐する（カウンターエネルギー等）', () => {
    const ops: Op[] = [
      {
        op: 'if',
        cond: {
          kind: 'count',
          of: { source: 'prizes', player: 'self' },
          compare: 'lte',
          value: 3,
        },
        then: [{ op: 'manual', prompt: '無色3個ぶんとしてはたらきます' }],
      },
    ];
    expect(validateAgainstSchema(ops)).toEqual([]);
  });

  it('所属タグで絞り込める（★エクストラでは必須）', () => {
    const ops: Op[] = [
      {
        op: 'search',
        from: 'deck',
        owner: 'self',
        filter: { tag: ['フュージョン'] },
        count: 1,
        upTo: true,
        dest: 'hand',
        chooser: 'self',
        reveal: false,
        thenShuffle: true,
      },
    ];
    expect(validateAgainstSchema(ops)).toEqual([]);
  });

  it('applyEffect は消滅条件まで書ける', () => {
    const ops: Op[] = [
      {
        op: 'applyEffect',
        effect: {
          target: { slot: { kind: 'self' } },
          applyAt: 'step5',
          kind: 'damageModifier',
          payload: { delta: 50 },
          duration: { type: 'untilEndOfNextOpponentTurn' },
          expiresOn: ['targetLeavesPlay', 'targetReturnsToBench', 'targetEvolves'],
          label: '受けるワザのダメージ +50',
        },
      },
    ];
    expect(validateAgainstSchema(ops)).toEqual([]);
  });
});

describe('★不正な Op を JSON Schema で弾ける', () => {
  it('知らないオペコードを弾く', () => {
    const issues = validateAgainstSchema([{ op: 'teleport', player: 'self' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('op が "teleport" のものはありません');
  });

  it('必須のキーが欠けているのを弾く', () => {
    const issues = validateAgainstSchema([{ op: 'draw', player: 'self' }]);
    expect(issues).toEqual(['effects[0]: "count" がありません']);
  });

  it('綴り違いのキーを弾く（黙って無視しない）', () => {
    const issues = validateAgainstSchema([
      { op: 'draw', player: 'self', count: 3, playerId: 'p-1' },
    ]);
    expect(issues).toEqual(['effects[0]: "playerId" は知らないキーです']);
  });

  it('列挙にない値を弾く', () => {
    const issues = validateAgainstSchema([{ op: 'shuffle', zone: 'graveyard', owner: 'self' }]);
    expect(issues).toEqual(['effects[0].zone: "graveyard" は使えません（deck / hand / active / bench / prize / discard / lost / stadium）']);
  });

  it('型違いを弾く', () => {
    const issues = validateAgainstSchema([{ op: 'draw', player: 'self', count: '3' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('effects[0].count');
  });

  it('入れ子の中の誤りも位置つきで報告する', () => {
    const issues = validateAgainstSchema([
      {
        op: 'repeat',
        times: 2,
        body: [{ op: 'heal', target: { kind: 'active', player: 'self' }, amount: -10 }],
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('effects[0].body[0].amount');
  });

  it('ルートが配列でないものを弾く', () => {
    expect(validateAgainstSchema({ op: 'draw', player: 'self', count: 1 })).toEqual([
      'effects: array が必要です（{"op":"draw","player":"self","count":1}）',
    ]);
  });

  it('問題は1件目で止めず、全部まとめて報告する', () => {
    const issues = validateAgainstSchema([
      { op: 'draw', player: 'nobody' },
      { op: 'shuffle', zone: 'deck' },
    ]);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('parseOps は DslError を投げる', () => {
    expect(() => parseOps([{ op: 'nope' }])).toThrow(DslError);
    try {
      parseOps([{ op: 'nope' }]);
    } catch (error) {
      expect((error as DslError).issues).toHaveLength(1);
    }
  });
});

describe('スキーマ自体の健全さ', () => {
  it('JSON にして戻しても同じ（外部ツールにそのまま渡せる）', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(EFFECTS_JSON_SCHEMA));
    expect(roundTripped).toEqual(EFFECTS_JSON_SCHEMA);
  });

  /** 判別子つき union の分岐タグを取り出す */
  const tagsOf = (defName: string, key: string): string[] => {
    const defs = EFFECTS_JSON_SCHEMA['$defs'] as Record<string, Record<string, unknown>>;
    const branches = defs[defName]?.['oneOf'] as Record<string, Record<string, { const: string }>>[];
    return branches.map((b) => b['properties']?.[key]?.const ?? '').sort();
  };

  it.each([
    ['Op', 'op', OP_CODES],
    ['SlotRef', 'kind', SLOT_REF_KINDS],
    ['Condition', 'kind', CONDITION_KINDS],
    ['CountSource', 'source', COUNT_SOURCES],
  ] as const)('★型の %s とスキーマの分岐が1対1で対応している', (defName, key, codes) => {
    expect(tagsOf(defName, key)).toEqual([...codes].sort());
  });

  it('$ref がすべて $defs にある', () => {
    const defs = EFFECTS_JSON_SCHEMA['$defs'] as Record<string, unknown>;
    const refs = [...JSON.stringify(EFFECTS_JSON_SCHEMA).matchAll(/#\/\$defs\/(\w+)/g)].map(
      (m) => m[1] as string,
    );
    const missing = [...new Set(refs)].filter((name) => !(name in defs));
    expect(missing).toEqual([]);
  });
});

describe('AUTO / ASSISTED / MANUAL の判定', () => {
  it('効果定義がなければ MANUAL', () => {
    expect(effectModeOf(null)).toBe('MANUAL');
    expect(effectModeOf(undefined)).toBe('MANUAL');
  });

  it('manual を含まなければ AUTO', () => {
    expect(effectModeOf([{ op: 'draw', player: 'self', count: 2 }])).toBe('AUTO');
  });

  it('manual を含めば ASSISTED', () => {
    expect(effectModeOf([{ op: 'manual', prompt: '相手の山札を見る' }])).toBe('ASSISTED');
  });

  it('入れ子の中の manual も見つける', () => {
    const ops: Op[] = [
      {
        op: 'repeat',
        times: 2,
        body: [
          {
            op: 'if',
            cond: { kind: 'exists', slot: { kind: 'active', player: 'opponent' } },
            then: [{ op: 'manual', prompt: '手で処理してください' }],
          },
        ],
      },
    ];
    expect(effectModeOf(ops)).toBe('ASSISTED');
  });
});
