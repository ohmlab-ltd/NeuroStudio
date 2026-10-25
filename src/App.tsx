import { useEffect, useState } from "react";
import { CameraStage } from "./components/CameraStage";
import { LinkKeyDialog } from "./components/LinkKeyDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { createSlot, type SidebarSlot } from "./panels";
import { startDeviceStore } from "./state/device";

export default function App() {
  const [fitMode, setFitMode] = useState(false);
  const [slots, setSlots] = useState<SidebarSlot[]>(() => [
    createSlot("overlay"),
    createSlot("terminal"),
  ]);

  useEffect(() => startDeviceStore(), []);

  useEffect(() => {
    if (!fitMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFitMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitMode]);

  return (
    <div className={fitMode ? "app-shell fit" : "app-shell"}>
      {fitMode ? null : (
        <header className="app-header">
          <div className="brand">
            <img className="brand-mark" src="./logo-mark.png" alt="" />
            <img src="./neurostudio.svg" alt="Neuro Studio" />
          </div>
        </header>
      )}

      <div className="workbench">
        <main className="main-area" aria-label="Device stream">
          <CameraStage fitMode={fitMode} onToggleFit={() => setFitMode((v) => !v)} />
        </main>
        {fitMode ? null : <Sidebar slots={slots} setSlots={setSlots} />}
      </div>

      {fitMode ? null : <StatusBar />}

      {/* Outside the chrome, so it also opens in the full-bleed view. */}
      <LinkKeyDialog />
    </div>
  );
}
