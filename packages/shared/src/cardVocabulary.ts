/** カードJSONと効果DSLの両方が参照する、循環しない語彙一覧。 */
import type { Ability, EnergyType, RuleBox, Stage, TrainerKind } from './types';

export const ENERGY_TYPES = [
  'grass',
  'fire',
  'water',
  'lightning',
  'psychic',
  'fighting',
  'darkness',
  'metal',
  'fairy',
  'dragon',
  'colorless',
] as const satisfies readonly EnergyType[];

export const STAGES = [
  'basic',
  'stage1',
  'stage2',
  'mega',
  'break',
  'vmax',
  'vstar',
  'vunion',
  'restored',
] as const satisfies readonly Stage[];

export const RULE_BOXES = [
  'EX',
  'MEGA',
  'BREAK',
  'GX',
  'PRISM',
  'TAGTEAM',
  'V',
  'VMAX',
  'VUNION',
  'VSTAR',
  'RADIANT',
  'ex',
] as const satisfies readonly NonNullable<RuleBox>[];

export const TRAINER_KINDS = [
  'item',
  'tool',
  'supporter',
  'stadium',
] as const satisfies readonly TrainerKind[];

export const ABILITY_KINDS = [
  'ability',
  'ancientTrait',
  'pokeBody',
  'pokePower',
] as const satisfies readonly Ability['kind'][];
