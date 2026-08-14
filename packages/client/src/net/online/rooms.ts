/**
 * 部屋の口（第5段階 T48）。
 *
 * ★Relay と同じ考え方で、Firestore を知らない形にしておく。
 *   こうしておくと、ホストとゲストを繋いだ通しの試験を、
 *   本物のデータベースなしで書ける（session.test.ts）。
 */
import type { PlayerId, SubmittedDeck, GameState } from '@pokeca/shared';
import type { Relay, RelayIntent, StateNotice } from './relay';

/** ゲストが部屋に置いていく名乗り。★ホストはこれを見て席を用意する */
export interface GuestProfile {
  displayName: string;
  deck?: SubmittedDeck;
}

export interface RoomDoc {
  code: string;
  hostUid: string;
  hostName: string;
  /** 部屋に入っている UID。★ルールの判断材料はこれ */
  members: string[];
  /** UID → 席。ホストが配る */
  seats: Record<string, PlayerId>;
  /** UID → 名乗り。ホストが席を作るときに読む */
  guests: Record<string, GuestProfile>;
}

/** 自分あての置き場に届いたもの。盤面と知らせが同じ書類に重なっている */
export interface StateUpdate {
  state?: GameState;
  notice?: StateNotice;
}

export interface RoomsApi {
  /** 部屋を作る。戻り値は部屋コード */
  create: (hostUid: string, hostName: string) => Promise<string>;
  read: (code: string) => Promise<RoomDoc | null>;
  /** 入室。★自分を members に足し、名乗りを置くだけ */
  join: (code: string, uid: string, profile: GuestProfile) => Promise<void>;
  watch: (code: string, onChange: (room: RoomDoc | null) => void) => () => void;
  /** ゲスト側: 自分あての盤面と知らせを受け取る */
  watchState: (code: string, uid: string, onUpdate: (update: StateUpdate) => void) => () => void;
  /** ゲスト側: 要求を送る */
  sendIntent: (code: string, uid: string, body: RelayIntent['body']) => Promise<void>;
  /** ホスト側: 部屋をたたむ。★ゲストに終わりが伝わる唯一の手がかり */
  close: (code: string) => Promise<void>;
  /** ホスト側: 中継 */
  relay: (code: string) => Relay;
}
