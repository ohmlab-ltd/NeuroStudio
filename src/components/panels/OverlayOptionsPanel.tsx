import { PanelFrame, type SlotControls } from "../PanelFrame";
import { Chip, PanelSection, PillToggle, Segmented, Slider } from "../controls";
import { Icon } from "../Icon";
import { useObservable } from "../../state/observable";
import { presenceLinger } from "../../state/device";
import {
  overlayOptions,
  overlaysMasterOff,
  patchTofDisplayOptions,
  setMaskFeather,
  setThermalColormap,
  setThermalOverlayAuto,
  setThermalOverlayOffsetX,
  setThermalOverlayOffsetY,
  setThermalOverlayOpacity,
  setThermalOverlayScale,
  toggleAllOverlays,
  toggleOverlayOption,
  tofDisplayOptions,
} from "../../state/options";
import type { ThermalColormap } from "../../device/thermal";

export function OverlayOptionsPanel({ controls }: { controls: SlotControls }) {
  const options = useObservable(overlayOptions);
  const presence = useObservable(presenceLinger);
  const tofDisplay = useObservable(tofDisplayOptions);

  const masterOff = useObservable(overlaysMasterOff);

  const anyOverlayMeta =
    presence.hasInferenceMs ||
    presence.hasBoxes ||
    presence.hasKeypoints ||
    presence.hasBindings ||
    presence.hasBoxLabels ||
    presence.hasShading;

  return (
    <PanelFrame title="OVERLAYS" controls={controls}>
      <div className="panel-body">
        <div className="chip-row">
          <Chip
            label="All overlays"
            on={!masterOff}
            available={anyOverlayMeta}
            onClick={toggleAllOverlays}
          />
          <Chip
            label="Boxes"
            on={options.showBoxes}
            available={presence.hasBoxes}
            onClick={() => toggleOverlayOption("showBoxes")}
          />
          <Chip
            label="Keypoints"
            on={options.showKeypoints}
            available={presence.hasKeypoints}
            onClick={() => toggleOverlayOption("showKeypoints")}
          />
          <Chip
            label="Bindings"
            on={options.showBindings}
            available={presence.hasBindings}
            onClick={() => toggleOverlayOption("showBindings")}
          />
          <Chip
            label="Labels"
            on={options.showBoxLabels}
            available={presence.hasBoxLabels}
            onClick={() => toggleOverlayOption("showBoxLabels")}
          />
          <Chip
            label="Shading"
            on={options.showShading}
            available={presence.hasShading}
            onClick={() => toggleOverlayOption("showShading")}
          />
        </div>

        <Slider
          label="Mask Upscale"
          display={options.maskFeather.toFixed(2)}
          value={options.maskFeather}
          min={0}
          max={8}
          step={0.08}
          onChange={setMaskFeather}
        />

        {presence.hasThermal ? (
          <>
            <PanelSection>Thermal colormap</PanelSection>
            <Segmented<ThermalColormap>
              value={options.thermalColormap}
              onChange={setThermalColormap}
              options={[
                { value: "grayscale", label: "Gray", icon: <Icon name="contrast" size={13} /> },
                { value: "ironbow", label: "Ironbow", icon: <Icon name="fire" size={13} /> },
                { value: "inferno", label: "Inferno", icon: <Icon name="flame" size={13} /> },
              ]}
            />

            <PanelSection>Thermal overlay</PanelSection>
            <Slider
              label="Opacity"
              display={options.thermalOverlayOpacity.toFixed(2)}
              value={options.thermalOverlayOpacity}
              min={0}
              max={1}
              step={0.01}
              onChange={setThermalOverlayOpacity}
            />
            {options.thermalOverlayOpacity > 0 ? (
              <div className="row" style={{ alignItems: "flex-end", gap: 8 }}>
                <PillToggle
                  label="AUTO"
                  on={options.thermalOverlayAuto}
                  onClick={() => setThermalOverlayAuto(!options.thermalOverlayAuto)}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Slider
                    label="Scale"
                    value={options.thermalOverlayScale}
                    min={0.2}
                    max={1.6}
                    step={0.01}
                    disabled={options.thermalOverlayAuto}
                    onChange={setThermalOverlayScale}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Slider
                    label="X"
                    value={options.thermalOverlayOffsetX}
                    min={-0.5}
                    max={0.5}
                    step={0.005}
                    disabled={options.thermalOverlayAuto}
                    onChange={setThermalOverlayOffsetX}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Slider
                    label="Y"
                    value={options.thermalOverlayOffsetY}
                    min={-0.5}
                    max={0.5}
                    step={0.005}
                    disabled={options.thermalOverlayAuto}
                    onChange={setThermalOverlayOffsetY}
                  />
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {presence.hasDebugTof ? (
          <>
            <PanelSection>ToF overlay calibration</PanelSection>
            <Slider
              label="Horizontal Scale"
              display={tofDisplay.scaleX.toFixed(2)}
              value={tofDisplay.scaleX}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => patchTofDisplayOptions({ scaleX: v })}
            />
            <Slider
              label="Vertical Scale"
              display={tofDisplay.scaleY.toFixed(2)}
              value={tofDisplay.scaleY}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => patchTofDisplayOptions({ scaleY: v })}
            />
            <Slider
              label="Horizontal Offset"
              display={tofDisplay.offsetX.toFixed(2)}
              value={tofDisplay.offsetX}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => patchTofDisplayOptions({ offsetX: v })}
            />
            <Slider
              label="Vertical Offset"
              display={tofDisplay.offsetY.toFixed(2)}
              value={tofDisplay.offsetY}
              min={-1}
              max={1}
              step={0.01}
              onChange={(v) => patchTofDisplayOptions({ offsetY: v })}
            />
          </>
        ) : null}
      </div>
    </PanelFrame>
  );
}
