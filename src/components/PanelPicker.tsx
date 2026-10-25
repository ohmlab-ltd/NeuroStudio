import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { panelLabels, panelOrder, type PanelKind } from "../panels";

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/** Viewport placement: below when it fits, else on the roomier side, capped to that room. */
export function menuPlacement(
  anchor: { top: number; bottom: number; right: number },
  menuHeight: number,
  viewport: { width: number; height: number },
): CSSProperties {
  const right = Math.max(VIEWPORT_MARGIN, viewport.width - anchor.right);
  const below = Math.max(0, viewport.height - anchor.bottom - MENU_GAP - VIEWPORT_MARGIN);
  const above = Math.max(0, anchor.top - MENU_GAP - VIEWPORT_MARGIN);
  if (menuHeight <= below || below >= above) {
    return { top: anchor.bottom + MENU_GAP, right, maxHeight: below };
  }
  return { bottom: viewport.height - anchor.top + MENU_GAP, right, maxHeight: above };
}

/** Lists the `available` panels and always the current one. */
export function PanelPicker({
  selected,
  available,
  onSelect,
}: {
  selected: PanelKind;
  available: Set<PanelKind>;
  onSelect(panel: PanelKind): void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const options = panelOrder.filter((p) => available.has(p) || p === selected);

  // Place the menu from its measured height before it is painted.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    setPlacement(
      menuPlacement(trigger.current.getBoundingClientRect(), menu.current.scrollHeight, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      !!root.current?.contains(target as Node) || !!menu.current?.contains(target as Node);
    const onPointerDown = (event: MouseEvent) => {
      if (!inside(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The menu is placed against the window, so a scroll or resize closes it.
    const onScroll = (event: Event) => {
      if (!inside(event.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <div className="panel-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        title="Choose panel"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{panelLabels[selected]}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              className="menu floating"
              role="menu"
              style={placement ?? { visibility: "hidden" }}
            >
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitem"
                  className={option === selected ? "selected" : undefined}
                  onClick={() => {
                    onSelect(option);
                    setOpen(false);
                  }}
                >
                  <span className="menu-mark">
                    {option === selected ? <Icon name="check" size={12} /> : null}
                  </span>
                  {panelLabels[option]}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
