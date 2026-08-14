/**
 * 右クリック / 長押しで出るメニュー（§6.6）。
 * 中身は menus.ts が組み立てる。ここは出す・畳む・選ぶだけ。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MenuCommand, MenuItem } from './menus';
import styles from './ContextMenu.module.css';

export interface MenuPosition {
  x: number;
  y: number;
}

function MenuList({
  title,
  items,
  position,
  onPick,
  onClose,
}: {
  title?: string;
  items: readonly MenuItem[];
  position: MenuPosition;
  onPick: (command: MenuCommand) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [openSub, setOpenSub] = useState<{ item: MenuItem; position: MenuPosition } | null>(null);

  // 画面からはみ出さない位置に寄せる
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(position.x, window.innerWidth - rect.width - 8);
    const y = Math.min(position.y, window.innerHeight - rect.height - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [position.x, position.y]);

  return (
    <>
      <div ref={ref} className={styles.menu} style={{ left: pos.x, top: pos.y }} role="menu">
        {title && <div className={styles.title}>{title}</div>}
        {items.length === 0 && <div className={styles.empty}>操作はありません</div>}
        {items.map((item) => (
          <div key={item.id}>
            {item.separatorBefore && <div className={styles.separator} />}
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${item.disabled ? styles.disabled : ''} ${
                item.danger ? styles.danger : ''
              }`}
              disabled={item.disabled}
              onMouseEnter={(e) => {
                if (item.submenu && !item.disabled) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setOpenSub({ item, position: { x: rect.right + 2, y: rect.top } });
                } else {
                  setOpenSub(null);
                }
              }}
              onClick={() => {
                if (item.disabled) return;
                if (item.command) {
                  onPick(item.command);
                  onClose();
                }
              }}
            >
              <span className={styles.label}>{item.label}</span>
              {item.hint && <span className={styles.hint}>{item.hint}</span>}
              {item.submenu && <span className={styles.arrow}>›</span>}
            </button>
          </div>
        ))}
      </div>

      {openSub?.item.submenu && (
        <MenuList
          items={openSub.item.submenu}
          position={openSub.position}
          onPick={onPick}
          onClose={onClose}
        />
      )}
    </>
  );
}

export function ContextMenu({
  title,
  items,
  position,
  onPick,
  onClose,
}: {
  title?: string;
  items: readonly MenuItem[];
  position: MenuPosition;
  onPick: (command: MenuCommand) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className={styles.backdrop} onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()} />
      <MenuList
        {...(title ? { title } : {})}
        items={items}
        position={position}
        onPick={onPick}
        onClose={onClose}
      />
    </>,
    document.body,
  );
}
