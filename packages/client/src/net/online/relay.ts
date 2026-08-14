/**
 * 対戦の中継（第5段階 T48）。
 *
 * ★卓（Room）はホストのブラウザにある。サーバーは置かない。
 *   ゲストは「こうしたい」を送り、ホストが正しさを決めて盤面を配る。
 *   第2段階からのサーバー権威型（§4.1）をそのまま持ってきた形で、
 *   ★可視性のフィルタ（filterStateFor）を通す場所も変わらない。
 *
 * ★このファイルは Firestore を知らない形（Relay）と、実際に Firestore を使う形を分ける。
 *   分けないと、中継の理屈をテストするのに本物のデータベースが要る。
 */
import type {
  ActionRequest,
  GameState,
  Intent,
  PlayerId,
  SubmittedDeck,
} from '@pokeca/shared';

/** ゲストが送る「こうしたい」。ホストだけが正しさを判断する */
export interface RelayIntent {
  id: string;
  /** 送り主。★Firebase の UID。席の取り違えを防ぐ唯一の手がかり */
  uid: string;
  body: { kind: 'intent'; intent: Intent } | { kind: 'action'; action: ActionRequest };
}

/** 卓に座っている人 */
export interface Seat {
  uid: string;
  playerId: PlayerId;
  displayName: string;
}

/**
 * その人あての知らせ（T49）。
 *
 * ★卓が断った理由を、断られた本人に届けるためのもの。
 *   これがないと、ゲストからは「押しても盤面が変わらない」としか見えない。
 * ★seq は同じ知らせを二度出さないための番号（読み込み直しで再送されるため）。
 */
export interface StateNotice {
  seq: number;
  message: string;
}

/**
 * 中継の口。Firestore でも、あとで別の仕組みに替えても、ここだけ差し替えれば済む。
 */
export interface Relay {
  /** その人に見える盤面を置く。★人ごとに別の場所へ置く（他人のぶんは読めない） */
  publishState: (uid: string, state: GameState) => Promise<void>;
  /** その人あての知らせを置く。★盤面と同じ置き場に重ねる（消し合わない） */
  publishNotice: (uid: string, notice: StateNotice) => Promise<void>;
  /** 席の割り当てを配る */
  publishSeats: (seats: readonly Seat[]) => Promise<void>;
  /** 届いた要求を受け取る。戻り値は購読の解除 */
  onIntent: (handler: (intent: RelayIntent) => void) => () => void;
  /** 処理し終えた要求を片づける */
  ackIntent: (id: string) => Promise<void>;
}

/** ホスト側が持つ卓の最小の口。Room をそのまま渡せる形にしてある */
export interface MatchEngine {
  join: (displayName: string, playerId?: PlayerId, deck?: SubmittedDeck) => { playerId: PlayerId };
  submitIntent: (actorId: PlayerId, intent: Intent) => void;
  submitAction: (actorId: PlayerId, action: ActionRequest) => void;
  stateFor: (playerId: PlayerId) => GameState;
}
