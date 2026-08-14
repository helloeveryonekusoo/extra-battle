/**
 * オンライン対戦のひとまとまり（第5段階 T48）。
 *
 * ★ホストのブラウザが卓を持つ。サーバーは置かない。
 *   ホスト  … Room をそのまま動かし、人ごとにフィルタした盤面を配る
 *   ゲスト  … 「こうしたい」を送り、返ってきた盤面をそのまま映す
 *
 * ★カード定義は行き来させない（絶対制約2）。
 *   ユーザーの決めごとどおり、**各自が自分の端末に読み込んだプール** を使う。
 *   だからここで cardPool を送る口は作らない。ホストが自分のプールで卓を建て、
 *   ゲストは自分のプールで画面を描く。
 */
import { Room } from '@pokeca/server/room';
import type {
  ActionRequest,
  CardText,
  GameState,
  Intent,
  PlayerId,
  SubmittedDeck,
} from '@pokeca/shared';
import { MatchHost } from './matchHost';
import type { MatchEngine, Relay, Seat } from './relay';
import type { RoomsApi } from './rooms';

/** 席と、その人がまだ卓にいるか */
export interface SeatPresence extends Seat {
  connected: boolean;
}

export interface OnlineHandlers {
  /** 自分に見える盤面が届いた */
  onState: (state: GameState) => void;
  /** 席が決まった・変わった。自分の playerId もここで分かる */
  onSeats: (seats: readonly SeatPresence[], myPlayerId: PlayerId | null) => void;
  /** 断られた・繋がらなかった。★黙って捨てない */
  onError: (message: string) => void;
}

export interface OnlineSession {
  code: string;
  role: 'host' | 'guest';
  submitIntent: (intent: Intent) => void;
  submitAction: (action: ActionRequest) => void;
  close: () => void;
}

export interface HostOptions {
  uid: string;
  displayName: string;
  deck?: SubmittedDeck;
  /** ホストの手元のカードプール。卓のルール判定はこれで動く */
  cardPool: readonly CardText[];
  rooms: RoomsApi;
  handlers: OnlineHandlers;
  /** 試験で卓を差し替えるため */
  createEngine?: (code: string) => MatchEngine;
}

export interface GuestOptions {
  code: string;
  uid: string;
  displayName: string;
  deck?: SubmittedDeck;
  rooms: RoomsApi;
  handlers: OnlineHandlers;
}

const randomSeed = (): string =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 部屋を建てて卓を持つ */
export async function hostOnlineRoom(options: HostOptions): Promise<OnlineSession> {
  const { uid, displayName, rooms, handlers } = options;
  const code = await rooms.create(uid, displayName);

  const engine =
    options.createEngine?.(code) ??
    new Room({ code, rngSeed: randomSeed(), cardPool: options.cardPool });

  /*
   * ★ホスト自身のぶんは Firestore を経由させない。
   *   自分の盤面を書いて自分で読み直す意味はないし、
   *   往復ぶんの待ちと通信量がそのまま操作の重さになる。
   */
  const base = rooms.relay(code);
  const relay: Relay = {
    ...base,
    publishState: async (target, state) => {
      if (target === uid) {
        handlers.onState(state);
        return;
      }
      await base.publishState(target, state);
    },
  };

  const host = new MatchHost({
    engine,
    relay,
    hostUid: uid,
    hostName: displayName,
    ...(options.deck ? { hostDeck: options.deck } : {}),
    onReject: (rejection) => handlers.onError(rejection.reason),
  });
  host.start();

  const announce = (): void => {
    handlers.onSeats(
      host.seatList.map((seat) => ({ ...seat, connected: true })),
      host.seatOf(uid)?.playerId ?? null,
    );
  };

  /*
   * ★席を作るのは部屋の変化を見たとき。
   *   同じ相手に何度も試さないよう、断った UID は覚えておく（理由が繰り返し出ないように）。
   *   席入れは順番待ちにする（同時に2通届いても席が二重にならないように）。
   */
  const refused = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  const unwatch = rooms.watch(code, (room) => {
    if (!room) return;
    for (const member of room.members) {
      if (host.seatOf(member) || refused.has(member)) continue;
      const profile = room.guests[member];
      queue = queue.then(async () => {
        if (host.seatOf(member) || refused.has(member)) return;
        const seat = await host.seat(member, profile?.displayName ?? 'ゲスト', profile?.deck);
        if (seat) announce();
        else refused.add(member);
      });
    }
  });

  await host.publish();
  announce();

  return {
    code,
    role: 'host',
    submitIntent: (intent) => {
      void host.applyOwn(uid, { kind: 'intent', intent });
    },
    submitAction: (action) => {
      void host.applyOwn(uid, { kind: 'action', action });
    },
    close: () => {
      unwatch();
      host.close();
      // ★部屋をたたむ。ゲストはこれで対戦の終わりに気づく
      void rooms.close(code).catch(() => {
        /* 消せなくても自分の側は閉じる */
      });
    },
  };
}

/** 部屋コードで入る。盤面は作らず、届いたものをそのまま映す */
export async function joinOnlineRoom(options: GuestOptions): Promise<OnlineSession> {
  const { code, uid, displayName, rooms, handlers } = options;

  /*
   * ★読めなかったときも「ない」と同じ扱いにする。
   *   ルール上、部屋がなければ読む権限もないので、どちらも同じ理由で断られる。
   *   入る側にとっては区別する意味がないし、部屋の存在の有無を返すと
   *   コードの総当たりに手がかりを与えることになる。
   */
  const room = await rooms.read(code).catch(() => null);
  if (!room) throw new Error('その部屋コードの部屋がありません');
  if (room.hostUid === uid) throw new Error('自分が建てた部屋には入れません');

  await rooms.join(code, uid, {
    displayName,
    ...(options.deck ? { deck: options.deck } : {}),
  });

  /* ★同じ知らせを二度出さない。読み込み直すと最後の1件がもう一度届くため */
  let lastNotice = 0;
  const unwatchState = rooms.watchState(code, uid, (update) => {
    if (update.state) handlers.onState(update.state);
    if (update.notice && update.notice.seq > lastNotice) {
      lastNotice = update.notice.seq;
      handlers.onError(update.notice.message);
    }
  });

  let knownSeats: SeatPresence[] = [];
  const unwatchRoom = rooms.watch(code, (current) => {
    if (!current) {
      /*
       * ★部屋が消えた＝ホストが去った。卓はホストのブラウザにしかないので続けられない。
       *   相手を切断中として伝え、いつもの一時停止の見た目に合わせる。
       */
      if (knownSeats.length === 0) return;
      knownSeats = knownSeats.map((seat) => ({ ...seat, connected: seat.uid === uid }));
      handlers.onSeats(knownSeats, knownSeats.find((seat) => seat.uid === uid)?.playerId ?? null);
      handlers.onError('ホストが対戦を終わりました');
      return;
    }
    knownSeats = Object.entries(current.seats).map(([seatUid, playerId]) => ({
      uid: seatUid,
      playerId,
      displayName:
        seatUid === current.hostUid
          ? current.hostName
          : (current.guests[seatUid]?.displayName ?? 'ゲスト'),
      connected: true,
    }));
    handlers.onSeats(knownSeats, current.seats[uid] ?? null);
  });

  const send = (body: Parameters<RoomsApi['sendIntent']>[2]): void => {
    rooms.sendIntent(code, uid, body).catch(() => {
      handlers.onError('操作を送れませんでした（通信を確認してください）');
    });
  };

  return {
    code,
    role: 'guest',
    submitIntent: (intent) => send({ kind: 'intent', intent }),
    submitAction: (action) => send({ kind: 'action', action }),
    close: () => {
      unwatchState();
      unwatchRoom();
    },
  };
}
