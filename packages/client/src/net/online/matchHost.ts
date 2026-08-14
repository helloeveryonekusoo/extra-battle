/**
 * ホスト側の卓（第5段階 T48）。
 *
 * ★役割は「誰の要求か」を確かめて卓に渡し、結果を人ごとに配ること。
 *
 * ★席は Firebase の UID に紐づける（T49 の先取り）。
 *   第2段階までは `playerId` を送るだけで席に戻れたが、それはローカル網の前提。
 *   公開するならその作りは成り立たない（コードさえ分かれば相手の席に座れてしまう）。
 *   ここでは **UID から席を引く** ので、他人の席の操作は届いても捨てられる。
 *
 * ★ホストが落ちたら対戦は止まる。それは仕様。
 *   卓の正しさを1か所に置くほうが、両者で同じ盤面を保つより確実だから。
 */
import type { PlayerId, SubmittedDeck } from '@pokeca/shared';
import type { MatchEngine, Relay, RelayIntent, Seat } from './relay';

export interface MatchHostOptions {
  engine: MatchEngine;
  relay: Relay;
  hostUid: string;
  hostName: string;
  /** ホスト自身の持ち込みデッキ */
  hostDeck?: SubmittedDeck;
  /** 捨てた要求の知らせ。★黙って捨てず、画面に理由を出すため */
  onReject?: (rejection: { uid: string; reason: string }) => void;
}

export class MatchHost {
  private readonly engine: MatchEngine;
  private readonly relay: Relay;
  /** UID → 席。★これが唯一の身元確認 */
  private readonly seats = new Map<string, Seat>();
  private stop: (() => void) | null = null;
  private readonly onReject: ((rejection: { uid: string; reason: string }) => void) | null;
  private readonly hostUid: string;
  /** 知らせの通し番号。読み込み直しで同じ知らせを二度出さないため */
  private noticeSeq = 0;

  /** 捨てた要求の理由。画面とログに出す（黙って捨てない） */
  readonly rejected: { uid: string; reason: string }[] = [];

  constructor(options: MatchHostOptions) {
    this.engine = options.engine;
    this.relay = options.relay;
    this.onReject = options.onReject ?? null;
    this.hostUid = options.hostUid;
    const seat = this.engine.join(options.hostName, undefined, options.hostDeck);
    this.seats.set(options.hostUid, {
      uid: options.hostUid,
      playerId: seat.playerId,
      displayName: options.hostName,
    });
  }

  get seatList(): Seat[] {
    return [...this.seats.values()];
  }

  seatOf(uid: string): Seat | undefined {
    return this.seats.get(uid);
  }

  /** 中継を聞き始める */
  start(): void {
    this.stop ??= this.relay.onIntent((intent) => void this.handle(intent));
  }

  close(): void {
    this.stop?.();
    this.stop = null;
  }

  /**
   * ゲストを席に着かせる。
   * ★同じ UID なら同じ席に戻す（再接続）。席が埋まっていれば断る。
   */
  async seat(uid: string, displayName: string, deck?: SubmittedDeck): Promise<Seat | null> {
    const existing = this.seats.get(uid);
    if (existing) return existing;
    if (this.seats.size >= 2) {
      this.reject(uid, '席が埋まっています');
      return null;
    }
    let joined: { playerId: PlayerId };
    try {
      joined = this.engine.join(displayName, undefined, deck);
    } catch (cause) {
      // ★デッキに不明なカードがあっても卓は壊さない。理由を残して座らせない
      this.reject(uid, cause instanceof Error ? cause.message : '席に着けませんでした');
      return null;
    }
    const seat: Seat = { uid, playerId: joined.playerId, displayName };
    this.seats.set(uid, seat);
    await this.relay.publishSeats(this.seatList);
    await this.publish();
    return seat;
  }

  /** いま座っている全員に、その人の見え方で盤面を配る */
  async publish(): Promise<void> {
    for (const seat of this.seats.values()) {
      await this.relay.publishState(seat.uid, this.engine.stateFor(seat.playerId));
    }
  }

  /** ホスト自身の操作。★中継を通さず直接卓へ入れる */
  async applyOwn(uid: string, body: RelayIntent['body']): Promise<void> {
    await this.handle({ id: `local-${Date.now()}`, uid, body }, false);
  }

  private async handle(intent: RelayIntent, ack = true): Promise<void> {
    const seat = this.seats.get(intent.uid);
    // ★席のない UID からの要求は捨てる。ここが席の乗っ取りを止める唯一の場所
    if (!seat) {
      this.reject(intent.uid, '席がありません');
      if (ack) await this.relay.ackIntent(intent.id);
      return;
    }

    try {
      if (intent.body.kind === 'intent') {
        this.engine.submitIntent(seat.playerId, intent.body.intent);
      } else {
        this.engine.submitAction(seat.playerId, this.stampActor(seat.playerId, intent.body.action));
      }
    } catch (cause) {
      // ★卓が断っても中継は止めない。理由を残して次の要求へ進む
      this.reject(intent.uid, cause instanceof Error ? cause.message : '処理できませんでした');
    }

    if (ack) await this.relay.ackIntent(intent.id);
    await this.publish();
  }

  /**
   * 要求を通さなかったことを残す。
   * ★理由は断られた本人にも送る（T49）。ホストの画面にしか出ないと、
   *   ゲストからは「押しても何も起きない」としか見えない。
   */
  private reject(uid: string, reason: string): void {
    const rejection = { uid, reason };
    this.rejected.push(rejection);
    this.onReject?.(rejection);
    if (uid === this.hostUid) return;
    this.noticeSeq += 1;
    void this.relay.publishNotice(uid, { seq: this.noticeSeq, message: reason }).catch(() => {
      /* 知らせが届かなくても対戦は続ける */
    });
  }

  /**
   * ★操作の中の playerId を、席から引いた値で上書きする。
   *   送り主が「相手のポケモンを自分のものとして動かす」形の要求を作れないようにする。
   */
  private stampActor(playerId: PlayerId, action: Record<string, unknown>): never {
    return ('playerId' in action ? { ...action, playerId } : action) as never;
  }
}
