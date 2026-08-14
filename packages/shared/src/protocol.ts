/**
 * クライアント ⇔ サーバー の通信プロトコル（T6）。
 *
 * §4.1 の流れ:
 *   Client → Server : Action（または Intent）
 *   Server          : ログに追記 → 状態更新
 *   Server → Client : 可視性フィルタ済みの StateSnapshot
 *
 * 状態は数KB なので差分同期はしない。毎回フルステートを送る。
 *
 * ★乱数を含む操作はクライアントが組み立てられない（§4.2）。
 *   そこで「やりたいこと（Intent）」だけを送り、サーバーが結果を確定して
 *   Action に仕立てる。クライアントは乱数を一切持たない。
 */
import type { Action } from './actions';
import type { CardText, GameState, PlayerId, SlotId } from './types';

export const DEFAULT_SERVER_PORT = 8787;

/** union の各メンバーごとに Omit する。素の Omit だと union が潰れる */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** サーバーが actorId と打刻を付ける前の Action */
export type UnstampedAction = DistributiveOmit<Action, 'actorId' | 'at'>;

/**
 * サーバーが中身を決めなければならない操作。
 * 乱数が要るものと、伏せられたカードの instanceId が要るもの（knockOut のサイド）。
 */
export type RandomActionType =
  | 'setupDeck'
  | 'shuffleDeck'
  | 'shuffleIntoDeck'
  | 'drawCards'
  | 'flipCoin'
  | 'randomChoice'
  | 'knockOut'
  | 'resolvePokemonCheckTarget'
  | 'detectDefeat'
  | 'confirmGameEnd';

/** クライアントが自分で組み立ててよい Action */
export type DeterministicAction = Exclude<Action, { type: RandomActionType }>;

/** クライアントが送る Action。actorId と打刻はサーバーが付ける */
export type ActionRequest = DistributiveOmit<DeterministicAction, 'actorId' | 'at' | 'seed'>;

/** 乱数を必要とする操作の依頼 */
export type Intent =
  | { type: 'shuffleDeck'; playerId: PlayerId }
  | { type: 'shuffleIntoDeck'; playerId: PlayerId; cardIds: string[] }
  | { type: 'drawCards'; playerId: PlayerId; count: number }
  | { type: 'flipCoin'; playerId: PlayerId; count: number; reason?: string }
  | { type: 'randomChoice'; label: string; options: string[] }
  /**
   * マリガン。手札を山札に戻して切り、7枚引き直す（§T10）。
   * どのカードが山札のどこへ行くかはサーバーが決める。
   */
  | { type: 'mulligan'; playerId: PlayerId; handSize?: number }
  /** 山札の上からサイドを置く。どのカードかはクライアントに選ばせない */
  | { type: 'dealPrizes'; playerId: PlayerId; count: number }
  /**
   * 取り消し要求への返事（T11）。
   * 承認したときの巻き戻しはサーバーが保持しているスナップショットで行うので、
   * クライアント側の Action にはできない。
   */
  | { type: 'resolveUndo'; requestId: string; approve: boolean }
  /**
   * 番を終える（T13）。
   * 次のプレイヤーの番の開始ドローまでをサーバーが続けて行う。
   * 山札が空なら引かない（敗北条件の検出は T18）。
   */
  | { type: 'endTurn'; drawCount?: number }
  /** 現在の公開盤面にサイド0・場0の敗北条件がないかサーバーへ確認を依頼する */
  | { type: 'detectDefeat' }
  /** 検出済みの対戦結果を自分が確認する */
  | { type: 'confirmGameEnd'; proposalId: string }
  /** ポケモンチェックの現在対象を1件処理する。コイン結果はサーバーが決める */
  | {
      type: 'resolvePokemonCheckTarget';
      order: 1 | 2 | 3 | 4;
      playerId: PlayerId;
      slotId: SlotId;
      expectedTopInstanceId: string;
      poisonCounters?: number;
      skip?: boolean;
    }
  /**
   * きぜつを確定する（T16）。
   * サイドは伏せてあり instanceId がクライアントに見えないので、
   * どのサイドを手札へ移すかはサーバーが決める。
   * ★prizeCount は人が決めた値をそのまま渡す（既定値の押しつけをしない）。
   */
  | {
      type: 'knockOut';
      playerId: PlayerId;
      slotId: SlotId;
      /** 確認ダイアログを出した時点の一番上のカード。古い要求の誤適用を防ぐ */
      expectedTopInstanceId: string;
      prizePlayerId: PlayerId | null;
      prizeCount: number;
    }
  /**
   * 応答待ちの選択に答える（T25）。
   * ★答えられるのは pendingChoice.chooser 本人だけ。サーバーが照合する。
   */
  | { type: 'resolveChoice'; requestId: string; selected: string[] }
  /**
   * カード定義に登録された効果を開始する。DSL本体はサーバーがカードIDから解決する。
   * abilityIndex を添えると、そのカードの **特性** を使う（T34）。
   */
  | { type: 'useCardEffect'; instanceId: string; abilityIndex?: number; attackIndex?: number }
  /** 開発用のサンプルデッキ投入 */
  | { type: 'devDealSampleDeck'; playerId: PlayerId; size: number };

export interface PresenceEntry {
  playerId: PlayerId;
  displayName: string;
  connected: boolean;
}

/**
 * 対戦開始時にクライアントから渡す保存デッキ。
 * 山札順と instanceId は含めず、サーバーが採番・シャッフルする。
 */
export interface SubmittedDeck {
  name: string;
  cards: { functionalId: string; count: number }[];
}

export type ClientMessage =
  | { type: 'createRoom'; displayName: string; deck?: SubmittedDeck }
  /** playerId を添えると、切断した席に戻れる */
  | {
      type: 'joinRoom';
      roomCode: string;
      displayName: string;
      playerId?: PlayerId;
      deck?: SubmittedDeck;
    }
  | { type: 'action'; action: ActionRequest }
  | { type: 'intent'; intent: Intent }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'hello'; protocolVersion: number }
  | {
      type: 'joined';
      roomCode: string;
      playerId: PlayerId;
      /** カード定義はプール全体を配る。誰が何を持っているかは含まないので漏れない */
      cards: CardText[];
    }
  /** 可視性フィルタ済みのフルステート */
  | { type: 'state'; state: GameState }
  | { type: 'presence'; players: PresenceEntry[] }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** 受信データを message として読む。壊れていたら null */
export function decode<T extends ClientMessage | ServerMessage>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as T).type === 'string') {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}
