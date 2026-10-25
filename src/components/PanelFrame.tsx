import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { panelLabels, type PanelKind } from "../panels";
import { PanelPicker } from "./PanelPicker";

export interface SlotControls {
  index: number;
  selected: PanelKind;
  available: Set<PanelKind>;
  collapsed: boolean;
  canAdd: boolean;
  canRemove: boolean;
  onSelect(panel: PanelKind): void;
  onToggleCollapse(): void;
  onAdd(): void;
  onRemove(): void;
  onDragStart(): void;
  onDragEnd(): void;
}

/** A panel with the slot controls in its header. */
export function PanelFrame({
  title,
  note,
  controls,
  headerExtra,
  children,
}: {
  title: string;
  note?: string;
  controls: SlotControls;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <header>
        <span className="panel-title">
          {title}
          {note ? <span className="panel-title-note">{note}</span> : null}
        </span>
        <div className="slot-controls">
          {headerExtra}
          <span
            className="slot-grip"
            title="Drag to re-arrange"
            draggable
            onDragStart={controls.onDragStart}
            onDragEnd={controls.onDragEnd}
          >
            <Icon name="grip" size={14} />
          </span>
          <PanelPicker
            selected={controls.selected}
            available={controls.available}
            onSelect={controls.onSelect}
          />
          <button
            type="button"
            className="slot-button"
            title={controls.collapsed ? "Expand panel" : "Collapse panel"}
            aria-label={controls.collapsed ? "Expand panel" : "Collapse panel"}
            onClick={controls.onToggleCollapse}
          >
            <Icon name={controls.collapsed ? "expand" : "collapse"} size={13} />
          </button>
          <button
            type="button"
            className="slot-button"
            title="Add panel below"
            aria-label="Add panel below"
            disabled={!controls.canAdd}
            onClick={controls.onAdd}
          >
            <Icon name="plus" size={13} />
          </button>
          <button
            type="button"
            className="slot-button"
            title="Remove panel"
            aria-label="Remove panel"
            disabled={!controls.canRemove}
            onClick={controls.onRemove}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>
      {controls.collapsed ? null : children}
    </>
  );
}

export function panelTitle(kind: PanelKind): string {
  return panelLabels[kind].toUpperCase();
}
