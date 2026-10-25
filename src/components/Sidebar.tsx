import { useMemo, useRef, useState } from "react";
import { createSlot, MAX_SLOTS, panelOrder, type PanelKind, type SidebarSlot } from "../panels";
import type { SlotControls } from "./PanelFrame";
import { useObservable, useObservableSelector } from "../state/observable";
import {
  audioClass,
  audioLabels,
  boardEvents,
  camCaps,
  imageClass,
  imuReading,
  ispMode,
  magReading,
  tofSeen,
  tuneParams,
  visionKind,
} from "../state/device";
import { OverlayOptionsPanel } from "./panels/OverlayOptionsPanel";
import { TerminalPanel } from "./panels/TerminalPanel";
import { TofPanel } from "./panels/TofPanel";
import { IspPanel } from "./panels/IspPanel";
import { VisionPanel } from "./panels/VisionPanel";
import { AudioPanel } from "./panels/AudioPanel";
import { ImageClassPanel } from "./panels/ImageClassPanel";
import { CameraControlsPanel } from "./panels/CameraControlsPanel";
import { TuningPanel } from "./panels/TuningPanel";
import { EventsPanel } from "./panels/EventsPanel";
import { ImuPanel, MagnetometerPanel } from "./panels/SensorPanel";
import { SecondaryViewPanel } from "./panels/SecondaryViewPanel";

function renderPanel(kind: PanelKind, controls: SlotControls) {
  switch (kind) {
    case "stream":
      return <SecondaryViewPanel controls={controls} />;
    case "overlay":
      return <OverlayOptionsPanel controls={controls} />;
    case "tof":
      return <TofPanel controls={controls} />;
    case "terminal":
      return <TerminalPanel controls={controls} />;
    case "isp":
      return <IspPanel controls={controls} />;
    case "mag":
      return <MagnetometerPanel controls={controls} />;
    case "imu":
      return <ImuPanel controls={controls} />;
    case "vision":
      return <VisionPanel controls={controls} />;
    case "audio":
      return <AudioPanel controls={controls} />;
    case "imageClass":
      return <ImageClassPanel controls={controls} />;
    case "camera":
      return <CameraControlsPanel controls={controls} />;
    case "tuning":
      return <TuningPanel controls={controls} />;
    case "events":
      return <EventsPanel controls={controls} />;
  }
}

export function Sidebar({
  slots,
  setSlots,
}: {
  slots: SidebarSlot[];
  setSlots(next: SidebarSlot[]): void;
}) {
  // Per-frame stores are read as present or not, so only availability re-renders the rail.
  const seenTof = useObservable(tofSeen);
  const hasMag = useObservableSelector(magReading, (r) => r !== null);
  const hasImu = useObservableSelector(imuReading, (r) => r !== null);
  const isp = useObservable(ispMode);
  const vision = useObservable(visionKind);
  const hasAudioLabels = useObservableSelector(audioLabels, (l) => l.length > 0);
  const hasAudioClass = useObservableSelector(audioClass, (f) => f !== null);
  const hasImageClass = useObservableSelector(imageClass, (f) => f !== null);
  const caps = useObservable(camCaps);
  const tune = useObservable(tuneParams);
  const hasEvents = useObservableSelector(boardEvents, (e) => e.length > 0);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);

  /** Panels with a live data source, plus the three always shown. */
  const available = useMemo(() => {
    const set = new Set<PanelKind>(["stream", "overlay", "terminal"]);
    if (seenTof) set.add("tof");
    if (hasMag) set.add("mag");
    if (hasImu) set.add("imu");
    if (isp !== 0) set.add("isp");
    if (vision !== 0) set.add("vision");
    // Either signal reveals it, so one lost 0x53 does not hide the panel.
    if (hasAudioLabels || hasAudioClass) set.add("audio");
    if (hasImageClass) set.add("imageClass");
    if (caps !== 0) set.add("camera");
    if (tune.length > 0) set.add("tuning");
    if (hasEvents) set.add("events");
    return set;
  }, [
    seenTof,
    hasMag,
    hasImu,
    isp,
    vision,
    hasAudioLabels,
    hasAudioClass,
    hasImageClass,
    caps,
    tune,
    hasEvents,
  ]);

  const addAfter = (index: number) => {
    if (slots.length >= MAX_SLOTS) return;
    const used = new Set(slots.map((s) => s.panel));
    const next = panelOrder.find((p) => !used.has(p) && available.has(p)) ?? "overlay";
    const copy = slots.slice();
    copy.splice(index + 1, 0, createSlot(next));
    setSlots(copy);
  };

  const remove = (index: number) => {
    if (slots.length <= 1) return;
    setSlots(slots.filter((_, i) => i !== index));
  };

  const patch = (index: number, changes: Partial<SidebarSlot>) => {
    setSlots(slots.map((slot, i) => (i === index ? { ...slot, ...changes } : slot)));
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const copy = slots.slice();
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved);
    setSlots(copy);
  };

  return (
    <aside className="panel-rail" aria-label="Instrument panels">
      {slots.map((slot, index) => {
        const controls: SlotControls = {
          index,
          selected: slot.panel,
          available,
          collapsed: slot.collapsed,
          canAdd: slots.length < MAX_SLOTS,
          canRemove: slots.length > 1,
          onSelect: (panel) => patch(index, { panel }),
          onToggleCollapse: () => patch(index, { collapsed: !slot.collapsed }),
          onAdd: () => addAfter(index),
          onRemove: () => remove(index),
          onDragStart: () => {
            dragRef.current = index;
            setDragIndex(index);
          },
          onDragEnd: () => {
            dragRef.current = null;
            setDragIndex(null);
            setOverIndex(null);
          },
        };

        const classes = ["panel"];
        if (slot.collapsed) classes.push("collapsed");
        if (dragIndex === index) classes.push("dragging");
        if (overIndex === index && dragIndex !== index) classes.push("drop-target");

        return (
          <section
            // The slot's permanent id keeps each panel's state through reorders.
            key={slot.id}
            className={classes.join(" ")}
            onDragOver={(event) => {
              if (dragRef.current === null) return;
              event.preventDefault();
              setOverIndex(index);
            }}
            onDrop={(event) => {
              if (dragRef.current === null) return;
              event.preventDefault();
              reorder(dragRef.current, index);
              dragRef.current = null;
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
            {renderPanel(slot.panel, controls)}
          </section>
        );
      })}
    </aside>
  );
}
