import { PanelFrame, type SlotControls } from "../PanelFrame";
import { EmptyState, Slider, ToggleRow } from "../controls";
import { Icon } from "../Icon";
import { useObservable } from "../../state/observable";
import { ispMode } from "../../state/device";
import { buildIspPacket, wbPresets } from "../../device/packets";
import { appendTerminal } from "../../state/terminal";
import { ispForm, patchIspForm } from "../../state/controls";

/** Shown once a sketch sets cfg.isp_enabled = VD66_isp_tuning_manual. */
export function IspPanel({ controls }: { controls: SlotControls }) {
  const mode = useObservable(ispMode);
  const { preset, gainR, gainG, gainB, black, sharp, gamma, ccm, status } = useObservable(ispForm);

  const apply = () => {
    window.neuro.write(buildIspPacket({ gainR, gainG, gainB, black, sharp, gamma, ccm }));
    appendTerminal(
      `[ui] ISP Apply: R=${gainR.toFixed(2)} G=${gainG.toFixed(2)} B=${gainB.toFixed(2)} ` +
        `black=${Math.round(black)} sharp=${Math.round(sharp)} gamma=${gamma ? "on" : "off"}\n`,
    );
    patchIspForm({ status: "Applied" });
  };

  const selectPreset = (index: number) => {
    const p = wbPresets[index];
    patchIspForm({ preset: index, gainR: p.gainR, gainG: p.gainG, gainB: p.gainB, ccm: p.ccm });
  };

  return (
    <PanelFrame title="IMAGE PIPELINE" controls={controls}>
      <div className="panel-body">
        {mode === 0 ? (
          <EmptyState>ISP controls not enabled</EmptyState>
        ) : mode === 2 ? (
          <div className="panel-empty" style={{ display: "grid", gap: 8 }}>
            <Icon name="sparkle" size={26} />
            <strong style={{ color: "var(--muted)", fontSize: 12 }}>
              Auto white balance active
            </strong>
            <span>
              The device is tracking white balance on its own (ST ISP middleware). Manual controls
              are disabled in auto mode.
            </span>
          </div>
        ) : (
          <>
            <label className="labelled-field">
              <span>White balance preset</span>
              <select
                className="select-input"
                value={preset}
                onChange={(event) => selectPreset(Number(event.target.value))}
              >
                {wbPresets.map((p, index) => (
                  <option key={p.label} value={index}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <Slider
              label="WB Red"
              display={`${gainR.toFixed(2)}×`}
              value={gainR}
              min={0}
              max={4}
              step={0.01}
              onChange={(v) => patchIspForm({ gainR: v })}
            />
            <Slider
              label="WB Green"
              display={`${gainG.toFixed(2)}×`}
              value={gainG}
              min={0}
              max={4}
              step={0.01}
              onChange={(v) => patchIspForm({ gainG: v })}
            />
            <Slider
              label="WB Blue"
              display={`${gainB.toFixed(2)}×`}
              value={gainB}
              min={0}
              max={4}
              step={0.01}
              onChange={(v) => patchIspForm({ gainB: v })}
            />
            <Slider
              label="Black level"
              display={`${Math.round(black)}`}
              value={black}
              min={0}
              max={64}
              step={1}
              onChange={(v) => patchIspForm({ black: v })}
            />
            <Slider
              label="Sharpness"
              display={`${Math.round(sharp)}`}
              value={sharp}
              min={0}
              max={7}
              step={1}
              onChange={(v) => patchIspForm({ sharp: v })}
            />
            <ToggleRow
              label="Gamma"
              checked={gamma}
              onChange={(on) => patchIspForm({ gamma: on })}
            />

            <button type="button" className="button primary" onClick={apply}>
              Apply
            </button>
            {status ? <p className="status-line">{status}</p> : null}
          </>
        )}
      </div>
    </PanelFrame>
  );
}
