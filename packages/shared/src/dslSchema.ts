/**
 * 効果DSL の JSON Schema と検証（T23）。
 *
 * ★スキーマは dsl.ts の語彙一覧（OP_CODES など）から組み立てる。
 *   手書きの二重管理にしないので、型とスキーマがずれない。
 *
 * ★外部ライブラリ（ajv 等）を足さない。
 *   使っているのは JSON Schema のごく一部（type / enum / const / properties /
 *   required / additionalProperties / items / oneOf / $ref / minimum / minItems）だけなので、
 *   その部分集合だけを解釈する検証器を自前で持つ。
 *   出力する schema.json 自体は標準の JSON Schema なので、エディタの補完にもそのまま使える。
 */
import { ENERGY_TYPES, RULE_BOXES, STAGES, TRAINER_KINDS } from './cardVocabulary';
import {
  COMPARES,
  EFFECT_APPLY_AT,
  EFFECT_DURATION_TYPES,
  EFFECT_KINDS,
  EXPIRY_CONDITIONS,
  PLAYER_REFS,
  SPECIAL_CONDITIONS,
  ZONES,
  type Op,
} from './dsl';

export type JsonSchema = Record<string, unknown>;

export class DslError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`効果定義が不正です:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'DslError';
    this.issues = issues;
  }
}

// ── スキーマの組み立て ──────────────────

const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const enumOf = (values: readonly string[]): JsonSchema => ({ enum: [...values] });
const int = (minimum = 0): JsonSchema => ({ type: 'integer', minimum });
const str: JsonSchema = { type: 'string' };
const bool: JsonSchema = { type: 'boolean' };
const arrayOf = (items: JsonSchema): JsonSchema => ({ type: 'array', items });

/** 判別子つきの union。分岐を1つに絞れるのでエラーメッセージが具体的になる */
const union = (propertyName: string, branches: JsonSchema[]): JsonSchema => ({
  oneOf: branches,
  discriminator: { propertyName },
});

const object = (
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  required: [...required],
  additionalProperties: false,
});

/** op / kind などのタグを先頭に足したオブジェクト */
const tagged = (
  key: string,
  tag: string,
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema => object({ [key]: { const: tag }, ...properties }, [key, ...required]);

function buildDefs(): Record<string, JsonSchema> {
  const slotRef = ref('SlotRef');
  const cardFilter = ref('CardFilter');
  const playerRef = ref('PlayerRef');
  const zone = ref('Zone');

  return {
    PlayerRef: enumOf(PLAYER_REFS),
    Zone: enumOf(ZONES),
    EnergyType: enumOf(ENERGY_TYPES),
    Stage: enumOf(STAGES),
    RuleBox: enumOf(RULE_BOXES),
    TrainerKind: enumOf(TRAINER_KINDS),
    SpecialCondition: enumOf(SPECIAL_CONDITIONS),
    Compare: enumOf(COMPARES),
    ExpiryCondition: enumOf(EXPIRY_CONDITIONS),

    /** 枚数。bindings から引くこともある */
    CountValue: {
      oneOf: [int(0), object({ binding: str }, ['binding']), object({ from: ref('CountSource') }, ['from'])],
    },
    CountOrAll: { oneOf: [int(0), { const: 'all' }] },

    CardFilter: object({
      anyOf: arrayOf(ref('CardFilter')),
      supertype: arrayOf(enumOf(['pokemon', 'trainer', 'energy'])),
      stage: arrayOf(ref('Stage')),
      types: arrayOf(ref('EnergyType')),
      typesNot: arrayOf(ref('EnergyType')),
      ruleBox: { oneOf: [{ const: 'any' }, { const: 'none' }, arrayOf(ref('RuleBox'))] },
      ruleBoxNot: arrayOf(ref('RuleBox')),
      nameExact: arrayOf(str),
      nameNotExact: arrayOf(str),
      nameContains: str,
      hpMax: int(0),
      isBasicEnergy: bool,
      energyProvides: arrayOf(ref('EnergyType')),
      hasAbilities: bool,
      trainerKind: arrayOf(ref('TrainerKind')),
      tag: arrayOf(str),
    }),

    SlotFilter: object({
      where: enumOf(['active', 'bench']),
      card: cardFilter,
      hasDamage: bool,
      hasEnergy: bool,
      hasTool: bool,
      hasCondition: bool,
    }),

    SlotRef: union('kind', [
      tagged('kind', 'active', { player: playerRef }, ['player']),
      tagged('kind', 'bench', { player: playerRef, index: int(0) }, ['player']),
      tagged('kind', 'self', {}),
      tagged('kind', 'choose', { player: playerRef, chooser: playerRef, filter: ref('SlotFilter') }, [
        'player',
        'chooser',
      ]),
      tagged('kind', 'binding', { name: str }, ['name']),
    ]),

    CountSource: union('source', [
      tagged('source', 'zone', { zone, owner: playerRef, filter: cardFilter }, ['zone', 'owner']),
      tagged('source', 'prizes', { player: playerRef }, ['player']),
      tagged('source', 'bench', { player: playerRef }, ['player']),
      tagged('source', 'inPlay', { player: playerRef, filter: cardFilter }, ['player']),
      tagged('source', 'damageCounters', { target: slotRef }, ['target']),
      tagged('source', 'attachedEnergy', { target: slotRef }, ['target']),
      tagged('source', 'binding', { name: str }, ['name']),
    ]),

    Condition: union('kind', [
      tagged('kind', 'coin', { binding: str, face: enumOf(['heads', 'tails']), atLeast: int(0) }, [
        'binding',
        'face',
      ]),
      tagged('kind', 'count', { of: ref('CountSource'), compare: ref('Compare'), value: int(0) }, [
        'of',
        'compare',
        'value',
      ]),
      tagged('kind', 'exists', { slot: slotRef }, ['slot']),
      tagged('kind', 'playersTurn', { player: playerRef, compare: ref('Compare'), value: int(0) }, [
        'player',
        'compare',
        'value',
      ]),
      tagged('kind', 'knockedOutLastOpponentTurn', { player: playerRef }, ['player']),
      tagged('kind', 'option', { binding: str, equals: str }, ['binding', 'equals']),
      tagged('kind', 'not', { of: ref('Condition') }, ['of']),
      tagged('kind', 'and', { of: arrayOf(ref('Condition')) }, ['of']),
      tagged('kind', 'or', { of: arrayOf(ref('Condition')) }, ['of']),
    ]),

    EffectDuration: object({ type: enumOf(EFFECT_DURATION_TYPES) }, ['type']),

    EffectTargetTemplate: {
      oneOf: [
        object({ slot: slotRef }, ['slot']),
        object({ player: playerRef }, ['player']),
        object({ global: { const: true } }, ['global']),
      ],
    },

    ActiveEffectTemplate: object(
      {
        target: ref('EffectTargetTemplate'),
        applyAt: enumOf(EFFECT_APPLY_AT),
        kind: enumOf(EFFECT_KINDS),
        payload: { type: 'object' },
        duration: ref('EffectDuration'),
        expiresOn: arrayOf(ref('ExpiryCondition')),
        label: str,
      },
      ['target', 'applyAt', 'kind', 'duration'],
    ),

    Op: union('op', [
      tagged(
        'op',
        'draw',
        { player: playerRef, count: ref('CountValue'), upToHandSize: ref('CountValue') },
        ['player', 'count'],
      ),

      tagged(
        'op',
        'search',
        {
          from: zone,
          owner: playerRef,
          filter: cardFilter,
          slotFilter: ref('SlotFilter'),
          count: int(0),
          upTo: bool,
          dest: zone,
          destSlot: slotRef,
          chooser: playerRef,
          reveal: bool,
          thenShuffle: bool,
          lookAt: int(1),
          bind: str,
        },
        ['from', 'owner', 'filter', 'count', 'upTo', 'dest', 'chooser', 'reveal', 'thenShuffle'],
      ),

      tagged(
        'op',
        'attachEnergy',
        {
          from: { oneOf: [zone, { const: 'inPlay' }] },
          filter: cardFilter,
          count: int(0),
          upTo: bool,
          target: slotRef,
          distribution: enumOf(['free', 'single']),
          lookAt: int(1),
          thenShuffle: bool,
        },
        ['from', 'filter', 'count', 'upTo', 'target', 'distribution'],
      ),

      tagged(
        'op',
        'moveCard',
        {
          from: { oneOf: [zone, { const: 'inPlay' }, { const: 'field' }] },
          to: zone,
          owner: playerRef,
          filter: cardFilter,
          slotFilter: ref('SlotFilter'),
          count: ref('CountOrAll'),
          chooser: playerRef,
          position: enumOf(['top', 'bottom']),
          includeAttached: bool,
          upTo: bool,
          bind: str,
        },
        ['from', 'to', 'owner', 'count', 'chooser'],
      ),

      tagged(
        'op',
        'discard',
        {
          from: zone,
          owner: playerRef,
          filter: cardFilter,
          count: ref('CountOrAll'),
          chooser: playerRef,
          upTo: bool,
          optional: bool,
          lookAt: int(1),
          bind: str,
        },
        ['from', 'owner', 'count', 'chooser'],
      ),

      tagged(
        'op',
        'evolve',
        {
          from: enumOf(['deck', 'hand']),
          player: playerRef,
          target: slotRef,
          chooser: playerRef,
          filter: cardFilter,
          skipStage1: bool,
          thenShuffle: bool,
        },
        ['from', 'player', 'target', 'chooser', 'thenShuffle'],
      ),

      tagged(
        'op',
        'switch',
        { side: enumOf(['own', 'opponent']), chooser: playerRef, target: slotRef },
        ['side', 'chooser'],
      ),

      tagged(
        'op',
        'damageCounter',
        {
          action: enumOf(['place', 'remove', 'move']),
          count: int(0),
          target: slotRef,
          from: slotRef,
          distribution: enumOf(['free', 'single']),
        },
        ['action', 'count', 'target', 'distribution'],
      ),

      tagged('op', 'heal', { target: slotRef, amount: { oneOf: [int(0), { const: 'all' }] } }, [
        'target',
        'amount',
      ]),

      tagged('op', 'coinFlip', { count: { oneOf: [int(1), { const: 'untilTails' }] }, bind: str }, [
        'count',
        'bind',
      ]),

      tagged(
        'op',
        'chooseOption',
        {
          chooser: playerRef,
          bind: str,
          options: arrayOf(object({ id: str, label: str }, ['id', 'label'])),
        },
        ['chooser', 'bind', 'options'],
      ),

      tagged('op', 'clearEffects', { source: enumOf(['attack', 'all']) }, ['source']),

      tagged(
        'op',
        'setCondition',
        { target: slotRef, condition: ref('SpecialCondition'), counterOverride: int(0) },
        ['target', 'condition'],
      ),

      tagged('op', 'applyEffect', { effect: ref('ActiveEffectTemplate') }, ['effect']),

      tagged(
        'op',
        'useAttackAs',
        {
          from: enumOf(['opponentActive', 'ownTrash', 'ownBench', 'anyInPlay']),
          filter: cardFilter,
          requireEnergy: bool,
        },
        ['from', 'requireEnergy'],
      ),

      tagged('op', 'shuffle', { zone, owner: playerRef }, ['zone', 'owner']),

      tagged(
        'op',
        'if',
        { cond: ref('Condition'), then: ref('OpList'), else: ref('OpList') },
        ['cond', 'then'],
      ),

      tagged('op', 'repeat', { times: ref('CountValue'), body: ref('OpList') }, ['times', 'body']),

      tagged('op', 'manual', { prompt: str }, ['prompt']),
    ]),

    OpList: arrayOf(ref('Op')),
  };
}

/**
 * カード定義ファイルの `effects` を検証するための JSON Schema。
 * ルートはオペコードの配列。
 */
export function buildEffectsJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://pokeca.local/schema/effects.json',
    title: 'ポケカ エクストラ 対戦卓 — 効果DSL',
    description:
      'カード定義の effects（Op[]）を検証する。第3段階 §3.1 のオペコードに対応する。',
    $ref: '#/$defs/OpList',
    $defs: buildDefs(),
  };
}

export const EFFECTS_JSON_SCHEMA: JsonSchema = buildEffectsJsonSchema();

// ── 検証器（JSON Schema の部分集合） ──────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** $ref をたどって実体のスキーマにする */
function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  let current = schema;
  for (let guard = 0; guard < 20; guard += 1) {
    const target = current['$ref'];
    if (typeof target !== 'string') return current;
    const name = target.replace('#/$defs/', '');
    const defs = root['$defs'];
    const next = isRecord(defs) ? defs[name] : undefined;
    if (!isRecord(next)) return {};
    current = next;
  }
  return current;
}

const show = (v: unknown): string => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

function check(
  value: unknown,
  schemaIn: JsonSchema,
  root: JsonSchema,
  path: string,
  issues: string[],
): void {
  const schema = resolveRef(schemaIn, root);

  if ('const' in schema && value !== schema['const']) {
    issues.push(`${path}: ${show(schema['const'])} でなければなりません`);
    return;
  }

  const allowed = schema['enum'];
  if (Array.isArray(allowed)) {
    if (!allowed.includes(value)) {
      issues.push(`${path}: ${show(value)} は使えません（${allowed.map(String).join(' / ')}）`);
    }
    return;
  }

  // ── union（判別子があれば1分岐に絞る） ──
  const branches = schema['oneOf'] ?? schema['anyOf'];
  if (Array.isArray(branches)) {
    const discriminator = schema['discriminator'];
    const key = isRecord(discriminator) ? String(discriminator['propertyName']) : null;

    if (key && isRecord(value)) {
      const tag = value[key];
      const tagOf = (branch: unknown): unknown => {
        const resolved = resolveRef(branch as JsonSchema, root);
        const props = resolved['properties'];
        const prop = isRecord(props) ? props[key] : undefined;
        return isRecord(prop) ? prop['const'] : undefined;
      };
      const matched = branches.find((b) => tagOf(b) === tag);
      if (!matched) {
        const known = branches.map(tagOf).filter((t) => t !== undefined).map(String);
        issues.push(`${path}: ${key} が ${show(tag)} のものはありません（${known.join(' / ')}）`);
        return;
      }
      check(value, matched as JsonSchema, root, path, issues);
      return;
    }

    const passes = branches.some((b) => {
      const scratch: string[] = [];
      check(value, b as JsonSchema, root, path, scratch);
      return scratch.length === 0;
    });
    if (!passes) issues.push(`${path}: ${show(value)} はどの形にも当てはまりません`);
    return;
  }

  const type = schema['type'];
  if (typeof type === 'string' && !matchesType(value, type)) {
    issues.push(`${path}: ${type} が必要です（${show(value)}）`);
    return;
  }

  if (typeof value === 'number' && typeof schema['minimum'] === 'number') {
    if (value < schema['minimum']) {
      issues.push(`${path}: ${schema['minimum']} 以上にしてください（${value}）`);
    }
  }

  if (Array.isArray(value)) {
    const min = schema['minItems'];
    if (typeof min === 'number' && value.length < min) {
      issues.push(`${path}: 要素が${min}個以上必要です`);
    }
    const items = schema['items'];
    if (isRecord(items)) {
      value.forEach((item, i) => check(item, items, root, `${path}[${i}]`, issues));
    }
    return;
  }

  if (isRecord(value)) {
    const properties = schema['properties'];
    if (!isRecord(properties)) return;

    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (value[String(key)] === undefined) issues.push(`${path}: "${String(key)}" がありません`);
      }
    }

    if (schema['additionalProperties'] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(`${path}: "${key}" は知らないキーです`);
      }
    }

    for (const [key, sub] of Object.entries(properties)) {
      const child = value[key];
      // 省略可能なキーは undefined を許す
      if (child === undefined) continue;
      if (isRecord(sub)) check(child, sub, root, `${path}.${key}`, issues);
    }
  }
}

/** JSON Schema（部分集合）で検証して、問題を全部まとめて返す */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema = EFFECTS_JSON_SCHEMA,
  path = 'effects',
): string[] {
  const issues: string[] = [];
  check(value, schema, schema, path, issues);
  return issues;
}

/**
 * カード定義の effects を Op[] として読む。
 * 1つでも不正があれば DslError を投げ、問題を全部まとめて報告する。
 */
export function parseOps(input: unknown, where = 'effects'): Op[] {
  const issues = validateAgainstSchema(input, EFFECTS_JSON_SCHEMA, where);
  if (issues.length > 0) throw new DslError(issues);
  return input as Op[];
}
