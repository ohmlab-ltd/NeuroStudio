import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState, Slider, ToggleRow } from "../controls";
import { useObservable } from "../../state/observable";
import { camCaps } from "../../state/device";
import {
  cameraControls,
  cameraFlags,
  patchCameraControls,
  type CameraControlState,
} from "../../state/controls";
import {
  buildCameraControlPacket,
  kApplyAutoAwb,
  kApplyAutoExposure,
  kApplyAutoGain,
  kApplyExposureUs,
  kCamCapAwb,
  kCamCapExposure,
  kCamCapGain,
} from "../../device/packets";

/** Exposure and gain lock together: the auto gain loop would undo a locked exposure. */
export function CameraControlsPanel({ controls }: { controls: SlotControls }) {
  const caps = useObservable(camCaps);
  const { autoExposure, autoAwb, exposureUs } = useObservable(cameraControls);

  const send = (applyMask: number, state: CameraControlState) => {
    window.neuro.write(
      buildCameraControlPacket({
        flags: cameraFlags(state),
        applyMask,
        exposureUs: Math.round(state.exposureUs),
      }),
    );
  };

  /** Exposure and gain go in one packet, so the sensor never sees a half-locked state. */
  const toggleAutoExposure = (auto: boolean) => {
    const next = patchCameraControls({ autoExposure: auto, exposureApplied: false });
    let mask = kApplyAutoExposure;
    if (caps & kCamCapGain) mask |= kApplyAutoGain;
    send(mask, next);
  };

  const toggleAutoAwb = (auto: boolean) => {
    send(kApplyAutoAwb, patchCameraControls({ autoAwb: auto }));
  };

  return (
    <PanelFrame title="CAMERA CONTROLS" controls={controls}>
      <div className="panel-body">
        {caps === 0 ? (
          <EmptyState>This sensor has no manual capture controls</EmptyState>
        ) : (
          <>
            <p className="panel-note">
              Point at a representative scene, let it settle, then switch auto off to hold what it
              found.
            </p>

            {caps & kCamCapExposure ? (
              <>
                <ToggleRow
                  label="Auto exposure"
                  help={
                    caps & kCamCapGain
                      ? "Off locks exposure and gain together"
                      : "Off locks the current exposure"
                  }
                  checked={autoExposure}
                  onChange={toggleAutoExposure}
                />
                {!autoExposure ? (
                  <>
                    <Slider
                      label="Exposure"
                      display={`${(exposureUs / 1000).toFixed(1)} ms`}
                      value={exposureUs}
                      min={100}
                      max={33000}
                      step={100}
                      onChange={(v) => patchCameraControls({ exposureUs: v })}
                      // Sent on release: the sensor applies at most one change per frame.
                      onCommit={() =>
                        send(kApplyExposureUs, patchCameraControls({ exposureApplied: true }))
                      }
                    />
                    <p className="panel-note">
                      The device clamps this to the frame period, so the ceiling drops as frame rate
                      rises.
                    </p>
                  </>
                ) : null}
              </>
            ) : null}

            {caps & kCamCapAwb ? (
              <ToggleRow
                label="Auto white balance"
                help="Off freezes the current channel gains"
                checked={autoAwb}
                onChange={toggleAutoAwb}
              />
            ) : null}
          </>
        )}
      </div>
    </PanelFrame>
  );
}
