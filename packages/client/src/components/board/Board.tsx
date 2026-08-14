/**
 * 盤面（§6.1）。相手が上・自分が下の対面配置。右サイドに操作ログ。
 *
 * 表示は state から作り、操作は controller に投げるだけ。
 * controller を渡さなければ読み取り専用の盤面になる。
 */
import { useState } from 'react';
import type { CardIndex, GameState, PlayerId, SlotId, Zone } from '@pokeca/shared';
import { CardCompact } from '../card/CardCompact';
import { Hand } from './Hand';
import { BreakDetail } from './BreakDetail';
import { ExtraTurnBanner } from './ExtraTurnBanner';
import { LockBanner } from './LockBanner';
import { EffectBadges, GlobalEffectBar } from './EffectBadges';
import { LogPanel } from './LogPanel';
import { PlayerHud } from './PlayerHud';
import { VUnionPanel } from './VUnionPanel';
import {
  benchInfo,
  benchSlotIds,
  dragPayloadFor,
  handViews,
  slotViewOf,
  viewCard,
  type CardView,
} from './boardView';
import { useDraggable, useDropTarget, type DragPayload } from '../../interaction/dnd';
import { useLongPress, type TableController } from '../../interaction/useTableController';
import { useRecentHighlight, type RecentHighlight } from './useRecentHighlight';
import compact from '../card/CardCompact.module.css';
import styles from './Board.module.css';

type MobileTab = 'opponent' | 'mine' | 'hand';

/**
 * カードをスロットに落としたときに何をするか。
 * ★ルール判定ではなく「たぶんこれ」を選ぶだけ。違えばメニューから明示的に選び直せる。
 */
export function dropIntoSlot(
  payload: DragPayload,
  playerId: PlayerId,
  slotId: SlotId,
  occupied: boolean,
  controller: TableController,
): void {
  // 場から場へ動かしたときは入れ替え
  if (payload.fromSlotId && payload.ownerId === playerId && payload.fromSlotId !== slotId) {
    controller.dispatch({
      type: 'movePokemon',
      playerId,
      fromSlotId: payload.fromSlotId,
      toSlotId: slotId,
    });
    return;
  }
  if (!occupied) {
    controller.dispatch({ type: 'placePokemon', playerId, slotId, cardId: payload.instanceId });
    return;
  }
  const card = payload.card;
  if (card?.supertype === 'energy') {
    controller.dispatch({
      type: 'attachCard',
      playerId,
      slotId,
      cardId: payload.instanceId,
      as: 'energy',
    });
    return;
  }
  if (card?.trainerKind === 'tool') {
    controller.dispatch({
      type: 'attachCard',
      playerId,
      slotId,
      cardId: payload.instanceId,
      as: 'tool',
    });
    return;
  }
  controller.dispatch({ type: 'evolvePokemon', playerId, slotId, cardId: payload.instanceId });
}

function Slot({
  state,
  cardIndex,
  playerId,
  slotId,
  emptyLabel,
  controller,
  recent,
}: {
  state: GameState;
  cardIndex: CardIndex | null;
  playerId: PlayerId;
  slotId: SlotId;
  emptyLabel: string;
  controller: TableController | null;
  recent: RecentHighlight;
}) {
  const view = slotViewOf(state, cardIndex, playerId, slotId);
  const occupied = Boolean(view.slot && view.top);

  const drop = useDropTarget(
    controller
      ? {
          id: `slot-${playerId}-${slotId}`,
          accepts: (p) => p.instanceId !== view.top?.instanceId,
          onDrop: (p) => dropIntoSlot(p, playerId, slotId, occupied, controller),
        }
      : null,
  );

  const payload = view.top ? dragPayloadFor(state, cardIndex, view.top.instanceId, slotId) : null;
  const drag = useDraggable(controller && payload ? payload : null);

  const openMenu = (x: number, y: number) => {
    controller?.openMenu({ kind: 'slot', playerId, slotId }, { x, y });
  };
  const longPress = useLongPress(({ x, y }) => openMenu(x, y));

  const isRecent = recent.isSlot(playerId, slotId) || recent.isCard(view.top?.instanceId);
  const highlight = `${drop.isOver ? compact.dropOver : drop.isActive ? compact.dropActive : ''} ${
    isRecent ? styles.recent : ''
  }`;

  if (!occupied || !view.slot || !view.top) {
    return (
      <div className={compact.wrap} ref={drop.ref as never}>
        <div className={`${compact.card} ${compact.empty} ${highlight}`}>{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className={styles.slot} ref={drop.ref as never}>
      <CardCompact
        card={view.top.card}
        faceDown={view.top.faceDown}
        energy={view.energy}
        energyTitle={view.energyTitle}
        oncePerGameUsed={state.players[playerId]?.oncePerGameUsed ?? []}
        breakUnder={view.breakUnder}
        damageCounters={view.slot.damageCounters}
        conditions={view.slot.conditions}
        toolName={view.toolName}
        toolIsOpponents={view.toolIsOpponents}
        stackSize={view.stackSize}
        isVUnion={view.profile.isVUnion}
        abilities={view.abilities}
        className={highlight}
        {...(controller
          ? {
              onContextMenu: (e: React.MouseEvent) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY);
              },
              onPointerDown: (e: React.PointerEvent) => {
                drag.onPointerDown(e);
                longPress.onPointerDown(e);
              },
              onDamageClick: (e: React.MouseEvent) => {
                const delta = e.type === 'contextmenu' ? -1 : e.shiftKey ? 5 : 1;
                controller.dispatch({ type: 'adjustDamage', playerId, slotId, delta });
              },
            }
          : {})}
      />
      {/* かかっている効果を必ず見せる（§5.2）。押せば手で外せる */}
      <EffectBadges
        state={state}
        playerId={playerId}
        slotId={slotId}
        cardIndex={cardIndex}
        {...(controller ? { dispatch: controller.dispatch } : {})}
      />
      {/* ★BREAKは引きつぐもの・引きつがないものが混ざる。由来を必ず出す（§4.3） */}
      <BreakDetail profile={view.profile} />
      {view.slot.notes && <span className={styles.notes}>{view.slot.notes}</span>}
    </div>
  );
}

function Bench({
  state,
  cardIndex,
  playerId,
  controller,
  recent,
}: {
  state: GameState;
  cardIndex: CardIndex | null;
  playerId: PlayerId;
  controller: TableController | null;
  recent: RecentHighlight;
}) {
  // ★ベンチの空き数を必ず出す（§4.1）。上限は可変なので数えないと分からない
  const info = benchInfo(state, playerId, cardIndex);
  return (
    <div className={styles.row} title={info.title}>
      {benchSlotIds(state, playerId, cardIndex).map((slotId, i) => (
        <Slot
          key={slotId}
          state={state}
          cardIndex={cardIndex}
          playerId={playerId}
          slotId={slotId}
          emptyLabel={`ベンチ${i + 1}`}
          controller={controller}
          recent={recent}
        />
      ))}
      <span className={styles.benchCount} title={info.title}>
        {info.used}/{info.limit}
        <span className={styles.benchFree}>空き{info.free}</span>
      </span>
    </div>
  );
}

function StadiumBar({
  state,
  cardIndex,
  controller,
}: {
  state: GameState;
  cardIndex: CardIndex | null;
  controller: TableController | null;
}) {
  const view = viewCard(state, cardIndex, state.stadium);
  const drop = useDropTarget(
    controller
      ? {
          id: 'stadium',
          accepts: () => true,
          onDrop: (p) => {
            controller.dispatch({ type: 'moveCard', cardId: p.instanceId, toZone: 'stadium' });
            controller.dispatch({ type: 'setStadium', cardId: p.instanceId });
          },
        }
      : null,
  );

  return (
    <div className={styles.stadiumBar} ref={drop.ref as never}>
      <span className={styles.stadiumLine} />
      {view ? (
        <span
          className={`${styles.stadiumCard} ${drop.isOver ? styles.dropOver : ''}`}
          onContextMenu={(e) => {
            e.preventDefault();
            controller?.openMenu({ kind: 'card', instanceId: view.instanceId }, {
              x: e.clientX,
              y: e.clientY,
            });
          }}
        >
          <span className={styles.stadiumDot} />
          {view.card?.name ?? '非公開'}
        </span>
      ) : (
        <span
          className={`${styles.stadiumEmpty} ${drop.isOver ? styles.dropOver : ''} ${
            drop.isActive ? styles.dropActive : ''
          }`}
        >
          スタジアム なし
        </span>
      )}
      <span className={styles.stadiumLine} />
    </div>
  );
}

function Toolbar({
  state,
  viewerId,
  controller,
}: {
  state: GameState;
  viewerId: PlayerId;
  controller: TableController;
}) {
  return (
    <div className={styles.toolbar}>
      {/* 番の終わりにはポケモンチェックを挟む（§6.7）。番の移行は T13 でサーバー経由 */}
      <button
        className={styles.toolButton}
        disabled={state.turnQueue.length <= 1}
        onClick={() => controller.dispatch({ type: 'setPhase', phase: 'pokemonCheck' })}
      >
        番を終える
      </button>
      <button
        className={styles.toolButton}
        title="追加の番を差し込む（スタークロノス等）"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          controller.openMenu({ kind: 'table' }, { x: rect.left, y: rect.bottom + 4 });
        }}
      >
        追加の番 +
      </button>
      <button
        className={styles.toolButton}
        disabled={!controller.canRandomize}
        title={controller.canRandomize ? '' : 'サーバー接続時のみ'}
        onClick={() => controller.intent({ type: 'flipCoin', playerId: viewerId, count: 1 })}
      >
        コイン
      </button>
      <button
        className={styles.toolButton}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          controller.openMenu({ kind: 'table' }, { x: rect.left, y: rect.bottom + 4 });
        }}
      >
        卓の操作 ▾
      </button>
    </div>
  );
}

export interface BoardProps {
  state: GameState;
  viewerId: PlayerId;
  cardIndex: CardIndex | null;
  opponentConnected?: boolean;
  controller?: TableController | null;
  onRequestUndo?: (targetSeq: number) => void;
  onResolveUndo?: (requestId: string, approve: boolean) => void;
}

export function Board({
  state,
  viewerId,
  cardIndex,
  opponentConnected = true,
  controller = null,
  onRequestUndo,
  onResolveUndo,
}: BoardProps) {
  const [tab, setTab] = useState<MobileTab>('mine');
  const recent = useRecentHighlight(state);
  const opponentId = Object.keys(state.players).find((id) => id !== viewerId);
  const myTurn = state.activePlayer === viewerId;

  const showOpponent = tab === 'opponent';
  const showMine = tab === 'mine';
  const showHand = tab === 'hand';

  const openCardMenu = (view: CardView, e: React.MouseEvent) => {
    e.preventDefault();
    controller?.openMenu({ kind: 'card', instanceId: view.instanceId }, { x: e.clientX, y: e.clientY });
  };

  const openZoneMenu = (playerId: PlayerId, zone: Zone, x: number, y: number) => {
    controller?.openMenu({ kind: 'zone', playerId, zone }, { x, y });
  };

  return (
    <div className={styles.shell}>
      <div
        className={`${styles.play} ${myTurn ? styles.myTurn : styles.theirTurn}`}
        role="region"
        aria-label="盤面"
      >
        <div className={styles.tabs}>
          {(
            [
              ['opponent', '相手盤面'],
              ['mine', '自分盤面'],
              ['hand', '手札'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {opponentId && (
          <div className={showOpponent ? '' : styles.hideOnMobile}>
            <PlayerHud
              state={state}
              playerId={opponentId}
              connected={opponentConnected}
              controller={controller}
              onZoneMenu={openZoneMenu}
            />
          </div>
        )}

        <div className={styles.field}>
          {opponentId && (
            <div className={showOpponent ? '' : styles.hideOnMobile}>
              <Bench
                state={state}
                cardIndex={cardIndex}
                playerId={opponentId}
                controller={controller}
                recent={recent}
              />
              <div className={styles.activeRow}>
                <div className={styles.activeSlot}>
                  <Slot
                    state={state}
                    cardIndex={cardIndex}
                    playerId={opponentId}
                    slotId="active"
                    emptyLabel="バトル場"
                    controller={controller}
                    recent={recent}
                  />
                </div>
              </div>
            </div>
          )}

          {/* 場全体・プレイヤー単位の効果（オルタージェネシスGX 等）は盤面上部に（§5.2） */}
        <GlobalEffectBar
          state={state}
          {...(controller ? { dispatch: controller.dispatch } : {})}
        />

        {/* ★ロック状態は常に出す（§4.1）。複数なら消えない警告も出る（§4.5） */}
        <LockBanner state={state} cardIndex={cardIndex} viewerId={viewerId} />

        <StadiumBar state={state} cardIndex={cardIndex} controller={controller} />

          <div className={showMine ? '' : styles.hideOnMobile}>
            <div className={styles.activeRow}>
              <div className={styles.activeSlot}>
                <Slot
                  state={state}
                  cardIndex={cardIndex}
                  playerId={viewerId}
                  slotId="active"
                  emptyLabel="バトル場"
                  controller={controller}
                  recent={recent}
                />
              </div>
            </div>
            <Bench
              state={state}
              cardIndex={cardIndex}
              playerId={viewerId}
              controller={controller}
              recent={recent}
            />
          </div>
        </div>

        <div className={showMine ? '' : styles.hideOnMobile}>
          <PlayerHud
            state={state}
            playerId={viewerId}
            cardIndex={cardIndex}
            controller={controller}
            onZoneMenu={openZoneMenu}
          />
        </div>

        {/* ★トラッシュに V-UNION があるときだけ出る組み立てパネル（T38） */}
        <div className={showMine ? '' : styles.hideOnMobile}>
          <VUnionPanel
            state={state}
            playerId={viewerId}
            cardIndex={cardIndex}
            {...(controller ? { dispatch: controller.dispatch } : {})}
          />
        </div>

        <div className={showHand ? '' : styles.hideOnMobile}>
          <Hand
            state={state}
            cardIndex={cardIndex}
            views={handViews(state, cardIndex, viewerId)}
            controller={controller}
            {...(controller ? { onCardContextMenu: openCardMenu } : {})}
          />
        </div>

        {controller && <Toolbar state={state} viewerId={viewerId} controller={controller} />}
      </div>

      {/* ★追加の番が始まったら、画面中央に短く出す（§4.4） */}
      <ExtraTurnBanner state={state} />

      <LogPanel
        state={state}
        cardIndex={cardIndex}
        viewerId={viewerId}
        {...(onRequestUndo ? { onRequestUndo } : {})}
        {...(onResolveUndo ? { onResolveUndo } : {})}
      />
    </div>
  );
}
