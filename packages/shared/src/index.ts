/**
 * @pokeca/shared
 * サーバー・クライアント双方から参照する型定義・定数・純粋ロジックの入口。
 */

export * from './types';
export * from './actions';
export * from './rules';
export * from './dsl';
export * from './dslSchema';
export * from './board';
export * from './cardFilter';
export * from './interpreter';
export * from './applicability';
export * from './effects';
export * from './vUnion';
export * from './effectiveCard';
export * from './lock';
export * from './derived';
export * from './ruleBox';
export * from './coverage';
export * from './knockout';
export * from './pokemonCheck';
export * from './defeat';
export * from './damageCalculation';
export * from './deckValidation';
export * from './cards';
export * from './gameState';
export * from './visibility';
export * from './logTargets';
export * from './protocol';
export { sampleGameState } from './sampleState';

export const PROTOCOL_VERSION = 1 as const;

/** ルームコードに使う文字集合（紛らわしい 0/O/1/I を除外） */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
