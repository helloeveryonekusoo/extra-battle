/**
 * 対戦卓（T6）。
 *
 * サーバー権威型（§4.1）: 完全な GameState はここにしかない。
 * クライアントへ渡すときは必ず filterStateFor を通す。
 *
 * このクラスは WebSocket を知らない。通信は server.ts の担当。
 */
import {
  applyAction,
  discardZoneFor,
  buildCardIndex,
  canStep,
  cardsInZone,
  createGameState,
  currentOp,
  detectDefeat,
  filterStateFor,
  resolveSinglePlayer,
  type EffectRolls,
  type Op,
  type RuleContext,
  type Action,
  type ActionRequest,
  type AbilityTrigger,
  type CardText,
  type GameState,
  type Intent,
  type PlayerId,
  type PresenceEntry,
  type SubmittedDeck,
  type UnstampedAction,
} from '@pokeca/shared';
import { SeededRng } from './rng';

export interface Seat {
  playerId: PlayerId;
  displayName: string;
  connected: boolean;
}

export class RoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomError';
  }
}

/** 1卓の定員 */
export const SEATS_PER_ROOM = 2;

/** 巻き戻せる範囲。これより古い操作は取り消せない */
export const MAX_SNAPSHOTS = 400;

/** 1回の操作で進める効果の歩数の上限。暴走しても卓が止まらないようにする */
export const MAX_EFFECT_STEPS = 512;

export interface RoomOptions {
  code: string;
  rngSeed: string;
  cardPool: readonly CardText[];
  /** JSONから対戦を復元するときに渡す。接続中かどうかは復元せず、全員を切断中にする。 */
  restored?: PersistedRoomState;
  /** テストで時刻を固定するため */
  now?: () => number;
}

export interface PersistedRoomState {
  version: 1;
  savedAt: string;
  code: string;
  rngSeed: string;
  rngDrawn: number;
  instanceCounter: number;
  seats: Pick<Seat, 'playerId' | 'displayName'>[];
  state: GameState;
  snapshots: { seq: number; state: GameState }[];
}

export class Room {
  readonly code: string;
  readonly cardPool: readonly CardText[];

  private state: GameState;
  private readonly rng: SeededRng;
  private readonly seats = new Map<PlayerId, Seat>();
  private readonly now: () => number;
  private instanceCounter = 0;

  /**
   * 「この seq の操作を適用する直前の状態」の控え。Undo（T11）で戻る先になる。
   * 状態は数KBなので、まるごと持っておくのがいちばん確実。
   */
  private readonly snapshots = new Map<number, GameState>();

  /** ルール検査に使うカード定義。これがないと「サポートかどうか」も判定できない */
  private readonly ruleContext: RuleContext;

  constructor(options: RoomOptions) {
    this.code = options.code;
    this.cardPool = options.cardPool;
    this.rng = new SeededRng(options.rngSeed, options.restored?.rngDrawn ?? 0);
    this.now = options.now ?? (() => Date.now());
    this.ruleContext = { cards: buildCardIndex(options.cardPool) };

    if (options.restored) {
      this.state = options.restored.state;
      this.instanceCounter = options.restored.instanceCounter;
      for (const seat of options.restored.seats) {
        this.seats.set(seat.playerId, { ...seat, connected: false });
      }
      for (const snapshot of options.restored.snapshots) {
        this.snapshots.set(snapshot.seq, snapshot.state);
      }
    } else {
      this.state = createGameState({
        gameId: `g-${options.code}`,
        rngSeed: options.rngSeed,
        seats: [],
      });
    }
  }

  // ── 席 ────────────────────────────

  get presence(): PresenceEntry[] {
    return [...this.seats.values()].map((s) => ({ ...s }));
  }

  get seatCount(): number {
    return this.seats.size;
  }

  /** 完全な状態。サーバー内部でだけ使う。クライアントへは決して渡さない */
  get rawState(): GameState {
    return this.state;
  }

  /** サーバー再起動後も続きを始められる、卓の完全な保存データ。 */
  toPersistedState(): PersistedRoomState {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      code: this.code,
      rngSeed: this.state.rngSeed,
      rngDrawn: this.rng.drawn,
      instanceCounter: this.instanceCounter,
      seats: [...this.seats.values()].map(({ playerId, displayName }) => ({
        playerId,
        displayName,
      })),
      state: this.state,
      // 巻き戻し時は現在ログを引き継ぐため、控え側の過去ログは不要。
      // ここを空にして、定期保存ファイルが操作回数の二乗で膨らむのを避ける。
      snapshots: [...this.snapshots].map(([seq, state]) => ({
        seq,
        state: { ...state, log: [] },
      })),
    };
  }

  /**
   * 席に着く。playerId を渡すと、切断していた自分の席に戻れる。
   * ★参加もアクションとして記録する。こうしないと巻き戻し先の状態に相手がいなくなる。
   */
  join(displayName: string, playerId?: PlayerId, deck?: SubmittedDeck): Seat {
    if (playerId) {
      const seat = this.seats.get(playerId);
      if (seat) {
        seat.connected = true;
        if (displayName && displayName !== seat.displayName) {
          seat.displayName = displayName;
          this.apply(
            this.stamp({ type: 'setPlayerName', playerId, displayName }, 'server'),
          );
        }
        return seat;
      }
    }

    if (this.seats.size >= SEATS_PER_ROOM) {
      throw new RoomError('この部屋は満席です');
    }

    if (deck) this.assertSubmittedDeck(deck);

    const newId: PlayerId = `p-${this.seats.size + 1}`;
    const seat: Seat = { playerId: newId, displayName, connected: true };
    this.seats.set(newId, seat);
    this.apply(this.stamp({ type: 'addPlayer', playerId: newId, displayName }, 'server'));
    if (deck && deck.cards.length > 0) this.placeSubmittedDeck(newId, deck);
    return seat;
  }

  private assertSubmittedDeck(deck: SubmittedDeck): void {
    const known = new Set(this.cardPool.map((card) => card.functionalId));
    if (deck.cards.some((entry) => !known.has(entry.functionalId))) {
      throw new RoomError(`デッキ「${deck.name}」に不明なカードがあります`);
    }
  }

  /** 保存デッキをサーバー権威の山札へ変換する。ルール違反はここでは拒否しない。 */
  private placeSubmittedDeck(playerId: PlayerId, deck: SubmittedDeck): void {
    const picks: { instanceId: string; functionalId: string }[] = [];

    for (const entry of deck.cards) {
      const count = Math.max(0, Math.trunc(entry.count));
      for (let i = 0; i < count; i += 1) {
        this.instanceCounter += 1;
        picks.push({
          instanceId: `${playerId}-c${this.instanceCounter}`,
          functionalId: entry.functionalId,
        });
      }
    }

    const { value, seed } = this.rng.shuffle(picks);
    this.apply(
      this.stamp({ type: 'setupDeck', playerId, cards: value, seed }, 'server'),
    );
  }

  disconnect(playerId: PlayerId): void {
    const seat = this.seats.get(playerId);
    if (seat) seat.connected = false;
  }

  get hasAnyoneConnected(): boolean {
    return [...this.seats.values()].some((s) => s.connected);
  }

  // ── 状態 ───────────────────────────

  /** そのプレイヤーへ送ってよい状態 */
  stateFor(playerId: PlayerId): GameState {
    return filterStateFor(this.state, playerId);
  }

  private stamp(request: UnstampedAction, actorId: PlayerId | 'server'): Action {
    return { ...request, actorId, at: this.now() } as Action;
  }

  private get nextSeq(): number {
    return (this.state.log[this.state.log.length - 1]?.seq ?? 0) + 1;
  }

  /**
   * 適用前の状態を控えてから適用する。
   * ルール警告はログに載るだけで、操作は必ず通る（第2段階 §2）。
   */
  private apply(action: Action): void {
    this.snapshots.set(this.nextSeq, this.state);
    if (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next();
      if (!oldest.done) this.snapshots.delete(oldest.value);
    }
    this.state = applyAction(this.state, action, this.ruleContext);
  }

  /** 直近の操作で出た警告 */
  get lastWarnings() {
    return this.state.log[this.state.log.length - 1]?.warnings ?? [];
  }

  /** その seq まで巻き戻せるか */
  canUndoTo(targetSeq: number): boolean {
    return this.snapshots.has(targetSeq);
  }

  /**
   * ログから盤面を組み直す（§4.2 の再現性の確認用）。
   * 取り消された操作は飛ばす。乱数の結果は Action に載っているので、
   * 同じログからは必ず同じ盤面になる。
   */
  replayFromLog(): GameState {
    let state = createGameState({
      gameId: this.state.gameId,
      rngSeed: this.state.rngSeed,
      seats: [],
    });
    for (const entry of this.state.log) {
      if (entry.undone) continue;
      // 取り消しの要求・返事は盤面を作らない（結果は undone 印に現れている）
      if (entry.action.type === 'requestUndo' || entry.action.type === 'resolveUndo') continue;
      state = applyAction(state, entry.action, this.ruleContext);
    }
    return state;
  }

  /**
   * クライアントが組み立てた Action を適用する。
   * actorId は必ずサーバーが上書きする（他人になりすませない）。
   */
  submitAction(actorId: PlayerId, request: ActionRequest): void {
    this.assertCanOperate(actorId);
    // 「手札から出したとき」の判定に、出す前のゾーンが要る（T34）
    const beforeZone =
      request.type === 'placePokemon' ? this.state.cards[request.cardId]?.zone : undefined;

    this.apply(this.stamp(request as UnstampedAction, actorId));

    if (request.type === 'placePokemon' && beforeZone === 'hand') {
      this.triggerAbility(actorId, request.cardId, 'onPlayFromHand');
    }
    // ★進化したとき（うらこうさく等。T43）。ふしぎなアメで飛び級しても同じ
    if (request.type === 'evolvePokemon') {
      this.triggerAbility(actorId, request.cardId, 'onEvolve');
    }
    this.runEffect();
  }

  /**
   * ★「出したとき」「進化したとき」の特性を自動で始める（T34 / T43）。
   *   クロバットV・カプ・テテフGX（出したとき）、
   *   ジメレオン・インテレオンのうらこうさく（進化したとき）など、
   *   きっかけが操作そのものである特性はプレイヤーの操作を待たない。
   *
   *   別の効果を処理中なら割り込まない（人が手で使い直せる）。
   */
  private triggerAbility(actorId: PlayerId, cardId: string, trigger: AbilityTrigger): void {
    if (this.state.execution) return;
    const instance = this.state.cards[cardId];
    if (!instance) return;
    const card = this.ruleContext.cards?.byFunctionalId.get(instance.functionalId);
    const index = (card?.abilities ?? []).findIndex(
      (ability) => ability.trigger === trigger && ability.effects,
    );
    const ability = index >= 0 ? card?.abilities?.[index] : undefined;
    if (!ability?.effects) return;

    this.apply(
      this.stamp(
        {
          type: 'startEffect',
          executionId: `${trigger}-${this.nextSeq}-${cardId}`,
          ops: ability.effects,
          source: {
            instanceId: cardId,
            playerId: actorId,
            label: ability.name,
            abilityIndex: index,
          },
        },
        actorId,
      ),
    );
  }

  /**
   * 乱数が要る操作。結果をサーバーが確定させてから Action にする（§4.2）。
   */
  submitIntent(actorId: PlayerId, intent: Intent): void {
    this.assertCanOperate(actorId);
    if (intent.type === 'resolveUndo') {
      this.resolveUndo(actorId, intent.requestId, intent.approve);
      return;
    }
    for (const action of this.materialize(intent, actorId)) {
      this.apply(action);
    }
    this.runEffect();
  }

  /**
   * 効果が動いていれば、応答待ちか終わりまで1オペコードずつ進める（T24）。
   *
   * ★乱数はここで振って Action に載せる（§4.2）。
   *   インタプリタ自身は乱数を持たないので、ログから同じ盤面を再現できる。
   */
  private runEffect(limit = MAX_EFFECT_STEPS): void {
    for (let i = 0; i < limit; i += 1) {
      const execution = this.state.execution;
      if (!execution || !canStep(this.state)) return;

      const { rolls, seed } = this.rollFor(currentOp(execution));
      this.apply(
        this.stamp(
          {
            type: 'effectStep',
            executionId: execution.executionId,
            ...(rolls ? { rolls } : {}),
            ...(seed ? { seed } : {}),
          },
          'server',
        ),
      );
    }
    // ここまで来たら異常。卓が固まらないよう打ち切る（§7-5）
    this.apply(this.stamp({ type: 'cancelEffect', reason: '処理が長すぎます' }, 'server'));
  }

  /** そのオペコードに必要な乱数を先に決める */
  private rollFor(op: Op | undefined): { rolls?: EffectRolls; seed?: string } {
    const execution = this.state.execution;
    if (!op || !execution) return {};

    if (op.op === 'shuffle') {
      const owner = resolveSinglePlayer(this.state, execution.source.playerId, op.owner);
      if (!owner) return {};
      const ids = cardsInZone(this.state, owner, op.zone).map((c) => c.instanceId);
      const { value, seed } = this.rng.shuffle(ids);
      return { rolls: { order: value }, seed };
    }

    if ((op.op === 'search' || op.op === 'evolve' || op.op === 'attachEnergy') && op.thenShuffle) {
      const owner = resolveSinglePlayer(
        this.state,
        execution.source.playerId,
        op.op === 'search' ? op.owner : op.op === 'evolve' ? op.player : 'self',
      );
      if (!owner) return {};
      const ids = cardsInZone(this.state, owner, op.from).map((card) => card.instanceId);
      const { value, seed } = this.rng.shuffle(ids);
      return { rolls: { order: value }, seed };
    }

    if (op.op === 'coinFlip') {
      const count = op.count === 'untilTails' ? 1 : Math.max(1, op.count);
      const { value, seed } = this.rng.coins(count);
      return { rolls: { coins: value }, seed };
    }

    return {};
  }

  /** 2席そろった卓では、片方の切断中に盤面を進めない。 */
  private assertCanOperate(actorId: PlayerId): void {
    const actor = this.seats.get(actorId);
    if (!actor) throw new RoomError('この部屋の席にいません');
    if (!actor.connected) throw new RoomError('再接続が完了するまで操作できません');
    if (this.seats.size >= SEATS_PER_ROOM && [...this.seats.values()].some((seat) => !seat.connected)) {
      throw new RoomError('相手が切断中のため操作を一時停止しています');
    }
  }

  /**
   * 取り消し要求への返事（T11）。
   * 承認されたら、控えておいた状態に戻し、取り消した操作にはログ上で印をつける。
   * ログ自体は消さない（何を巻き戻したのか後から読めるように）。
   */
  private resolveUndo(actorId: PlayerId, requestId: string, approve: boolean): void {
    const pending = this.state.pendingUndo;
    if (!pending || pending.requestId !== requestId) {
      throw new RoomError('その取り消し要求はもうありません');
    }
    if (approve && pending.requestedBy === actorId) {
      throw new RoomError('自分の要求は自分では承認できません');
    }

    if (!approve) {
      this.apply(this.stamp({ type: 'resolveUndo', requestId, approved: false }, actorId));
      return;
    }

    const snapshot = this.snapshots.get(pending.targetSeq);
    if (!snapshot) throw new RoomError('そこまでは巻き戻せません');

    const log = this.state.log.map((entry) =>
      entry.seq >= pending.targetSeq && !entry.undone ? { ...entry, undone: true } : entry,
    );
    // 盤面は控えのものに戻し、ログだけは全部残す
    this.state = { ...snapshot, log, pendingUndo: null };
    this.apply(
      this.stamp(
        { type: 'resolveUndo', requestId, approved: true, targetSeq: pending.targetSeq },
        actorId,
      ),
    );
  }

  private materialize(intent: Intent, actorId: PlayerId): Action[] {
    switch (intent.type) {
      // submitIntent が先に処理しているのでここには来ない
      case 'resolveUndo':
        throw new RoomError('取り消しの返事はここでは扱いません');

      case 'shuffleDeck': {
        const deck = cardsInZone(this.state, intent.playerId, 'deck').map((c) => c.instanceId);
        const { value, seed } = this.rng.shuffle(deck);
        return [
          this.stamp({ type: 'shuffleDeck', playerId: intent.playerId, order: value, seed }, 'server'),
        ];
      }

      case 'shuffleIntoDeck': {
        const deck = cardsInZone(this.state, intent.playerId, 'deck').map((c) => c.instanceId);
        const { value, seed } = this.rng.shuffle([...deck, ...intent.cardIds]);
        return [
          this.stamp(
            {
              type: 'shuffleIntoDeck',
              playerId: intent.playerId,
              cardIds: intent.cardIds,
              order: value,
              seed,
            },
            'server',
          ),
        ];
      }

      case 'drawCards': {
        const deck = cardsInZone(this.state, intent.playerId, 'deck');
        const cardIds = deck.slice(0, Math.max(0, intent.count)).map((c) => c.instanceId);
        if (cardIds.length === 0) throw new RoomError('山札にカードがありません');
        return [this.stamp({ type: 'drawCards', playerId: intent.playerId, cardIds }, intent.playerId)];
      }

      case 'flipCoin': {
        const { value, seed } = this.rng.coins(Math.max(1, intent.count));
        const action: UnstampedAction = {
          type: 'flipCoin',
          playerId: intent.playerId,
          results: value,
          seed,
          ...(intent.reason ? { reason: intent.reason } : {}),
        };
        return [this.stamp(action, 'server')];
      }

      case 'randomChoice': {
        const { value, seed } = this.rng.pick(intent.options);
        return [
          this.stamp(
            {
              type: 'randomChoice',
              label: intent.label,
              options: intent.options,
              result: value,
              seed,
            },
            'server',
          ),
        ];
      }

      case 'endTurn': {
        // 番を終える → 次のプレイヤーの番の開始ドローまでを1操作で（T13）
        const actions: Action[] = [this.stamp({ type: 'endTurn' }, 'server')];

        // endTurn 後に誰の番になるかを先に見る（turnQueue の2番目）
        const nextPlayer = this.state.turnQueue[1];
        const drawCount = intent.drawCount ?? 1;
        if (nextPlayer && drawCount > 0) {
          const deck = cardsInZone(this.state, nextPlayer, 'deck');
          const cardIds = deck.slice(0, drawCount).map((c) => c.instanceId);
          if (cardIds.length > 0) {
            actions.push(this.stamp({ type: 'drawCards', playerId: nextPlayer, cardIds }, nextPlayer));
          } else {
            // 「山札が空」ではなく「番の最初に引けなかった」という出来事を記録する。
            actions.push(
              this.stamp(
                { type: 'detectDefeat', turnStartDrawFailedPlayerId: nextPlayer },
                'server',
              ),
            );
          }
        }
        return actions;
      }

      case 'detectDefeat': {
        const detection = detectDefeat(this.state);
        if (!detection || this.state.gameEnd?.proposalId === detection.proposalId) return [];
        return [this.stamp({ type: 'detectDefeat' }, 'server')];
      }

      case 'confirmGameEnd': {
        const proposal = this.state.gameEnd;
        if (
          !proposal ||
          proposal.proposalId !== intent.proposalId ||
          proposal.confirmations[actorId]
        ) {
          return [];
        }
        return [
          this.stamp(
            { type: 'confirmGameEnd', playerId: actorId, proposalId: intent.proposalId },
            actorId,
          ),
        ];
      }

      case 'resolvePokemonCheckTarget': {
        const step = this.state.pokemonCheck?.steps.find(
          (candidate) => candidate.order === intent.order,
        );
        const target = step?.targets.find(
          (candidate) =>
            candidate.playerId === intent.playerId &&
            candidate.slotId === intent.slotId &&
            candidate.topInstanceId === intent.expectedTopInstanceId,
        );
        // 両画面から同時に届いた解決要求は、後着をログにも積まず無視する。
        if (!step || !target || target.resolved) return [];

        let coinResult: 'heads' | 'tails' | undefined;
        let seed: string | undefined;
        if (!intent.skip && (step.condition === 'burned' || step.condition === 'asleep')) {
          const result = this.rng.coins(1);
          coinResult = result.value[0];
          seed = result.seed;
        }

        const action: UnstampedAction = {
          type: 'resolvePokemonCheckTarget',
          order: intent.order,
          playerId: intent.playerId,
          slotId: intent.slotId,
          expectedTopInstanceId: intent.expectedTopInstanceId,
          ...(intent.poisonCounters !== undefined
            ? { poisonCounters: Math.max(0, Math.trunc(intent.poisonCounters)) }
            : {}),
          ...(coinResult ? { coinResult } : {}),
          ...(seed ? { seed } : {}),
          ...(intent.skip ? { skip: true } : {}),
        };
        return [this.stamp(action, 'server')];
      }

      /**
       * きぜつの確定（T16）。
       * 乱数は使わないが、サイドの instanceId はクライアントに伏せてあるので、
       * どのカードを手札へ移すかはここで決める（サイドの上から順）。
       */
      case 'knockOut': {
        const count = Math.max(0, intent.prizeCount);
        const taker = intent.prizePlayerId;
        const prizeCardIds =
          taker && count > 0
            ? cardsInZone(this.state, taker, 'prize')
                .slice(0, count)
                .map((c) => c.instanceId)
            : [];
        const action: UnstampedAction = {
          type: 'knockOut',
          playerId: intent.playerId,
          slotId: intent.slotId,
          expectedTopInstanceId: intent.expectedTopInstanceId,
          prizePlayerId: taker,
          prizeCount: count,
          prizeCardIds,
        };
        return [this.stamp(action, actorId)];
      }

      /**
       * 応答待ちの選択に答える（T25）。
       * ★答えられるのは頼まれた本人だけ。ここで照合する。
       *   thenShuffle があるカード（クイックボール等）のために、
       *   選んだぶんを抜いたあとの山札の並びを先に決めておく。
       */
      case 'resolveChoice': {
        const execution = this.state.execution;
        const choice = execution?.pendingChoice;
        if (!execution || !choice) throw new RoomError('いま聞かれている選択はありません');
        if (choice.requestId !== intent.requestId) {
          throw new RoomError('その選択はもう終わっています');
        }
        if (choice.chooser !== actorId) throw new RoomError('その選択に答えるのは相手です');

        const selected = intent.selected.filter((id) => choice.candidates.includes(id));
        if (selected.length < choice.min || selected.length > choice.max) {
          throw new RoomError(`選ぶ枚数は${choice.min}〜${choice.max}枚です`);
        }
        if (choice.allowedCounts && !choice.allowedCounts.includes(selected.length)) {
          throw new RoomError(`選べる枚数は${choice.allowedCounts.join('枚または')}枚です`);
        }

        const op = currentOp(execution);
        let rolls: EffectRolls | undefined;
        let seed: string | undefined;
        if ((op?.op === 'search' || op?.op === 'evolve' || op?.op === 'attachEnergy') && op.thenShuffle) {
          const owner = resolveSinglePlayer(
            this.state,
            execution.source.playerId,
            op.op === 'search' ? op.owner : op.op === 'evolve' ? op.player : 'self',
          );
          if (owner) {
            const remaining = cardsInZone(this.state, owner, op.from)
              .map((c) => c.instanceId)
              .filter((id) => !selected.includes(id));
            const shuffled = this.rng.shuffle(remaining);
            rolls = { order: shuffled.value };
            seed = shuffled.seed;
          }
        }

        return [
          this.stamp(
            {
              type: 'resolveChoice',
              requestId: intent.requestId,
              selected,
              ...(rolls ? { rolls } : {}),
              ...(seed ? { seed } : {}),
            },
            actorId,
          ),
        ];
      }

      case 'useCardEffect': {
        const instance = this.state.cards[intent.instanceId];
        if (!instance) throw new RoomError('そのカードは盤面にありません');
        if (instance.ownerId !== actorId) {
          throw new RoomError('相手のカードの効果は実行できません');
        }
        if (!instance.visibleTo.includes(actorId)) {
          throw new RoomError('非公開カードの効果は実行できません');
        }
        const card = this.ruleContext.cards?.byFunctionalId.get(instance.functionalId);
        if (this.state.execution) {
          throw new RoomError('別のカード効果を処理中です');
        }

        // ── 特性を使う（T34） ──
        if (intent.abilityIndex !== undefined) {
          const ability = card?.abilities?.[intent.abilityIndex];
          if (!ability?.effects) throw new RoomError('この特性はMANUAL操作です');
          // ★止めない。すでに使っていても警告だけ出して通す（第2段階 §2）
          return [
            this.stamp(
              {
                type: 'startEffect',
                executionId: `ability-${this.nextSeq}-${instance.instanceId}`,
                ops: ability.effects,
                source: {
                  instanceId: instance.instanceId,
                  playerId: actorId,
                  label: ability.name,
                  abilityIndex: intent.abilityIndex,
                },
              },
              actorId,
            ),
          ];
        }

        /*
         * ── ワザに付随する効果を実行する（T42） ──
         * ★ダメージはここで出さない。人が6段パイプラインで確定させる（§4.1）。
         *   ここで動かすのは「次の相手の番、相手はグッズを使えない」のような効果だけ。
         */
        if (intent.attackIndex !== undefined) {
          const attack = card?.attacks?.[intent.attackIndex];
          if (!attack?.effects) throw new RoomError('このワザの効果はMANUAL操作です');
          return [
            this.stamp(
              {
                type: 'startEffect',
                executionId: `attack-${this.nextSeq}-${instance.instanceId}`,
                ops: attack.effects,
                source: {
                  instanceId: instance.instanceId,
                  playerId: actorId,
                  label: attack.name,
                  attackIndex: intent.attackIndex,
                },
              },
              actorId,
            ),
          ];
        }

        if (!card?.effects) {
          throw new RoomError('このカードはMANUAL操作です');
        }
        const consumableTrainer = card.trainerKind === 'item' || card.trainerKind === 'supporter';
        if (consumableTrainer && instance.zone !== 'hand') {
          throw new RoomError('トレーナーズは手札から使ってください');
        }
        const actions: Action[] = [];
        if (consumableTrainer) {
          // ★プリズムスターはトラッシュではなくロストゾーンへ（T36）
          actions.push(
            this.stamp(
              {
                type: 'moveCard',
                cardId: instance.instanceId,
                toZone: discardZoneFor(card.ruleBox),
              },
              actorId,
            ),
          );
        }
        actions.push(
          this.stamp(
            {
              type: 'startEffect',
              executionId: `effect-${this.nextSeq}-${instance.instanceId}`,
              ops: card.effects,
              source: {
                instanceId: instance.instanceId,
                playerId: actorId,
                label: card.name,
              },
            },
            actorId,
          ),
        );
        return actions;
      }

      case 'mulligan': {
        const handSize = intent.handSize ?? 7;
        const hand = cardsInZone(this.state, intent.playerId, 'hand').map((c) => c.instanceId);
        const deck = cardsInZone(this.state, intent.playerId, 'deck').map((c) => c.instanceId);
        const { value: order, seed } = this.rng.shuffle([...deck, ...hand]);

        const actions: Action[] = [
          this.stamp({ type: 'recordMulligan', playerId: intent.playerId }, intent.playerId),
          this.stamp(
            {
              type: 'shuffleIntoDeck',
              playerId: intent.playerId,
              cardIds: hand,
              order,
              seed,
            },
            'server',
          ),
        ];
        // 切り直した山札の上から引き直す
        const redraw = order.slice(0, Math.min(handSize, order.length));
        if (redraw.length > 0) {
          actions.push(
            this.stamp(
              { type: 'drawCards', playerId: intent.playerId, cardIds: redraw },
              intent.playerId,
            ),
          );
        }
        return actions;
      }

      case 'dealPrizes': {
        const deck = cardsInZone(this.state, intent.playerId, 'deck');
        const picked = deck.slice(0, Math.max(0, intent.count));
        if (picked.length < intent.count) {
          throw new RoomError('山札の枚数が足りません');
        }
        return [
          ...picked.map((card) =>
            this.stamp(
              { type: 'moveCard', cardId: card.instanceId, toZone: 'prize' as const },
              intent.playerId,
            ),
          ),
          this.stamp(
            {
              type: 'setPrizes',
              playerId: intent.playerId,
              prizesRemaining: intent.count,
              prizesTotal: intent.count,
            },
            intent.playerId,
          ),
        ];
      }

      case 'devDealSampleDeck': {
        if (this.cardPool.length === 0) throw new RoomError('カードプールが空です');
        const picks: { instanceId: string; functionalId: string }[] = [];
        for (let i = 0; i < intent.size; i += 1) {
          const card = this.cardPool[i % this.cardPool.length]!;
          this.instanceCounter += 1;
          picks.push({
            instanceId: `${intent.playerId}-c${this.instanceCounter}`,
            functionalId: card.functionalId,
          });
        }
        const { value, seed } = this.rng.shuffle(picks);
        return [
          this.stamp({ type: 'setupDeck', playerId: intent.playerId, cards: value, seed }, 'server'),
        ];
      }
    }
  }
}
